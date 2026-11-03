/*
 * Host-side tests of cloud.c: what it counts about the MQTT connection for the console's MQTT
 * command, and the topics that it subscribes to and lists. The real file is compiled here, against
 * a fake of the AWS IoT library that answers each call as the test says and sends the events the
 * library sends. The connection's work runs when a test runs it, as the connection thread would.
 *
 * What the broker does, and the library's own threads, are for a board: see firmware/README.md.
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

	/* The connection thread. */
	k_work_handler_t work;
	int submitted;

	/* The main loop. */
	int ups;
	int downs;
	int job_messages;
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

const struct identity_settings *identity_settings_get(void)
{
	return &settings;
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
	return lib.send_result;
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
	CHECK(now_stats().published == 4);
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
	CHECK(stats.errors == 3 && stats.connects == 2 && stats.received == 2);
}

int main(void)
{
	test_before_anything_happened();
	test_the_topics_listed_are_the_ones_subscribed_to();
	test_a_connection_is_counted_as_it_happens();
	test_messages_in_and_out();
	test_an_event_goes_to_the_events_topic();
	test_a_connection_that_ends();
	test_errors_say_where_they_came_from();

	printf("%d cloud checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
