/*
 * Commissioning a Matter-over-Thread device onto this board's Thread network and fabric:
 *   1. Bluetooth: find the device by discriminator, connect, BTP handshake.
 *   2. PASE: PBKDF parameters, SPAKE2+ with the setup passcode, the PASE session keys.
 *   3. Over the PASE session: ArmFailSafe, SetRegulatoryConfig, the device's certificates and attestation
 *      (against the Matter test PAAs), its CSR, this fabric's root certificate and the device's NOC,
 *      AddOrUpdateThreadNetwork with this board's dataset, ConnectNetwork: the device joins the board's Thread
 *      network with its operational identity.
 *   4. Over Thread: CASE with the device's new identity, then CommissioningComplete. The device is kept in the
 *      fabric's node list.
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
	MT_STAGE_PAI_CERT,
	MT_STAGE_DAC_CERT,
	MT_STAGE_ATTESTATION,
	MT_STAGE_CSR,
	MT_STAGE_ROOT_CERT,
	MT_STAGE_ADD_NOC,
	MT_STAGE_THREAD_NETWORK,
	MT_STAGE_CONNECT_NETWORK,
	MT_STAGE_CASE,      /* on Thread: CASE and CommissioningComplete */
	MT_STAGE_DONE,
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
