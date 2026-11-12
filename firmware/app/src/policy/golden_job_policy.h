/*
 * What the application does with a golden promotion job (src/ota/golden_promote.c), with no flash and
 * no cloud in it: firmware/tests/host/test_golden_record.c runs it on the build machine.
 *
 * The job carries a promotion record (sysbuild/mcuboot/golden/src/golden_record.h). The application
 * only checks what it can, and passes the record on: the bootloader checks the signature, the counter
 * and the image itself. Across the restart in between, the external flash says how it went: the info
 * sector holds the record that is golden now, and the request sector the record handed over with the
 * bootloader's answer.
 */

#ifndef GOLDEN_JOB_POLICY_H_
#define GOLDEN_JOB_POLICY_H_

#include <stdbool.h>
#include <stdint.h>

#include "golden_record.h"

enum golden_job_action {
	/* The record is golden on this board: the job succeeded. */
	GOLDEN_JOB_SUCCEEDED,
	/* The bootloader answered this record with a refusal: the job failed, with that reason. */
	GOLDEN_JOB_FAILED,
	/* Handed over in this boot, and the restart has not come yet. */
	GOLDEN_JOB_WAIT,
	/* Not acceptable here: refused (queued) or failed (in progress), with the reason. */
	GOLDEN_JOB_REFUSE,
	/* Hand the record over, and restart when the board is idle. */
	GOLDEN_JOB_START,
};

struct golden_job_view {
	/* The record in the job. */
	const struct golden_record *record;
	/* The info sector: the record that is golden now, if any. */
	bool info_present;
	struct golden_pin info;
	/* The request sector holds exactly the job's record, and the bootloader's answer to it. */
	bool request_is_this;
	enum golden_status request_status;
	/* The record was handed over in this boot. */
	bool handed_over;
	/* The running image: its version, and whether it is confirmed (not on trial). */
	struct golden_version running;
	bool running_confirmed;
};

/* *reason is set for FAILED and REFUSE: short and machine-readable. */
enum golden_job_action golden_job_decide(const struct golden_job_view *view, const char **reason);

#endif /* GOLDEN_JOB_POLICY_H_ */
