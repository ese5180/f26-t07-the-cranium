/*
 * The SPI link from the Raspberry Pi: see pi_link.h and docs/pi-link.md.
 *
 * The peripheral is armed with the STATUS frame for the next transfer, and READY goes high. When the
 * Pi has done the transfer, the SPI driver's callback lowers READY at once and hands the transfer to
 * the system work queue, which takes the frame (pi_rx.c) and arms the peripheral again. While it is not armed the peripheral
 * clocks out def-char (0xff), which the Pi reads as no answer; after the STATUS frame's 16 bytes it
 * clocks out the overrun character, which the Pi ignores.
 *
 * With Raspberry Pi delta updates (CONFIG_APP_PI_DELTA), one rule for every transfer: the board
 * answers each frame in the next transfer, a delta request with its answer (pi_dlink_answer(), read
 * from the SD card) and everything else with STATUS, as without them. The answer is armed with its
 * own length, so the overrun character follows it as it follows STATUS. The work runs on the link's
 * own queue, so that a READ waiting for the card never holds up the system work queue.
 *
 * With plays (CONFIG_APP_PI_PLAYS), the last np waits here until the main loop sends it to the cloud
 * (pi_link_plays_on_tick()): a newer np replaces one that has not gone yet, which then counts as skipped.
 */

#include "pi_link.h"

#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "console.h"
#include "console_port.h"
#include "pi_frame.h"
#include "pi_rx.h"
#if defined(CONFIG_APP_PI_DELTA)
#include "pi_dlink.h"
#endif
#if defined(CONFIG_APP_PI_PLAYS)
#include "cloud.h"
#include "sessions.h"
#endif

LOG_MODULE_REGISTER(pi_link, CONFIG_APP_LOG_LEVEL);

#define SPIS_NODE DT_NODELABEL(spi3)
/* A link that has had no frame for this long is "quiet", and its next frame says so on the console. */
#define QUIET_MS (30 * MSEC_PER_SEC)
/* The longest message printed on the console; the rest is left out. */
#define PRINT_MAX 300
#define PRINT_PREFIX "[PI] "
#define PRINT_PREFIX_LENGTH (sizeof(PRINT_PREFIX) - 1)

BUILD_ASSERT(DT_NODE_HAS_COMPAT(SPIS_NODE, nordic_nrf_spis),
	     "the Pi link needs spi3 as an SPI peripheral (nordic,nrf-spis): see the board's overlay");
/* The prefix is written over the end of the frame's header, just before the payload. */
BUILD_ASSERT(PRINT_PREFIX_LENGTH <= PI_FRAME_HEADER);

static const struct device *const spis = DEVICE_DT_GET(SPIS_NODE);
static const struct gpio_dt_spec ready = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), pi_ready_gpios);

static const struct spi_config spi_cfg = {
	.operation = SPI_OP_MODE_SLAVE | SPI_WORD_SET(8) | SPI_TRANSFER_MSB,
};

static uint8_t rx_buf[PI_FRAME_SIZE];
#if defined(CONFIG_APP_PI_DELTA)
/* A whole frame: the answer to a delta request can take all of it. */
static uint8_t tx_buf[PI_FRAME_SIZE];
/* Only on the work queue: the length of the answer in tx_buf for arm(), or 0 for STATUS. */
static size_t tx_length;
/* Only on the work queue, but for its counts, which pi_link_get_view() reads. */
static struct pi_dlink dlink;
/* Set once by pi_link_serve_card(), from another thread. */
static atomic_ptr_t served_card = ATOMIC_PTR_INIT(NULL);

static K_THREAD_STACK_DEFINE(link_stack, CONFIG_APP_PI_DELTA_LINK_STACK_SIZE);
static struct k_work_q link_queue;
#define LINK_RESCHEDULE(delay) k_work_reschedule_for_queue(&link_queue, &link_work, (delay))
#else
static uint8_t tx_buf[PI_FRAME_HEADER + PI_FRAME_CRC];
#define LINK_RESCHEDULE(delay) k_work_reschedule(&link_work, (delay))
#endif

static void link_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(link_work, link_work_handler);

/* Set by the driver's callback, read by the work queue. */
static volatile int transfer_result;
/* Only on the work queue: the peripheral has buffers and READY is high. */
static bool armed;

static K_MUTEX_DEFINE(view_lock);
static struct pi_rx rx;
static int link_error;
static bool running;
static int64_t last_frame_at;
static char last_np[PI_LINK_NP_KEPT_MAX + 1];
static char last_hb[PI_LINK_KEPT_MAX + 1];
#if defined(CONFIG_APP_PI_PLAYS)
/* The last np is whole and has not gone to the cloud yet, and when it came in (k_uptime_get_32()). */
static bool np_waiting;
static uint32_t np_at;
static uint32_t plays_skipped;
/* Only on the main loop, read by pi_link_get_view(). */
static uint32_t plays_sent;
static uint32_t plays_failed;
#endif

