// The audio thread: render a block, hand it to I2S, repeat.
#include <atomic>

#include <zephyr/device.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "app.h"

LOG_MODULE_REGISTER(mz_audio, LOG_LEVEL_INF);

namespace app {

namespace {

constexpr int kFrames = CONFIG_MZ_BLOCK_FRAMES;
constexpr size_t kBlockBytes = kFrames * 2 * sizeof(int16_t);

K_MEM_SLAB_DEFINE_STATIC(g_slab, kBlockBytes, CONFIG_MZ_I2S_BLOCKS, 4);
K_THREAD_STACK_DEFINE(g_stack, 4096);
struct k_thread g_thread;

const struct device* const g_i2s = DEVICE_DT_GET(DT_ALIAS(mz_i2s));
mz::Engine* g_engine;
std::atomic<uint32_t> g_blocks{0};
std::atomic<uint32_t> g_underruns{0};

int writeBlock() {
    void* block;
    // Waits until I2S has sent a block and freed it: this paces the thread.
    int err = k_mem_slab_alloc(&g_slab, &block, K_FOREVER);
    if (err != 0) {
        return err;
    }
    g_engine->render(static_cast<int16_t*>(block), kFrames);
    err = i2s_write(g_i2s, block, kBlockBytes);
    if (err != 0) {
        k_mem_slab_free(&g_slab, block);
        return err;
    }
    g_blocks.fetch_add(1, std::memory_order_relaxed);
    return 0;
}

void audioThread(void*, void*, void*) {
    // Fill the queue, then start the clocks.
    for (int i = 0; i < CONFIG_MZ_I2S_BLOCKS - 1; ++i) {
        writeBlock();
    }
    if (i2s_trigger(g_i2s, I2S_DIR_TX, I2S_TRIGGER_START) != 0) {
        LOG_ERR("cannot start I2S");
        return;
    }
    while (true) {
        const int err = writeBlock();
        if (err == -EIO) {
            // The queue ran dry (we were late): restart the stream.
            g_underruns.fetch_add(1, std::memory_order_relaxed);
            i2s_trigger(g_i2s, I2S_DIR_TX, I2S_TRIGGER_DROP);
            i2s_trigger(g_i2s, I2S_DIR_TX, I2S_TRIGGER_PREPARE);
            for (int i = 0; i < CONFIG_MZ_I2S_BLOCKS - 1; ++i) {
                writeBlock();
            }
            i2s_trigger(g_i2s, I2S_DIR_TX, I2S_TRIGGER_START);
        } else if (err != 0) {
            LOG_ERR("i2s_write failed (%d)", err);
            k_sleep(K_MSEC(10));
        }
    }
}

} // namespace

int startAudio(mz::Engine* engine) {
    if (!device_is_ready(g_i2s)) {
        LOG_ERR("I2S is not ready");
        return -ENODEV;
    }
    g_engine = engine;

    struct i2s_config config = {};
    config.word_size = 16;
    config.channels = 2;
    config.format = I2S_FMT_DATA_FORMAT_I2S;
    config.options = I2S_OPT_BIT_CLK_CONTROLLER | I2S_OPT_FRAME_CLK_CONTROLLER;
    config.frame_clk_freq = CONFIG_MZ_SAMPLE_RATE;
    config.mem_slab = &g_slab;
    config.block_size = kBlockBytes;
    config.timeout = 1000;
    const int err = i2s_configure(g_i2s, I2S_DIR_TX, &config);
    if (err != 0) {
        LOG_ERR("cannot configure I2S (%d)", err);
        return err;
    }

    // Above every other thread: a late block is an audible click.
    k_thread_create(&g_thread, g_stack, K_THREAD_STACK_SIZEOF(g_stack), audioThread,
            nullptr, nullptr, nullptr, K_PRIO_COOP(2), 0, K_NO_WAIT);
    k_thread_name_set(&g_thread, "audio");
    return 0;
}

uint32_t audioBlocks() {
    return g_blocks.load(std::memory_order_relaxed);
}

uint32_t audioUnderruns() {
    return g_underruns.load(std::memory_order_relaxed);
}

} // namespace app
