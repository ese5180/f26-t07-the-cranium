/*
 * Host-side tests of src/bt/bt_passkey.c: the board's own Bluetooth passkey in TF-M's protected storage,
 * which is faked here. What is stored, when the passkey is in memory and when it is not, how failures
 * are counted across restarts, when it is locked, and what happens when storage fails.
 *
 * The real file is compiled here, to get at what it keeps static.
 */

#define CONFIG_APP_CONSOLE 1

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "bt_passkey.c"

static int failed_checks;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failed_checks++;                                                     \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static struct {
	bool present;
	uint8_t data[64];
	size_t size;
	psa_storage_uid_t uid;
	psa_status_t get_result;
	psa_status_t set_result;
	psa_status_t remove_result;
	int sets;
	int gets;
	char console[2048];
} ps;

void console_event(const char *tag, const char *format, ...)
{
	char line[256];
	va_list args;

	va_start(args, format);
	vsnprintf(line, sizeof(line), format, args);
	va_end(args);
	snprintf(ps.console + strlen(ps.console), sizeof(ps.console) - strlen(ps.console), "[%s] %s\n",
		 tag, line);
}

psa_status_t psa_ps_set(psa_storage_uid_t uid, size_t data_length, const void *p_data,
			psa_storage_create_flags_t create_flags)
{
	CHECK(create_flags == PSA_STORAGE_FLAG_NONE);
	CHECK(data_length <= sizeof(ps.data));
	ps.sets++;
	ps.uid = uid;
	if (ps.set_result != PSA_SUCCESS) {
		return ps.set_result;
	}
	memcpy(ps.data, p_data, data_length);
	ps.size = data_length;
	ps.present = true;
	return PSA_SUCCESS;
}

psa_status_t psa_ps_get(psa_storage_uid_t uid, size_t data_offset, size_t data_size, void *p_data,
			size_t *p_data_length)
{
	CHECK(data_offset == 0);
	ps.gets++;
	ps.uid = uid;
	if (ps.get_result != PSA_SUCCESS) {
		return ps.get_result;
	}
	if (!ps.present) {
		return PSA_ERROR_DOES_NOT_EXIST;
	}
	*p_data_length = ps.size < data_size ? ps.size : data_size;
	memcpy(p_data, ps.data, *p_data_length);
	return PSA_SUCCESS;
}

psa_status_t psa_ps_remove(psa_storage_uid_t uid)
{
	ps.uid = uid;
	if (ps.remove_result != PSA_SUCCESS) {
		return ps.remove_result;
	}
	if (!ps.present) {
		return PSA_ERROR_DOES_NOT_EXIST;
	}
	ps.present = false;
	return PSA_SUCCESS;
}

static struct bt_passkey_record in_storage(void)
{
	struct bt_passkey_record record = { 0 };

	memcpy(&record, ps.data, sizeof(record));
	return record;
}

/* A new board, or one restarted with what is in storage now. */
static void restart(void)
{
	ps.console[0] = '\0';
	memset(&kept, 0, sizeof(kept));
	have_record = false;
	failures_written = 0;
	atomic_set(&state, BT_PASSKEY_STATE_NONE);
	atomic_set(&window_passkey, 0);
	atomic_set(&failures, 0);
	bt_passkey_init();
}

static void blank(void)
{
	memset(&ps, 0, sizeof(ps));
	restart();
}

/* The passkey is not anywhere in the module's memory. */
static bool not_in_memory(uint32_t passkey)
{
	return kept.passkey == 0 && (atomic_get(&window_passkey) == 0 ||
				     (uint32_t)atomic_get(&window_passkey) != passkey + 1);
}

static void test_a_blank_board_has_none(void)
{
	uint16_t tag;

	blank();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_NONE);
	CHECK(strcmp(bt_passkey_state_name(bt_passkey_state()), "unset") == 0);
	CHECK(!bt_passkey_tag(&tag));
	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);
	CHECK(ps.console[0] == '\0');
	CHECK(!bt_passkey_persist());
}

static void test_it_is_stored_and_used_only_in_a_window(void)
{
	struct bt_passkey_record record;
	uint16_t tag = 0;

	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	CHECK(ps.uid == 0x4352414e00000101ULL);
	CHECK(ps.size == sizeof(struct bt_passkey_record));
	record = in_storage();
	CHECK(record.magic == BT_PASSKEY_RECORD_MAGIC);
	CHECK(record.passkey == 284913 && record.tag == 0x3f9c && record.failures == 0);

	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_SET);
	CHECK(bt_passkey_tag(&tag) && tag == 0x3f9c);
	CHECK(not_in_memory(284913));
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == 284913);
	CHECK(bt_passkey_for_pairing(2) == 284913);
	/* A window that has had its three: nothing more guesses at it. */
	CHECK(bt_passkey_for_pairing(3) == BT_PASSKEY_NONE);
	bt_passkey_window_close();
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);
	CHECK(not_in_memory(284913));

	/* It is never said. */
	CHECK(strstr(ps.console, "284913") == NULL);

	/* After a restart it is read again, and still not kept in memory until a window. */
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_SET);
	CHECK(not_in_memory(284913));
	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == 284913);
}

