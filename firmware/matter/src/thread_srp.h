/*
 * thread_srp — form + lead a Thread network on a fixed channel and run the
 * on-chip SRP + DNS-SD server WITHOUT a border router (the esp_ot_custom_config.h
 * trick mapped to NCS). The DK is the Thread leader; accessories join its mesh
 * directly and are discovered via the on-chip SRP/DNS-SD server for CASE.
 *
 * (Plain-English note on that "esp_ot_custom_config.h trick mapped to NCS": it
 * just means the build is configured — via Nordic's nRF Connect SDK, "NCS" —
 * to run the directory server standalone on this chip, borrowing a config idea
 * from another SDK, instead of relying on a separate border-router box.)
 *
 * Kconfig (prj.conf) compiles the SRP server in (CONFIG_OPENTHREAD_SRP_SERVER);
 * EnableSrpServer() turns it on at runtime via otSrpServerSetEnabled() — NOT
 * auto-enable mode, which would require the Border Routing manager we omit.
 *
 * (Plain-English note on "NOT auto-enable mode ... Border Routing manager we
 * omit": OpenThread can auto-start the directory server, but only as part of the
 * full border-router machinery — which is exactly the separate-box role we are
 * deliberately leaving out. So instead we simply flip the server on ourselves by
 * hand at runtime.)
 *
 * In plain English:
 * This small header lists the handful of helper functions that let this hub run
 * the whole Thread mesh (the low-power wireless network for battery-powered
 * gadgets) all by itself, without the usual separate "border router" box.
 * Normally a border router is a separate device that bridges the Thread mesh to
 * your home Wi-Fi/Internet; here we skip that box and just make this chip the
 * always-on organizer ("leader") of the mesh. It also switches on a tiny on-chip
 * directory service (SRP/DNS-SD) so newly-added smart devices can register their
 * names and be found again for ongoing control. The real code lives in the
 * matching .cpp file; this .h just declares what these helpers are named and what
 * they take/return so the rest of the program can call them.
 */
#pragma once

// CHIP_ERROR: Matter's standard result type — every helper returns one to say
// whether it succeeded or, if not, exactly what went wrong.
#include <lib/core/CHIPError.h>
// Standard C++ headers for size_t (a count/length type) and fixed-width integers
// like uint8_t (a single byte).
#include <cstddef>
#include <cstdint>

// nrf::controller — the namespace (a labeled bucket that keeps this project's
// names from clashing with other libraries) that groups this hub's own code.
namespace nrf {
namespace controller {

// Boot up the Thread mesh with this chip as its leader. On a fresh chip it does
// NOT load a canned/fixed blob: instead it asks OpenThread to generate a brand-new
// network (the "dataset" = network name + password + radio channel), then pins
// only the radio channel and network ID (PAN ID) to fixed values. (If the chip
// already has a saved network from a previous boot, it keeps that one.)
// It then
// turns on the wireless networking interface, and starts Thread as an FTD (a
// "full" always-powered device that can run the mesh). It then logs whatever role
// this chip currently reports, and immediately switches on the SRP directory
// server. Note: it does NOT wait, block, or poll for this chip to actually become
// a router/leader first — it just kicks off Thread and turns SRP on right away
// (becoming leader happens shortly afterward, on its own, in the background).
// Called once at startup. Returns success or an error.
// (Note: the older one-line /// docstring just below says "the fixed active
// dataset" — that wording is stale; the .cpp generates a fresh dataset and only
// pins channel/PAN ID, as described in the plain-English paragraph above.)
/// Commit the fixed active dataset, bring the IPv6 IF up, and start Thread as FTD.
/// Logs the current role once (no wait/poll for router/leader), then enables SRP.
CHIP_ERROR StartThreadLeader();

// Turn on the on-chip SRP/DNS-SD directory server at runtime, so devices on the
// mesh can register their names and be looked up. Safe to call once Thread is
// already running. (StartThreadLeader calls this for you; exposed here in case
// it's needed separately.) Returns success or an error.
/// otSrpServerSetEnabled(instance, true). Safe to call once Thread is up.
CHIP_ERROR EnableSrpServer();

// Hand back a copy of the current Thread network credentials in the packed
// binary format ("TLVs") that a brand-new device needs in order to join the
// mesh. The caller passes a buffer `out` and its capacity `cap`; on success this
// writes the bytes and reports how many it wrote in `outLen`. Used while pairing
// a new device (to push it these credentials). If the buffer is too small it
// returns CHIP_ERROR_BUFFER_TOO_SMALL instead of overflowing.
/// Copy the active operational dataset TLVs (for pushing to a joiner during
/// PairBleThread). Returns the length in outLen; CHIP_ERROR_BUFFER_TOO_SMALL if cap is short.
CHIP_ERROR GetActiveDatasetTlvs(uint8_t * out, size_t cap, size_t & outLen);

// Return this chip's current role in the mesh as a plain human-readable word —
// e.g. "leader", "router", "child", "detached" (not connected), or "disabled"
// (Thread off) — purely for log messages and the serial command line.
/// "leader" / "router" / "child" / "detached" / "disabled" for logging/shell.
const char * ThreadRoleString();

} // namespace controller
} // namespace nrf
