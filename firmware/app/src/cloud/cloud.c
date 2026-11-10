#include "cloud.h"

#include <errno.h>
#include <string.h>

#include <net/aws_iot.h>
#include <net/mqtt_helper.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/mqtt.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"
#include "cloud_events.h"
#include "command.h"
#include "identity.h"
#include "location.h"
#include "mflt.h"
#if defined(CONFIG_APP_MEMFAULT)
#include "mflt_link.h"
#endif

LOG_MODULE_REGISTER(cloud, CONFIG_APP_LOG_LEVEL);

#define TOPIC_MAX        128
#define SHADOW_MAX       512
/*
 * The board's own topics are "cranium/<thing name>/<what>", where the thing name is the prefix
 * and 16 hexadecimal digits. A PUBLISH at QoS 0 has a fixed header of 3 bytes (up to 16383 bytes
 * in all) and the topic's length in 2. The library sends the payload from where it is and only puts
 * the rest into its buffer; all of it fits there all the same, as the shadow report does.
 */
#define OWN_TOPIC_LENGTH(what)                                                                     \
	(sizeof("cranium//" what) - 1 + sizeof(CONFIG_APP_THING_NAME_PREFIX) - 1 + 16)
#define EVENTS_TOPIC_LENGTH   OWN_TOPIC_LENGTH("events")
#define COMMANDS_TOPIC_LENGTH OWN_TOPIC_LENGTH("commands")
#define LOCATION_TOPIC_LENGTH OWN_TOPIC_LENGTH("location")
#define MEMFAULT_TOPIC_LENGTH OWN_TOPIC_LENGTH("memfault")
#define PUBLISH_QOS0_HEADER 5
BUILD_ASSERT(EVENTS_TOPIC_LENGTH < TOPIC_MAX, "the events topic must fit its buffer");
BUILD_ASSERT(PUBLISH_QOS0_HEADER + EVENTS_TOPIC_LENGTH + CLOUD_EVENTS_JSON_MAX - 1 <=
		     CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE,
	     "the longest event must fit the MQTT buffer with its topic");
BUILD_ASSERT(PUBLISH_QOS0_HEADER + LOCATION_TOPIC_LENGTH + LOCATION_JSON_MAX - 1 <=
		     CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE,
	     "the longest location must fit the MQTT buffer with its topic");
#if defined(CONFIG_APP_MEMFAULT)
BUILD_ASSERT(PUBLISH_QOS0_HEADER + MEMFAULT_TOPIC_LENGTH + MFLT_LINK_HEADER +
			     CONFIG_APP_MEMFAULT_CHUNK_MAX <=
		     CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE,
	     "the largest Memfault frame must fit the MQTT buffer with its topic");
#endif
#define CONNECT_STACK    4096
#define CONNECT_PRIORITY K_PRIO_PREEMPT(10)

static char topic_notify_next[TOPIC_MAX];
static char topic_get_accepted[TOPIC_MAX];
static char topic_get_rejected[TOPIC_MAX];
static char topic_update_accepted[TOPIC_MAX];
static char topic_update_rejected[TOPIC_MAX];
static char topic_get_next[TOPIC_MAX];
static char topic_events[TOPIC_MAX];
/* Only as long as they can be: RAM is short. */
static char topic_commands[COMMANDS_TOPIC_LENGTH + 1];
static char topic_location[LOCATION_TOPIC_LENGTH + 1];
#if defined(CONFIG_APP_MEMFAULT)
static char topic_memfault[MEMFAULT_TOPIC_LENGTH + 1];
#endif

#if defined(CONFIG_APP_PI_OTA)
/* From 1.20.0: the list of pending jobs, for the order of a firmware and a Pi image (ota.c). */
static char topic_get_list[TOPIC_MAX];
static char topic_list_accepted[TOPIC_MAX];
#endif

/*
 * What is subscribed to, in this order. The console lists them from here as well. The commands
 * topic is the last, so that a connection without it takes one fewer: see cloud_subscription().
 * From 1.20.0 the list of pending jobs comes right before it, and the guard drops the two
 * together: both need the device policy of console 2.25.0, so a cloud that still has an older one ends
 * the connection for either of them.
 */
