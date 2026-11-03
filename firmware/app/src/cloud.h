/*
 * Connection to AWS IoT Core: MQTT over TLS with mutual authentication.
 *
 * The device talks only to its own shadow and its own jobs topics, and from 1.12.0 publishes its
 * events to cranium/<thing name>/events. The endpoint and the client ID (the thing name) are
 * provisioned per device.
 */

#ifndef CLOUD_H_
#define CLOUD_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum cloud_state {
	CLOUD_STATE_IDLE,
	/* An attempt is running: aws_iot_connect() has not returned yet. */
	CLOUD_STATE_CONNECTING,
	CLOUD_STATE_CONNECTED,
};

/* Where the last error came from. The numbers mean different things in each. */
enum cloud_error_source {
	CLOUD_ERROR_NONE,
	/* aws_iot_connect() failed, with a negative errno, or a positive DNS error code. */
	CLOUD_ERROR_CONNECT,
	/* AWS_IOT_EVT_ERROR: the library closed a connection. 0 is a message too large for its
	 * buffer, 1 to 5 the broker's refusal in its CONNACK (5 is "not authorized", which is what
	 * a certificate or a policy that does not fit gets), and a negative number an errno.
	 */
	CLOUD_ERROR_LIBRARY,
};

/*
 * What the connection has done since the board started, for the console. Nothing in it is
 * secret. Times are uptimes in milliseconds, -1 for never.
 */
struct cloud_stats {
	enum cloud_state state;
	/* When the connection that is up now came up. -1 unless state is CLOUD_STATE_CONNECTED. */
	int64_t connected_at_ms;
	/* Calls of aws_iot_connect(). */
	uint32_t attempts;
	/* AWS_IOT_EVT_CONNECTED: connected, and every subscription acknowledged. */
	uint32_t connects;
	/* Connections that were up and ended, for whatever reason. */
	uint32_t disconnects;
	/* Failed attempts and AWS_IOT_EVT_ERROR, together. */
	uint32_t errors;
	enum cloud_error_source last_error_source;
	int last_error;
	int64_t last_error_ms;
	/* Messages that aws_iot_send() took, and messages that arrived on a subscription. */
	uint32_t published;
	uint32_t received;
	int64_t last_publish_ms;
	int64_t last_receive_ms;
};

enum cloud_job_message {
	/* The list of pending job executions changed. Carries no payload: the document
	 * is always fetched with cloud_jobs_request_next(), which also signs a fresh URL.
	 */
	CLOUD_JOB_NOTIFY_NEXT,
	/* Reply to cloud_jobs_request_next(). */
	CLOUD_JOB_GET_ACCEPTED,
	CLOUD_JOB_GET_REJECTED,
};

int cloud_init(void);

/* Start connecting in the background. APP_EVENT_CLOUD_UP or _DOWN follows. */
void cloud_connect(void);
void cloud_disconnect(void);
bool cloud_is_connected(void);

/* An attempt is running: APP_EVENT_CLOUD_UP or _DOWN is still to come. */
bool cloud_is_connecting(void);

/* A copy of the statistics, consistent in itself. From any thread. */
void cloud_stats_get(struct cloud_stats *out);

/*
 * The topics the board subscribes to at every connection, one by one from 0: NULL after the
 * last one, and before cloud_init(). The library adds none of its own here: no shadow topic
 * is subscribed to (CONFIG_AWS_IOT_TOPIC_*_SUBSCRIBE are all off). From any thread.
 */
const char *cloud_subscription(size_t index);

/* Publish the reported state. json is the object that goes under state.reported. */
int cloud_shadow_report(const char *reported_json);

/*
 * Publish one event for the console (src/cloud_events.h) to cranium/<thing name>/events, at QoS 0.
 * The device policy has to allow that topic: AWS IoT closes the connection of a board that publishes
 * where it may not.
 */
int cloud_event_publish(const char *json);

/* Ask for the next pending job execution, including a fresh job document. */
int cloud_jobs_request_next(void);

/*
 * Update a job execution. body_json is the complete request body. If it carries a
 * "clientToken" of one letter followed by a number, the reply arrives as
 * APP_EVENT_JOB_ACK with that letter and number.
 */
int cloud_jobs_update(const char *job_id, const char *body_json);

/*
 * Access to the jobs message announced by APP_EVENT_JOB_MESSAGE. The payload stays
 * valid until cloud_job_message_done(); messages that arrive in between are dropped,
 * which cloud_job_message_done() reports so that the caller can ask again.
 */
bool cloud_job_message_get(enum cloud_job_message *kind, const char **payload, size_t *len);
bool cloud_job_message_done(void);

#endif /* CLOUD_H_ */
