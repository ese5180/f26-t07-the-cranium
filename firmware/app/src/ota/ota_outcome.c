/*
 * What a stored record of an update means once the board has restarted: ota_restart_outcome() in
 * ota_job.h. On its own, out of ota_job.c, because updates over Bluetooth need it as well as jobs.
 */

#include "ota_job.h"

enum ota_restart_outcome ota_restart_outcome(bool running_target, bool on_trial, bool has_trailer,
					     bool was_testing)
{
	if (running_target && on_trial) {
		return OTA_RESTART_ON_TRIAL;
	}

	if (running_target) {
		return has_trailer ? OTA_RESTART_CONFIRMED : OTA_RESTART_TRIAL_LOST;
	}

	return was_testing ? OTA_RESTART_ROLLED_BACK : OTA_RESTART_NOT_INSTALLED;
}
