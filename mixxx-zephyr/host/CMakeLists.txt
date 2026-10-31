# The engine on a computer, to hear it without hardware:
#   cmake -S mixxx-zephyr/host -B build/mz-host && cmake --build build/mz-host
#   build/mz-host/mz_render a.wav b.wav mix.wav 20
cmake_minimum_required(VERSION 3.20)
project(mixxx_zephyr_host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Python3 REQUIRED COMPONENTS Interpreter)
include(${CMAKE_CURRENT_LIST_DIR}/../engine/engine.cmake)

add_executable(mz_render mz_render.cpp)
mz_add_engine(mz_render ${Python3_EXECUTABLE})
target_compile_options(mz_render PRIVATE -Wall -Wextra -Wno-unused-parameter)
