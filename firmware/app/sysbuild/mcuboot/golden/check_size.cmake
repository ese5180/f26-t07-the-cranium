#
# After the bootloader's link: its code has to end below the golden image's state page at 0xf000
# (CMakeLists.txt). Run as cmake -DIMAGE=<zephyr.bin> -DLIMIT=<bytes> -P check_size.cmake.
#
file(SIZE ${IMAGE} size)
if(size GREATER LIMIT)
  message(FATAL_ERROR "The bootloader is ${size} bytes, and it has to end below ${LIMIT}: the last page "
                      "of its partition holds the golden image's pin and counter. See firmware/README.md.")
endif()
message(STATUS "Bootloader: ${size} bytes, of ${LIMIT} before the golden image's state page")
