/*
 * What a stored record of an update means once the board has restarted: ota_restart_outcome() in
 * ota_job.h. On its own, out of ota_job.c, because a board with Bluetooth only has no jobs to parse
 * and needs this for its updates over Bluetooth all the same.
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
