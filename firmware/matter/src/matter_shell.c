/*
 * The "matter" shell commands:
 *   matter pair <manual code> [fail-safe seconds]   commission a device onto this board's Thread network
 *   matter status                                   the commissioning stage and the Thread role
 *   matter cancel                                   stop commissioning
 *   matter nodes                                    the commissioned devices
 *   matter onoff <node> on|off|toggle [endpoint]    switch a device (endpoint 1 by default)
 *   matter forget <node>                            remove a device from the list (not from the device)
 */
#include <stdlib.h>
#include <string.h>

#include <zephyr/shell/shell.h>

#include "mt_commission.h"
#include "mt_controller.h"
#include "mt_fabric.h"
#include "mt_im.h"
#include "ot_leader.h"

static const struct shell *last_shell;

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

static int cmd_nodes(const struct shell *sh, size_t argc, char **argv)
{
	const struct mt_fabric *f = mt_fabric();

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	shell_print(sh, "fabric 0x%016llx, this board node 0x%016llx", (unsigned long long)f->fabric_id,
		    (unsigned long long)f->own_node_id);
	for (int i = 0; i < MT_MAX_NODES; i++) {
		if (f->nodes[i].in_use) {
			shell_print(sh, "node 0x%016llx vendor 0x%04x product 0x%04x",
				    (unsigned long long)f->nodes[i].node_id, f->nodes[i].vendor_id,
				    f->nodes[i].product_id);
		}
	}
	return 0;
}

static void onoff_done(uint64_t node, int result)
{
	if (last_shell) {
		if (result == 0) {
			shell_print(last_shell, "node 0x%016llx: done", (unsigned long long)node);
		} else {
			shell_error(last_shell, "node 0x%016llx: failed (%d)", (unsigned long long)node, result);
		}
	}
}

static int cmd_onoff(const struct shell *sh, size_t argc, char **argv)
{
	uint64_t node = strtoull(argv[1], NULL, 16);
	unsigned long ep = argc > 3 ? strtoul(argv[3], NULL, 10) : 1;
	uint32_t cmd;

	if (strcmp(argv[2], "on") == 0) {
		cmd = MT_CMD_ONOFF_ON;
	} else if (strcmp(argv[2], "off") == 0) {
		cmd = MT_CMD_ONOFF_OFF;
	} else if (strcmp(argv[2], "toggle") == 0) {
		cmd = MT_CMD_ONOFF_TOGGLE;
	} else {
		shell_error(sh, "on, off or toggle");
		return -EINVAL;
	}
	if (mt_fabric_node(node) == NULL) {
		shell_error(sh, "no such node: see matter nodes");
		return -ENOENT;
	}
	last_shell = sh;
	int err = mt_ctl_invoke(node, (uint16_t)ep, MT_CL_ONOFF, cmd, NULL, NULL, onoff_done);

	if (err) {
		shell_error(sh, "could not start: %d", err);
	}
	return err;
}

static int cmd_forget(const struct shell *sh, size_t argc, char **argv)
{
	uint64_t node = strtoull(argv[1], NULL, 16);

	ARG_UNUSED(argc);
	mt_ctl_drop(node);
	if (mt_fabric_remove_node(node) != 0) {
		shell_error(sh, "no such node");
		return -ENOENT;
	}
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(matter_cmds,
	SHELL_CMD_ARG(pair, NULL, "<manual code> [fail-safe s]: commission a device", cmd_pair, 2, 1),
	SHELL_CMD(status, NULL, "commissioning stage and Thread role", cmd_status),
	SHELL_CMD(cancel, NULL, "stop commissioning", cmd_cancel),
	SHELL_CMD(nodes, NULL, "commissioned devices", cmd_nodes),
	SHELL_CMD_ARG(onoff, NULL, "<node> on|off|toggle [endpoint]: switch a device", cmd_onoff, 3, 1),
	SHELL_CMD_ARG(forget, NULL, "<node>: remove a device from the list", cmd_forget, 2, 0),
	SHELL_SUBCMD_SET_END);
SHELL_CMD_REGISTER(matter, &matter_cmds, "Matter commissioner", NULL);
