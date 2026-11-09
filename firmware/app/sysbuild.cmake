#
# Sysbuild hooks.
#

# Fail early, with a useful message, when the signing key is missing.
if("$ENV{HOME}" STREQUAL "")
  message(FATAL_ERROR
    "The HOME environment variable is not set. The firmware signing key is read from "
    "HOME/.cranium; on Windows set HOME to your user profile directory.")
endif()
set(cranium_signing_key "$ENV{HOME}/.cranium/mcuboot_signing_key.pem")
if(DEFINED CRANIUM_BOOTLOADER_KEY)
  # A build without the signing key (scripts/firmware/build.sh --without-key), to set up a board: the
  # bootloader takes this public key, the team's, and the application is signed with the throwaway key
  # given as SB_CONFIG_BOOT_SIGNATURE_KEY_FILE, which that bootloader refuses. imgtool reads a public key
  # for the bootloader's copy of it as well as a private one.
  if(NOT EXISTS "${CRANIUM_BOOTLOADER_KEY}")
    message(FATAL_ERROR "CRANIUM_BOOTLOADER_KEY names no file: ${CRANIUM_BOOTLOADER_KEY}")
  endif()
  set_config_string(mcuboot CONFIG_BOOT_SIGNATURE_KEY_FILE "${CRANIUM_BOOTLOADER_KEY}")
elseif(NOT EXISTS "${cranium_signing_key}")
  message(FATAL_ERROR
    "Firmware signing key not found at ${cranium_signing_key}\n"
    "Place the team key there (secrets/README.md), or set up a board without it: "
    "scripts/firmware/build.sh --keep --no-upload --without-key. Never make a new one: no board would take "
    "its images. The key is deliberately kept outside the repository.")
endif()

# Building the network-core image does not start that core: the application has to
# release it from reset.
if(SB_CONFIG_NETCORE_BLINKY)
  set_config_bool(${DEFAULT_IMAGE} CONFIG_SOC_NRF53_CPUNET_ENABLE y)
endif()

# The nRF5340 DK has no Wi-Fi chip. Its application starts from prj_bt_only.conf, which has no network
# stack, no AWS IoT and no downloader, and not from prj.conf, which is about the cloud. The image itself
# only learns its board inside find_package(Zephyr), too late to choose, so the choice is made here.
# Naming CONF_FILE leaves out Zephyr's search for boards/<board>.conf, so the board's file is named too.
# A -Dapp_CONF_FILE of one's own goes first.
if(SB_CONFIG_BOARD_NRF5340DK AND NOT DEFINED CACHE{${DEFAULT_IMAGE}_CONF_FILE})
  set(${DEFAULT_IMAGE}_CONF_FILE
    "${CMAKE_CURRENT_LIST_DIR}/prj_bt_only.conf;${CMAKE_CURRENT_LIST_DIR}/boards/nrf5340dk_nrf5340_cpuapp_ns.conf"
    CACHE INTERNAL "The configuration of a board with Bluetooth only")
endif()

# A board with Bluetooth only updates that way or over USB, and has nothing else: without it, no
# update could ever reach it.
if(SB_CONFIG_BOARD_NRF5340DK AND NOT SB_CONFIG_APP_BT_OTA)
  message(FATAL_ERROR "The nRF5340 DK has Bluetooth only: it cannot be built with no_bt_sysbuild.conf")
endif()