static void test_failures_add_up_across_windows_and_restarts(void)
{
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	bt_passkey_window_open();

	bt_passkey_count_failure();
	CHECK(bt_passkey_failures() == 1);
	CHECK(!bt_passkey_persist());
	CHECK(in_storage().failures == 1);
	/* Written once: nothing changed since. */
	ps.sets = 0;
	CHECK(!bt_passkey_persist());
	CHECK(ps.sets == 0);
	bt_passkey_window_close();

	restart();
	CHECK(bt_passkey_failures() == 1);
	bt_passkey_window_open();
	bt_passkey_count_failure();
	/* Before the main loop has written it, the Bluetooth thread already goes by it. */
	CHECK(bt_passkey_for_pairing(0) == 284913);
	bt_passkey_count_failure();
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	/* The third locks it, and that is said, once. */
	CHECK(bt_passkey_persist());
	CHECK(!bt_passkey_persist());
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_LOCKED);
	CHECK(in_storage().failures == 3);
	CHECK(strstr(ps.console, "failed 3 times and is not used any more") != NULL);
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);
	CHECK(atomic_get(&window_passkey) == 0);

	/* And it stays locked through a restart, with the console told again. */
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_LOCKED);
	CHECK(strstr(ps.console, "not used any more") != NULL);
	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	/* Its name goes with it: the phone cannot pair with it anyway. */
	uint16_t tag;

	CHECK(!bt_passkey_tag(&tag));

	/* A new passkey starts with none. */
	CHECK(bt_passkey_store(530172, 0x1111) == 0);
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_SET);
	CHECK(bt_passkey_failures() == 0 && in_storage().failures == 0);
	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == 530172);
}

static void test_a_count_that_cannot_be_written_still_holds(void)
{
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	bt_passkey_window_open();

	ps.set_result = PSA_ERROR_STORAGE_FAILURE;
	bt_passkey_count_failure();
	bt_passkey_count_failure();
	bt_passkey_count_failure();
	CHECK(bt_passkey_persist());
	CHECK(in_storage().failures == 0);
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_LOCKED);
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	/* It tries again each second, and gets it written once storage answers. */
	ps.set_result = PSA_SUCCESS;
	CHECK(!bt_passkey_persist());
	CHECK(in_storage().failures == 3);
}

static void test_what_cannot_be_read_is_not_used(void)
{
	struct bt_passkey_record record;

	/* Storage that does not answer. */
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	ps.get_result = PSA_ERROR_GENERIC_ERROR;
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);
	CHECK(strcmp(bt_passkey_state_name(BT_PASSKEY_STATE_UNREADABLE), "unreadable") == 0);
	CHECK(strstr(ps.console, "cannot be read") != NULL);
	bt_passkey_window_open();
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	/* A record of another size, of another firmware, or with a weak passkey in it. */
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	ps.size--;
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);

	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	record = in_storage();
	record.magic ^= 1;
	memcpy(ps.data, &record, sizeof(record));
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);

	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	record = in_storage();
	record.passkey = 111111;
	memcpy(ps.data, &record, sizeof(record));
	restart();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);

	/* Readable at boot, and not when the window opens: that window draws new ones. */
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	restart();
	ps.get_result = PSA_ERROR_GENERIC_ERROR;
	bt_passkey_window_open();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);

	/* Replaced underneath, with another name: not this board's record any more. */
	blank();
	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	record = in_storage();
	record.tag = 0x1234;
	memcpy(ps.data, &record, sizeof(record));
	bt_passkey_window_open();
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_UNREADABLE);
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);
}

static void test_storing_and_erasing(void)
{
	blank();
	CHECK(bt_passkey_store(123456, 0x3f9c) == -EINVAL);
	CHECK(!ps.present);
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_NONE);

	ps.set_result = PSA_ERROR_STORAGE_FAILURE;
	CHECK(bt_passkey_store(284913, 0x3f9c) == -EIO);
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_NONE);
	ps.set_result = PSA_SUCCESS;

	CHECK(bt_passkey_store(284913, 0x3f9c) == 0);
	bt_passkey_window_open();
	CHECK(bt_passkey_erase() == 0);
	CHECK(!ps.present);
	CHECK(bt_passkey_state() == BT_PASSKEY_STATE_NONE);
	CHECK(bt_passkey_for_pairing(0) == BT_PASSKEY_NONE);
	CHECK(bt_passkey_erase() == 0);

	ps.remove_result = PSA_ERROR_STORAGE_FAILURE;
	CHECK(bt_passkey_erase() == -EIO);
}

int main(void)
{
	test_a_blank_board_has_none();
	test_it_is_stored_and_used_only_in_a_window();
	test_failures_add_up_across_windows_and_restarts();
	test_a_count_that_cannot_be_written_still_holds();
	test_what_cannot_be_read_is_not_used();
	test_storing_and_erasing();

	printf("%d passkey checks, %d failed\n", checks, failed_checks);
	return failed_checks == 0 ? 0 : 1;
}
