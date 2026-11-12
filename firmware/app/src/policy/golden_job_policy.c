#include "golden_job_policy.h"

enum golden_job_action golden_job_decide(const struct golden_job_view *view, const char **reason)
{
	const struct golden_pin *wanted = &view->record->pin;

	*reason = "";

	/* Golden already, whatever came before: a lost report, or the same job sent again. */
	if (view->info_present && golden_pin_equal(&view->info, wanted)) {
		return GOLDEN_JOB_SUCCEEDED;
	}

	if (view->request_is_this) {
		if (view->request_status == GOLDEN_STATUS_SEALED) {
			/* Sealed, and the info sector was not written: the answer is what counts. */
			return GOLDEN_JOB_SUCCEEDED;
		}

		if (view->request_status != GOLDEN_STATUS_PENDING) {
			*reason = golden_status_name(view->request_status);
			return GOLDEN_JOB_FAILED;
		}

		if (view->handed_over) {
			return GOLDEN_JOB_WAIT;
		}

		/* Still unanswered after a restart: this bootloader does not take promotions. */
		*reason = "bootloader_unsupported";
		return GOLDEN_JOB_FAILED;
	}

	/* What the bootloader would refuse anyway, said before a restart for nothing. */
	if (golden_version_compare(&view->running, &wanted->version) != 0) {
		*reason = "not_running";
		return GOLDEN_JOB_REFUSE;
	}

	if (!view->running_confirmed) {
		*reason = "not_confirmed";
		return GOLDEN_JOB_REFUSE;
	}

	if (view->info_present && wanted->counter <= view->info.counter) {
		*reason = "not_newer";
		return GOLDEN_JOB_REFUSE;
	}

	return GOLDEN_JOB_START;
}
