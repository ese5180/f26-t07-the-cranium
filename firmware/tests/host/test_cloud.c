/*
 * Host-side tests of cloud.c: what it counts about the MQTT connection for the console's MQTT
 * command, the topics that it subscribes to and lists, where a command and a location go, and the
 * guard that gives up on the commands topic. The real file is compiled here, against
 * a fake of the AWS IoT library that answers each call as the test says and sends the events the
 * library sends. The connection's work runs when a test runs it, as the connection thread would.
 *
 * What the broker does, and the library's own threads, are for a board: see firmware/README.md.
 *
 * Built with CONFIG_APP_MEMFAULT, against fakes of what src/mflt/mflt.h counts: from 1.14.0 a frame of
 * Memfault data goes to the board's own memfault topic, as bytes, and a jobs reply is read where it
 * arrives, so that the 4 KB copy of it is gone.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cloud.c"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

#define CHECK_TEXT(actual, expected)                                                         \
	do {                                                                                 \
		const char *actual_ = (actual);                                              \
		checks++;                                                                    \
		if (actual_ == NULL || strcmp(actual_, (expected)) != 0) {                   \
			failures++;                                                          \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_ != NULL ? actual_ : "(null)", (expected));            \
		}                                                                            \
	} while (0)

#define THING    "cranium-fe5b26c0c5b1dcd7"
#define ENDPOINT "example-ats.iot.us-east-1.amazonaws.com"

static struct {
	long long uptime_ms;

	/* The library. */
	aws_iot_evt_handler_t handler;
	const struct mqtt_topic *topics;
	size_t topic_count;
	int connect_result;
	/* aws_iot_connect() reports the connection before it returns, as the library does. */
	bool connect_comes_up;
	/* Or the broker's refusal of the CONNECT, as AWS_IOT_EVT_ERROR with this, 0 for none. */
	int connect_refused_with;
	/* How many topics the attempts subscribed to, the last one. */
	size_t topics_at_connect;
	char connect_host[IDENTITY_ENDPOINT_MAX];
	char connect_client[64];
	/* What the statistics said while aws_iot_connect() was running. */
	struct cloud_stats during_connect;
	int send_result;
	int sends;
	/* The last message the library was given. */
	char sent_topic[TOPIC_MAX];
	enum aws_iot_shadow_topic_type sent_shadow_topic;
	enum mqtt_qos sent_qos;
	char sent_payload[CLOUD_EVENTS_JSON_MAX];
	uint8_t sent_bytes[CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE];
	size_t sent_len;
	uint16_t sent_message_id;

	/* The MQTT helper's message IDs, and the PUBACK that the broker sends while the main loop waits. */
	uint16_t next_id;
	bool acks;
	uint16_t ack_id;
	int waits;
	int32_t waited_ms;

	/* The connection thread. */
	k_work_handler_t work;
	int submitted;

	/* The main loop. */
	int ups;
	int downs;
	int job_messages;

	/* command.c */
	int commands;
	char command[64];

	/* src/mflt/mflt.h */
	int connected_notes;
	int lost_notes;
	int reports_sent;
	int reports_failed;
} lib;

static struct identity_settings settings = { .endpoint = ENDPOINT,
					     .download_url_prefix = "https://b.example.com/fw/" };

/* ---- what cloud.c calls ------------------------------------------------------------- */

long long k_uptime_get(void)
{
	return lib.uptime_ms;
}

void k_work_init(struct k_work *work, k_work_handler_t handler)
{
	work->handler = handler;
	lib.work = handler;
}

void k_work_queue_init(struct k_work_q *queue)
{
	ARG_UNUSED(queue);
}

void k_work_queue_start(struct k_work_q *queue, char *stack, size_t size, int priority,
			const void *config)
{
	ARG_UNUSED(queue);
	ARG_UNUSED(stack);
	ARG_UNUSED(size);
	ARG_UNUSED(priority);
	ARG_UNUSED(config);
}

int k_work_submit_to_queue(struct k_work_q *queue, struct k_work *work)
{
	ARG_UNUSED(queue);
	ARG_UNUSED(work);
	lib.submitted++;
	return 1;
}

int app_event_post(const struct app_event *event)
{
	ARG_UNUSED(event);
	return 0;
}

int app_event_post_simple(enum app_event_type type)
{
	lib.ups += type == APP_EVENT_CLOUD_UP;
	lib.downs += type == APP_EVENT_CLOUD_DOWN;
	lib.job_messages += type == APP_EVENT_JOB_MESSAGE;
	return 0;
}

const char *identity_thing_name(void)
{
	return THING;
}

