/*
 * Commissioning a Matter-over-Thread device onto this board's Thread network, as far as this library goes today:
 *   1. Bluetooth: find the device by discriminator, connect, BTP handshake.
 *   2. PASE: PBKDF parameters, SPAKE2+ with the setup passcode, the PASE session keys.
 *   3. Over the PASE session: ArmFailSafe, SetRegulatoryConfig, AddOrUpdateThreadNetwork with this board's
 *      dataset, ConnectNetwork: the device joins the board's Thread network.
 * Still to come (docs/matter-thread.md): device attestation, the fabric's certificates (CSR, AddTrustedRoot,
 * AddNOC), CASE over Thread and CommissioningComplete. Until then the device leaves again when its fail-safe
 * expires.
 */
#ifndef MT_COMMISSION_H_
#define MT_COMMISSION_H_

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum mt_stage {
	MT_STAGE_IDLE,
	MT_STAGE_SCANNING,
	MT_STAGE_BTP,
	MT_STAGE_PASE,
	MT_STAGE_ARM_FAIL_SAFE,
	MT_STAGE_REGULATORY,
	MT_STAGE_THREAD_NETWORK,
	MT_STAGE_CONNECT_NETWORK,
	MT_STAGE_ON_THREAD, /* the furthest this version goes */
	MT_STAGE_FAILED,
};

/*
 * Starts commissioning with a setup code: an 11- or 21-digit manual code. The code is checked before anything
 * starts (src/policy/matter_policy.c). 0, -EINVAL for a bad code, -EBUSY while another is running.
 */
int mt_commission_start(const char *setup_code, uint16_t fail_safe_s);
enum mt_stage mt_commission_stage(void);
const char *mt_stage_name(enum mt_stage stage);
void mt_commission_cancel(void);

#ifdef __cplusplus
}
#endif

#endif /* MT_COMMISSION_H_ */
