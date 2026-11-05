/*
 * Host build: the one function of the SDK's MQTT helper that cloud.c calls itself, for the message ID
 * of a report it waits for. test_cloud.c defines it.
 */
#ifndef HOST_STUB_MQTT_HELPER_H_
#define HOST_STUB_MQTT_HELPER_H_

#include <stdint.h>

uint16_t mqtt_helper_msg_id_get(void);

#endif
