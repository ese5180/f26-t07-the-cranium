/*
 * The "matter" shell commands:
 *   matter pair <manual code> [fail-safe seconds]   commission a device onto this board's Thread network
 *   matter status                                   the commissioning stage and the Thread role
 *   matter cancel                                   stop commissioning
 */
#include <stdlib.h>

#include <zephyr/shell/shell.h>

#include "mt_commission.h"
#include "ot_leader.h"

static int cmd_pair(const struct shell *sh, size_t argc, char **argv)
{
	unsigned long fail_safe = argc > 2 ? strtoul(argv[2], NULL, 10) : 120;

	if (fail_safe < 30 || fail_safe > 900) {
		shell_error(sh, "fail-safe: 30 to 900 seconds");
		return -EINVAL;
	}
	int err = mt_commission_start(argv[1], (uint16_t)fail_safe);

	if (err == -EINVAL) {
		shell_error(sh, "not a valid manual pairing code (11 or 21 digits)");
	} else if (err == -EBUSY) {
		shell_error(sh, "commissioning is already running");
	} else if (err) {
		shell_error(sh, "could not start: %d", err);
	} else {
		shell_print(sh, "scanning for the device");
	}
	return err;
}

static int cmd_status(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	shell_print(sh, "commissioning: %s; Thread: %s", mt_stage_name(mt_commission_stage()), ot_leader_role());
	return 0;
}

static int cmd_cancel(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh);
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	mt_commission_cancel();
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(matter_cmds,
	SHELL_CMD_ARG(pair, NULL, "<manual code> [fail-safe s]: commission a device", cmd_pair, 2, 1),
	SHELL_CMD(status, NULL, "commissioning stage and Thread role", cmd_status),
	SHELL_CMD(cancel, NULL, "stop commissioning", cmd_cancel),
	SHELL_SUBCMD_SET_END);
SHELL_CMD_REGISTER(matter, &matter_cmds, "Matter commissioner", NULL);
