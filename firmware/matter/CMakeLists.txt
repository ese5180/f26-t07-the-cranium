#
# Cranium firmware, Matter variant: the board as Matter commissioner and Thread border router
# (docs/matter-thread.md). A separate application from firmware/app, with the same version number: VERSION
# here is a link to firmware/app/VERSION.
#
# The Matter commissioner is this project's own (src/matter/): connectedhomeip's controller does not fit next to
# Wi-Fi and the border router in the nRF5340's flash.
#
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(cranium_matter)

target_sources(app PRIVATE
  src/main.c
  src/ot_leader.c
  src/matter_shell.c
  src/policy/matter_policy.c
  src/matter/mt_tlv.c
  src/matter/mt_btp.c
  src/matter/mt_msg.c
  src/matter/mt_im.c
  src/matter/mt_pase_msg.c
  src/matter/mt_crypto.c
  src/matter/mt_ble.c
  src/matter/mt_ble_adv.c
  src/matter/mt_commission.c
  src/matter/mt_der.c
  src/matter/mt_cert.c
  src/matter/mt_attest.c
  src/matter/mt_test_paa.c
  src/matter/mt_fabric.c
  src/matter/mt_case_msg.c
  src/matter/mt_controller.c
  src/matter/mt_bdx.c
  src/matter/mt_ota.c
  src/matter/mt_ota_store.c
  src/matter/mt_server.c
  src/matter/mt_identity.c
  src/matter/mt_node.c
  src/matter/mt_csr.c
  src/matter/mt_dev_im.c
  src/matter/mt_peripheral.c
  src/matter/mt_ota_req.c
  src/matter_node.c
  src/matter_selftest.c
)
target_include_directories(app PRIVATE src src/policy src/matter)

# The board's Matter TEST device credentials (DAC, its key, PAI, certification declaration), generated from the
# Matter SDK in the build's SDK at configure time, so that no key is kept in this repository.
set(cranium_test_creds ${CMAKE_CURRENT_BINARY_DIR}/mt_test_credentials.c)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
execute_process(
  COMMAND ${Python3_EXECUTABLE} -I ${CMAKE_CURRENT_LIST_DIR}/scripts/gen_test_credentials.py
          ${ZEPHYR_CONNECTEDHOMEIP_MODULE_DIR} ${cranium_test_creds}
  RESULT_VARIABLE cranium_creds_result)
if(NOT cranium_creds_result EQUAL 0)
  message(FATAL_ERROR "The Matter SDK's test credentials could not be read (scripts/gen_test_credentials.py)")
endif()
target_sources(app PRIVATE ${cranium_test_creds})

if(CONFIG_CRANIUM_MATTER_BORDER_ROUTER)
  target_sources(app PRIVATE src/border_router.c)

  # The border router's platform code for OpenThread: the backbone interface, the UDP and mDNS sockets.
  # Zephyr has it in modules/openthread/platform, but this SDK builds OpenThread's platform from its own list
  # (nrf/modules/openthread/platform), which leaves these out, so this application builds them, patched for this
  # SDK's OpenThread (sdk/patch_sdk.py). src/br/br_unused.c stands in for the parts left out.
  set(ot_platform ${ZEPHYR_BASE}/modules/openthread/platform)
  target_sources(app PRIVATE
    ${ot_platform}/infra_if.c
    ${ot_platform}/udp.c
    ${ot_platform}/mdns_socket.c
    src/br/br_unused.c
  )
  target_include_directories(app PRIVATE
    ${ot_platform}
    ${ZEPHYR_BASE}/subsys/net/ip
    ${ZEPHYR_BASE}/subsys/net/lib/sockets
    ${ZEPHYR_BASE}/subsys/net/lib/dns
    ${ZEPHYR_OPENTHREAD_MODULE_DIR}/src/core
  )
  target_link_libraries(app PRIVATE ot-config)
  # Zephyr's OpenThread start-up code includes the border router's header from here.
  zephyr_include_directories(${ZEPHYR_BASE}/subsys/net/l2/openthread ${ot_platform})
endif()