void command_received(const char *payload, size_t len)
{
	lib.commands++;
	snprintf(lib.command, sizeof(lib.command), "%.*s", (int)len, payload);
}

const struct identity_settings *identity_settings_get(void)
{
	return &settings;
}

void mflt_note_cloud_connected(void)
{
	lib.connected_notes++;
}

void mflt_note_cloud_lost(void)
{
	lib.lost_notes++;
}

void mflt_note_report(bool sent)
{
	lib.reports_sent += sent;
	lib.reports_failed += !sent;
}

static void library_event(enum aws_iot_evt_type type, int err)
{
	struct aws_iot_evt event = { .type = type };

	event.data.err = err;
	lib.handler(&event);
}

static void library_message(const char *topic, const char *payload)
{
	struct aws_iot_evt event = { .type = AWS_IOT_EVT_DATA_RECEIVED };

	event.data.msg.topic.str = topic;
	event.data.msg.topic.len = strlen(topic);
	event.data.msg.ptr = (char *)payload;
	event.data.msg.len = strlen(payload);
	lib.handler(&event);
}

int aws_iot_init(aws_iot_evt_handler_t event_handler)
{
	lib.handler = event_handler;
	return 0;
}

int aws_iot_application_topics_set(const struct mqtt_topic *const list, size_t count)
{
	lib.topics = list;
	lib.topic_count = count;
	return 0;
}

int aws_iot_connect(const struct aws_iot_config *const config)
{
	snprintf(lib.connect_host, sizeof(lib.connect_host), "%s", config->host_name);
	snprintf(lib.connect_client, sizeof(lib.connect_client), "%s", config->client_id);
	cloud_stats_get(&lib.during_connect);
	lib.topics_at_connect = lib.topic_count;

	if (lib.connect_refused_with != 0) {
		library_event(AWS_IOT_EVT_ERROR, lib.connect_refused_with);
	}

	if (lib.connect_result == 0 && lib.connect_comes_up) {
		library_event(AWS_IOT_EVT_CONNECTED, 0);
	}

	return lib.connect_result;
}

/* The library reports the end of a connection from inside the call, as mqtt_disconnect() does. */
int aws_iot_disconnect(void)
{
	library_event(AWS_IOT_EVT_DISCONNECTED, 0);
	return 0;
}

int aws_iot_send(const struct aws_iot_data *const tx_data)
{
	lib.sends++;
	snprintf(lib.sent_topic, sizeof(lib.sent_topic), "%.*s", (int)tx_data->topic.len,
		 tx_data->topic.str != NULL ? tx_data->topic.str : "");
	lib.sent_shadow_topic = tx_data->topic.type;
	lib.sent_qos = tx_data->qos;
	snprintf(lib.sent_payload, sizeof(lib.sent_payload), "%.*s", (int)tx_data->len, tx_data->ptr);
	lib.sent_len = tx_data->len;
	lib.sent_message_id = tx_data->message_id;
	CHECK(tx_data->len <= sizeof(lib.sent_bytes));
	memcpy(lib.sent_bytes, tx_data->ptr, MIN(tx_data->len, sizeof(lib.sent_bytes)));
	return lib.send_result;
}

uint16_t mqtt_helper_msg_id_get(void)
{
	return ++lib.next_id;
}

/* A wait that would block: the broker's PUBACK, if it sends one, comes on the MQTT thread meanwhile. */
int k_sem_take(struct k_sem *sem, k_timeout_t timeout)
{
	if (timeout != K_NO_WAIT) {
		lib.waits++;
		lib.waited_ms = timeout;
		if (lib.acks) {
			struct aws_iot_evt event = { .type = AWS_IOT_EVT_PUBACK };

			event.data.message_id = lib.ack_id != 0 ? lib.ack_id : lib.sent_message_id;
			lib.handler(&event);
		}
	}

	if (sem->count > 0) {
		sem->count--;
		return 0;
	}
	return -EAGAIN;
}

void k_sem_give(struct k_sem *sem)
{
	if (sem->count < 1) {
		sem->count++;
	}
}

/* ---- helpers ------------------------------------------------------------------------ */

static struct cloud_stats now_stats(void)
{
	struct cloud_stats out;

	cloud_stats_get(&out);
	return out;
}

/* An attempt, all the way through the connection thread. */
static void attempt(int result, bool comes_up)
{
	lib.connect_result = result;
	lib.connect_comes_up = comes_up;
	cloud_connect();
	lib.work(&connect_work);
}

/* ---- tests -------------------------------------------------------------------------- */

