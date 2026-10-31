#include <cstdio>

#include "test.h"

namespace mz_test {

TestCase*& registry() {
    static TestCase* head = nullptr;
    return head;
}

int& failures() {
    static int count = 0;
    return count;
}

} // namespace mz_test

int main() {
    // Registration prepends, so reverse to run in file order.
    mz_test::TestCase* reversed = nullptr;
    for (mz_test::TestCase* test = mz_test::registry(); test != nullptr;) {
        mz_test::TestCase* next = test->next;
        test->next = reversed;
        reversed = test;
        test = next;
    }
    int run = 0;
    int failedTests = 0;
    for (mz_test::TestCase* test = reversed; test != nullptr; test = test->next) {
        const int before = mz_test::failures();
        test->function();
        ++run;
        const bool failed = mz_test::failures() != before;
        failedTests += failed ? 1 : 0;
        std::printf("%s %s\n", failed ? "FAIL" : "ok  ", test->name);
    }
    std::printf("\n%d tests, %d failed, %d failed checks\n", run, failedTests, mz_test::failures());
    return mz_test::failures() == 0 ? 0 : 1;
}