# Firmware update over Bluetooth LE, off unless bt_ota_sysbuild.conf is given.
# From 1.16.0: Raspberry Pi images (docs/pi-ota.md). Only with Wi-Fi and the cloud, and not with
# Bluetooth, which the RAM does not hold as well: the link would fail with less to go on.
if(SB_CONFIG_APP_PI_OTA)
  if(SB_CONFIG_BOARD_NRF5340DK)
    message(FATAL_ERROR "The nRF5340 DK has no cloud, so no Pi image job reaches it: "
                        "it cannot be built with pi_ota_sysbuild.conf")
  endif()
  if(SB_CONFIG_APP_BT_OTA)
    message(FATAL_ERROR "SB_CONFIG_APP_PI_OTA and SB_CONFIG_APP_BT_OTA do not fit the RAM together: "
                        "use pi_ota_sysbuild.conf, which turns Bluetooth off (docs/pi-ota.md, \"Memory\")")
  endif()
  add_overlay_config(${DEFAULT_IMAGE} "${CMAKE_CURRENT_LIST_DIR}/pi_ota.conf")
  set(${DEFAULT_IMAGE}_EXTRA_DTC_OVERLAY_FILE "${CMAKE_CURRENT_LIST_DIR}/boards/pi_ota.overlay"
      CACHE INTERNAL "The SPI bus of the SD card and the Raspberry Pi, turned on")
endif()
if(SB_CONFIG_APP_BT_OTA)
  if(NOT SB_CONFIG_NETCORE_HCI_IPC)
    message(FATAL_ERROR "SB_CONFIG_APP_BT_OTA needs SB_CONFIG_NETCORE_HCI_IPC: use bt_ota_sysbuild.conf")
  endif()
  add_overlay_config(${DEFAULT_IMAGE} "${CMAKE_CURRENT_LIST_DIR}/bt_ota.conf")
endif()

# The golden image is a module of MCUboot, not of this application: it has to live with the
# bootloader's own code. With CONFIG_CRANIUM_GOLDEN off the golden image adds nothing to it, and
# the module still holds the bootloader's check on serial recovery's image number.
set(mcuboot_EXTRA_ZEPHYR_MODULES "${CMAKE_CURRENT_LIST_DIR}/sysbuild/mcuboot/golden" CACHE INTERNAL "")

# Keep the signed image of every build of this checkout in binaries/, where scripts/firmware/ota.sh
# and the console's upload page can find it. See tools/store_binary.py.
get_filename_component(cranium_repo "${APP_DIR}/../.." ABSOLUTE)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

# From 1.13.0 the image says its flash layout (TLV 0xa2, CONFIG_APP_IMAGE_LAYOUT), and a board
# refuses an image of another. flash_layout.py describes the partitions that the application and
# the bootloader were built with, from their final devicetrees, and stops the build unless they are
# the ones firmware/app/flash_layouts.json holds for that number: a change of partitions has to come
# with a new number. Before the image is kept, so that binaries/ never gets one that says wrong.
if(SB_CONFIG_PARTITION_MANAGER)
  message(FATAL_ERROR "The flash layout check reads the devicetree's partitions, and Partition "
                      "Manager would place them elsewhere: see firmware/app/flash_layout.py")
endif()
add_custom_target(cranium_flash_layout ALL
  COMMAND ${Python3_EXECUTABLE} -I "${CMAKE_CURRENT_LIST_DIR}/flash_layout.py" check
          --zephyr-base "${ZEPHYR_BASE}"
          --config "${CMAKE_BINARY_DIR}/${DEFAULT_IMAGE}/zephyr/.config"
          --dts "${DEFAULT_IMAGE}=${CMAKE_BINARY_DIR}/${DEFAULT_IMAGE}/zephyr/zephyr.dts"
          --dts "mcuboot=${CMAKE_BINARY_DIR}/mcuboot/zephyr/zephyr.dts"
          --layouts "${CMAKE_CURRENT_LIST_DIR}/flash_layouts.json"
  COMMENT "Checking the flash layout number against the partitions"
  VERBATIM)
add_dependencies(cranium_flash_layout ${DEFAULT_IMAGE} mcuboot)

add_custom_target(cranium_store_binary ALL
  # -I: isolated mode, so nothing in tools/ or the environment can stand in for a standard module.
  COMMAND ${Python3_EXECUTABLE} -I "${cranium_repo}/tools/store_binary.py"
          --build "${CMAKE_BINARY_DIR}" --repo "${cranium_repo}"
  COMMENT "Keeping the signed image in binaries/"
  VERBATIM)
add_dependencies(cranium_store_binary ${DEFAULT_IMAGE} cranium_flash_layout)