static void test_before_anything_happened(void)
{
	struct cloud_stats stats = now_stats();

	CHECK(stats.state == CLOUD_STATE_IDLE);
	CHECK(stats.connected_at_ms == -1);
	CHECK(stats.attempts == 0 && stats.connects == 0 && stats.disconnects == 0);
	CHECK(stats.errors == 0);
	CHECK(stats.last_error_source == CLOUD_ERROR_NONE);
	CHECK(stats.last_error_ms == -1);
	CHECK(stats.published == 0 && stats.received == 0);
	CHECK(stats.last_publish_ms == -1 && stats.last_receive_ms == -1);

	/* No topic exists before cloud_init(), and none is half written. */
	CHECK(cloud_subscription(0) == NULL);
}

static void test_the_topics_listed_are_the_ones_subscribed_to(void)
{
	static const char *const expected[] = {
		"$aws/things/" THING "/jobs/notify-next",
		"$aws/things/" THING "/jobs/$next/get/accepted",
		"$aws/things/" THING "/jobs/$next/get/rejected",
		"$aws/things/" THING "/jobs/+/update/accepted",
		"$aws/things/" THING "/jobs/+/update/rejected",
		"cranium/" THING "/commands",
	};

	CHECK(cloud_init() == 0);
	CHECK(lib.topic_count == ARRAY_SIZE(expected));

	for (size_t i = 0; i < ARRAY_SIZE(expected); i++) {
		CHECK_TEXT(cloud_subscription(i), expected[i]);
		CHECK(lib.topics[i].topic.size == strlen(expected[i]));
		CHECK(memcmp(lib.topics[i].topic.utf8, expected[i], strlen(expected[i])) == 0);
		CHECK(lib.topics[i].qos == MQTT_QOS_1_AT_LEAST_ONCE);
	}

	CHECK(cloud_subscription(ARRAY_SIZE(expected)) == NULL);
	CHECK(cloud_subscription((size_t)-1) == NULL);
	CHECK(!cloud_commands_given_up());

	/* The library takes eight at most in one SUBSCRIBE, and AWS IoT as many. */
	CHECK(ARRAY_SIZE(expected) <= 8);
	CHECK(strlen(topic_commands) == COMMANDS_TOPIC_LENGTH);
	/* Each jobs topic fills its buffer exactly: none is cut short, and none has room to spare. */
	CHECK(strlen(topic_notify_next) == sizeof(topic_notify_next) - 1);
	CHECK(strlen(topic_get_accepted) == sizeof(topic_get_accepted) - 1);
	CHECK(strlen(topic_get_rejected) == sizeof(topic_get_rejected) - 1);
	CHECK(strlen(topic_update_accepted) == sizeof(topic_update_accepted) - 1);
	CHECK(strlen(topic_update_rejected) == sizeof(topic_update_rejected) - 1);
	CHECK(strlen(topic_get_next) == sizeof(topic_get_next) - 1);
	CHECK_TEXT(topic_get_next, "$aws/things/" THING "/jobs/$next/get");
	CHECK(strlen(topic_events) == sizeof(topic_events) - 1);
}

static void test_a_connection_is_counted_as_it_happens(void)
{
	struct cloud_stats stats;

	lib.uptime_ms = 5000;
	lib.connect_result = 0;
	lib.connect_comes_up = true;
	cloud_connect();
	CHECK(lib.submitted == 1);

	/* Asked for, and not under way yet: it is connecting, and nothing was attempted so far. */
	stats = now_stats();
	CHECK(stats.state == CLOUD_STATE_CONNECTING);
	CHECK(stats.attempts == 0);

	/* A second request while one is running is not another attempt. */
	cloud_connect();
	CHECK(lib.submitted == 1);

	lib.uptime_ms = 6500;
	lib.work(&connect_work);

	/* While aws_iot_connect() ran, the attempt was counted and the board was connecting. */
	CHECK(lib.during_connect.state == CLOUD_STATE_CONNECTING);
	CHECK(lib.during_connect.attempts == 1);
	CHECK(lib.during_connect.connects == 0);

	/* With the stored endpoint, and the thing name as the client ID. */
	CHECK_TEXT(lib.connect_host, ENDPOINT);
	CHECK_TEXT(lib.connect_client, THING);

	stats = now_stats();
	CHECK(stats.state == CLOUD_STATE_CONNECTED);
	CHECK(stats.attempts == 1);
	CHECK(stats.connects == 1);
	CHECK(stats.connected_at_ms == 6500);
	CHECK(stats.errors == 0);
	CHECK(lib.ups == 1);
	CHECK(cloud_is_connected());
	CHECK(!cloud_is_connecting());

	/* Connected: nothing more is asked of the library. */
	cloud_connect();
	CHECK(lib.submitted == 1);
}

