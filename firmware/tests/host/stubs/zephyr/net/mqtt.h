/* Host build: the little of Zephyr's MQTT header that cloud.c uses, with the same layout. */
#ifndef HOST_STUB_MQTT_H_
#define HOST_STUB_MQTT_H_

#include <stdint.h>

enum mqtt_qos {
	MQTT_QOS_0_AT_MOST_ONCE = 0x00,
	MQTT_QOS_1_AT_LEAST_ONCE = 0x01,
	MQTT_QOS_2_EXACTLY_ONCE = 0x02,
};

struct mqtt_utf8 {
	const uint8_t *utf8;
	uint32_t size;
};

struct mqtt_topic {
	struct mqtt_utf8 topic;
	uint8_t qos;
};

#endif
