/*
 * Events to the console: see cloud_events.h.
 *
 * What may go to the cloud is decided twice. When a line comes in, from any thread: by where it
 * comes from (sources[]), by what it must never have in it (never_anywhere[] and the source's own
 * word), and by the source's rule for what to replace. When it goes out, on the main loop: the name
 * of the stored network is replaced wherever it stands, which needs the Wi-Fi credentials store, and
 * so cannot be done on every thread.
 */

#include "cloud_events.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/util.h>

#include "app_events.h"
#if defined(CONFIG_APP_BOOT_DIARY)
#include "boot_diary.h"
#endif
#include "cloud.h"
#include "net.h"

LOG_MODULE_REGISTER(cloud_events, CONFIG_APP_LOG_LEVEL);

/* The rate limit counts in thousandths of a line: a millisecond adds CLOUD_EVENTS_PER_SECOND. */
#define MILLI        1000
#define NETWORK      "the network"
#define A_URL        "a URL"
#define CUT          "..."

enum rule {
	/* As it is, after what every line goes through. */
	RULE_AS_IS,
	/*
	 * What stands between the first double quote and the last is a network's name: net.c's
	 * Leaving "<ssid>": ... A name can have quotes in it, so it is all of that, or to the end.
	 */
	RULE_QUOTES_HOLD_A_NETWORK,
};

struct source {
	const char *tag;
	enum rule rule;
	/* A line of this source that has this in it, in any case, is never sent. */
	const char *never;
};

/*
 * Where a line may come from. Every other tag, which is every module of Zephyr and the SDK, is never
 * sent: those are where network names, host names and URLs are printed.
 */
static const struct source sources[] = {
	/* console_event(). bt_ota.c prints the passkey, which reaches a phone app by the shadow alone. */
	{ "BT", RULE_AS_IS, "passkey" },
	{ "WIFI", RULE_QUOTES_HOLD_A_NETWORK, NULL },
	{ "STUCK", RULE_AS_IS, NULL },
	{ "CONSOLE", RULE_AS_IS, NULL },
	/* command.c's answers to the console's commands, from 1.13.0. */
	{ "CMD", RULE_AS_IS, NULL },
	/* LOG_*() of this application's modules, by the name each one registers. */
	{ "app", RULE_AS_IS, NULL },
	{ "boot_diary", RULE_AS_IS, NULL },
	{ "bt_ota", RULE_AS_IS, "passkey" },
	{ "cloud", RULE_AS_IS, NULL },
	{ "factory", RULE_AS_IS, NULL },
	{ "health", RULE_AS_IS, NULL },
	{ "identity", RULE_AS_IS, NULL },
	/* From 1.13.0. It prints counts of access points, and never an address or a network's name. */
	{ "location", RULE_AS_IS, NULL },
	{ "net", RULE_QUOTES_HOLD_A_NETWORK, NULL },
	{ "ota", RULE_AS_IS, NULL },
	{ "store", RULE_AS_IS, NULL },
	{ "stuck", RULE_AS_IS, NULL },
	{ "ui", RULE_AS_IS, NULL },
};

/*
 * A line with any of these in it, in any case, is never sent, whatever its source. No line of this
 * firmware has one today: this is for the line that someone adds tomorrow. "x-amz-" is in every
 * signed download URL, also one that has lost its "https://".
 */
static const char *const never_anywhere[] = {
	"passkey", "passphrase", "password=", "password:", "psk=",
	"secret", "-----begin", "private key", "x-amz-",
};

struct event {
	int64_t t;
	uint32_t seq;
	/* How many lines are missing right before this one: the ring's and the limit's. */
	uint32_t dropped;
	char tag[CLOUD_EVENTS_TAG_MAX + 1];
	char text[CLOUD_EVENTS_TEXT_MAX + 1];
};

/* Lines come from every thread: the ring and the numbers that go with it are under this lock. */
static struct k_spinlock lock;
static struct event ring[CLOUD_EVENTS_RING];
static size_t oldest;
static size_t waiting;
static uint32_t next_seq = 1;
/* Lines lost since the last one that got into the ring: the next one says so. */
static uint32_t missing;
static int64_t tokens = (int64_t)CLOUD_EVENTS_BURST * MILLI;
static int64_t refilled_at;

/* A wake-up for the main loop is in its queue, or about to be. */
static atomic_t wake_posted;
/* The main loop has given up on events for this boot: see link.refused. */
static atomic_t given_up;