static void on_transfer(const struct device *dev, int result, void *data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(data);
	/* At once, in the interrupt: the Pi looks at READY 0.5 ms after its transfer. */
	(void)gpio_pin_set_dt(&ready, 0);
	transfer_result = result;
	(void)LINK_RESCHEDULE(K_NO_WAIT);
}

/* Where to keep the message: the last np or hb, if it starts as the Pi's do ({"t":"np", ...). */
static char *kept_for(const uint8_t *payload, size_t length)
{
	static const char start[] = "{\"t\":\"";
	const size_t n = sizeof(start) - 1;

	if (length < n + 3 || memcmp(payload, start, n) != 0 || payload[n + 2] != '"') {
		return NULL;
	}
	if (payload[n] == 'n' && payload[n + 1] == 'p') {
		return last_np;
	}
	if (payload[n] == 'h' && payload[n + 1] == 'b') {
		return last_hb;
	}
	return NULL;
}

static void handle_transfer(size_t received)
{
	struct pi_frame frame;
	enum pi_rx_result result;
	int64_t now = k_uptime_get();
	bool framed;
	bool was_quiet = false;

	k_mutex_lock(&view_lock, K_FOREVER);
	result = pi_rx_handle(&rx, rx_buf, received, &frame);
	framed = result != PI_RX_NOTHING && result != PI_RX_BAD;
	if (framed) {
		was_quiet = last_frame_at == 0 || now - last_frame_at > QUIET_MS;
		last_frame_at = now;
	}
	if (result == PI_RX_DELIVER) {
		/* From the Pi, so untrusted: a control character could forge a console line. */
		char *into;

		pi_rx_clean_text((uint8_t *)frame.payload, frame.length);
		into = kept_for(frame.payload, frame.length);
		if (into != NULL) {
			size_t n = MIN((size_t)frame.length,
				       into == last_np ? (size_t)PI_LINK_NP_KEPT_MAX : (size_t)PI_LINK_KEPT_MAX);

			memcpy(into, frame.payload, n);
			into[n] = '\0';
#if defined(CONFIG_APP_PI_PLAYS)
			if (into == last_np) {
				/* The one before, if still waiting, is skipped; so is one too long to send. */
				plays_skipped += (np_waiting ? 1 : 0) + (n < frame.length ? 1 : 0);
				np_waiting = n == frame.length;
				np_at = (uint32_t)now;
			}
#endif
		}
	}
	k_mutex_unlock(&view_lock);

	if (was_quiet) {
		console_event("PI", "link up");
	}
	if (result == PI_RX_DELIVER) {
		/*
		 * In place, with no copy: the prefix goes over the end of the header, which has been read.
		 * Only on the serial console: a line per message would be too many for the cloud's events.
		 */
		uint8_t *line = (uint8_t *)frame.payload - PRINT_PREFIX_LENGTH;

		memcpy(line, PRINT_PREFIX, PRINT_PREFIX_LENGTH);
		console_port_event((const char *)line,
				   PRINT_PREFIX_LENGTH + MIN((size_t)frame.length, (size_t)PRINT_MAX));
	} else if (result == PI_RX_BAD) {
		LOG_DBG("bad frame of %u bytes", (unsigned int)received);
	}
#if defined(CONFIG_APP_PI_DELTA)
	if (result == PI_RX_DELTA) {
		/* Its answer, for the next transfer; for anything else arm() writes STATUS. */
		dlink.card = atomic_ptr_get(&served_card);
		tx_length = pi_dlink_answer(&dlink, &rx, result, &frame, tx_buf, sizeof(tx_buf));
	}
#endif
}

static void arm(void)
{
	struct spi_buf tx = { .buf = tx_buf, .len = sizeof(tx_buf) };
	const struct spi_buf rxb = { .buf = rx_buf, .len = sizeof(rx_buf) };
	const struct spi_buf_set tx_set = { .buffers = &tx, .count = 1 };
	const struct spi_buf_set rx_set = { .buffers = &rxb, .count = 1 };
	int err;

	k_mutex_lock(&view_lock, K_FOREVER);
#if defined(CONFIG_APP_PI_DELTA)
	if (tx_length == 0) {
		tx_length = pi_rx_status(&rx, tx_buf, sizeof(tx_buf));
	}
	tx.len = tx_length;
#else
	(void)pi_rx_status(&rx, tx_buf, sizeof(tx_buf));
#endif
	k_mutex_unlock(&view_lock);
	memset(rx_buf, 0, sizeof(rx_buf));

	/* Before the call: the callback can come before it returns. */
	armed = true;
	err = spi_transceive_cb(spis, &spi_cfg, &tx_set, &rx_set, on_transfer, NULL);
	if (err != 0) {
		armed = false;
		k_mutex_lock(&view_lock, K_FOREVER);
		link_error = err;
		k_mutex_unlock(&view_lock);
		LOG_ERR("Could not arm the SPI peripheral: %d", err);
		(void)LINK_RESCHEDULE(K_SECONDS(1));
		return;
	}
	k_mutex_lock(&view_lock, K_FOREVER);
	link_error = 0;
	k_mutex_unlock(&view_lock);
	(void)gpio_pin_set_dt(&ready, 1);
}

