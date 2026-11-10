# Tests for the parts of the firmware that take input from outside the device, such as the update
# client's job parser and the serial console, and for what it decides by itself, such as when it
# restarts. They are plain C with no hardware dependency, so they run on the build machine, with
# the address and undefined-behaviour sanitizers on:
#
#   make -C firmware/tests/host
#
# cJSON and the base64 library are taken from the nRF Connect SDK checkout (the same source
# the firmware uses), or from what firmware/tests/fetch-sdk-files.sh fetches of it.

ZEPHYR_BASE ?= $(error ZEPHYR_BASE is not set: run this from an nRF Connect SDK terminal)
CJSON_DIR ?= $(ZEPHYR_BASE)/../modules/lib/cjson
SRC := ../../app/src
BUILD := build

CC ?= cc
SANITIZE := -fsanitize=address,undefined -fno-sanitize-recover=undefined
# The firmware's sources are in folders under src/, each on the include path, as in its CMakeLists.txt.
SRC_DIRS := $(SRC) $(addprefix $(SRC)/,bt bt_only cloud mflt ota pi policy)
CFLAGS := -std=c11 -O1 -g $(SANITIZE) $(addprefix -I,$(SRC_DIRS)) -Istubs -I$(CJSON_DIR)
WARNINGS := -Wall -Wextra -Werror

# What the console's code expects from Kconfig.
CONSOLE_DEFINES := -D_GNU_SOURCE -DCONFIG_APP_CONSOLE=1 -DCONFIG_APP_CLOUD_EVENTS=1 -DCONFIG_APP_LOG_LEVEL=0 \
	-DCONFIG_APP_THING_NAME_PREFIX=\"cranium-\" -DCONFIG_MQTT_HELPER_SEC_TAG=201 \
	-DCONFIG_APP_DOWNLOAD_SEC_TAG=202 -DCONFIG_MQTT_HELPER_PORT=8883 -DCONFIG_MQTT_KEEPALIVE=120 \
	-DCONFIG_APP_LOCATION=1 -DCONFIG_APP_BOARD_TYPE=\"nrf7002dk\" -DCONFIG_APP_IMAGE_LAYOUT=1
CONSOLE_SOURCES := $(SRC)/console_cmd.c $(SRC)/console_parser.c $(SRC)/console_stream.c \
	$(SRC)/device.c $(SRC)/factory.c $(SRC)/identity.c $(SRC)/ota/version.c console_fakes.c
