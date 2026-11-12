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
  src/policy/matter_policy.c
)
target_include_directories(app PRIVATE src src/policy src/matter)

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
