#
# Built into MCUboot only. With CONFIG_CRANIUM_GOLDEN off, the golden image adds nothing to it, and
# the one file built is the check on serial recovery's image number, which CONFIG_BOOT_FLASH_AREA_HOOKS
# in sysbuild/mcuboot/prj.conf calls for.
#
# src/golden.c includes src/bootutil_priv.h, which is private to MCUboot. The SDK is pinned,
# and an update that changes that header breaks this build loudly rather than silently.
#
# Promotion over the air (firmware/README.md, "Golden image") is built in when the golden public key
# is in firmware/keys/golden_promote_pub.pem, or in the file the environment variable
# CRANIUM_GOLDEN_PROMOTE_KEY names (CI uses a throwaway key that way, outside the tree). Its private
# key is kept offline, never in this repository: tools/golden_promote.py genkey makes the pair.
# Without a key the bootloader has the gesture only, as before 1.22.0, and says so here.
#

zephyr_library()
zephyr_library_sources(src/image_number_guard.c)
zephyr_library_sources_ifdef(CONFIG_CRANIUM_GOLDEN src/golden.c src/golden_policy.c src/golden_record.c)
zephyr_library_link_libraries(MCUBOOT_BOOTUTIL)

if(CONFIG_CRANIUM_GOLDEN)
  if(DEFINED ENV{CRANIUM_GOLDEN_PROMOTE_KEY})
    set(golden_key_pem $ENV{CRANIUM_GOLDEN_PROMOTE_KEY})
  else()
    set(golden_key_pem ${CMAKE_CURRENT_LIST_DIR}/../../../../keys/golden_promote_pub.pem)
  endif()
  if(EXISTS ${golden_key_pem})
    set(golden_key_dir ${CMAKE_CURRENT_BINARY_DIR}/golden_key)
    file(MAKE_DIRECTORY ${golden_key_dir})
    execute_process(
      COMMAND ${PYTHON_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/../../../../../tools/golden_promote.py
              c-key --key ${golden_key_pem} --out ${golden_key_dir}/golden_key.h
      RESULT_VARIABLE golden_key_result)
    if(NOT golden_key_result EQUAL 0)
      message(FATAL_ERROR "${golden_key_pem} is not an ECDSA P-256 public key")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${golden_key_pem})
    zephyr_library_include_directories(${golden_key_dir})
    zephyr_library_compile_definitions(CRANIUM_GOLDEN_PROMOTE=1)
    message(STATUS "Golden image: promotion over the air, with the key in ${golden_key_pem}")
  else()
    message(WARNING "Golden image: no firmware/keys/golden_promote_pub.pem, so this bootloader has the "
                    "gesture only and ignores promotion records. See firmware/README.md, \"Golden image\".")
  endif()
endif()

# The last 4 KiB page of the bootloader's 64 KiB holds the golden image's pin and counter, so its code
# must end below 0xf000. The flash map's code partition stays 64 KiB, so that the write protection
# still covers that page: this checks the linked image instead.
if(CONFIG_CRANIUM_GOLDEN)
  set_property(GLOBAL APPEND PROPERTY extra_post_build_commands
    COMMAND ${CMAKE_COMMAND} -DIMAGE=${ZEPHYR_BINARY_DIR}/${KERNEL_BIN_NAME} -DLIMIT=61440
            -P ${CMAKE_CURRENT_LIST_DIR}/check_size.cmake)
endif()
