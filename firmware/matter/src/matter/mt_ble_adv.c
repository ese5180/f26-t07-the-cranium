/*
 * The part of mt_ble.h that needs no radio: reading a commissionable device's advertisement.
 */
#include "mt_ble.h"

bool mt_ble_parse_service_data(const uint8_t *data, size_t len, uint16_t *discriminator, uint16_t *vendor,
			       uint16_t *product)
{
	/* opcode (0 = commissionable), discriminator and advertisement version, vendor ID, product ID */
	if (len < 7 || data[0] != 0x00) {
		return false;
	}
	*discriminator = (uint16_t)((data[1] | (data[2] << 8)) & 0x0FFFu);
	*vendor = (uint16_t)(data[3] | (data[4] << 8));
	*product = (uint16_t)(data[5] | (data[6] << 8));
	return true;
}
