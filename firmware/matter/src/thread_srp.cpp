/*
 * thread_srp.cpp — Form + lead a Thread network on a fixed dataset and enable
 * the on-chip SRP/DNS-SD server so accessories can register directly without a
 * border router.
 *
 * All OpenThread calls are made with the Thread stack lock held via
 * ThreadStackMgr().LockThreadStack() / UnlockThreadStack(), as required when
 * calling OT APIs from outside the OpenThread task.
 *
 * In plain English:
 * This file is what turns the hub into the boss of its own low-power wireless
 * mesh (Thread — think Wi-Fi but for tiny battery gadgets). It creates the
 * mesh, picks a fixed radio channel and network ID, and starts leading it, so
 * that normally you'd need a separate "border router" box — but here the chip
 * does that job itself. It also switches on a little on-chip directory service
 * (SRP/DNS-SD) that lets newly added smart devices announce themselves and be
 * found by name. Finally it can hand out the mesh's "network name + password"
 * (the dataset) that a brand-new device needs to join the mesh during pairing.
 * OpenThread (the code that runs the mesh) insists that we "hold a lock" before
 * poking it from another thread, which is why every function grabs and releases
 * that lock around its calls.
 */

// Our own declarations (function signatures) for this file.
#include "thread_srp.h"

#include <zephyr/kernel.h>

// Matter/CHIP core support: error codes and logging helpers.
#include <lib/core/CHIPError.h>
#include <lib/support/logging/CHIPLogging.h>
#include <platform/CHIPDeviceLayer.h>
// The manager that owns the Thread mesh and the lock we must hold to talk to it.
#include <platform/ThreadStackManager.h>

// OpenThread public API headers
// OpenThread is the open-source code that actually runs the Thread mesh.
// These headers give us the functions to configure and start it:
// - dataset:     read/write the mesh's "network name + password" (credentials).
// - dataset_ftd: create a brand-new mesh (FTD = an always-on full router device).
// - ip6:         turn the network (IPv6) interface on.
// - srp_server:  the on-chip directory that lets devices register their names.
// - thread:      start/stop the mesh and check what role we're playing.
#include <openthread/dataset.h>
#include <openthread/dataset_ftd.h>
#include <openthread/ip6.h>
#include <openthread/srp_server.h>
#include <openthread/thread.h>

// The nRF Connect / Zephyr platform exposes the raw otInstance* through
// ThreadStackMgrImpl().OTInstance().  The impl class lives in the platform
// layer and is reachable via the DeviceLayer namespace.
// This header gives us access to the raw OpenThread "instance" handle that all
// the OpenThread functions above need as their first argument.
#include <platform/OpenThread/GenericThreadStackManagerImpl_OpenThread.h>

