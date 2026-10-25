// A minimal test runner, so the host tests need nothing beyond a compiler.
#pragma once

#include <cmath>
#include <cstdio>

namespace mz_test {

struct TestCase {
    const char* name;
    void (*function)();
    TestCase* next;
};

TestCase*& registry();
int& failures();

struct Registrar {
    Registrar(const char* name, void (*function)()) {
        static TestCase cases[256];
        static int count = 0;
        TestCase& test = cases[count++];
        test.name = name;
        test.function = function;
        test.next = registry();
        registry() = &test;
    }
};

} // namespace mz_test

#define TEST(name)                                                   \
    static void name();                                              \
    static mz_test::Registrar registrar_##name(#name, &name);        \
    static void name()

#define CHECK(condition)                                                          \
    do {                                                                          \
        if (!(condition)) {                                                       \
            std::printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #condition); \
            ++mz_test::failures();                                                \
        }                                                                         \
    } while (0)

#define CHECK_NEAR(actual, expected, tolerance)                                   \
    do {                                                                          \
        const double a_ = (actual);                                               \
        const double e_ = (expected);                                             \
        if (!(std::fabs(a_ - e_) <= (tolerance))) {                               \
            std::printf("  %s:%d: %s = %.9g, expected %.9g (+/- %g)\n", __FILE__, \
                    __LINE__, #actual, a_, e_, static_cast<double>(tolerance));   \
            ++mz_test::failures();                                                \
        }                                                                         \
    } while (0)
