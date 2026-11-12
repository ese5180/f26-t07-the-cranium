/*
 * The Matter variant's start-up (docs/matter-thread.md): the board leads a Thread network with an SRP server,
 * joins Wi-Fi as the border router's backbone, and runs this project's own Matter commissioner (src/matter/).
 * Becoming leader is retried with a growing delay that never gives up (src/policy/matter_policy.c).
 */
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

#include "matter_policy.h"
#include "ot_leader.h"
#if defined(CONFIG_CRANIUM_MATTER_BORDER_ROUTER)
#include "border_router.h"
#endif

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

static void thread_up(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(thread_work, thread_up);
static uint32_t thread_attempt;

static void thread_up(struct k_work *work)
{
	ARG_UNUSED(work);

	if (ot_leader_start() == 0) {
		LOG_INF("Thread up (role %s), SRP server on", ot_leader_role());
		return;
	}
	uint32_t ms = mp_backoff_ms(thread_attempt++, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS);

	LOG_WRN("Thread start failed, again in %u s", ms / 1000);
	k_work_schedule(&thread_work, K_MSEC(ms));
}

int main(void)
{
	LOG_INF("Cranium Matter commissioner and Thread border router");
	if (settings_subsys_init() != 0) {
		LOG_ERR("settings could not start: the fabric cannot be kept");
	}

	int err = bt_enable(NULL);

	if (err != 0) {
		LOG_ERR("Bluetooth did not start: %d", err);
	}
#if defined(CONFIG_CRANIUM_MATTER_BORDER_ROUTER)
	(void)border_router_start();
#endif
	k_work_schedule(&thread_work, K_NO_WAIT);
	return 0;
}