static void test_messages_in_and_out(void)
{
	struct cloud_stats stats;

	lib.uptime_ms = 7000;
	lib.send_result = 0;
	CHECK(cloud_shadow_report("{\"uptime\":7}") == 0);
	CHECK(cloud_jobs_request_next() == 0);
	stats = now_stats();
	CHECK(stats.published == 2);
	CHECK(stats.last_publish_ms == 7000);

	/* What the library does not take was not published. */
	lib.uptime_ms = 8000;
	lib.send_result = -EAGAIN;
	CHECK(cloud_jobs_update("job-1", "{}") == -EAGAIN);
	stats = now_stats();
	CHECK(stats.published == 2);
	CHECK(stats.last_publish_ms == 7000);
	lib.send_result = 0;

	/* What is too long for its document is not even tried. */
	{
		static char long_json[600];

		memset(long_json, 'x', sizeof(long_json) - 1);
		CHECK(cloud_shadow_report(long_json) == -ENOSPC);
		CHECK(now_stats().published == 2);
	}

	/* Every message that arrives is counted, whatever its topic. */
	lib.uptime_ms = 9000;
	library_message("$aws/things/" THING "/jobs/notify-next", "{}");
	CHECK(lib.job_messages == 1);
	cloud_job_message_done();
	lib.uptime_ms = 9500;
	library_message("$aws/things/" THING "/jobs/job-1/update/accepted", "{\"clientToken\":\"a1\"}");
	stats = now_stats();
	CHECK(stats.received == 2);
	CHECK(stats.last_receive_ms == 9500);
	CHECK(stats.published == 2);
}

/*
 * An event for the console goes to the board's own events topic, at QoS 0, and counts as published.
 * The longest one fits the MQTT buffer with that topic: see test_cloud_events.c for the longest.
 */
static void test_an_event_goes_to_the_events_topic(void)
{
	const char json[] = "{\"t\":1,\"seq\":1,\"boot\":1,\"up\":2,\"tag\":\"BT\",\"text\":\"a phone connected\"}";
	uint32_t published = now_stats().published;

	lib.uptime_ms = 9700;
	CHECK(cloud_event_publish(json) == 0);
	CHECK_TEXT(lib.sent_topic, "cranium/" THING "/events");
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_NONE);
	CHECK(lib.sent_qos == MQTT_QOS_0_AT_MOST_ONCE);
	CHECK_TEXT(lib.sent_payload, json);
	CHECK(now_stats().published == published + 1);
	CHECK(now_stats().last_publish_ms == 9700);

	/* Everything else still goes at QoS 1. */
	CHECK(cloud_shadow_report("{}") == 0);
	CHECK(lib.sent_qos == MQTT_QOS_1_AT_LEAST_ONCE);
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_UPDATE);

	/* The topic is no subscription: nothing comes back on it. */
	for (size_t i = 0; cloud_subscription(i) != NULL; i++) {
		CHECK(strstr(cloud_subscription(i), "/events") == NULL);
	}

	/* What cloud.c asserts at build time, with the topic it made. */
	CHECK(strlen(topic_events) == EVENTS_TOPIC_LENGTH);
	CHECK(PUBLISH_QOS0_HEADER + strlen(topic_events) + CLOUD_EVENTS_JSON_MAX - 1 <=
	      CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE);
}

/* A command goes to command.c as it came, from its own topic and from no other. */
static void test_a_command_goes_to_command_c(void)
{
	static const char json[] = "{\"id\":\"3f9c2a1b7d4e6f80\",\"cmd\":\"identify\"}";
	int jobs = lib.job_messages;

	library_message("cranium/" THING "/commands", json);
	CHECK(lib.commands == 1);
	CHECK_TEXT(lib.command, json);

	/* Another board's, a topic that only ends the same way, and the jobs topics are not commands. */
	library_message("cranium/cranium-0000000000000000/commands", json);
	library_message("cranium/" THING "/commands/x", json);
	library_message("x/cranium/" THING "/commands", json);
	library_message("$aws/things/" THING "/jobs/commands", json);
	library_message("cranium/" THING "/command", json);
	CHECK(lib.commands == 1);
	CHECK(lib.job_messages == jobs);
}

