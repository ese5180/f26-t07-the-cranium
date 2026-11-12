#
# Sysbuild hooks of the Matter variant.
#

# The border router: Wi-Fi and Zephyr's OpenThread border router, from border_router.conf.
if(SB_CONFIG_CRANIUM_BORDER_ROUTER)
  if(NOT SB_CONFIG_BOARD_NRF7002DK)
    message(FATAL_ERROR "The border router needs Wi-Fi: only the nRF7002 DK has it")
  endif()
  add_overlay_config(${DEFAULT_IMAGE} "${CMAKE_CURRENT_LIST_DIR}/border_router.conf")
endif()