static char *const subscribed[] = {
	topic_notify_next, topic_get_accepted, topic_get_rejected, topic_update_accepted,
	topic_update_rejected,
#if defined(CONFIG_APP_PI_OTA)
	topic_list_accepted,
#endif
	topic_commands,
};

/* What the guard leaves out once it has given up. */
#if defined(CONFIG_APP_PI_OTA)
#define GUARDED_TOPICS 2
#else
#define GUARDED_TOPICS 1
#endif

static struct mqtt_topic subscriptions[ARRAY_SIZE(subscribed)];
/* The topics are complete: before that the console must not read them. */
static atomic_t topics_ready;

/*
 * The commands topic's guard, from 1.13.0. AWS IoT may end a connection that subscribes where its
 * device policy does not allow, and the jobs topics are in that SUBSCRIBE too: see
 * cloud_subscription() in cloud.h. The strikes are the connection thread's alone.
 */
static atomic_t commands_off;
static uint8_t commands_strikes;
/* AWS_IOT_EVT_ERROR came during the attempt under way: the broker refused its CONNECT. */
static atomic_t attempt_refused;

static K_THREAD_STACK_DEFINE(connect_stack, CONNECT_STACK);
static struct k_work_q connect_queue;
static struct k_work connect_work;
/* The connection thread's own copy: the settings can change on the main loop. */
static char connect_host[IDENTITY_ENDPOINT_MAX];
/*
 * Where this connection's jobs may download from, for the MQTT library's thread, which reads them
 * (cloud_job_message_get()). Copied with the host, while no connection is up or being made.
 */
static char connect_url_prefix[IDENTITY_URL_PREFIX_MAX];

static atomic_t connected;
static atomic_t connecting;

/*
 * The report that cloud_shadow_report_acked() waits for: its message ID plus one, 0 for none. Set by
 * the main loop, and taken by the MQTT helper's thread with the PUBACK that has that ID.
 */
static atomic_t awaited_ack;
static K_SEM_DEFINE(ack_arrived, 0, 1);

/*
 * Written by the connection thread, the MQTT helper's thread and whoever publishes, and read by
 * the console: under a lock, so that a copy is never half of one update and half of another. The
 * state is not in here. It comes from the atomics above, which the rest of this file goes by.
 */
static struct k_spinlock stats_lock;
static struct cloud_stats connection_stats = {
	.connected_at_ms = -1,
	.last_error_ms = -1,
	.last_publish_ms = -1,
	.last_receive_ms = -1,
};

static void stats_note_error(enum cloud_error_source source, int err)
{
	int64_t now = k_uptime_get();
	k_spinlock_key_t key = k_spin_lock(&stats_lock);

	connection_stats.errors++;
	connection_stats.last_error_source = source;
	connection_stats.last_error = err;
	connection_stats.last_error_ms = now;
	k_spin_unlock(&stats_lock, key);
}

/* A connection that was up has ended. */
static void stats_note_down(void)
{
	k_spinlock_key_t key = k_spin_lock(&stats_lock);

	connection_stats.disconnects++;
	k_spin_unlock(&stats_lock, key);
}

/*
 * One jobs message at a time is handed to the main loop, read already: written here while job_busy
 * is 0, and read by the main loop while it is 1.
 */
static struct ota_job job_read;
static enum ota_job_result job_result;
static enum cloud_job_message job_kind;
static atomic_t job_busy;
static atomic_t job_overrun;
/* The URL of a job with both parts that the next reply keeps: an enum ota_job_part. */
static atomic_t job_part;

static bool ends_with(const char *text, size_t text_len, const char *suffix)
{
	size_t suffix_len = strlen(suffix);

	return text_len >= suffix_len &&
	       memcmp(text + text_len - suffix_len, suffix, suffix_len) == 0;
}

/*
 * Copy the value of a string member out of a small JSON reply from AWS IoT. This is
 * not a parser: it finds "name" followed by a colon and a quoted value without
 * escapes, which is all that tokens and error codes are.
 */
