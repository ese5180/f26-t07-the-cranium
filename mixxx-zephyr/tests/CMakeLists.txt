# Host tests for the engine:
#   cmake -S mixxx-zephyr/tests -B build/mz-tests && cmake --build build/mz-tests
#   build/mz-tests/mz_tests
cmake_minimum_required(VERSION 3.20)
project(mixxx_zephyr_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

find_package(Python3 REQUIRED COMPONENTS Interpreter)
include(${CMAKE_CURRENT_LIST_DIR}/../engine/engine.cmake)

add_executable(mz_tests
  test_main.cpp
  test_reference.cpp
  test_dsp.cpp
  test_storage.cpp
  test_engine.cpp
  test_midi.cpp
  mixxx_reference/engine/enginexfader.cpp)
mz_add_engine(mz_tests ${Python3_EXECUTABLE})
target_include_directories(mz_tests PRIVATE ${CMAKE_CURRENT_LIST_DIR} mixxx_reference)
target_compile_options(mz_tests PRIVATE -Wall -Wextra -Wno-unused-parameter
  -fsanitize=address,undefined -fno-omit-frame-pointer)
target_link_options(mz_tests PRIVATE -fsanitize=address,undefined)

enable_testing()
add_test(NAME mz_tests COMMAND mz_tests)