// Everything in this file lives under nrf::controller to keep names tidy.
namespace nrf {
namespace controller {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Obtain the raw otInstance pointer.  Must be called with the Thread stack
/// lock already held (or on the OT task), because OTInstance() is not itself
/// thread-safe.
//
// In plain English: fetches the single handle that represents "our Thread
// stack." Every OpenThread function needs this handle. The caller must already
// be holding the Thread lock (see file header) before calling this.
static otInstance * GetOTInstance()
{
    return chip::DeviceLayer::ThreadStackMgrImpl().OTInstance();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Creates and starts the Thread mesh with this hub as its leader (the boss that
// organizes the network). Call this once at startup, after the Thread stack is
// initialized. Without it there is no mesh for smart devices to join. Returns a
// success/error code. On success, it also turns on the SRP directory service.
CHIP_ERROR StartThreadLeader()
{
    ChipLogProgress(DeviceLayer, "thread_srp: starting Thread leader");

    // Grab the lock so no one else touches the Thread stack while we set it up.
    chip::DeviceLayer::ThreadStackMgr().LockThreadStack();

    // Get the handle every OpenThread call needs.
    otInstance * instance = GetOTInstance();
    ChipLogProgress(DeviceLayer, "thread_srp: OT instance = %p", static_cast<void *>(instance));

    // 1. Ensure a COMPLETE, VALID active operational dataset. A hand-rolled TLV
    //    blob is fragile (e.g. missing the required Active Timestamp / mesh-local
    //    prefix) and faults in DatasetManager::LocalSave. On a fresh device, let
    //    OpenThread generate a full dataset (random NetworkKey/PSKc/ExtPANID/
    //    timestamp) and pin the channel + PAN ID to fixed values.
    // otErr holds the result of each OpenThread call; OT_ERROR_NONE means "OK".
    otError otErr = OT_ERROR_NONE;
    // Only build a new network if this chip doesn't already have one saved from a
    // previous boot ("commissioned" = already has network credentials on file).
    if (!otDatasetIsCommissioned(instance))
    {
        // A struct that will hold the freshly generated network settings.
        otOperationalDataset ds;
        // Zero it out first so no leftover garbage bytes sneak in.
        memset(&ds, 0, sizeof(ds));
        // Ask OpenThread to invent a complete, valid network: random secret keys,
        // ID, and timestamp. Safer than hand-writing the byte blob above.
        otErr = otDatasetCreateNewNetwork(instance, &ds);
        if (otErr != OT_ERROR_NONE)
        {
            // Something went wrong — always release the lock before bailing out.
            chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();
            ChipLogError(DeviceLayer, "thread_srp: otDatasetCreateNewNetwork failed: %d", static_cast<int>(otErr));
            return CHIP_ERROR_INTERNAL;
        }
        // The channel comes from CONFIG_CRANIUM_THREAD_CHANNEL: pick one away from the Wi-Fi
        // channel (docs/matter-thread.md). The PAN ID and keys stay the random ones.
        ds.mChannel                      = CONFIG_CRANIUM_THREAD_CHANNEL;
        // ...and mark that we've explicitly set the channel field.
        ds.mComponents.mIsChannelPresent = true;
        // Save this dataset as the active/current network for the mesh.
        otErr = otDatasetSetActive(instance, &ds);
        if (otErr != OT_ERROR_NONE)
        {
            // On failure, release the lock and report the error.
            chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();
            ChipLogError(DeviceLayer, "thread_srp: otDatasetSetActive failed: %d", static_cast<int>(otErr));
            return CHIP_ERROR_INTERNAL;
        }
        ChipLogProgress(DeviceLayer, "thread_srp: created new Thread network (ch %u, PAN 0x%04x)", ds.mChannel, ds.mPanId);
    }

    // 2. Bring up the IPv6 interface.
    // Turn on networking (the IPv6 addressing layer) so the mesh can carry data.
    otErr = otIp6SetEnabled(instance, true);
    if (otErr != OT_ERROR_NONE)
    {
        chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();
        ChipLogError(DeviceLayer, "thread_srp: otIp6SetEnabled failed: %d", static_cast<int>(otErr));
        return CHIP_ERROR_INTERNAL;
    }

    // 3. Start the Thread stack (FTD — becomes leader on a fresh network).
    // Actually start participating in the mesh. Because this is a full always-on
    // router (FTD) and the network is brand-new, it becomes the leader (boss).
    otErr = otThreadSetEnabled(instance, true);
    if (otErr != OT_ERROR_NONE)
    {
        chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();
        ChipLogError(DeviceLayer, "thread_srp: otThreadSetEnabled failed: %d", static_cast<int>(otErr));
        return CHIP_ERROR_INTERNAL;
    }

    // Setup done — release the lock so other threads can use the Thread stack.
    chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();

    // Log which role we ended up in (should be "leader" on a fresh network).
    ChipLogProgress(DeviceLayer, "thread_srp: Thread started, role=%s", ThreadRoleString());

    // Enable SRP now that the stack is up.
    // Turn on the on-chip name/directory service so joining devices can register.
    return EnableSrpServer();
}

// Switches on the on-chip SRP server — the little directory service where smart
// devices on the mesh register their names/addresses so they can be found (this
// is normally the border router's job). Called after the mesh is up. Returns a
// success code (this always succeeds here).
CHIP_ERROR EnableSrpServer()
{
    ChipLogProgress(DeviceLayer, "thread_srp: enabling SRP server");

    // Hold the lock, flip the SRP directory service on, then release the lock.
    chip::DeviceLayer::ThreadStackMgr().LockThreadStack();
    // SAFETY NET: the server's constructor sets the domain ("default.service.arpa.") with the
    // error IGNORED; that string is heap-allocated, and when OT ran on its tiny internal heap the
    // allocation failed silently, leaving domain=NULL — so the server refused EVERY registration
    // with "security" (confirmed on HW: zone 'default.service.arpa.' vs domain '(null)'), which
    // blocked DNS-SD init → FindOperational → CASE. CONFIG_OPENTHREAD_EXTERNAL_HEAP=y (prj.conf)
    // is the real fix; here we positively verify the domain each boot and repair it if ever NULL
    // again (only legal while the server is still disabled).
    const char * srpDomain = otSrpServerGetDomain(GetOTInstance());
    if ((srpDomain == nullptr) || (srpDomain[0] == '\0'))
    {
        otError domErr = otSrpServerSetDomain(GetOTInstance(), "default.service.arpa.");
        ChipLogError(DeviceLayer, "thread_srp: SRP domain was NULL; SetDomain -> %d", static_cast<int>(domErr));
    }
    else
    {
        ChipLogProgress(DeviceLayer, "thread_srp: SRP domain '%s'", srpDomain);
    }
    otSrpServerSetEnabled(GetOTInstance(), true);
    chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();

    ChipLogProgress(DeviceLayer, "thread_srp: SRP server enabled");
    return CHIP_NO_ERROR;
}

// Copies out the mesh's current "network name + password" (the active dataset)
// in Thread's compact binary form. The pairing code calls this so it can hand
// these credentials to a brand-new device, letting it join the mesh. Writes the
// bytes into caller-provided buffer 'out' (capacity 'cap') and reports how many
// bytes were written via 'outLen'. Returns an error if the buffer is too small.
CHIP_ERROR GetActiveDatasetTlvs(uint8_t * out, size_t cap, size_t & outLen)
{
    // Refuse a null output buffer.
    VerifyOrReturnError(out != nullptr, CHIP_ERROR_INVALID_ARGUMENT);

    // Hold the lock while reading from the Thread stack.
    chip::DeviceLayer::ThreadStackMgr().LockThreadStack();

    // Local struct to receive the credentials bytes and their length.
    otOperationalDatasetTlvs datasetTlvs;
    // Ask OpenThread for the currently active network credentials.
    otError otErr = otDatasetGetActiveTlvs(GetOTInstance(), &datasetTlvs);

    // Done reading — release the lock before handling the result.
    chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();

    if (otErr != OT_ERROR_NONE)
    {
        // No active dataset (or some failure) — report an internal error.
        ChipLogError(DeviceLayer, "thread_srp: otDatasetGetActiveTlvs failed: %d", static_cast<int>(otErr));
        return CHIP_ERROR_INTERNAL;
    }

    // Make sure the caller's buffer is big enough to hold the credentials.
    if (datasetTlvs.mLength > cap)
    {
        ChipLogError(DeviceLayer, "thread_srp: output buffer too small (%zu < %u)", cap,
                     static_cast<unsigned>(datasetTlvs.mLength));
        return CHIP_ERROR_BUFFER_TOO_SMALL;
    }

    // Copy the credential bytes into the caller's buffer and tell them the size.
    memcpy(out, datasetTlvs.mTlvs, datasetTlvs.mLength);
    outLen = datasetTlvs.mLength;
    return CHIP_NO_ERROR;
}

// Returns a short human-readable word for what part this hub is playing in the
// mesh right now (e.g. "leader"). Handy for logs and shell status output. The
// returned text is a fixed string, so it's always safe to use.
const char * ThreadRoleString()
{
    // Hold the lock, read our current role, then release the lock.
    chip::DeviceLayer::ThreadStackMgr().LockThreadStack();
    otDeviceRole role = otThreadGetDeviceRole(GetOTInstance());
    chip::DeviceLayer::ThreadStackMgr().UnlockThreadStack();

    // Translate the numeric role code into a word:
    switch (role)
    {
    // The boss that organizes the whole mesh (expected for this hub).
    case OT_DEVICE_ROLE_LEADER:
        return "leader";
    // A relay that forwards traffic for others but isn't the leader.
    case OT_DEVICE_ROLE_ROUTER:
        return "router";
    // A leaf device that connects through a router (often a battery gadget).
    case OT_DEVICE_ROLE_CHILD:
        return "child";
    // On, but not yet attached to any mesh (searching/joining).
    case OT_DEVICE_ROLE_DETACHED:
        return "detached";
    // Thread is turned off entirely.
    case OT_DEVICE_ROLE_DISABLED:
    default:
        return "disabled";
    }
}

} // namespace controller
} // namespace nrf