static bool json_string(const char *json, size_t len, const char *name, char *out,
			size_t out_size)
{
	size_t name_len = strlen(name);

	for (size_t i = 1; i + name_len + 1 < len; i++) {
		size_t at;
		size_t used = 0;

		if (json[i - 1] != '"' || (i >= 2 && json[i - 2] == '\\') ||
		    memcmp(json + i, name, name_len) != 0 || json[i + name_len] != '"') {
			continue;
		}

		at = i + name_len + 1;
		while (at < len && (json[at] == ' ' || json[at] == '\t')) {
			at++;
		}
		if (at >= len || json[at] != ':') {
			continue;
		}
		at++;
		while (at < len && (json[at] == ' ' || json[at] == '\t')) {
			at++;
		}
		if (at >= len || json[at] != '"') {
			return false;
		}
		at++;

		while (at < len && json[at] != '"') {
			if (json[at] == '\\' || used + 1 >= out_size) {
				return false;
			}
			out[used++] = json[at++];
		}
		if (at >= len) {
			return false;
		}

		out[used] = '\0';
		return true;
	}

	return false;
}

/* The reply to a job status update: hand it over if the update logic waits for it. */
static void on_update_reply(bool accepted, const char *payload, size_t len)
{
	struct app_event event = { .type = APP_EVENT_JOB_ACK, .job_ack.accepted = accepted };
	char token[12];
	char code[32];
	unsigned int sequence = 0;

	if (!accepted) {
		LOG_WRN("Job update rejected: %.*s", (int)MIN(len, 160), payload);
	}

	if (!json_string(payload, len, "clientToken", token, sizeof(token)) || token[1] == '\0') {
		return;
	}

	for (const char *digit = token + 1; *digit != '\0'; digit++) {
		if (*digit < '0' || *digit > '9') {
			return;
		}
		sequence = sequence * 10 + (unsigned int)(*digit - '0');
	}

	event.job_ack.kind = token[0];
	event.job_ack.sequence = (uint16_t)sequence;

	/* Everything except a busy or failing service is final: the execution was
	 * cancelled, timed out or deleted, or the request itself is not acceptable.
	 */
	event.job_ack.permanent = !accepted &&
		!(json_string(payload, len, "code", code, sizeof(code)) &&
		  (strcmp(code, "RequestThrottled") == 0 || strcmp(code, "InternalError") == 0 ||
		   strcmp(code, "ServiceUnavailable") == 0));

	(void)app_event_post(&event);
}

/*
 * The MQTT library's own buffer holds the message only until this returns, so the reply that the
 * main loop needs is read here, as the main loop would: the same function, the same checks. Only
 * what it found is kept.
 */
static void queue_job_message(enum cloud_job_message kind, const char *payload, size_t len)
{
	if (!atomic_cas(&job_busy, 0, 1)) {
		atomic_set(&job_overrun, 1);
		return;
	}

	job_kind = kind;
	job_result = OTA_JOB_NONE;
	memset(&job_read, 0, sizeof(job_read));
	if (kind == CLOUD_JOB_GET_ACCEPTED) {
		job_result = ota_job_parse_part(payload, len, connect_url_prefix,
						(enum ota_job_part)atomic_get(&job_part), &job_read);
	} else if (kind == CLOUD_JOB_LIST) {
		job_result = ota_job_list_parse(payload, len, &job_read);
	}

	if (app_event_post_simple(APP_EVENT_JOB_MESSAGE) != 0) {
		atomic_set(&job_busy, 0);
		atomic_set(&job_overrun, 1);
	}
}

