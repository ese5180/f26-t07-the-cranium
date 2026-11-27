#pragma once

#include <atomic>
#include <chrono>
#include <thread>

// Core Audio can call the finished callback while holding an AudioUnit lock.
// Never acquire a mutex in that callback: stopping/resetting the AudioUnit on
// another thread may already be waiting for it. Only the control thread waits.
class StreamCompletion {
  public:
    void reset() {
        m_finished.store(false, std::memory_order_release);
    }

    void finish() noexcept {
        m_finished.store(true, std::memory_order_release);
    }

    bool waitFor(std::chrono::milliseconds timeout) const {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (!m_finished.load(std::memory_order_acquire)) {
            if (std::chrono::steady_clock::now() >= deadline) {
                return false;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        return true;
    }

  private:
    static_assert(std::atomic<bool>::is_always_lock_free);
    std::atomic<bool> m_finished{false};
};
