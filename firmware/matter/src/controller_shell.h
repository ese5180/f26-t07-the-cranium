/*
 * controller_shell — registers the `matter controller ...` sub-command tree.
 *
 * In plain English:
 * This tiny header is the "menu card" for the human-typed commands this hub
 * understands. The hub has a text command line (a "shell") over its USB/serial
 * port where a person can type instructions. This file declares one function
 * that wires up a whole family of commands starting with "matter controller ...".
 * Those commands let a person pair a brand-new smart device, then control it —
 * turn it on/off, change brightness/color (invoke-cmd), read a setting from it
 * (read-attr), change a setting (write-attr), or ask to be notified whenever a
 * setting changes (subs-attr). The actual code that DOES all this lives in the
 * matching .cpp file; this header just exposes the single setup call to the rest
 * of the program. (Shell = the text command-line a person types into. Matter =
 * a shared smart-home language so devices from different brands work together.)
 *
 * The Zephyr shell bridge (chip MainLoopZephyr.cpp) already registers the
 * `matter` root via SHELL_CMD_ARG_REGISTER and routes into chip::Shell::Engine.
 * We add our commands into that engine with Engine::Root().RegisterCommands()
 * (NOT a second SHELL_CMD_ARG_REGISTER). Resulting command forms:
 *
 *   matter controller pairing ble-thread <node> <datasetHex> <pin> <disc>
 *   matter controller pairing code <node> <MT:.../manual>
 *   matter controller pairing unpair <node>
 *   matter controller invoke-cmd <node> <ep> <cluster> <cmd> <json>
 *   matter controller read-attr <node> <ep> <cluster> <attr>
 *   matter controller write-attr <node> <ep> <cluster> <attr> <val>
 *   matter controller subs-attr <node> <ep> <cluster> <attr> <min> <max>
 *
 * Quick decoder for the arguments seen above:
 *   node       = the numeric Node ID identifying one paired smart device.
 *   datasetHex = the Thread "network name + password" a new device needs to join
 *                the low-power mesh (Thread = wireless mesh for smart gadgets).
 *   pin        = the setup passcode/PIN from the device's QR code or label,
 *                proving we're allowed to pair with it.
 *   disc       = the discriminator, a number the new device broadcasts so we can
 *                pick it out from other nearby devices.
 *   ep         = endpoint, a logical sub-device inside a device (e.g. the light).
 *   cluster    = a group of related commands/settings (OnOff, brightness, color).
 *   attr/cmd   = a single setting to read/write, or a single command to send.
 *   min/max    = how often (fastest/slowest) we want change notifications.
 */
#pragma once

// Everything here lives under nrf::controller so it doesn't collide with other
// parts of the program that might use similar names.
namespace nrf {
namespace controller {

/// Register the `controller` command sub-tree into the CHIP shell engine.
// Call this ONCE at startup. It plugs all the "matter controller ..." commands
// listed above into the shell so a person can actually type and run them.
// (CHIP is the open-source code implementing Matter; it was Matter's old name.)
void RegisterShellCommands();

} // namespace controller
} // namespace nrf
