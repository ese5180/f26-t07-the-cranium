// Mixxx Zephyr: a two-deck player for the Pioneer DDJ-FLX4 on a
// microcontroller. main() mounts the SD card, loads the first two tracks,
// starts the audio and MIDI threads, then serves storage requests itself.
#include <zephyr/device.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/drivers/watchdog.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "app.h"
#include "mz/engine.h"

LOG_MODULE_REGISTER(mz_main, LOG_LEVEL_INF);

namespace {

// Far too large for a stack: about 2 * MZ_CHUNKS_PER_DECK * 16 KiB.
mz::Engine g_engine(CONFIG_MZ_SAMPLE_RATE);
app::SdStorage g_storage;

mz::OutputMode outputMode() {
#if defined(CONFIG_MZ_OUTPUT_HEADPHONES)
    return mz::OutputMode::Headphones;
#elif defined(CONFIG_MZ_OUTPUT_SPLIT_CUE)
    return mz::OutputMode::SplitCue;
#else
    return mz::OutputMode::Main;
#endif
}

// The hardware watchdog resets the board if audio stops: a hung image on
// trial then goes back to the previous one.
const struct device* const g_watchdog = DEVICE_DT_GET(DT_ALIAS(watchdog0));
int g_watchdogChannel = -1;

void startWatchdog() {
    if (!device_is_ready(g_watchdog)) {
        LOG_WRN("no watchdog");
        return;
    }
    struct wdt_timeout_cfg config = {};
    config.window.min = 0;
    config.window.max = 4000; // ms
    config.flags = WDT_FLAG_RESET_SOC;
    g_watchdogChannel = wdt_install_timeout(g_watchdog, &config);
    if (g_watchdogChannel < 0 || wdt_setup(g_watchdog, WDT_OPT_PAUSE_HALTED_BY_DBG) != 0) {
        LOG_ERR("cannot start the watchdog");
        g_watchdogChannel = -1;
    }
}

// Feeds the watchdog only while the audio thread is still delivering blocks,
// so a stuck audio thread resets the board as surely as a stuck main loop.
void feedWatchdog() {
    static uint32_t lastBlocks = 0;
    const uint32_t blocks = app::audioBlocks();
    if (g_watchdogChannel >= 0 && blocks != lastBlocks) {
        lastBlocks = blocks;
        wdt_feed(g_watchdog, g_watchdogChannel);
    }
}

// After an update MCUboot boots the new image once. Keep it only if it got
// as far as playing audio cleanly; otherwise do nothing, and the next reset
// (the watchdog, the power switch or the user) brings the old image back.
void confirmIfHealthy(bool storageOk, int64_t startMs) {
    static bool done = false;
    if (done || boot_is_img_confirmed()) {
        done = true;
        return;
    }
    if (!storageOk || app::audioUnderruns() != 0 ||
            k_uptime_get() - startMs < CONFIG_MZ_CONFIRM_AFTER_MS) {
        return;
    }
    const int err = boot_write_img_confirmed();
    if (err == 0) {
        LOG_INF("new image confirmed");
        done = true;
    } else {
        LOG_ERR("cannot confirm the image (%d)", err);
    }
}

} // namespace

int main() {
    LOG_INF("Mixxx Zephyr, image %s", boot_is_img_confirmed() ? "confirmed" : "on trial");

    const bool storageOk = app::mountAndScan(&g_engine.library()) == 0;
    if (storageOk && g_engine.library().count() > 0) {
        // Before the MIDI thread starts, main may post; afterwards only it.
        g_engine.requestLoad(0, 0);
        g_engine.requestLoad(1, g_engine.library().count() > 1 ? 1 : 0);
    }
    g_engine.setOutputMode(outputMode());

    const bool audioOk = app::startAudio(&g_engine) == 0;
    if (!audioOk) {
        LOG_ERR("no audio output");
    }
    if (app::startMidi(&g_engine) != 0) {
        LOG_ERR("no MIDI input");
    }
    if (audioOk) {
        startWatchdog();
    }
    // Reading the SD card can take tens of milliseconds a chunk; run it below
    // the MIDI thread so the controller stays responsive.
    k_thread_priority_set(k_current_get(), K_PRIO_PREEMPT(5));

    const int64_t startMs = k_uptime_get();
    int64_t lastReport = startMs;
    while (true) {
        if (!g_engine.serviceWorker(&g_storage)) {
            k_sleep(K_MSEC(2));
        }
        confirmIfHealthy(storageOk, startMs);
        feedWatchdog();

        if (k_uptime_get() - lastReport >= 5000) {
            lastReport = k_uptime_get();
            for (int d = 0; d < mz::kNumDecks; ++d) {
                const mz::DeckStatus s = g_engine.deckStatus(d);
                LOG_INF("deck %d: %s %lld/%lld, %u cache misses", d + 1,
                        s.playing ? "playing" : "stopped", static_cast<long long>(s.position),
                        static_cast<long long>(s.frameCount), s.underruns);
            }
            LOG_INF("audio: %u blocks, %u late, %u events dropped", app::audioBlocks(),
                    app::audioUnderruns(), g_engine.droppedEvents());
        }
    }
    return 0;
}
