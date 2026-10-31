// The control thread: MIDI bytes from the UART into the engine, LED state
// back out.
//
// The DDJ-FLX4 is a USB device and the nRF5340 has no USB host, so the
// controller's MIDI has to arrive over DIN MIDI (or a USB-host-to-DIN
// adapter). A board with a USB host could feed the same MidiParser.
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/ring_buffer.h>

#include "app.h"
#include "mz/midi.h"

LOG_MODULE_REGISTER(mz_midi, LOG_LEVEL_INF);

namespace app {

namespace {

const struct device* const g_uart = DEVICE_DT_GET(DT_ALIAS(mz_midi_uart));
RING_BUF_DECLARE(g_rx, 256);
K_SEM_DEFINE(g_rxReady, 0, 1);
K_THREAD_STACK_DEFINE(g_stack, 3072);
struct k_thread g_thread;
mz::Engine* g_engine;

void uartIsr(const struct device* dev, void*) {
    if (!uart_irq_update(dev)) {
        return;
    }
    while (uart_irq_rx_ready(dev)) {
        uint8_t bytes[16];
        const int n = uart_fifo_read(dev, bytes, sizeof(bytes));
        if (n <= 0) {
            break;
        }
        ring_buf_put(&g_rx, bytes, static_cast<uint32_t>(n));
        k_sem_give(&g_rxReady);
    }
}

void sendMidi(const uint8_t* bytes, size_t length, void*) {
    for (size_t i = 0; i < length; ++i) {
        uart_poll_out(g_uart, bytes[i]);
    }
}

void midiThread(void*, void*, void*) {
    mz::MidiParser parser;
    mz::MidiMapper mapper(g_engine, &mz::kPioneerDdjFlx4Mapping);
    mz::MidiOutputs leds(g_engine, &mz::kPioneerDdjFlx4Mapping, sendMidi, nullptr);
    leds.update(true);
    while (true) {
        // Wake for input, or every 10 ms to refresh the LEDs.
        k_sem_take(&g_rxReady, K_MSEC(10));
        uint8_t bytes[32];
        uint32_t n;
        while ((n = ring_buf_get(&g_rx, bytes, sizeof(bytes))) > 0) {
            for (uint32_t i = 0; i < n; ++i) {
                mz::MidiMessage message;
                if (parser.feed(bytes[i], &message)) {
                    mapper.process(message);
                }
            }
        }
        leds.update();
    }
}

} // namespace

int startMidi(mz::Engine* engine) {
    if (!device_is_ready(g_uart)) {
        LOG_ERR("MIDI UART is not ready");
        return -ENODEV;
    }
    g_engine = engine;
    uart_irq_callback_user_data_set(g_uart, uartIsr, nullptr);
    uart_irq_rx_enable(g_uart);
    k_thread_create(&g_thread, g_stack, K_THREAD_STACK_SIZEOF(g_stack), midiThread,
            nullptr, nullptr, nullptr, K_PRIO_PREEMPT(2), 0, K_NO_WAIT);
    k_thread_name_set(&g_thread, "midi");
    return 0;
}

} // namespace app
