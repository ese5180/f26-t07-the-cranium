#
# Cranium firmware: application-core image (TF-M + non-secure application).
#
# Based on the nRF Connect SDK v3.4.0 sample samples/net/aws_iot
# (Copyright (c) 2020 Nordic Semiconductor ASA, LicenseRef-Nordic-5-Clause).
#

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(cranium_app)

# From 1.13.0 every signed image says what it is compatible with, in protected TLVs: the board type
# with tag 0xa1 and the flash layout with tag 0xa2 (Kconfig's CRANIUM_BOARD_TLV and
# CRANIUM_LAYOUT_TLV), and the diagnostics report says both too. They come from
# CONFIG_APP_BOARD_TYPE and CONFIG_APP_IMAGE_LAYOUT: an image without them, or with others in it, is
# not built. The image was signed with these arguments inside find_package() above, so this only
# stops what follows. That the layout number is the one of these partitions, sysbuild.cmake checks.
if(CONFIG_APP_BOARD_TYPE STREQUAL "")
  message(FATAL_ERROR "No board type for ${BOARD}${BOARD_QUALIFIERS}: give it one in APP_BOARD_TYPE "
                      "(firmware/app/Kconfig) and in docs/fleet.md")
endif()
if(NOT CONFIG_APP_IMAGE_LAYOUT GREATER 0)
  message(FATAL_ERROR "No flash layout for ${BOARD}${BOARD_QUALIFIERS}: give it a number in "
                      "APP_IMAGE_LAYOUT (firmware/app/Kconfig) and its partitions in "
                      "firmware/app/flash_layouts.json")
endif()
if(CONFIG_BOOTLOADER_MCUBOOT AND
   (NOT CONFIG_MCUBOOT_EXTRA_IMGTOOL_ARGS MATCHES "(^| )--custom-tlv 0xa1 ${CONFIG_APP_BOARD_TYPE}( |$)" OR
    NOT CONFIG_MCUBOOT_EXTRA_IMGTOOL_ARGS MATCHES "(^| )--custom-tlv 0xa2 ${CONFIG_APP_IMAGE_LAYOUT}( |$)"))
  message(FATAL_ERROR "The signed image has to carry its board type and flash layout: "
                      "CONFIG_MCUBOOT_EXTRA_IMGTOOL_ARGS must have --custom-tlv 0xa1 ${CONFIG_APP_BOARD_TYPE} "
                      "and --custom-tlv 0xa2 ${CONFIG_APP_IMAGE_LAYOUT}, and it is "
                      "\"${CONFIG_MCUBOOT_EXTRA_IMGTOOL_ARGS}\"")
endif()

if(NOT CONFIG_APP_BT_ONLY)
target_sources(app PRIVATE
  src/main.c
  src/cloud/cloud.c
  src/cloud/command.c
  src/device.c
  src/diag.c
  src/factory.c
  src/health.c
  src/identity.c
  src/policy/join_policy.c
  src/net.c
  src/ota/ota.c
  src/ota/ota_job.c
  src/reset_cause.c
  src/store.c
  src/stuck.c
  src/policy/stuck_policy.c
  src/ui.c
  src/ota/version.c
)
# Golden image promotion (src/ota/golden_promote.h), with the record's format from the bootloader's
# own code, so that the two read the same bytes.
target_sources_ifdef(CONFIG_APP_GOLDEN_PROMOTE app PRIVATE
  src/ota/golden_promote.c
  src/policy/golden_job_policy.c
  sysbuild/mcuboot/golden/src/golden_record.c
)
else()
# A board with Bluetooth only: its own main loop and update manager, and no network or cloud at all.
# src/bt_only/bt_only_stubs.c answers what the shared code asks of Wi-Fi and the cloud with "there is none".
# The console reads the reset cause from src/reset_cause.c, as on the nRF7002 DK.
target_sources(app PRIVATE
  src/bt_only/bt_only_leds.c
  src/bt_only/bt_only_main.c
  src/bt_only/bt_only_ota.c
  src/bt_only/bt_only_stubs.c
  src/device.c
  src/factory.c
  src/health.c
  src/identity.c
  src/reset_cause.c
  src/store.c
  src/ui.c
  src/ota/version.c
)
endif()

# On every board: what a stored record of an update means after a restart, and what an image is
# compatible with (image_compat.h), for ota.c and bt_ota.c.
target_sources(app PRIVATE
  src/ota/image_compat.c
  src/ota/image_compat_slot.c
  src/ota/ota_outcome.c
)

target_sources_ifdef(CONFIG_APP_CONSOLE app PRIVATE
  src/console.c
  src/console_cmd.c
  src/console_parser.c
  src/console_stream.c
)

# Creating the device key for AWS IoT: there is no AWS IoT on a board with Bluetooth only.
if(CONFIG_APP_CONSOLE AND NOT CONFIG_APP_BT_ONLY)
  target_sources(app PRIVATE src/console_keys.c)
endif()

target_sources_ifdef(CONFIG_APP_BT_OTA app PRIVATE
  src/bt/bt_ota.c
  src/policy/bt_ota_policy.c
  src/bt/bt_status.c
)
target_sources_ifdef(CONFIG_APP_BT_OFFLINE app PRIVATE
  src/bt/bt_offline.c
  src/policy/bt_offline_policy.c
)
target_sources_ifdef(CONFIG_APP_BT_STATIC_PASSKEY app PRIVATE
  src/bt/bt_passkey.c
  src/policy/bt_passkey_policy.c
)