/* A location goes to the board's own location topic, at QoS 0, and its longest fits the buffer. */
static void test_a_location_goes_to_the_location_topic(void)
{
	const char json[] = "{\"aps\":[{\"mac\":\"a4:2b:b0:12:34:56\",\"rss\":-51},"
			    "{\"mac\":\"f0:9f:c2:65:43:21\",\"rss\":-70}],\"boot\":42,\"t\":61234}";
	uint32_t published = now_stats().published;

	lib.uptime_ms = 9800;
	CHECK(cloud_location_publish(json) == 0);
	CHECK_TEXT(lib.sent_topic, "cranium/" THING "/location");
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_NONE);
	CHECK(lib.sent_qos == MQTT_QOS_0_AT_MOST_ONCE);
	CHECK_TEXT(lib.sent_payload, json);
	CHECK(now_stats().published == published + 1);

	/* What the library does not take was not published. */
	lib.send_result = -EAGAIN;
	CHECK(cloud_location_publish(json) == -EAGAIN);
	CHECK(now_stats().published == published + 1);
	lib.send_result = 0;

	/* The topic is no subscription. */
	for (size_t i = 0; cloud_subscription(i) != NULL; i++) {
		CHECK(strstr(cloud_subscription(i), "/location") == NULL);
	}

	/* What cloud.c asserts at build time, with the topic it made. */
	CHECK(strlen(topic_location) == LOCATION_TOPIC_LENGTH);
	CHECK(PUBLISH_QOS0_HEADER + strlen(topic_location) + LOCATION_JSON_MAX - 1 <=
	      CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE);
}

static void test_a_connection_that_ends(void)
{
	struct cloud_stats stats;

	lib.uptime_ms = 10000;
	cloud_disconnect();

	stats = now_stats();
	CHECK(stats.state == CLOUD_STATE_IDLE);
	CHECK(stats.disconnects == 1);
	CHECK(stats.connected_at_ms == -1);
	CHECK(stats.errors == 0);
	CHECK(lib.downs == 1);

	/* Nothing more is said of a connection that is not there. */
	library_event(AWS_IOT_EVT_DISCONNECTED, 0);
	CHECK(now_stats().disconnects == 1);
	CHECK(lib.downs == 1);

	/* Not connected: nothing goes out, and nothing is counted. */
	CHECK(cloud_shadow_report("{}") == -ENOTCONN);
	CHECK(cloud_event_publish("{}") == -ENOTCONN);
	CHECK(cloud_location_publish("{}") == -ENOTCONN);
	CHECK(now_stats().published == 5);
}

static void test_errors_say_where_they_came_from(void)
{
	struct cloud_stats stats;

	/* An attempt that fails: no connection, an error, and the main loop hears of it. */
	lib.uptime_ms = 20000;
	attempt(-EAGAIN, false);
	stats = now_stats();
	CHECK(stats.state == CLOUD_STATE_IDLE);
	CHECK(stats.attempts == 2);
	CHECK(stats.connects == 1);
	CHECK(stats.errors == 1);
	CHECK(stats.last_error_source == CLOUD_ERROR_CONNECT);
	CHECK(stats.last_error == -EAGAIN);
	CHECK(stats.last_error_ms == 20000);
	CHECK(stats.disconnects == 1);
	CHECK(lib.downs == 2);

	/* Up again, and then the broker refuses: the library's error ends the connection. */
	lib.uptime_ms = 30000;
	attempt(0, true);
	CHECK(now_stats().connected_at_ms == 30000);
	lib.uptime_ms = 31000;
	library_event(AWS_IOT_EVT_ERROR, 5);
	stats = now_stats();
	CHECK(stats.state == CLOUD_STATE_IDLE);
	CHECK(stats.attempts == 3);
	CHECK(stats.connects == 2);
	CHECK(stats.errors == 2);
	CHECK(stats.last_error_source == CLOUD_ERROR_LIBRARY);
	CHECK(stats.last_error == 5);
	CHECK(stats.last_error_ms == 31000);
	CHECK(stats.disconnects == 2);
	CHECK(lib.downs == 3);

	/* An error with no connection is an error, and no disconnect. */
	library_event(AWS_IOT_EVT_ERROR, -ENOMEM);
	stats = now_stats();
	CHECK(stats.errors == 3);
	CHECK(stats.last_error == -ENOMEM);
	CHECK(stats.disconnects == 2);
	CHECK(lib.downs == 3);

	/* What the other events are is no business of these numbers. */
	library_event(AWS_IOT_EVT_PINGRESP, 0);
	library_event(AWS_IOT_EVT_PUBACK, 0);
	library_event(AWS_IOT_EVT_CONNECTING, 0);
	stats = now_stats();
	CHECK(stats.errors == 3 && stats.connects == 2 && stats.received == 2 + 6);
}

/*
 * A cloud whose device policy ends a connection on the commands subscription. The attempt waits
 * for the SUBACK, and the library gives up on it with -EAGAIN. Twice of those, and the board
 * connects without the commands topic until a restart, so that updates go on. Last: it stays so.
 */
