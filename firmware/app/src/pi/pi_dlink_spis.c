/*
 * The Pi's SPI link on a board, for Raspberry Pi delta updates: see pi_dlink_spis.h.
 *
 * As in the message link (PR #58): the target is armed with the answer for the next transfer, and
 * READY goes high. When the Pi has done the transfer, the driver's callback lowers READY at once
 * and hands the transfer to this link's work queue, which answers it (pi_dlink.c) and arms the
 * target again. Unlike the message link, the answer is a whole frame: up to 480 bytes of the image.
 * While it is not armed the target clocks out 0xff, which the Pi reads as no answer.
 */

#include "pi_dlink_spis.h"

#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "pi_dlink.h"
#include "pi_frame.h"

LOG_MODULE_REGISTER(pi_dlink, CONFIG_APP_LOG_LEVEL);

#define SPIS_NODE DT_NODELABEL(spi3)
#define PI_DELTA_NODE DT_NODELABEL(pi_delta)

BUILD_ASSERT(DT_NODE_HAS_COMPAT(SPIS_NODE, nordic_nrf_spis),
	     "the Pi's link needs spi3 as an SPI target (nordic,nrf-spis): boards/pi_delta.overlay");

static const struct device *const spis = DEVICE_DT_GET(SPIS_NODE);
static const struct gpio_dt_spec ready = GPIO_DT_SPEC_GET(PI_DELTA_NODE, ready_gpios);

static const struct spi_config spi_cfg = {
	.operation = SPI_OP_MODE_SLAVE | SPI_WORD_SET(8) | SPI_TRANSFER_MSB,
};

static uint8_t rx_buf[PI_FRAME_SIZE];
static uint8_t tx_buf[PI_FRAME_SIZE];

static K_THREAD_STACK_DEFINE(link_stack, CONFIG_APP_PI_DELTA_LINK_STACK_SIZE);
static struct k_work_q link_queue;
static void link_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(link_work, link_work_handler);

static struct pi_dlink link;
/* Set by the driver's callback, read on the work queue. */
static volatile int transfer_result;
/* Only on the work queue: the target has buffers and READY is high. */
static bool armed;
static int link_error;
static bool running;

static void on_transfer(const struct device *dev, int result, void *data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(data);
	/* At once, in the interrupt: the Pi looks at READY soon after its transfer. */
	(void)gpio_pin_set_dt(&ready, 0);
	transfer_result = result;
	(void)k_work_reschedule_for_queue(&link_queue, &link_work, K_NO_WAIT);
}

static void arm(void)
{
	const struct spi_buf tx = { .buf = tx_buf, .len = sizeof(tx_buf) };
	const struct spi_buf rx = { .buf = rx_buf, .len = sizeof(rx_buf) };
	const struct spi_buf_set tx_set = { .buffers = &tx, .count = 1 };
	const struct spi_buf_set rx_set = { .buffers = &rx, .count = 1 };
	int err;

	memset(rx_buf, 0, sizeof(rx_buf));
	/* Before the call: the callback can come before it returns. */
	armed = true;
	err = spi_transceive_cb(spis, &spi_cfg, &tx_set, &rx_set, on_transfer, NULL);
	if (err != 0) {
		armed = false;
		link_error = err;
		LOG_ERR("Could not arm the SPI target: %d", err);
		(void)k_work_reschedule_for_queue(&link_queue, &link_work, K_SECONDS(1));
		return;
	}
	link_error = 0;
	(void)gpio_pin_set_dt(&ready, 1);
}

static void link_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	if (armed) {
		int result = transfer_result;

		armed = false;
		(void)gpio_pin_set_dt(&ready, 0);
		if (result > 0) {
			(void)pi_dlink_handle(&link, rx_buf, (size_t)MIN(result, (int)sizeof(rx_buf)),
					      tx_buf);
		} else if (result < 0) {
			LOG_WRN("SPI transfer failed: %d", result);
		}
	}
	arm();
}

int pi_dlink_spis_start(struct pi_card *card)
{
	int err;

	pi_dlink_init(&link, card);
	memset(tx_buf, 0xff, sizeof(tx_buf));

	if (!device_is_ready(spis) || !gpio_is_ready_dt(&ready)) {
		LOG_ERR("The SPI target or the READY pin for the Pi is not ready");
		link_error = -ENODEV;
		return -ENODEV;
	}
	err = gpio_pin_configure_dt(&ready, GPIO_OUTPUT_INACTIVE);
	if (err != 0) {
		link_error = err;
		return err;
	}
	k_work_queue_start(&link_queue, link_stack, K_THREAD_STACK_SIZEOF(link_stack),
			   CONFIG_APP_PI_DELTA_LINK_PRIORITY, NULL);
	k_thread_name_set(&link_queue.thread, "pi_link");
	running = true;
	(void)k_work_reschedule_for_queue(&link_queue, &link_work, K_NO_WAIT);
	return 0;
}

void pi_dlink_spis_view(struct pi_dlink_spis_view *view)
{
	view->running = running;
	view->error = link_error;
	view->answered = link.answered;
	view->errors = link.errors;
	view->bad_frames = link.bad_frames;
	view->polls = link.polls;
}
