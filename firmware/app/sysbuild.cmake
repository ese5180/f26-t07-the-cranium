#
# Sysbuild hooks.
#

# Fail early, with a useful message, when the signing key is missing.
set(cranium_signing_key "${APP_DIR}/../../secrets/mcuboot_signing_key.pem")
if(NOT EXISTS "${cranium_signing_key}")
  message(FATAL_ERROR
    "Firmware signing key not found at ${cranium_signing_key}\n"
    "Run `python tools/keys.py generate` to create one, or place the team key there. "
    "The key is deliberately not stored in the repository.")
endif()

# Building the network-core image does not start that core: the application has to
# release it from reset and hand over the LED pin.
if(SB_CONFIG_NETCORE_BLINKY)
  set_config_bool(${DEFAULT_IMAGE} CONFIG_SOC_NRF53_CPUNET_ENABLE y)
endif()
