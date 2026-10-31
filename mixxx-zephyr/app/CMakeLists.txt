cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(mixxx_zephyr)

# The engine's sizes come from Kconfig.
zephyr_compile_definitions(
  MZ_CHUNK_FRAMES=${CONFIG_MZ_CHUNK_FRAMES}
  MZ_CHUNKS_PER_DECK=${CONFIG_MZ_CHUNKS_PER_DECK}
  MZ_MAX_BLOCK_FRAMES=${CONFIG_MZ_BLOCK_FRAMES}
  MZ_MAX_TRACKS=${CONFIG_MZ_MAX_TRACKS})

include(${CMAKE_CURRENT_SOURCE_DIR}/../engine/engine.cmake)
mz_add_engine(app ${PYTHON_EXECUTABLE})

target_sources(app PRIVATE
  src/main.cpp
  src/audio_out.cpp
  src/midi_uart.cpp
  src/sd_storage.cpp)