/* The main loop's: the connection, as far as events go. */
static struct {
	bool up;
	int64_t up_at;
	/* When this connection's first event went out, or -1. */
	int64_t probe_at;
	/* That first event, to go back into the ring if AWS IoT turned it away. */
	struct event probe;
	/* AWS IoT has taken an event in this boot. */
	bool proven;
	uint8_t refusals;
	bool refused;
} link = { .probe_at = -1 };

/* ---- what may be sent ---------------------------------------------------------------- */

static char lower(char c)
{
	return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

static bool is_alnum(char c)
{
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/* word is in lower case. */
static bool contains(const char *text, size_t length, const char *word)
{
	size_t word_length = strlen(word);

	for (size_t at = 0; at + word_length <= length; at++) {
		size_t i = 0;

		while (i < word_length && lower(text[at + i]) == word[i]) {
			i++;
		}

		if (i == word_length) {
			return true;
		}
	}

	return false;
}

static const struct source *source_of(const char *tag)
{
	for (size_t i = 0; i < ARRAY_SIZE(sources); i++) {
		if (strcmp(tag, sources[i].tag) == 0) {
			return &sources[i];
		}
	}

	return NULL;
}

static bool may_be_sent(const struct source *source, const char *text, size_t length)
{
	/* The console marks a debug line so. Those are for whoever has the cable. */
	if (length == 0 || (length >= 5 && memcmp(text, "DBG: ", 5) == 0)) {
		return false;
	}

	if (source->never != NULL && contains(text, length, source->never)) {
		return false;
	}

	for (size_t i = 0; i < ARRAY_SIZE(never_anywhere); i++) {
		if (contains(text, length, never_anywhere[i])) {
			return false;
		}
	}

	return true;
}

/* ---- the text, as it is kept --------------------------------------------------------- */

/* Writes at most CLOUD_EVENTS_TEXT_MAX characters, and marks a text that was longer. */
struct writer {
	char *out;
	size_t used;
	bool cut;
};

static void put_char(struct writer *w, char c)
{
	if (w->used < CLOUD_EVENTS_TEXT_MAX) {
		w->out[w->used++] = c;
	} else {
		w->cut = true;
	}
}

static void put_text(struct writer *w, const char *text)
{
	for (; *text != '\0'; text++) {
		put_char(w, *text);
	}
}

static void finish(struct writer *w)
{
	if (w->cut) {
		memcpy(w->out + CLOUD_EVENTS_TEXT_MAX - (sizeof(CUT) - 1), CUT, sizeof(CUT) - 1);
		w->used = CLOUD_EVENTS_TEXT_MAX;
	}

	w->out[w->used] = '\0';
}

static bool in_scheme(char c)
{
	return is_alnum(c) || c == '+' || c == '-' || c == '.';
}

/* The length of the URL that starts at text[at], up to a blank or a quote, or 0 if none does. */
static size_t url_at(const char *text, size_t length, size_t at)
{
	size_t end = at;

	if ((at > 0 && in_scheme(text[at - 1])) || !is_alnum(text[at])) {
		return 0;
	}

	while (end < length && in_scheme(text[end])) {
		end++;
	}

	if (end + 3 > length || memcmp(text + end, "://", 3) != 0) {
		return 0;
	}

	end += 3;
	while (end < length && text[end] != ' ' && text[end] != '\t' && text[end] != '"' &&
	       text[end] != '\'') {
		end++;
	}

	return end - at;
}

/* Into the ring: printable ASCII only, with what the rules replace already replaced. */
static void keep_text(char *out, const char *text, size_t length, enum rule rule)
{
	struct writer w = { .out = out };
	size_t at = 0;

	while (at < length) {
		size_t url = url_at(text, length, at);

		if (rule == RULE_QUOTES_HOLD_A_NETWORK && text[at] == '"') {
			size_t close = length - 1;

			while (close > at && text[close] != '"') {
				close--;
			}

			put_text(&w, NETWORK);
			at = close > at ? close + 1 : length;
		} else if (url > 0) {
			put_text(&w, A_URL);
			at += url;
		} else {
			put_char(&w, (text[at] >= ' ' && text[at] <= '~') ? text[at] : '?');
			at++;
		}
	}

	finish(&w);
}

/*
 * The stored network's name, wherever it stands in a text that has been through keep_text(), as a
 * name of its own: "net" is not taken out of "network". name has been through keep_text() too.
 */
static void take_out_network(char *text, const char *name)
{
	static char rest[CLOUD_EVENTS_TEXT_MAX + 1];
	size_t name_length = strlen(name);
	struct writer w = { .out = rest };
	size_t length = strlen(text);
	size_t at = 0;

	if (name_length == 0) {
		return;
	}

	while (at < length) {
		bool here = at + name_length <= length && memcmp(text + at, name, name_length) == 0 &&
			    !(is_alnum(name[0]) && at > 0 && is_alnum(text[at - 1])) &&
			    !(is_alnum(name[name_length - 1]) && at + name_length < length &&
			      is_alnum(text[at + name_length]));

		if (here) {
			put_text(&w, NETWORK);
			at += name_length;
		} else {
			put_char(&w, text[at++]);
		}
	}

	/* A mark of a cut stays at the end, or a new one comes there. */
	finish(&w);
	strcpy(text, rest);
}

/* ---- the ring ------------------------------------------------------------------------ */

static void refill_locked(int64_t now)
{
	if (now > refilled_at) {
		tokens = MIN(tokens + (now - refilled_at) * CLOUD_EVENTS_PER_SECOND,
			     (int64_t)CLOUD_EVENTS_BURST * MILLI);
		refilled_at = now;
	}
}

/* An event that will never go: the oldest that waits, or else the next to come, says so. */
static void lose_locked(const struct event *event)
{
	if (waiting > 0) {
		ring[oldest].dropped += event->dropped + 1;
	} else {
		missing += event->dropped + 1;
	}
}

static void drop_oldest_locked(void)
{
	const struct event *dropped = &ring[oldest];

	oldest = (oldest + 1) % CLOUD_EVENTS_RING;
	waiting--;
	lose_locked(dropped);
}

static bool nothing_waiting(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	bool none = waiting == 0;

	k_spin_unlock(&lock, key);
	return none;
}

static bool take_oldest(struct event *event)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	bool taken = waiting > 0;

	if (taken) {
		*event = ring[oldest];
		oldest = (oldest + 1) % CLOUD_EVENTS_RING;
		waiting--;
	}

	k_spin_unlock(&lock, key);
	return taken;
}

/* Back to the front, as it was, for another try. If the ring filled up meanwhile, it is lost. */
static void put_back(const struct event *event)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	if (waiting < CLOUD_EVENTS_RING) {
		oldest = (oldest + CLOUD_EVENTS_RING - 1) % CLOUD_EVENTS_RING;
		ring[oldest] = *event;
		waiting++;
	} else {
		lose_locked(event);
	}

	k_spin_unlock(&lock, key);
}