static void test_a_cloud_that_ends_the_connection_on_the_commands_subscription(void)
{
	/* A refusal of the CONNECT says nothing about the subscription, nor does DNS or TLS. */
	lib.connect_refused_with = 5;
	attempt(-EAGAIN, false);
	attempt(-EAGAIN, false);
	lib.connect_refused_with = 0;
	attempt(-ECONNREFUSED, false);
	attempt(-ETIMEDOUT, false);
	attempt(-EAGAIN, false);
	CHECK(lib.topics_at_connect == 6);
	CHECK(!cloud_commands_given_up());

	/* A connection with the subscription is proof: the count starts again. */
	attempt(0, true);
	CHECK(cloud_is_connected());
	cloud_disconnect();
	attempt(-EAGAIN, false);
	CHECK(!cloud_commands_given_up());
	CHECK(lib.topics_at_connect == 6);

	/* The second in a row: given up, and the next attempt has the jobs topics alone. */
	attempt(-EAGAIN, false);
	CHECK(cloud_commands_given_up());
	CHECK(cloud_subscription(4) != NULL);
	CHECK(cloud_subscription(5) == NULL);
	attempt(0, true);
	CHECK(lib.topics_at_connect == 5);
	for (size_t i = 0; i < lib.topics_at_connect; i++) {
		CHECK(strstr((const char *)lib.topics[i].topic.utf8, "/jobs/") != NULL);
	}
	CHECK(cloud_is_connected());

	/* Until a restart: a good connection does not bring it back, nor do more failures change it. */
	cloud_disconnect();
	attempt(-EAGAIN, false);
	attempt(0, true);
	CHECK(lib.topics_at_connect == 5);
	CHECK(cloud_commands_given_up());
}

/* A frame of Memfault data: bytes, zeros and all, to the board's own topic, at QoS 0. */
static void test_a_memfault_frame_goes_to_the_memfault_topic(void)
{
	static const uint8_t frame[] = { 1, 0x12, 0x34, 0x00, 0x08, 0x02, 0x00, 0xa7, 0xff };
	uint32_t published = now_stats().published;

	lib.uptime_ms = 11000;
	CHECK(cloud_memfault_publish(frame, sizeof(frame)) == 0);
	CHECK_TEXT(lib.sent_topic, "cranium/" THING "/memfault");
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_NONE);
	CHECK(lib.sent_qos == MQTT_QOS_0_AT_MOST_ONCE);
	CHECK(lib.sent_len == sizeof(frame));
	CHECK(memcmp(lib.sent_bytes, frame, sizeof(frame)) == 0);
	CHECK(now_stats().published == published + 1);

	/* What the library does not take was not published, and src/mflt/mflt_link.c holds the frame. */
	lib.send_result = -EAGAIN;
	CHECK(cloud_memfault_publish(frame, sizeof(frame)) == -EAGAIN);
	CHECK(now_stats().published == published + 1);
	lib.send_result = 0;

	/* The topic is no subscription: the answers come on the commands topic. */
	for (size_t i = 0; cloud_subscription(i) != NULL; i++) {
		CHECK(strstr(cloud_subscription(i), "/memfault") == NULL);
	}

	/* What cloud.c asserts at build time, with the topic it made, for the largest chunk. */
	CHECK(strlen(topic_memfault) == MEMFAULT_TOPIC_LENGTH);
	CHECK(PUBLISH_QOS0_HEADER + strlen(topic_memfault) + MFLT_LINK_HEADER + MFLT_LINK_CHUNK_LIMIT <=
	      CONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE);
}

/* What Memfault is told of the connection and of the shadow reports. */
static void test_memfault_hears_of_the_connection_and_the_reports(void)
{
	int connected = lib.connected_notes;
	int lost = lib.lost_notes;

	library_event(AWS_IOT_EVT_CONNECTED, 0);
	CHECK(lib.connected_notes == connected + 1);
	library_event(AWS_IOT_EVT_DISCONNECTED, 0);
	CHECK(lib.lost_notes == lost + 1);
	/* A second word that it is down is not a second loss. */
	library_event(AWS_IOT_EVT_DISCONNECTED, 0);
	library_event(AWS_IOT_EVT_ERROR, -ECONNRESET);
	CHECK(lib.lost_notes == lost + 1);
	library_event(AWS_IOT_EVT_CONNECTED, 0);
	library_event(AWS_IOT_EVT_ERROR, -ECONNRESET);
	CHECK(lib.lost_notes == lost + 2);

	library_event(AWS_IOT_EVT_CONNECTED, 0);
	lib.reports_sent = 0;
	lib.reports_failed = 0;
	CHECK(cloud_shadow_report("{\"uptime\":1}") == 0);
	lib.send_result = -EAGAIN;
	CHECK(cloud_shadow_report("{\"uptime\":2}") == -EAGAIN);
	lib.send_result = 0;
	CHECK(lib.reports_sent == 1 && lib.reports_failed == 1);
	/* An event or a location is no report. */
	CHECK(cloud_event_publish("{}") == 0);
	CHECK(cloud_location_publish("{}") == 0);
	CHECK(lib.reports_sent == 1 && lib.reports_failed == 1);
}

