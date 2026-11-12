/*
 * The "matter" shell commands:
 *   matter pair <manual code> [fail-safe seconds]   commission a device onto this board's Thread network
 *   matter status                                   the commissioning stage and the Thread role
 *   matter cancel                                   stop commissioning
 *   matter nodes                                    the commissioned devices
 *   matter onoff <node> on|off|toggle [endpoint]    switch a device (endpoint 1 by default)
 *   matter forget <node>                            remove a device from the list (not from the device)
 *   matter ota status                                the stored image and the provider's state
 *   matter ota begin <vid> <pid> <version> <name> <length>, ota write <offset> <hex>, ota finish
 *                                                    store an image (tools/matter_ota_upload.py does this)
 *   matter ota announce <node>                       tell a device this board has an update for it
 *   matter device                                    this board as a device: its onboarding codes, the phone's fabric
 *   matter open                                      advertise over Bluetooth for a phone to add this board
 *   matter selftest                                  check the Matter pieces with known answers (matter_selftest.c)
 *   matter reboot                                    restart the board
 */
#include <stdlib.h>
#include <string.h>

#include <openthread.h>
#include <openthread/srp_server.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/reboot.h>

#include "mt_commission.h"
#include "mt_controller.h"
#include "mt_fabric.h"
#include "mt_im.h"
#include "mt_ota.h"
#include "mt_ota_store.h"
#include "mt_server.h"
#include "mt_node.h"
#include "mt_ota_req.h"
#include "mt_peripheral.h"
#include "matter_policy.h"
#include "ot_leader.h"

static const struct shell *last_shell;

int matter_selftest_cmd(const struct shell *sh, size_t argc, char **argv);

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
	otSrpServerState srp;

	openthread_mutex_lock();
	srp = otSrpServerGetState(openthread_get_default_instance());
	openthread_mutex_unlock();
	shell_print(sh, "commissioning: %s; Thread: %s; SRP: %s", mt_stage_name(mt_commission_stage()), ot_leader_role(),
		    srp == OT_SRP_SERVER_STATE_RUNNING ? "running" : srp == OT_SRP_SERVER_STATE_STOPPED ? "stopped" : "off");
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

static int cmd_ota_status(const struct shell *sh, size_t argc, char **argv)
{
	struct mt_ota_image img;

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	if (mt_ota_store_image(&img)) {
		shell_print(sh, "image %s: vendor 0x%04x product 0x%04x version %u, %u bytes", img.name, img.vendor_id,
			    img.product_id, img.version, img.length);
	} else {
		shell_print(sh, "no image stored");
	}
	shell_print(sh, "provider: %s", mt_server_state());
	return 0;
}

static int cmd_ota_begin(const struct shell *sh, size_t argc, char **argv)
{
	struct mt_ota_image img = {0};

	ARG_UNUSED(argc);
	img.vendor_id = (uint16_t)strtoul(argv[1], NULL, 0);
	img.product_id = (uint16_t)strtoul(argv[2], NULL, 0);
	img.version = (uint32_t)strtoul(argv[3], NULL, 0);
	img.length = (uint32_t)strtoul(argv[5], NULL, 0);
	if (strlen(argv[4]) == 0 || strlen(argv[4]) > MT_OTA_NAME_LEN) {
		shell_error(sh, "name: 1 to 16 characters");
		return -EINVAL;
	}
	strcpy(img.name, argv[4]);
	int err = mt_ota_store_begin(&img);

	if (err) {
		shell_error(sh, "could not start: %d", err);
	} else {
		shell_print(sh, "OK");
	}
	return err;
}

