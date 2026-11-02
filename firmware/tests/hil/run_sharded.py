#!/usr/bin/env python3
"""Run one test file's tests in several processes at once, and report the way unittest does.

    python3 firmware/tests/hil/run_sharded.py --jobs 4 firmware/tests/hil/test_board.py

test_board.py spends most of its time waiting on simulated boards, one test after another. Each
test starts its own console_sim on its own pseudo-terminal and works in its own temporary folder,
so the tests can run side by side. Whole test classes go to each process, so that a class's
setUpClass and the order of its tests stay as they are, and the classes with the most tests are
handed out first, to keep the processes about equally busy. --split-classes hands out single
tests instead, for a file whose tests do not depend on their order.

The last line is unittest's own: "OK", "OK (skipped=N)" or "FAILED (...)", with the counts of
every process added up, so that CI's check of that line works as it does for a plain run. The
output of a process that did not pass is printed in full.
"""

import argparse
import os
import re
import subprocess
import sys
import time
import unittest
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAN = re.compile(r"^Ran (\d+) tests? in ", re.MULTILINE)
RESULT = re.compile(r"^(OK|FAILED)(?: \((.*)\))?$", re.MULTILINE)


def test_ids(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from test_ids(item)
        else:
            yield item.id()


def shards_by_class(ids, count):
    """Whole classes, largest first, each to the process with the fewest tests so far."""
    classes = defaultdict(list)
    for test_id in ids:
        classes[test_id.rsplit(".", 1)[0]].append(test_id)
    shards = [[] for _ in range(count)]
    for _, tests in sorted(classes.items(), key=lambda item: (-len(item[1]), item[0])):
        min(shards, key=len).extend(tests)
    return [shard for shard in shards if shard]


def shards_by_test(ids, count):
    """Every count-th test, so that a large class is spread over all the processes."""
    return [shard for shard in (ids[index::count] for index in range(count)) if shard]


def counts(text):
    """{"tests", "failures", "errors", "skipped", "ok"} from the end of a unittest run."""
    ran = RAN.findall(text)
    results = RESULT.findall(text)
    found = {"tests": int(ran[-1]) if ran else 0, "failures": 0, "errors": 0, "skipped": 0,
             "expected failures": 0, "unexpected successes": 0,
             "ok": bool(results) and results[-1][0] == "OK"}
    if results and results[-1][1]:
        for part in results[-1][1].split(","):
            name, _, value = part.strip().partition("=")
            if name in found and value.isdigit():
                found[name] = int(value)
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", type=Path, help="the test file, for example firmware/tests/hil/test_board.py")
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1),
                        help="how many processes (default: 4, or fewer CPUs)")
    parser.add_argument("--split-classes", action="store_true",
                        help="hand out single tests rather than whole classes: for files whose tests "
                             "do not depend on running in order")
    args = parser.parse_args()

    folder = args.file.resolve().parent
    module = args.file.stem
    sys.path.insert(0, str(folder))
    ids = list(test_ids(unittest.defaultTestLoader.loadTestsFromName(module)))
    if not ids:
        sys.exit(f"run_sharded: no tests in {args.file}")
    shards = (shards_by_test if args.split_classes else shards_by_class)(ids, max(1, args.jobs))

    def run(shard):
        return subprocess.run([sys.executable, "-m", "unittest", *shard], cwd=folder,
                              capture_output=True, text=True, check=False)

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(shards)) as pool:
        finished = list(pool.map(run, shards))
    seconds = time.monotonic() - started

    total = defaultdict(int)
    passed = True
    for index, process in enumerate(finished):
        output = process.stdout + process.stderr
        found = counts(output)
        for key in ("tests", "failures", "errors", "skipped", "expected failures", "unexpected successes"):
            total[key] += found[key]
        if process.returncode != 0 or not found["ok"]:
            passed = False
            print(f"---- process {index + 1} of {len(shards)} ----", flush=True)
            print(output, flush=True)

    if total["tests"] != len(ids):
        passed = False
        print(f"run_sharded: {len(ids)} tests were handed out and {total['tests']} ran")

    details = ", ".join(f"{key}={total[key]}"
                        for key in ("failures", "errors", "skipped", "expected failures", "unexpected successes")
                        if total[key])
    print("-" * 70)
    print(f"Ran {total['tests']} tests in {seconds:.3f}s, in {len(shards)} processes")
    print()
    if passed:
        print(f"OK ({details})" if details else "OK")
    else:
        print(f"FAILED ({details})" if details else "FAILED")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
