/*
 * The Matter variant's start-up (docs/matter-thread.md): the board leads a Thread network with an SRP server,
 * joins Wi-Fi as the border router's backbone (nRF7002 DK), and runs the Matter commissioner, driven from the
 * shell ("matter controller pairing ...").
 *
 * The order matters:
 *   1. Matter's memory, then its stack, then the Thread stack.
 *   2. The Bluetooth central, before the event loop, so that its scan and connection callbacks are in place.
 *   3. The shell commands, then the Matter event loop.
 *   4. On the Matter thread: PSA crypto, Thread leader, the SRP server, then the commissioner (storage, keys,
 *      credentials issuer, DeviceCommissioner). The commissioner needs the event loop, so it comes last.
 * Becoming leader is retried with a growing delay that never gives up (src/policy/matter_policy.c).
 */
#include "ble_central.h"
#include "controller_client.h"
#include "controller_shell.h"
#include "matter_policy.h"
#include "thread_srp.h"
#if defined(CONFIG_CRANIUM_MATTER_BORDER_ROUTER)
#include "border_router.h"
#endif

#include <lib/support/logging/CHIPLogging.h>
#include <platform/CHIPDeviceLayer.h>
#include <platform/ThreadStackManager.h>
#include <psa/crypto.h>

#include <zephyr/kernel.h>

using namespace ::chip::DeviceLayer;
using namespace ::nrf::controller;

namespace {

uint32_t sLeaderAttempt;

void StartCommissioner()
{
    CHIP_ERROR e = ControllerClient::Instance().Init();
    if (e != CHIP_NO_ERROR)
    {
        ChipLogError(DeviceLayer, "Commissioner storage and keys failed: %" CHIP_ERROR_FORMAT, e.Format());
        return;
    }
    e = ControllerClient::Instance().SetupCommissioner();
    if (e != CHIP_NO_ERROR)
    {
        ChipLogError(DeviceLayer, "Commissioner set-up failed: %" CHIP_ERROR_FORMAT, e.Format());
        return;
    }
    ChipLogProgress(DeviceLayer, "Commissioner ready: matter controller pairing code <node> <code>");
}

void BringUpThread(chip::System::Layer *, void *)
{
    CHIP_ERROR e = StartThreadLeader();
    if (e == CHIP_NO_ERROR)
    {
        e = EnableSrpServer();
    }
    if (e != CHIP_NO_ERROR)
    {
        uint32_t ms = mp_backoff_ms(sLeaderAttempt++, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS);
        ChipLogError(DeviceLayer, "Thread start failed (%" CHIP_ERROR_FORMAT "), again in %u s", e.Format(),
                     static_cast<unsigned>(ms / 1000));
        SystemLayer().StartTimer(chip::System::Clock::Milliseconds32(ms), BringUpThread, nullptr);
        return;
    }
    ChipLogProgress(DeviceLayer, "Thread up (role %s), SRP server on", ThreadRoleString());
    if (!ControllerClient::Instance().IsInitialized())
    {
        StartCommissioner();
    }
}

} // namespace

int main()
{
    ChipLogProgress(DeviceLayer, "Cranium Matter commissioner and Thread border router");

    CHIP_ERROR err = chip::Platform::MemoryInit();
    if (err == CHIP_NO_ERROR)
    {
        err = PlatformMgr().InitChipStack();
    }
    if (err == CHIP_NO_ERROR)
    {
        err = ThreadStackMgr().InitThreadStack();
    }
    if (err == CHIP_NO_ERROR)
    {
        err = BleCentral::Instance().Init();
    }
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(DeviceLayer, "Matter start-up failed: %" CHIP_ERROR_FORMAT, err.Format());
        return 0;
    }

    RegisterShellCommands();

#if defined(CONFIG_CRANIUM_MATTER_BORDER_ROUTER)
    (void) border_router_start();
#endif

    err = PlatformMgr().StartEventLoopTask();
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(DeviceLayer, "Matter event loop failed: %" CHIP_ERROR_FORMAT, err.Format());
        return 0;
    }

    PlatformMgr().ScheduleWork(
        [](intptr_t) {
            psa_status_t ps = psa_crypto_init();
            if (ps != PSA_SUCCESS)
            {
                ChipLogError(DeviceLayer, "psa_crypto_init failed: %d", static_cast<int>(ps));
                return;
            }
            BringUpThread(nullptr, nullptr);
        },
        0);

    return 0;
}
