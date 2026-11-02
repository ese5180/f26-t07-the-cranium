/*
 * Host build: the AWS IoT library of the nRF Connect SDK (v3.4.0), as far as cloud.c uses it. The
 * types have the library's names and members. The functions are only declared here: test_cloud.c
 * defines them, and decides what each call returns and which events follow.
 */
#ifndef HOST_STUB_AWS_IOT_H_
#define HOST_STUB_AWS_IOT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/net/mqtt.h>

enum aws_iot_shadow_topic_type {
	AWS_IOT_SHADOW_TOPIC_NONE,
	AWS_IOT_SHADOW_TOPIC_GET,
	AWS_IOT_SHADOW_TOPIC_UPDATE,
	AWS_IOT_SHADOW_TOPIC_DELETE,
};

enum aws_iot_evt_type {
	AWS_IOT_EVT_CONNECTING = 0x1,
	AWS_IOT_EVT_CONNECTED,
	AWS_IOT_EVT_DISCONNECTED,
	AWS_IOT_EVT_DATA_RECEIVED,
	AWS_IOT_EVT_PUBACK,
	AWS_IOT_EVT_PINGRESP,
	AWS_IOT_EVT_FOTA_START,
	AWS_IOT_EVT_FOTA_DONE,
	AWS_IOT_EVT_FOTA_ERASE_PENDING,
	AWS_IOT_EVT_FOTA_ERASE_DONE,
	AWS_IOT_EVT_FOTA_DL_PROGRESS,
	AWS_IOT_EVT_FOTA_ERROR,
	AWS_IOT_EVT_ERROR,
};

struct aws_iot_topic_data {
	enum aws_iot_shadow_topic_type type;
	const char *str;
	size_t len;
};

struct aws_iot_data {
	struct aws_iot_topic_data topic;
	char *ptr;
	size_t len;
	enum mqtt_qos qos;
	uint16_t message_id;
	uint8_t dup_flag;
	uint8_t retain_flag;
};

struct aws_iot_evt {
	enum aws_iot_evt_type type;
	union {
		struct aws_iot_data msg;
		int err;
		bool persistent_session;
		uint16_t message_id;
	} data;
};

typedef void (*aws_iot_evt_handler_t)(const struct aws_iot_evt *evt);

struct aws_iot_config {
	char *client_id;
	char *host_name;
	const char *if_name;
};

int aws_iot_init(aws_iot_evt_handler_t event_handler);
int aws_iot_connect(const struct aws_iot_config *const config);
int aws_iot_disconnect(void);
int aws_iot_send(const struct aws_iot_data *const tx_data);
int aws_iot_application_topics_set(const struct mqtt_topic *const list, size_t count);

#endif
