#
# Cranium firmware, Matter variant: the board as Matter commissioner and Thread border router
# (docs/matter-thread.md). A separate application from firmware/app, with the same version number: VERSION
# here is a link to firmware/app/VERSION.
#
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(cranium_matter LANGUAGES C CXX)

include(${ZEPHYR_CONNECTEDHOMEIP_MODULE_DIR}/config/nrfconnect/app/enable-gnu-std.cmake)
# The code generator for the data model (src/default_zap), from the SDK's Matter build helpers.
include(${ZEPHYR_NRF_MODULE_DIR}/samples/matter/common/cmake/data_model.cmake)
include(${ZEPHYR_NRF_MODULE_DIR}/samples/matter/common/cmake/zap_helpers.cmake)
ncs_get_zap_parent_dir(ZAP_PARENT_DIR)

if(NOT CONFIG_CHIP_CONTROLLER)
  message(FATAL_ERROR "CONFIG_CHIP_CONTROLLER is missing: the SDK has not been patched. Run "
                      "python3 -I firmware/matter/sdk/patch_sdk.py on a copy of the SDK (docs/matter-thread.md).")
endif()

target_sources(app PRIVATE
  src/main.cpp
  src/controller_client.cpp
  src/ble_central.cpp
  src/controller_shell.cpp
  src/thread_srp.cpp
  src/attestation.cpp
  src/empty_provider.cpp
  src/stubs.cpp
  src/policy/matter_policy.c
)
target_sources_ifdef(CONFIG_CRANIUM_MATTER_BORDER_ROUTER app PRIVATE src/border_router.c)

target_include_directories(app PRIVATE src src/policy ${ZAP_PARENT_DIR})
zephyr_include_directories(src)

# stubs.cpp stands in for the OTA requestor the Matter library expects until the board has one.
zephyr_link_libraries(-Wl,--allow-multiple-definition)

ncs_configure_data_model()