static void wake_main_loop(void)
{
	static const struct app_event wake = {
		.type = APP_EVENT_CALL,
		.call.function = cloud_events_send,
	};

	/* While offline, the main loop sends everything when the connection comes up. */
	if (cloud_is_connected() && !atomic_get(&given_up) && atomic_cas(&wake_posted, 0, 1) &&
	    app_event_post(&wake) != 0) {
		atomic_set(&wake_posted, 0);
	}
}

void cloud_events_add(const char *tag, const char *text, size_t length)
{
	const struct source *source = source_of(tag);
	k_spinlock_key_t key;
	struct event *slot;
	int64_t now;

	if (source == NULL || !may_be_sent(source, text, length)) {
		return;
	}

	/* The time under the lock as well: a later seq never has an earlier t. */
	key = k_spin_lock(&lock);
	now = k_uptime_get();

	refill_locked(now);
	if (tokens < MILLI) {
		/* Its number is used up all the same, so that the gap shows where it would have been. */
		next_seq++;
		missing++;
		k_spin_unlock(&lock, key);
		return;
	}

	tokens -= MILLI;

	if (waiting == CLOUD_EVENTS_RING) {
		drop_oldest_locked();
	}

	slot = &ring[(oldest + waiting) % CLOUD_EVENTS_RING];
	waiting++;
	slot->t = now;
	slot->seq = next_seq++;
	slot->dropped = missing;
	missing = 0;
	strcpy(slot->tag, source->tag);
	keep_text(slot->text, text, length, source->rule);
	k_spin_unlock(&lock, key);

	wake_main_loop();
}

/* ---- out ----------------------------------------------------------------------------- */

static uint32_t boot_number(void)
{
#if defined(CONFIG_APP_BOOT_DIARY)
	return boot_diary_boots();
#else
	return 0;
#endif
}