CONSOLE_HEADERS := $(wildcard $(addsuffix /*.h,$(SRC_DIRS))) console_fakes.h

.PHONY: test clean
test: $(BUILD)/host_tests $(BUILD)/console_tests $(BUILD)/console_output_tests $(BUILD)/app_tests $(BUILD)/console_sim \
		$(BUILD)/ui_tests $(BUILD)/golden_policy_tests $(BUILD)/bt_ota_policy_tests $(BUILD)/bt_status_tests \
		$(BUILD)/bt_ota_tests $(BUILD)/ota_bt_tests $(BUILD)/ota_bt_no_consent_tests $(BUILD)/ota_bt_no_confirm_tests \
		$(BUILD)/console_bt_tests $(BUILD)/app_bt_tests $(BUILD)/ui_bt_tests \
		$(BUILD)/stuck_policy_tests $(BUILD)/join_policy_tests $(BUILD)/console_fault_tests \
		$(BUILD)/fault_wifi_tests $(BUILD)/fault_wifi_command_tests $(BUILD)/app_fault_tests \
		$(BUILD)/console_sim_fault $(BUILD)/cloud_tests $(BUILD)/cloud_events_tests \
		$(BUILD)/command_tests $(BUILD)/location_tests $(BUILD)/location_bt_tests $(BUILD)/image_compat_tests \
		$(BUILD)/command_mflt_tests $(BUILD)/mflt_link_tests $(BUILD)/reset_cause_tests \
		$(BUILD)/bt_passkey_policy_tests $(BUILD)/bt_passkey_tests \
		$(BUILD)/bt_only_tests $(BUILD)/bt_only_ota_tests $(BUILD)/console_bt_only_tests \
		$(BUILD)/bt_only_leds_tests $(BUILD)/pi_ota_tests $(BUILD)/ota_pi_tests $(BUILD)/pi_link_harness
	./$(BUILD)/host_tests
	./$(BUILD)/console_tests
	./$(BUILD)/console_output_tests
	./$(BUILD)/app_tests
	./$(BUILD)/ui_tests
	./$(BUILD)/golden_policy_tests
	./$(BUILD)/bt_ota_policy_tests
	./$(BUILD)/bt_status_tests
	./$(BUILD)/bt_ota_tests
	./$(BUILD)/ota_bt_tests
	./$(BUILD)/ota_bt_no_consent_tests
	./$(BUILD)/ota_bt_no_confirm_tests
	./$(BUILD)/console_bt_tests
	./$(BUILD)/app_bt_tests
	./$(BUILD)/ui_bt_tests
	./$(BUILD)/stuck_policy_tests
	./$(BUILD)/join_policy_tests
	./$(BUILD)/console_fault_tests
	./$(BUILD)/fault_wifi_tests
	./$(BUILD)/fault_wifi_command_tests
	./$(BUILD)/app_fault_tests
	./$(BUILD)/cloud_tests
	./$(BUILD)/cloud_events_tests
	./$(BUILD)/command_tests
	./$(BUILD)/location_tests
	./$(BUILD)/location_bt_tests
	./$(BUILD)/image_compat_tests
	./$(BUILD)/command_mflt_tests
	./$(BUILD)/mflt_link_tests
	./$(BUILD)/reset_cause_tests
	./$(BUILD)/bt_passkey_policy_tests
	./$(BUILD)/bt_passkey_tests
	./$(BUILD)/bt_only_tests
	./$(BUILD)/bt_only_ota_tests
	./$(BUILD)/console_bt_only_tests
	./$(BUILD)/bt_only_leds_tests
	./$(BUILD)/pi_ota_tests
	./$(BUILD)/ota_pi_tests

$(BUILD)/cJSON.o: $(CJSON_DIR)/cJSON.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/base64.o: $(ZEPHYR_BASE)/lib/utils/base64.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/host_tests: test_main.c $(SRC)/ota/ota_job.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/version.c $(BUILD)/cJSON.o
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $^ -lm

$(BUILD)/console_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ $(filter %.c %.o,$^)

# console.c on a fake UART, and main.c and net.c on a fake network stack. These test files
# include the real source files, to get at what they keep static.
$(BUILD)/console_output_tests: test_console_output.c $(SRC)/console.c $(SRC)/console_parser.c $(SRC)/reset_cause.c \
		$(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ test_console_output.c $(SRC)/console_parser.c \
		$(SRC)/reset_cause.c

$(BUILD)/app_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(SRC)/diag.c $(SRC)/stuck.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c \
		$(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) -o $@ test_app.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c

# cloud.c, included by its test to get at the AWS IoT library's callback and the connection's work,
# against a fake of that library: what the console's MQTT command counts, and the topics it lists.
# With CONFIG_APP_MEMFAULT, as a board has it from 1.14.0: the memfault topic, what src/mflt/mflt.h is
# told, and a jobs reply read where it arrives, by the real job parser.
$(BUILD)/cloud_tests: test_cloud.c $(SRC)/cloud/cloud.c $(SRC)/cloud/cloud.h $(SRC)/app_events.h $(SRC)/identity.h \
		$(SRC)/cloud/cloud_events.h $(SRC)/cloud/command.h $(SRC)/cloud/location.h $(SRC)/mflt/mflt.h $(SRC)/mflt/mflt_link.h \
		$(SRC)/ota/ota_job.c $(SRC)/ota/ota_job.h $(SRC)/ota/version.c stubs/net/aws_iot.h stubs/net/mqtt_helper.h stubs/zephyr/net/mqtt.h \
		stubs/zephyr/kernel.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_MQTT_HELPER_PAYLOAD_BUFFER_LEN=4096 \
		-DCONFIG_MQTT_HELPER_RX_TX_BUFFER_SIZE=512 -DCONFIG_APP_THING_NAME_PREFIX=\"cranium-\" \
		-DCONFIG_APP_MEMFAULT=1 -DCONFIG_APP_MEMFAULT_CHUNK_MAX=400 \
		-o $@ test_cloud.c $(SRC)/ota/ota_job.c $(SRC)/ota/version.c $(BUILD)/cJSON.o -lm

# The events for the console (src/cloud/cloud_events.c), included by its test to get at the ring and the
# connection's state, against fakes of the cloud, the main loop's queue and the Wi-Fi store: what is
# never sent, what is replaced, the JSON, the ring, the limit, and when a connection may have them.
$(BUILD)/cloud_events_tests: test_cloud_events.c $(SRC)/cloud/cloud_events.c $(SRC)/cloud/cloud_events.h $(SRC)/app_events.h \
		$(SRC)/cloud/cloud.h $(SRC)/net.h $(SRC)/boot_diary.h stubs/zephyr/kernel.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_CLOUD_EVENTS=1 -DCONFIG_APP_BOOT_DIARY=1 \
		-o $@ test_cloud_events.c $(BUILD)/cJSON.o -lm

# The console's commands (src/cloud/command.c), included by its test, against fakes of the main loop's queue,
# the LEDs, the reports and the location: reading a message strictly, hostile ones above all, and what
# each command does and answers.
# The second is a build with Memfault, from 1.14.0, against fakes of src/mflt/mflt.h: the memfault command,
# and the answers for its chunks, which go past the one command that waits.
COMMAND_DEPS := test_command.c $(SRC)/cloud/command.c $(SRC)/cloud/command.h $(SRC)/cloud/location.h $(SRC)/ui.h \
	$(SRC)/app_events.h $(SRC)/console.h $(SRC)/mflt/mflt.h stubs/zephyr/kernel.h
$(BUILD)/command_tests: $(COMMAND_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_CONSOLE=1 -DCONFIG_APP_LOCATION=1 \
		-o $@ test_command.c

$(BUILD)/command_mflt_tests: $(COMMAND_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_CONSOLE=1 -DCONFIG_APP_LOCATION=1 \
		-DCONFIG_APP_MEMFAULT=1 -o $@ test_command.c

# How Memfault chunks go to the cloud (src/mflt/mflt_link.c), from 1.14.0: in order, each after its
# answer, again after no answer, and their sizes. It needs nothing but the C library.
$(BUILD)/mflt_link_tests: test_mflt_link.c $(SRC)/mflt/mflt_link.c $(SRC)/mflt/mflt_link.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_mflt_link.c $(SRC)/mflt/mflt_link.c

# Why the last boot ended (src/reset_cause.c), from 1.14.0 read once and cleared once, included by
# its test against a fake of the register.
$(BUILD)/reset_cause_tests: test_reset_cause.c $(SRC)/reset_cause.c $(SRC)/reset_cause.h stubs/host_hw.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_reset_cause.c

# Location by Wi-Fi (src/cloud/location.c), included by its test, against fakes of the Wi-Fi stack's scan, the
# cloud, the update and the main loop's queue: what is kept, the JSON, when a scan happens and what holds
# one. The second has CONFIG_APP_BT_OTA on, for the Bluetooth window.
LOCATION_DEPS := test_location.c $(SRC)/cloud/location.c $(SRC)/cloud/location.h $(SRC)/cloud/cloud.h $(SRC)/ota/ota.h \
	$(SRC)/app_events.h $(SRC)/boot_diary.h $(SRC)/bt/bt_ota.h stubs/host_net.h stubs/zephyr/kernel.h $(BUILD)/cJSON.o
$(BUILD)/location_tests: $(LOCATION_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_LOCATION=1 -DCONFIG_APP_BOOT_DIARY=1 \
		-o $@ test_location.c $(BUILD)/cJSON.o -lm

$(BUILD)/location_bt_tests: $(LOCATION_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_LOCATION=1 -DCONFIG_APP_BOOT_DIARY=1 \
		$(BT_DEFINES) -o $@ test_location.c $(BUILD)/cJSON.o -lm

# What an image is compatible with (src/ota/image_compat.c and src/ota/image_compat_slot.c), against a fake slot
# in flash: good images, legacy ones, the wrong type or layout, and every kind of broken TLV area.
$(BUILD)/image_compat_tests: test_image_compat.c $(SRC)/ota/image_compat.c $(SRC)/ota/image_compat_slot.c \
		$(SRC)/ota/image_compat.h stubs/host_bt.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -o $@ test_image_compat.c

# ui.c, included by its test to get at its input callback and its timers.
$(BUILD)/ui_tests: test_ui.c $(SRC)/ui.c $(SRC)/ui.h $(SRC)/app_events.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -o $@ test_ui.c

# What the golden image's code in the bootloader decides, and the bootloader's check on serial
# recovery's image number. They need nothing but the C library and a stub of one MCUboot header.
GOLDEN_SRC := ../../app/sysbuild/mcuboot/golden/src
$(BUILD)/golden_policy_tests: test_golden_policy.c $(GOLDEN_SRC)/golden_policy.c $(GOLDEN_SRC)/golden_policy.h \
		$(GOLDEN_SRC)/image_number_guard.c stubs/bootutil/boot_hooks.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -I$(GOLDEN_SRC) -o $@ test_golden_policy.c $(GOLDEN_SRC)/golden_policy.c \
		$(GOLDEN_SRC)/image_number_guard.c

# Firmware update over Bluetooth: what it is allowed to do, then src/bt/bt_ota.c on a fake of the
# Bluetooth host, MCUmgr and the bootloader's API. The last three are the same tests as above
# with CONFIG_APP_BT_OTA on, which is off everywhere else, to show what it changes there.
BT_DEFINES := -DCONFIG_APP_BT_OTA=1
$(BUILD)/bt_ota_policy_tests: test_bt_ota_policy.c $(SRC)/policy/bt_ota_policy.c $(SRC)/policy/bt_ota_policy.h $(SRC)/ota/version.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_bt_ota_policy.c $(SRC)/policy/bt_ota_policy.c $(SRC)/ota/version.c

# The status characteristic, from 1.14.0: its payload, byte by byte, and what the policy decides for it.
# `build/bt_status_tests --print` gives the sample payload that the phone apps' tests parse.
$(BUILD)/bt_status_tests: test_bt_status.c $(SRC)/bt/bt_status.c $(SRC)/bt/bt_status.h $(SRC)/policy/bt_ota_policy.c \
		$(SRC)/policy/bt_ota_policy.h $(SRC)/ota/version.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_bt_status.c $(SRC)/bt/bt_status.c $(SRC)/policy/bt_ota_policy.c $(SRC)/ota/version.c

# The board's own type and flash layout, for what image_compat.c compares an image with.
COMPAT_DEFINES := -DCONFIG_APP_BOARD_TYPE=\"nrf7002dk\" -DCONFIG_APP_IMAGE_LAYOUT=1
$(BUILD)/bt_ota_tests: test_bt_ota.c $(SRC)/bt/bt_ota.c $(SRC)/bt/bt_ota.h $(SRC)/policy/bt_ota_policy.c $(SRC)/policy/bt_ota_policy.h $(SRC)/bt/bt_status.c \
		$(SRC)/ota/ota_job.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/version.c $(SRC)/ota/image_compat.c $(SRC)/ota/image_compat.h stubs/host_bt.h \
		stubs/zephyr/kernel.h $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -o $@ test_bt_ota.c $(SRC)/policy/bt_ota_policy.c $(SRC)/bt/bt_status.c $(SRC)/ota/ota_job.c \
		$(SRC)/ota/ota_outcome.c $(SRC)/ota/version.c $(SRC)/ota/image_compat.c $(BUILD)/cJSON.o -lm

# What it adds to ota.c, which is compiled for this and for nothing else here, and how a job goes
# through it. The first has CONFIG_APP_OTA_REQUIRE_USER_CONSENT on, and the second has it off, as a
# build gets it by default, so that a job starts with no button. The third is a test image that never
# confirms itself.
OTA_DEPS := test_ota_bt.c $(SRC)/ota/ota.c $(SRC)/ota/ota.h $(SRC)/ota/ota_job.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/version.c \
	$(SRC)/ota/image_compat.c $(SRC)/ota/image_compat.h stubs/host_ota.h stubs/host_bt.h $(BUILD)/cJSON.o
OTA_SOURCES := test_ota_bt.c $(SRC)/ota/ota_job.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/version.c $(SRC)/ota/image_compat.c $(BUILD)/cJSON.o -lm
$(BUILD)/ota_bt_tests: $(OTA_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -o $@ $(OTA_SOURCES)

$(BUILD)/ota_bt_no_consent_tests: $(OTA_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -DTEST_NO_CONSENT=1 -o $@ $(OTA_SOURCES)

$(BUILD)/ota_bt_no_confirm_tests: $(OTA_DEPS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -DCONFIG_APP_TEST_FAULT_NO_CONFIRM=1 -o $@ $(OTA_SOURCES)

$(BUILD)/console_bt_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(BT_DEFINES) -o $@ $(filter %.c %.o,$^)

$(BUILD)/app_bt_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(SRC)/diag.c $(SRC)/stuck.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c \
		$(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(BT_DEFINES) -o $@ test_app.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c

$(BUILD)/ui_bt_tests: test_ui.c $(SRC)/ui.c $(SRC)/ui.h $(SRC)/app_events.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 $(BT_DEFINES) -o $@ test_ui.c

# A board with Bluetooth only (CONFIG_APP_BT_ONLY): the nRF5340 DK. Which board an image is for, the
# board's own passkey and its policy, the status a phone reads, bt_ota.c and bt_only_ota.c with no cloud
# at all, the console's commands there, and LED3 and LED4.
BT_ONLY_DEFINES := -DCONFIG_APP_BT_OTA=1 -DCONFIG_APP_BT_ONLY=1 -DCONFIG_APP_BT_STATIC_PASSKEY=1 \
	-DCONFIG_APP_BT_PASSKEY_FAILURE_BUDGET=3 -DCONFIG_BT_DEVICE_NAME=\"Cranium\"
CONSOLE_BT_ONLY_DEFINES := $(filter-out -DCONFIG_APP_LOCATION=1,$(subst \"nrf7002dk\",\"nrf5340dk\",$(CONSOLE_DEFINES))) \
	$(BT_ONLY_DEFINES)

$(BUILD)/bt_passkey_policy_tests: test_bt_passkey_policy.c $(SRC)/policy/bt_passkey_policy.c $(SRC)/policy/bt_passkey_policy.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_bt_passkey_policy.c $(SRC)/policy/bt_passkey_policy.c

# bt_passkey.c, included by its test to get at its state, against a fake of TF-M's protected storage.
$(BUILD)/bt_passkey_tests: test_bt_passkey.c $(SRC)/bt/bt_passkey.c $(SRC)/bt/bt_passkey.h $(SRC)/policy/bt_passkey_policy.c \
		stubs/psa/protected_storage.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 $(BT_ONLY_DEFINES) -o $@ test_bt_passkey.c \
		$(SRC)/policy/bt_passkey_policy.c

# test_bt_only.c includes test_bt_ota.c, and runs its tests that are not about the cloud on this board:
# the others are left there unused.
$(BUILD)/bt_only_tests: test_bt_only.c test_bt_ota.c $(SRC)/bt/bt_ota.c $(SRC)/bt/bt_ota.h $(SRC)/policy/bt_ota_policy.c $(SRC)/policy/bt_passkey_policy.c \
		$(SRC)/bt/bt_status.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/image_compat.c $(SRC)/ota/version.c stubs/host_bt.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -Wno-unused-function -DCONFIG_APP_BT_ONLY=1 -o $@ test_bt_only.c $(SRC)/policy/bt_ota_policy.c \
		$(SRC)/policy/bt_passkey_policy.c \
		$(SRC)/bt/bt_status.c $(SRC)/ota/ota_outcome.c $(SRC)/ota/image_compat.c $(SRC)/ota/version.c

# bt_only_ota.c and health.c, included by their test: the trial, kept by a person or reverted by the deadline.
$(BUILD)/bt_only_ota_tests: test_bt_only_ota.c $(SRC)/bt_only/bt_only_ota.c $(SRC)/health.c $(SRC)/ota/ota.h stubs/host_bt.h \
		stubs/zephyr/drivers/watchdog.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 $(BT_ONLY_DEFINES) -o $@ test_bt_only_ota.c

$(BUILD)/console_bt_only_tests: test_console_bt_only.c $(CONSOLE_SOURCES) $(SRC)/policy/bt_passkey_policy.c $(BUILD)/base64.o \
		$(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_BT_ONLY_DEFINES) -o $@ $(filter-out %.h,$^)

# Raspberry Pi images, from 1.20.0 (docs/pi-ota.md). The first: SHA-256, CRC-32, the job document
# and the list of jobs, the signed manifest, the SD card's layer on an in-memory file system, and the
# download onto it with a fake HTTP server. The second: ota.c with CONFIG_APP_PI_OTA, the same tests
# as ota_bt_no_consent_tests and the order of a firmware and a Pi image (test_ota_bt.c, TEST_PI).
# The third is no test by itself: firmware/tests/hil/test_pi_link.py runs it against the simulator
# of the Pi's end, tools/pi_link_sim.py.
PI_SOURCES := $(SRC)/pi/pi_dl.c $(SRC)/pi/pi_image.c $(SRC)/pi/pi_sd.c $(SRC)/pi/pi_sha256.c
PI_HEADERS := $(SRC)/pi/pi_dl.h $(SRC)/pi/pi_image.h $(SRC)/pi/pi_sd.h $(SRC)/pi/pi_sha256.h stubs/zephyr/fs/fs.h
$(BUILD)/pi_ota_tests: test_pi_ota.c $(PI_SOURCES) $(PI_HEADERS) $(SRC)/ota/ota_job.c $(SRC)/ota/ota_job.h \
		$(SRC)/ota/version.c $(BUILD)/cJSON.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_PI_OTA_CHECKPOINT_KB=1024 -o $@ test_pi_ota.c $(PI_SOURCES) \
		$(SRC)/ota/ota_job.c $(SRC)/ota/version.c $(BUILD)/cJSON.o -lm

$(BUILD)/ota_pi_tests: $(OTA_DEPS) $(SRC)/pi/pi_ota.h $(SRC)/pi/pi_image.c $(SRC)/pi/pi_sha256.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(COMPAT_DEFINES) -DTEST_NO_CONSENT=1 -DTEST_PI=1 -DCONFIG_APP_PI_OTA=1 \
		-o $@ $(OTA_SOURCES) $(SRC)/pi/pi_image.c $(SRC)/pi/pi_sha256.c

$(BUILD)/pi_link_harness: pi_link_harness.c $(SRC)/pi/pi_link.c $(SRC)/pi/pi_link.h $(SRC)/pi/pi_image.c \
		$(SRC)/pi/pi_sha256.c $(SRC)/ota/version.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ pi_link_harness.c $(SRC)/pi/pi_link.c $(SRC)/pi/pi_image.c \
		$(SRC)/pi/pi_sha256.c $(SRC)/ota/version.c

# LED3 and LED4, included by their test to get at the pattern they show.
$(BUILD)/bt_only_leds_tests: test_bt_only_leds.c $(SRC)/bt_only/bt_only_leds.c $(SRC)/bt_only/bt_only.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 $(BT_ONLY_DEFINES) -o $@ test_bt_only_leds.c

# When a board that is stuck gets restarted, and when a join may start. tests/host/mutate_stuck.py,
# mutate_join.py and mutate_net.py show that these tests notice when a policy, or what net.c tells
# it, is wrong: `make mutants` runs them.
# test_app.c has the wiring.
$(BUILD)/stuck_policy_tests: test_stuck_policy.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/stuck_policy.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_stuck_policy.c $(SRC)/policy/stuck_policy.c

$(BUILD)/join_policy_tests: test_join_policy.c $(SRC)/policy/join_policy.c $(SRC)/policy/join_policy.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ test_join_policy.c $(SRC)/policy/join_policy.c

.PHONY: mutants
mutants:
	CC=$(CC) python3 mutate_stuck.py
	CC=$(CC) python3 mutate_join.py
	CC=$(CC) python3 mutate_net.py

# The console of the test image that can stop the Wi-Fi chip. Every other build of it answers that
# the command does not exist, which test_console.c checks.
FAULT_DEFINES := -DCONFIG_APP_TEST_FAULT_WIFI_DEAD=1
$(BUILD)/console_fault_tests: test_console.c $(CONSOLE_SOURCES) $(BUILD)/base64.o $(CONSOLE_HEADERS)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(FAULT_DEFINES) -o $@ $(filter %.c %.o,$^)

# That image's fault itself, with a time after which it fires by itself and with none, and the main
# loop that calls it.
$(BUILD)/fault_wifi_tests: test_fault_wifi.c $(SRC)/fault_wifi.c $(SRC)/fault_wifi.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS=300 -o $@ test_fault_wifi.c

$(BUILD)/fault_wifi_command_tests: test_fault_wifi.c $(SRC)/fault_wifi.c $(SRC)/fault_wifi.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -DCONFIG_APP_LOG_LEVEL=0 -DCONFIG_APP_TEST_WIFI_DEAD_AFTER_SECONDS=0 -o $@ test_fault_wifi.c

$(BUILD)/app_fault_tests: test_app.c $(SRC)/main.c $(SRC)/net.c $(SRC)/diag.c $(SRC)/stuck.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c \
		$(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) $(CONSOLE_DEFINES) $(FAULT_DEFINES) -o $@ test_app.c $(SRC)/policy/stuck_policy.c $(SRC)/policy/join_policy.c

# The console on a pseudo-terminal, for firmware/tests/hil/test_board.py. No sanitizers
# are needed for that, and the tools' tests do not have to run with their runtime.
$(BUILD)/console_sim: console_sim.c $(CONSOLE_SOURCES) $(ZEPHYR_BASE)/lib/utils/base64.c $(CONSOLE_HEADERS)
	@mkdir -p $(BUILD)
	$(CC) -std=c11 -O1 -g $(addprefix -I,$(SRC_DIRS)) -Istubs $(WARNINGS) $(CONSOLE_DEFINES) -o $@ $(filter %.c,$^)

$(BUILD)/console_sim_fault: console_sim.c $(CONSOLE_SOURCES) $(ZEPHYR_BASE)/lib/utils/base64.c $(CONSOLE_HEADERS)
	$(CC) -std=c11 -O1 -g $(addprefix -I,$(SRC_DIRS)) -Istubs $(WARNINGS) $(CONSOLE_DEFINES) $(FAULT_DEFINES) -o $@ $(filter %.c,$^)

clean:
	rm -rf $(BUILD)