static void link_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	if (armed) {
		int result = transfer_result;

		armed = false;
		(void)gpio_pin_set_dt(&ready, 0);
#if defined(CONFIG_APP_PI_DELTA)
		/* STATUS, unless what came in was a delta request (handle_transfer()). */
		tx_length = 0;
#endif
		if (result >= 0) {
			handle_transfer((size_t)MIN(result, (int)sizeof(rx_buf)));
		} else {
			LOG_WRN("SPI transfer failed: %d", result);
		}
	}
	arm();
}

void pi_link_start(void)
{
	int err = 0;

	pi_rx_init(&rx);
#if defined(CONFIG_APP_PI_DELTA)
	pi_dlink_init(&dlink, NULL);
#endif

	if (!device_is_ready(spis)) {
		err = -ENODEV;
		LOG_ERR("The SPI peripheral for the Pi is not ready");
	} else if (!gpio_is_ready_dt(&ready)) {
		err = -ENODEV;
		LOG_ERR("The READY pin for the Pi is not ready");
	} else {
		err = gpio_pin_configure_dt(&ready, GPIO_OUTPUT_INACTIVE);
		if (err != 0) {
			LOG_ERR("Could not set up the READY pin: %d", err);
		}
	}

	k_mutex_lock(&view_lock, K_FOREVER);
	link_error = err;
	running = (err == 0);
	k_mutex_unlock(&view_lock);

	if (err == 0) {
#if defined(CONFIG_APP_PI_DELTA)
		k_work_queue_start(&link_queue, link_stack, K_THREAD_STACK_SIZEOF(link_stack),
				   CONFIG_APP_PI_DELTA_LINK_PRIORITY, NULL);
		k_thread_name_set(&link_queue.thread, "pi_link");
#endif
		(void)LINK_RESCHEDULE(K_NO_WAIT);
	}
}

#if defined(CONFIG_APP_PI_DELTA)
void pi_link_serve_card(struct pi_card *card)
{
	atomic_ptr_set(&served_card, card);
}
#endif

void pi_link_get_view(struct pi_link_view *out)
{
	k_mutex_lock(&view_lock, K_FOREVER);
	out->running = running;
	out->error = link_error;
	out->since_frame_ms = last_frame_at == 0 ? -1 : k_uptime_get() - last_frame_at;
	out->delivered = rx.delivered;
	out->duplicates = rx.duplicates;
	out->polls = rx.polls;
	out->bad = rx.bad;
	out->bad_crc = rx.bad_crc;
#if defined(CONFIG_APP_PI_DELTA)
	/* Counted on the work queue outside the lock: a count read here may be one behind. */
	out->delta_answered = dlink.answered;
	out->delta_refused = dlink.errors;
#endif
#if defined(CONFIG_APP_PI_PLAYS)
	out->plays_sent = plays_sent;
	out->plays_skipped = plays_skipped;
	out->plays_failed = plays_failed;
#endif
	k_mutex_unlock(&view_lock);
}

void pi_link_get_last(enum pi_link_kind kind, char *buf, size_t size)
{
	if (size == 0) {
		return;
	}
	k_mutex_lock(&view_lock, K_FOREVER);
	strncpy(buf, kind == PI_LINK_NP ? last_np : last_hb, size - 1);
	buf[size - 1] = '\0';
	k_mutex_unlock(&view_lock);
}

#if defined(CONFIG_APP_PI_PLAYS)
void pi_link_plays_on_tick(void)
{
	/* On the main loop's stack. The np goes at the end, and session_format_play() moves it down. */
	char buf[SESSION_PLAY_HEAD_MAX + PI_LINK_NP_KEPT_MAX + 2];
	char *np = buf + SESSION_PLAY_HEAD_MAX;
	/* Ticks, a second each, before the next play may go. */
	static uint16_t wait;
	size_t length = 0;
	uint32_t age_ms = 0;

	if (wait > 0) {
		wait--;
		return;
	}
	if (!cloud_is_connected()) {
		return;
	}

	k_mutex_lock(&view_lock, K_FOREVER);
	if (np_waiting) {
		length = strlen(last_np);
		memcpy(np, last_np, length);
		/* In 32 bits: right for any age under 49 days. */
		age_ms = k_uptime_get_32() - np_at;
		np_waiting = false;
	}
	k_mutex_unlock(&view_lock);
	if (length == 0) {
		return;
	}

	if (session_format_play(buf, sizeof(buf), age_ms / MSEC_PER_SEC, np, length) > 0 &&
	    cloud_session_publish(buf) == 0) {
		plays_sent++;
	} else {
		plays_failed++;
	}
	wait = CONFIG_APP_PI_PLAYS_INTERVAL_SECONDS - 1;
}
#endif