# MCUmgr's image header needs MCUboot's.
if(CONFIG_APP_BT_OTA)
  target_link_libraries(app PRIVATE MCUBOOT_BOOTUTIL)
endif()

# Only bt_ota.conf turns Bluetooth on. Without the console APP_BT_OTA stays off, which Kconfig only
# warns about, and this would be an image with a Bluetooth host and nobody to read a passkey.
if(CONFIG_BT AND NOT CONFIG_APP_BT_OTA)
  message(FATAL_ERROR "Firmware update over Bluetooth needs the console: CONFIG_APP_CONSOLE is off")
endif()

# Memfault's chunks go over AWS IoT (docs/memfault.md), which a board with Bluetooth only does not have.
if(CONFIG_APP_BT_ONLY AND CONFIG_MEMFAULT)
  message(FATAL_ERROR "A board with Bluetooth only has no AWS IoT to send Memfault's chunks over: "
                      "CONFIG_MEMFAULT must be off")
endif()

# sysbuild.cmake gives the nRF5340 DK prj_bt_only.conf. A CONF_FILE of one's own must have it too.
if(CONFIG_BOARD_NRF5340DK AND NOT CONFIG_APP_BT_ONLY)
  message(FATAL_ERROR "The nRF5340 DK has no Wi-Fi chip: it builds with prj_bt_only.conf, and "
    "Bluetooth only. A CONF_FILE given on the command line replaced it.")
endif()

# Nothing of the cloud in an image with Bluetooth only: no heartbeat, no shadow, no MQTT, no downloader.
# bt_only_check.py looks at the linked image, and the build fails if any of it is there. A target of its
# own after the link: Zephyr reads extra_post_build_commands before this file gets that far.
if(CONFIG_APP_BT_ONLY)
  add_custom_target(cranium_bt_only_check ALL
    COMMAND ${PYTHON_EXECUTABLE} -I ${CMAKE_CURRENT_LIST_DIR}/bt_only_check.py
            --nm ${CMAKE_NM} --elf ${CMAKE_BINARY_DIR}/zephyr/${KERNEL_ELF_NAME}
            --bin ${CMAKE_BINARY_DIR}/zephyr/${KERNEL_BIN_NAME}
    COMMENT "Checking that nothing of the cloud is in this image"
    VERBATIM)
  add_dependencies(cranium_bt_only_check ${logical_target_for_zephyr_elf})
endif()

target_sources_ifndef(CONFIG_APP_CONSOLE app PRIVATE src/log_discard.c)

# The driver's recovery would power the chip back up, so the timer under test would never fire.
target_sources_ifdef(CONFIG_APP_TEST_FAULT_WIFI_DEAD app PRIVATE src/fault_wifi.c)
target_sources_ifdef(CONFIG_APP_BOOT_DIARY app PRIVATE src/boot_diary.c)
target_sources_ifdef(CONFIG_APP_CLOUD_EVENTS app PRIVATE src/cloud/cloud_events.c)
target_sources_ifdef(CONFIG_APP_LOCATION app PRIVATE src/cloud/location.c)
target_sources_ifdef(CONFIG_APP_SESSIONS app PRIVATE src/cloud/sessions.c)
if(CONFIG_APP_TEST_FAULT_WIFI_DEAD AND CONFIG_NRF_WIFI_RPU_RECOVERY)
  message(FATAL_ERROR "APP_TEST_FAULT_WIFI_DEAD needs -Dapp_CONFIG_NRF_WIFI_RPU_RECOVERY=n as well")
endif()

# Memfault, from 1.14.0 (docs/memfault.md). The SDK looks for its three configuration files on the
# include path of each of its libraries, so this directory goes on every one. What it keeps across a
# reset has to be in the two memory regions of the board's overlay, at the same address in every
# image; prj.conf names them, and this stops a build that would put them anywhere else.
if(CONFIG_MEMFAULT)
  zephyr_include_directories(config)
endif()
target_sources_ifdef(CONFIG_APP_MEMFAULT app PRIVATE src/mflt/mflt.c src/mflt/mflt_link.c)
if(CONFIG_APP_MEMFAULT AND
   (NOT CONFIG_MEMFAULT_RAM_BACKED_COREDUMP OR
    NOT CONFIG_MEMFAULT_RAM_BACKED_COREDUMP_REGION STREQUAL "MFLT_COREDUMP" OR
    NOT CONFIG_MEMFAULT_REBOOT_TRACKING_REGION STREQUAL "MFLT_REBOOT"))
  message(FATAL_ERROR "Memfault's coredump and reboot reason must be in the regions MFLT_COREDUMP "
                      "and MFLT_REBOOT of the board's overlay: see prj.conf")
endif()
# The board never talks to Memfault itself, and its image carries no project key.
if(CONFIG_APP_MEMFAULT AND (CONFIG_MEMFAULT_HTTP_ENABLE OR NOT CONFIG_MEMFAULT_NCS_PROJECT_KEY STREQUAL ""))
  message(FATAL_ERROR "The Memfault chunks go over AWS IoT: no HTTP client and no project key in the "
                      "image (CONFIG_MEMFAULT_HTTP_ENABLE, CONFIG_MEMFAULT_NCS_PROJECT_KEY)")
endif()

zephyr_linker_sources_ifdef(CONFIG_LOG SECTIONS src/log_backend_check.ld)

# The sources are grouped in folders under src/ (src/README.md); each folder is on the include path, so
# an #include names only the header.
target_include_directories(app PRIVATE
  src
  src/bt
  src/bt_only
  src/cloud
  src/mflt
  src/ota
  src/policy
  sysbuild/mcuboot/golden/src
)