/* The message, or a negative number if it does not fit, which cannot happen with JSON_MAX. */
static int format_event(const struct event *event, uint32_t boot, int64_t up, char *buf, size_t len)
{
	int used = snprintk(buf, len, "{\"t\":%lld,\"seq\":%u,\"boot\":%u,\"up\":%lld",
			    (long long)event->t, (unsigned int)event->seq, (unsigned int)boot,
			    (long long)up);

	if (used > 0 && (size_t)used < len && event->dropped > 0) {
		used += snprintk(buf + used, len - (size_t)used, ",\"dropped\":%u",
				 (unsigned int)event->dropped);
	}

	if (used > 0 && (size_t)used < len) {
		used += snprintk(buf + used, len - (size_t)used, ",\"tag\":\"%s\",\"text\":\"",
				 event->tag);
	}

	/* Printable ASCII by now: only the quote and the backslash need escaping. */
	for (const char *c = event->text; *c != '\0' && used > 0 && (size_t)used < len; c++) {
		if (*c == '"' || *c == '\\') {
			buf[used++] = '\\';
		}
		if ((size_t)used < len) {
			buf[used++] = *c;
		}
	}

	if (used <= 0 || (size_t)used + 3 > len) {
		return -ENOSPC;
	}

	memcpy(buf + used, "\"}", 3);
	return used + 2;
}

/* The oldest, if there is one and it went. */
static bool send_oldest(const char *network, int64_t now, struct event *sent)
{
	static char json[CLOUD_EVENTS_JSON_MAX];

	if (!take_oldest(sent)) {
		return false;
	}

	take_out_network(sent->text, network);

	if (format_event(sent, boot_number(), now, json, sizeof(json)) < 0) {
		/* One that cannot exist: the next one says it is missing. */
		k_spinlock_key_t key = k_spin_lock(&lock);

		lose_locked(sent);
		k_spin_unlock(&lock, key);
		return true;
	}

	if (cloud_event_publish(json) != 0) {
		put_back(sent);
		return false;
	}

	return true;
}

/* The connection has lived CLOUD_EVENTS_PROOF_MS with its first event: AWS IoT took it. */
static void judge_probe(int64_t now)
{
	if (!link.proven && link.probe_at >= 0 && now - link.probe_at >= CLOUD_EVENTS_PROOF_MS) {
		link.proven = true;
	}
}

/* The stored network's name, as keep_text() would have kept it in a line, or "". */
static const char *network_name(void)
{
	static char name[NET_SSID_MAX + 1];
	static char kept[CLOUD_EVENTS_TEXT_MAX + 1];

	if (net_stored_ssid(name, sizeof(name)) == 0) {
		return "";
	}

	keep_text(kept, name, strlen(name), RULE_AS_IS);
	return kept;
}

void cloud_events_send(void)
{
	static struct event sent;
	int64_t now = k_uptime_get();
	const char *network;

	atomic_set(&wake_posted, 0);

	if (!link.up || link.refused || !cloud_is_connected()) {
		return;
	}

	judge_probe(now);
	if (nothing_waiting()) {
		return;
	}

	network = network_name();

	if (!link.proven) {
		if (link.probe_at < 0 && now - link.up_at >= CLOUD_EVENTS_START_MS &&
		    send_oldest(network, now, &sent)) {
			link.probe = sent;
			link.probe_at = now;
		}
		return;
	}

	for (int i = 0; i < CLOUD_EVENTS_PER_CALL; i++) {
		if (!send_oldest(network, now, &sent)) {
			return;
		}
	}

	/* More may be waiting: after whatever else the main loop has to do. */
	wake_main_loop();
}

void cloud_events_on_cloud_up(void)
{
	link.up = true;
	link.up_at = k_uptime_get();
	link.probe_at = -1;
	cloud_events_send();
}

void cloud_events_on_cloud_down(void)
{
	judge_probe(k_uptime_get());

	/* The connection ended soon after its first event, and AWS IoT may have closed it for that. */
	if (link.up && !link.proven && link.probe_at >= 0) {
		put_back(&link.probe);

		if (++link.refusals >= CLOUD_EVENTS_REFUSALS_MAX) {
			link.refused = true;
			atomic_set(&given_up, 1);
			LOG_WRN("AWS IoT closed the connection right after an event, %d times: no events "
				"until a restart. Its device policy must allow cranium/<thing>/events",
				CLOUD_EVENTS_REFUSALS_MAX);
		}
	}

	link.up = false;
	link.probe_at = -1;
}