static void on_message(const char *topic, size_t topic_len, const char *payload, size_t len)
{
	int64_t now = k_uptime_get();
	k_spinlock_key_t key = k_spin_lock(&stats_lock);

	connection_stats.received++;
	connection_stats.last_receive_ms = now;
	k_spin_unlock(&stats_lock, key);

	if (ends_with(topic, topic_len, "/jobs/notify-next")) {
		/* Only a signal. Its copy of the document has no usable download URL. */
		queue_job_message(CLOUD_JOB_NOTIFY_NEXT, "", 0);
	} else if (ends_with(topic, topic_len, "/jobs/$next/get/accepted")) {
		queue_job_message(CLOUD_JOB_GET_ACCEPTED, payload, len);
	} else if (ends_with(topic, topic_len, "/jobs/$next/get/rejected")) {
		queue_job_message(CLOUD_JOB_GET_REJECTED, payload, len);
#if defined(CONFIG_APP_PI_OTA)
	} else if (ends_with(topic, topic_len, "/jobs/get/accepted")) {
		queue_job_message(CLOUD_JOB_LIST, payload, len);
#endif
	} else if (ends_with(topic, topic_len, "/update/accepted")) {
		on_update_reply(true, payload, len);
	} else if (ends_with(topic, topic_len, "/update/rejected")) {
		on_update_reply(false, payload, len);
	} else if (topic_commands[0] != '\0' && topic_len == strlen(topic_commands) &&
		   memcmp(topic, topic_commands, topic_len) == 0) {
		command_received(payload, len);
	}
}