/* A session message goes to the board's own session topic, at QoS 0, and the longest fits the buffer. */
static void test_a_session_goes_to_the_session_topic(void)
{
	const char json[] = "{\"v\":1,\"type\":\"now\",\"playing\":false}";
	uint32_t published = now_stats().published;

	CHECK(cloud_session_publish(json) == 0);
	CHECK_TEXT(lib.sent_topic, "cranium/" THING "/session");
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_NONE);
	CHECK(lib.sent_qos == MQTT_QOS_0_AT_MOST_ONCE);
	CHECK_TEXT(lib.sent_payload, json);
	CHECK(now_stats().published == published + 1);

	lib.send_result = -EAGAIN;
	CHECK(cloud_session_publish(json) == -EAGAIN);
	lib.send_result = 0;

	for (size_t i = 0; cloud_subscription(i) != NULL; i++) {
		CHECK(strstr(cloud_subscription(i), "/session") == NULL);
	}
}

#define JOB_REPLY(url)                                                                             \
	"{\"clientToken\":\"x\",\"timestamp\":1760137000,\"execution\":{\"jobId\":\"job-7\","     \
	"\"status\":\"QUEUED\",\"queuedAt\":1760136000,\"versionNumber\":1,\"executionNumber\":1,"   \
	"\"jobDocument\":{\"op\":\"fw_update\",\"v\":1,\"fw\":{\"version\":\"9.1.0\",\"size\":1000,"   \
	"\"sha256\":\"00000000000000000000000000000000000000000000000000000000000000ff\","            \
	"\"url\":\"" url "\"}}}}"

/*
 * A reply to a request for the next job is read where it arrives, on the library's thread, with the
 * prefix that the connection was made with, and the main loop gets what came of it.
 */
static void test_a_jobs_reply_is_read_where_it_arrives(void)
{
	enum cloud_job_message kind;
	enum ota_job_result result;
	const struct ota_job *job;
	char reply[] = JOB_REPLY("https://b.example.com/fw/9.1.0.bin?X-Amz-Signature=ab");

	/* The prefix is the connection's own copy: a change on the main loop waits for the next one. */
	CHECK_TEXT(connect_url_prefix, "https://b.example.com/fw/");
	strcpy(settings.download_url_prefix, "https://elsewhere.example.com/fw/");

	CHECK(!cloud_job_message_get(&kind, &result, &job));
	library_message("$aws/things/" THING "/jobs/$next/get/accepted", reply);
	/* The library's buffer is gone once the callback returns: nothing may point into it. */
	memset(reply, 'x', sizeof(reply) - 1);
	CHECK(cloud_job_message_get(&kind, &result, &job));
	CHECK(kind == CLOUD_JOB_GET_ACCEPTED);
	CHECK(result == OTA_JOB_OK);
	CHECK_TEXT(job->id, "job-7");
	CHECK(!job->in_progress);
	CHECK(job->version.major == 9 && job->version.minor == 1 && job->size == 1000);
	CHECK_TEXT(job->host, "https://b.example.com");
	CHECK_TEXT(job->file, "fw/9.1.0.bin?X-Amz-Signature=ab");
	CHECK(job->sha256[31] == 0xff);

	/* Another while the main loop has that one: dropped, and the main loop is told to ask again. */
	library_message("$aws/things/" THING "/jobs/$next/get/accepted",
			JOB_REPLY("https://b.example.com/fw/other.bin"));
	CHECK(cloud_job_message_get(&kind, &result, &job));
	CHECK_TEXT(job->file, "fw/9.1.0.bin?X-Amz-Signature=ab");
	CHECK(cloud_job_message_done());
	CHECK(!cloud_job_message_get(&kind, &result, &job));

	/* A URL under another prefix: refused by its id, as the main loop would have. */
	library_message("$aws/things/" THING "/jobs/$next/get/accepted",
			JOB_REPLY("https://elsewhere.example.com/fw/9.1.0.bin"));
	CHECK(cloud_job_message_get(&kind, &result, &job));
	CHECK(result == OTA_JOB_URL_NOT_ALLOWED);
	CHECK_TEXT(job->id, "job-7");
	CHECK(job->host[0] == '\0' && job->file[0] == '\0');
	CHECK(!cloud_job_message_done());

	/* Nothing pending, the other kinds, and what is not JSON. */
	library_message("$aws/things/" THING "/jobs/$next/get/accepted", "{\"clientToken\":\"x\"}");
	CHECK(cloud_job_message_get(&kind, &result, &job) && result == OTA_JOB_NONE);
	CHECK(!cloud_job_message_done());
	library_message("$aws/things/" THING "/jobs/notify-next", "{\"execution\":{\"jobId\":\"job-7\"}}");
	CHECK(cloud_job_message_get(&kind, &result, &job));
	CHECK(kind == CLOUD_JOB_NOTIFY_NEXT && result == OTA_JOB_NONE && job->id[0] == '\0');
	CHECK(!cloud_job_message_done());
	library_message("$aws/things/" THING "/jobs/$next/get/rejected", "{\"code\":\"InternalError\"}");
	CHECK(cloud_job_message_get(&kind, &result, &job));
	CHECK(kind == CLOUD_JOB_GET_REJECTED && result == OTA_JOB_NONE);
	CHECK(!cloud_job_message_done());
	library_message("$aws/things/" THING "/jobs/$next/get/accepted", "{\"execution\":");
	CHECK(cloud_job_message_get(&kind, &result, &job) && result == OTA_JOB_MALFORMED);
	CHECK(!cloud_job_message_done());

	strcpy(settings.download_url_prefix, "https://b.example.com/fw/");
}

