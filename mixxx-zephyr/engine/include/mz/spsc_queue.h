// Fixed-size single-producer, single-consumer queue.
//
// Plays the part of rigtorp::SPSCQueue (lib/rigtorp in Mixxx), which Mixxx
// uses between its engine and worker threads: one thread pushes, one pops,
// neither blocks or allocates. Needs only 32-bit atomics, which every
// Cortex-M3 and later has.
#pragma once

#include <atomic>
#include <cstdint>

namespace mz {

template<typename T, uint32_t Capacity>
class SpscQueue {
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0,
            "capacity must be a power of two");

  public:
    SpscQueue()
            : m_head(0), m_tail(0) {
    }

    // Producer side. Returns false when full.
    bool push(const T& item) {
        const uint32_t tail = m_tail.load(std::memory_order_relaxed);
        if (tail - m_head.load(std::memory_order_acquire) == Capacity) {
            return false;
        }
        m_items[tail & (Capacity - 1)] = item;
        m_tail.store(tail + 1, std::memory_order_release);
        return true;
    }

    // Consumer side. Returns false when empty.
    bool pop(T* item) {
        const uint32_t head = m_head.load(std::memory_order_relaxed);
        if (head == m_tail.load(std::memory_order_acquire)) {
            return false;
        }
        *item = m_items[head & (Capacity - 1)];
        m_head.store(head + 1, std::memory_order_release);
        return true;
    }

    bool empty() const {
        return m_head.load(std::memory_order_acquire) ==
                m_tail.load(std::memory_order_acquire);
    }

  private:
    T m_items[Capacity];
    std::atomic<uint32_t> m_head;
    std::atomic<uint32_t> m_tail;
};

} // namespace mz