static int hexval(char c)
{
	return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

static int cmd_ota_write(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t data[256];
	size_t n = strlen(argv[2]);

	ARG_UNUSED(argc);
	if (n % 2 != 0 || n / 2 > sizeof(data)) {
		shell_error(sh, "hex: an even number of digits, at most 512");
		return -EINVAL;
	}
	for (size_t i = 0; i < n / 2; i++) {
		int hi = hexval(argv[2][2 * i]);
		int lo = hexval(argv[2][2 * i + 1]);

		if (hi < 0 || lo < 0) {
			shell_error(sh, "not hex");
			return -EINVAL;
		}
		data[i] = (uint8_t)(hi << 4 | lo);
	}
	int err = mt_ota_store_write((uint32_t)strtoul(argv[1], NULL, 0), data, n / 2);

	if (err) {
		shell_error(sh, "write failed: %d", err);
	} else {
		shell_print(sh, "OK");
	}
	return err;
}

static int cmd_ota_finish(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	int err = mt_ota_store_finish();

	if (err) {
		shell_error(sh, "could not finish: %d", err);
	} else {
		shell_print(sh, "OK");
	}
	return err;
}

static int cmd_ota_announce(const struct shell *sh, size_t argc, char **argv)
{
	uint64_t node = strtoull(argv[1], NULL, 16);

	ARG_UNUSED(argc);
	if (mt_fabric_node(node) == NULL) {
		shell_error(sh, "no such node: see matter nodes");
		return -ENOENT;
	}
	last_shell = sh;
	int err = mt_server_announce(node, onoff_done);

	if (err) {
		shell_error(sh, "could not start: %d", err);
	}
	return err;
}

static int cmd_device(const struct shell *sh, size_t argc, char **argv)
{
	const struct mt_node_fabric *f = mt_node_fabric();
	char qr[23];
	char manual[12];

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	mp_qr_payload(MT_NODE_VENDOR_ID, MT_NODE_PRODUCT_ID, 0x02, MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, qr);
	mp_manual_code(MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, manual);
	shell_print(sh, "as a device: %s; QR %s, code %s (test credentials)",
		    f->committed ? "added to a phone's fabric" : f->present ? "being added" : "not added yet", qr, manual);
	if (f->present) {
		shell_print(sh, "phone fabric 0x%016llx, this board node 0x%016llx", (unsigned long long)f->fabric_id,
			    (unsigned long long)f->node_id);
	}
	shell_print(sh, "Bluetooth: %s; own update: %s", mt_peripheral_advertising() ? "advertising" : "not advertising",
		    mt_ota_req_state());
	return 0;
}

static int cmd_open(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	int err = mt_peripheral_open();

	if (err) {
		shell_error(sh, "could not advertise: %d", err);
	}
	return err;
}

static int cmd_reboot(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	shell_print(sh, "restarting");
	k_sleep(K_MSEC(100));
	sys_reboot(SYS_REBOOT_COLD);
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(ota_cmds,
	SHELL_CMD(status, NULL, "the stored image and the provider", cmd_ota_status),
	SHELL_CMD_ARG(begin, NULL, "<vid> <pid> <version> <name> <length>: start storing an image", cmd_ota_begin, 6, 0),
	SHELL_CMD_ARG(write, NULL, "<offset> <hex>: a piece of the image", cmd_ota_write, 3, 0),
	SHELL_CMD(finish, NULL, "the image is complete", cmd_ota_finish),
	SHELL_CMD_ARG(announce, NULL, "<node>: tell a device an update is here", cmd_ota_announce, 2, 0),
	SHELL_SUBCMD_SET_END);

SHELL_STATIC_SUBCMD_SET_CREATE(matter_cmds,
	SHELL_CMD_ARG(pair, NULL, "<manual code> [fail-safe s]: commission a device", cmd_pair, 2, 1),
	SHELL_CMD(status, NULL, "commissioning stage and Thread role", cmd_status),
	SHELL_CMD(cancel, NULL, "stop commissioning", cmd_cancel),
	SHELL_CMD(nodes, NULL, "commissioned devices", cmd_nodes),
	SHELL_CMD_ARG(onoff, NULL, "<node> on|off|toggle [endpoint]: switch a device", cmd_onoff, 3, 1),
	SHELL_CMD_ARG(forget, NULL, "<node>: remove a device from the list", cmd_forget, 2, 0),
	SHELL_CMD(ota, &ota_cmds, "the OTA provider", NULL),
	SHELL_CMD(device, NULL, "this board as a device: its codes and the phone's fabric", cmd_device),
	SHELL_CMD(open, NULL, "advertise for a phone to add this board (15 minutes)", cmd_open),
	SHELL_CMD(reboot, NULL, "restart the board", cmd_reboot),
	SHELL_CMD(selftest, NULL, "check the Matter pieces on the board (known answers)", matter_selftest_cmd),
	SHELL_SUBCMD_SET_END);
SHELL_CMD_REGISTER(matter, &matter_cmds, "Matter commissioner", NULL);