/*
 * From 1.14.0, the last report before a restart: its own message ID, from the helper's counter, at
 * QoS 1 to the shadow, and a wait that only the PUBACK with that ID ends.
 */
static void test_a_report_waits_for_its_own_acknowledgement(void)
{
	struct aws_iot_evt late = { .type = AWS_IOT_EVT_PUBACK };
	int waits;

	if (!cloud_is_connected()) {
		attempt(0, true);
	}
	lib.send_result = 0;
	lib.waits = 0;

	lib.acks = true;
	lib.ack_id = 0;
	CHECK(cloud_shadow_report_acked("{\"ota\":{\"state\":\"rebooting\"}}", 2000) == 0);
	CHECK(lib.sent_shadow_topic == AWS_IOT_SHADOW_TOPIC_UPDATE);
	CHECK(lib.sent_qos == MQTT_QOS_1_AT_LEAST_ONCE);
	CHECK(lib.sent_message_id != 0 && lib.sent_message_id == lib.next_id);
	CHECK(lib.waits == 1);
	CHECK(lib.waited_ms == 2000);
	CHECK_TEXT(lib.sent_payload, "{\"state\":{\"reported\":{\"ota\":{\"state\":\"rebooting\"}}}}");

	/* Another message's PUBACK does not end it. */
	lib.ack_id = (uint16_t)(lib.next_id + 7);
	CHECK(cloud_shadow_report_acked("{}", 2000) == -ETIMEDOUT);
	CHECK(lib.waits == 2);

	/* No answer at all, and that one's PUBACK comes too late to end the next wait. */
	lib.acks = false;
	CHECK(cloud_shadow_report_acked("{}", 2000) == -ETIMEDOUT);
	late.data.message_id = lib.sent_message_id;
	lib.handler(&late);
	CHECK(cloud_shadow_report_acked("{}", 2000) == -ETIMEDOUT);

	/* What could not be sent is not waited for. */
	waits = lib.waits;
	lib.send_result = -EAGAIN;
	CHECK(cloud_shadow_report_acked("{}", 2000) == -EAGAIN);
	CHECK(lib.waits == waits);
	lib.send_result = 0;

	/* A report that does not wait leaves the ID to the library, as before. */
	CHECK(cloud_shadow_report("{}") == 0);
	CHECK(lib.sent_message_id == 0);
	CHECK(lib.waits == waits);
}

int main(void)
{
	test_before_anything_happened();
	test_the_topics_listed_are_the_ones_subscribed_to();
	test_a_connection_is_counted_as_it_happens();
	test_messages_in_and_out();
	test_an_event_goes_to_the_events_topic();
	test_a_command_goes_to_command_c();
	test_a_location_goes_to_the_location_topic();
	test_a_connection_that_ends();
	test_errors_say_where_they_came_from();
	test_a_cloud_that_ends_the_connection_on_the_commands_subscription();
	test_a_memfault_frame_goes_to_the_memfault_topic();
	test_memfault_hears_of_the_connection_and_the_reports();
	test_a_jobs_reply_is_read_where_it_arrives();
	test_a_report_waits_for_its_own_acknowledgement();
	test_a_session_goes_to_the_session_topic();

	printf("%d cloud checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