static void on_aws_iot_event(const struct aws_iot_evt *const event)
{
	k_spinlock_key_t key;
	int64_t now;

	switch (event->type) {
	case AWS_IOT_EVT_CONNECTED:
		/* Before the flag: whoever sees the flag sees when it came up. */
		now = k_uptime_get();
		key = k_spin_lock(&stats_lock);
		connection_stats.connects++;
		connection_stats.connected_at_ms = now;
		k_spin_unlock(&stats_lock, key);

		atomic_set(&connected, 1);
		mflt_note_cloud_connected();
		(void)app_event_post_simple(APP_EVENT_CLOUD_UP);
		break;
	case AWS_IOT_EVT_DISCONNECTED:
		if (atomic_set(&connected, 0)) {
			stats_note_down();
			mflt_note_cloud_lost();
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
		break;
	case AWS_IOT_EVT_PUBACK:
		if (atomic_cas(&awaited_ack, (atomic_val_t)event->data.message_id + 1, 0)) {
			k_sem_give(&ack_arrived);
		}
		break;
	case AWS_IOT_EVT_DATA_RECEIVED:
		on_message(event->data.msg.topic.str, event->data.msg.topic.len,
			   event->data.msg.ptr, event->data.msg.len);
		break;
	case AWS_IOT_EVT_ERROR:
		/* The library has already closed the connection. Reconnecting is the main
		 * loop's decision. A cloud problem does not restart the device from here: only
		 * STUCK_NO_CLOUD_SECONDS of link-up time with no connection does, in stuck.c.
		 */
		LOG_WRN("AWS IoT library error %d", event->data.err);
		stats_note_error(CLOUD_ERROR_LIBRARY, event->data.err);
		if (atomic_get(&connecting)) {
			atomic_set(&attempt_refused, 1);
		}
		if (atomic_set(&connected, 0)) {
			stats_note_down();
			mflt_note_cloud_lost();
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
		break;
	default:
		break;
	}
}

/*
 * After an attempt that subscribed to the commands topic. aws_iot_connect() waits for the SUBACK,
 * and returns -EAGAIN when it has not come in CONFIG_AWS_IOT_CONNECT_TIMEOUT_SECONDS: the broker
 * ended the connection or said nothing, after a CONNACK that did not refuse it, since a refusal is
 * AWS_IOT_EVT_ERROR. A failure before that (DNS, TLS) says nothing either way.
 */
static void judge_commands_subscription(int err)
{
	if (err == 0) {
		commands_strikes = 0;
		return;
	}

	if (err != -EAGAIN || atomic_get(&attempt_refused) ||
	    ++commands_strikes < CLOUD_COMMANDS_REFUSALS_MAX) {
		return;
	}

	atomic_set(&commands_off, 1);
	LOG_WRN("AWS IoT ended the connection while it subscribed, %d times: no commands until a "
		"restart. Its device policy must allow cranium/<thing>/commands",
		CLOUD_COMMANDS_REFUSALS_MAX);
}

static void connect_work_handler(struct k_work *work)
{
	struct aws_iot_config aws_config = {
		.client_id = (char *)identity_thing_name(),
		.host_name = connect_host,
	};
	bool with_commands = !atomic_get(&commands_off);
	k_spinlock_key_t key;
	int err;

	ARG_UNUSED(work);

	LOG_INF("Connecting to AWS IoT as %s", identity_thing_name());

	key = k_spin_lock(&stats_lock);
	connection_stats.attempts++;
	k_spin_unlock(&stats_lock, key);

	/* Every topic, or all but the last, the commands topic, which the guard has given up on. */
	(void)aws_iot_application_topics_set(subscriptions,
					     ARRAY_SIZE(subscriptions) -
						     (with_commands ? 0 : GUARDED_TOPICS));
	atomic_set(&attempt_refused, 0);

	/* Blocks until the broker has acknowledged the subscriptions, or fails. */
	err = aws_iot_connect(&aws_config);

	/* Counted before the flag goes: whoever sees the attempt over sees its error as well. */
	if (err) {
		stats_note_error(CLOUD_ERROR_CONNECT, err);
	}

	if (with_commands) {
		judge_commands_subscription(err);
	}

	atomic_set(&connecting, 0);

	if (err) {
		LOG_WRN("Connection to AWS IoT failed: %d", err);
		if (!atomic_get(&connected)) {
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
	}
}

static int build_topic(char *buf, const char *suffix)
{
	int written = snprintk(buf, TOPIC_MAX, "$aws/things/%s/jobs/%s", identity_thing_name(),
			       suffix);

	return (written < 0 || written >= TOPIC_MAX) ? -ENOSPC : 0;
}

static void subscribe_to(size_t index, const char *topic)
{
	subscriptions[index].topic.utf8 = (const uint8_t *)topic;
	subscriptions[index].topic.size = strlen(topic);
	subscriptions[index].qos = MQTT_QOS_1_AT_LEAST_ONCE;
}

int cloud_init(void)
{
	int written;
	int err;

	err = build_topic(topic_notify_next, "notify-next");
	err = err ? err : build_topic(topic_get_accepted, "$next/get/accepted");
	err = err ? err : build_topic(topic_get_rejected, "$next/get/rejected");
	err = err ? err : build_topic(topic_update_accepted, "+/update/accepted");
	err = err ? err : build_topic(topic_update_rejected, "+/update/rejected");
	err = err ? err : build_topic(topic_get_next, "$next/get");
#if defined(CONFIG_APP_PI_OTA)
	err = err ? err : build_topic(topic_get_list, "get");
	err = err ? err : build_topic(topic_list_accepted, "get/accepted");
#endif
	if (err) {
		return err;
	}

	written = snprintk(topic_events, sizeof(topic_events), "cranium/%s/events",
			   identity_thing_name());
	if (written < 0 || written >= (int)sizeof(topic_events)) {
		return -ENOSPC;
	}

	written = snprintk(topic_commands, sizeof(topic_commands), "cranium/%s/commands",
			   identity_thing_name());
	if (written < 0 || written >= (int)sizeof(topic_commands)) {
		return -ENOSPC;
	}

	written = snprintk(topic_location, sizeof(topic_location), "cranium/%s/location",
			   identity_thing_name());
	if (written < 0 || written >= (int)sizeof(topic_location)) {
		return -ENOSPC;
	}

#if defined(CONFIG_APP_MEMFAULT)
	written = snprintk(topic_memfault, sizeof(topic_memfault), "cranium/%s/memfault",
			   identity_thing_name());
	if (written < 0 || written >= (int)sizeof(topic_memfault)) {
		return -ENOSPC;
	}
#endif

	for (size_t i = 0; i < ARRAY_SIZE(subscribed); i++) {
		subscribe_to(i, subscribed[i]);
	}
	atomic_set(&topics_ready, 1);

	err = aws_iot_init(on_aws_iot_event);
	if (err) {
		LOG_ERR("AWS IoT library could not be initialised: %d", err);
		return err;
	}

	err = aws_iot_application_topics_set(subscriptions, ARRAY_SIZE(subscriptions));
	if (err) {
		return err;
	}

	k_work_queue_init(&connect_queue);
	k_work_queue_start(&connect_queue, connect_stack, K_THREAD_STACK_SIZEOF(connect_stack),
			   CONNECT_PRIORITY, NULL);
	k_work_init(&connect_work, connect_work_handler);
	return 0;
}

void cloud_connect(void)
{
	const struct identity_settings *config = identity_settings_get();

	if (config == NULL || atomic_get(&connected) || !atomic_cas(&connecting, 0, 1)) {
		return;
	}

	strcpy(connect_host, config->endpoint);
	strcpy(connect_url_prefix, config->download_url_prefix);
	(void)k_work_submit_to_queue(&connect_queue, &connect_work);
}

void cloud_disconnect(void)
{
	if (atomic_get(&connected)) {
		(void)aws_iot_disconnect();
	}
}

bool cloud_is_connected(void)
{
	return atomic_get(&connected) != 0;
}

bool cloud_is_connecting(void)
{
	return atomic_get(&connecting) != 0;
}

void cloud_stats_get(struct cloud_stats *out)
{
	/* The flags first: what they say happened was counted before they were set. */
	bool up = atomic_get(&connected) != 0;
	bool trying = atomic_get(&connecting) != 0;
	k_spinlock_key_t key = k_spin_lock(&stats_lock);

	*out = connection_stats;
	k_spin_unlock(&stats_lock, key);

	out->state = up ? CLOUD_STATE_CONNECTED : trying ? CLOUD_STATE_CONNECTING : CLOUD_STATE_IDLE;
	if (!up) {
		out->connected_at_ms = -1;
	}
}

const char *cloud_subscription(size_t index)
{
	size_t count = ARRAY_SIZE(subscribed) - (atomic_get(&commands_off) ? GUARDED_TOPICS : 0);

	if (!atomic_get(&topics_ready) || index >= count) {
		return NULL;
	}

	return subscribed[index];
}

bool cloud_commands_given_up(void)
{
	return atomic_get(&commands_off) != 0;
}

/* message_id 0 lets the library pick one. */
static int publish_bytes(enum mqtt_qos qos, const char *topic,
			 enum aws_iot_shadow_topic_type shadow_topic, const void *payload, size_t len,
			 uint16_t message_id)
{
	struct aws_iot_data message = {
		.qos = qos,
		.message_id = message_id,
		.topic.type = shadow_topic,
		.topic.str = topic,
		.topic.len = topic ? strlen(topic) : 0,
		.ptr = (char *)payload,
		.len = len,
	};
	k_spinlock_key_t key;
	int err;

	if (!atomic_get(&connected)) {
		return -ENOTCONN;
	}

	err = aws_iot_send(&message);
	if (err == 0) {
		int64_t now = k_uptime_get();

		key = k_spin_lock(&stats_lock);
		connection_stats.published++;
		connection_stats.last_publish_ms = now;
		k_spin_unlock(&stats_lock, key);
	}

	return err;
}

static int publish_at(enum mqtt_qos qos, const char *topic,
		      enum aws_iot_shadow_topic_type shadow_topic, const char *payload)
{
	return publish_bytes(qos, topic, shadow_topic, payload, strlen(payload), 0);
}

static int publish(const char *topic, enum aws_iot_shadow_topic_type shadow_topic,
		   const char *payload)
{
	return publish_at(MQTT_QOS_1_AT_LEAST_ONCE, topic, shadow_topic, payload);
}

/* With message_id 0, the library picks one. */
static int shadow_report(const char *reported_json, uint16_t message_id)
{
	static char document[SHADOW_MAX];
	int written = snprintk(document, sizeof(document), "{\"state\":{\"reported\":%s}}",
			       reported_json);

	if (written < 0 || written >= (int)sizeof(document)) {
		return -ENOSPC;
	}

	written = publish_bytes(MQTT_QOS_1_AT_LEAST_ONCE, NULL, AWS_IOT_SHADOW_TOPIC_UPDATE, document,
				strlen(document), message_id);
	/* Memfault's sync success rate: the reports that got out, and those that did not. */
	mflt_note_report(written == 0);
	return written;
}

int cloud_shadow_report(const char *reported_json)
{
	return shadow_report(reported_json, 0);
}

int cloud_shadow_report_acked(const char *reported_json, int32_t wait_ms)
{
	/* The library's own counter, so that the ID is none that it has in flight. */
	uint16_t id = mqtt_helper_msg_id_get();
	int err;

	/* A PUBACK that came after an earlier wait gave up is not this one's. */
	atomic_set(&awaited_ack, 0);
	(void)k_sem_take(&ack_arrived, K_NO_WAIT);
	atomic_set(&awaited_ack, (atomic_val_t)id + 1);

	err = shadow_report(reported_json, id);
	if (err == 0 && k_sem_take(&ack_arrived, K_MSEC(wait_ms)) != 0) {
		err = -ETIMEDOUT;
	}

	atomic_set(&awaited_ack, 0);
	return err;
}

/* QoS 0: nothing here would send it again, and the shadow is what the board's state is kept in. */
int cloud_event_publish(const char *json)
{
	if (topic_events[0] == '\0') {
		return -ENOTCONN;
	}

	return publish_at(MQTT_QOS_0_AT_MOST_ONCE, topic_events, AWS_IOT_SHADOW_TOPIC_NONE, json);
}

/* QoS 0, as the events: a location that did not get there is no use later. */
int cloud_location_publish(const char *json)
{
	if (topic_location[0] == '\0') {
		return -ENOTCONN;
	}

	return publish_at(MQTT_QOS_0_AT_MOST_ONCE, topic_location, AWS_IOT_SHADOW_TOPIC_NONE, json);
}

#if defined(CONFIG_APP_MEMFAULT)
/* QoS 0: src/mflt/mflt_link.c waits for the cloud's own answer, and sends again without one. */
int cloud_memfault_publish(const uint8_t *frame, size_t len)
{
	if (topic_memfault[0] == '\0') {
		return -ENOTCONN;
	}

	return publish_bytes(MQTT_QOS_0_AT_MOST_ONCE, topic_memfault, AWS_IOT_SHADOW_TOPIC_NONE,
			     frame, len, 0);
}
#endif

int cloud_jobs_request_next(void)
{
	return publish(topic_get_next, AWS_IOT_SHADOW_TOPIC_NONE, "{}");
}

void cloud_jobs_set_part(enum ota_job_part part)
{
	atomic_set(&job_part, (atomic_val_t)part);
}

#if defined(CONFIG_APP_PI_OTA)
int cloud_jobs_request_list(void)
{
	if (!cloud_jobs_list_available()) {
		return -ENOTSUP;
	}

	return publish(topic_get_list, AWS_IOT_SHADOW_TOPIC_NONE, "{}");
}

bool cloud_jobs_list_available(void)
{
	return !atomic_get(&commands_off);
}
#endif

int cloud_jobs_update(const char *job_id, const char *body_json)
{
	char topic[TOPIC_MAX];
	int written = snprintk(topic, sizeof(topic), "$aws/things/%s/jobs/%s/update",
			       identity_thing_name(), job_id);

	if (written < 0 || written >= (int)sizeof(topic)) {
		return -ENOSPC;
	}

	return publish(topic, AWS_IOT_SHADOW_TOPIC_NONE, body_json);
}

bool cloud_job_message_get(enum cloud_job_message *kind, enum ota_job_result *result,
			   const struct ota_job **job)
{
	if (!atomic_get(&job_busy)) {
		return false;
	}

	*kind = job_kind;
	*result = job_result;
	*job = &job_read;
	return true;
}

bool cloud_job_message_done(void)
{
	atomic_set(&job_busy, 0);
	return atomic_set(&job_overrun, 0) != 0;
}
