/*
 * The Interaction Model server of this board as a Matter device on endpoint 0: Read, Write, Invoke and Timed
 * requests for the clusters a phone needs to commission it and update its firmware: Descriptor, Access Control,
 * Basic Information, OTA Software Update Requestor, General Commissioning, Network Commissioning (Wi-Fi on the
 * nRF7002 DK, Thread on the nRF5340 DK) and Operational Credentials. Subscriptions are refused.
 */
#ifndef MT_DEV_IM_H_
#define MT_DEV_IM_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct mt_dev_session {
	bool pase;                  /* the commissioning session (over Bluetooth) */
	const uint8_t *challenge;   /* its attestation challenge, 16 bytes */
	uint8_t fabric_index;       /* 0 on PASE before AddNOC */
};

/* What the board's platform does for the clusters (set by the board code, stubbed in host tests). */
struct mt_dev_platform {
	int (*wifi_add)(const uint8_t *ssid, size_t ssid_len, const uint8_t *pass, size_t pass_len);
	int (*wifi_connect)(void);
	int (*thread_add)(const uint8_t *dataset, size_t len);
	bool wifi; /* the Network Commissioning instance is Wi-Fi (else Thread) */
	uint32_t software_version;
	const char *software_version_string;
	void (*ota_announced)(uint64_t provider_node, uint16_t endpoint);
};

void mt_dev_im_set_platform(const struct mt_dev_platform *p);

/*
 * Handles one IM request (its opcode and body). Writes the response opcode and body and returns the body's
 * length; -1 when nothing is to be sent back.
 */
int mt_dev_im(const struct mt_dev_session *s, uint8_t opcode, const uint8_t *in, size_t len, uint8_t *out_opcode,
	      uint8_t *out, size_t cap);

#ifdef __cplusplus
}
#endif

#endif /* MT_DEV_IM_H_ */
