#include "golden_record.h"

#include <string.h>

static uint32_t get32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put32(uint8_t *p, uint32_t value)
{
	p[0] = (uint8_t)value;
	p[1] = (uint8_t)(value >> 8);
	p[2] = (uint8_t)(value >> 16);
	p[3] = (uint8_t)(value >> 24);
}

/* The pin's 48 bytes after the magic and format: counter, size, version and digest. */
static void pin_encode(const struct golden_pin *pin, uint8_t out[48])
{
	put32(out, pin->counter);
	put32(out + 4, pin->size);
	out[8] = pin->version.major;
	out[9] = pin->version.minor;
	out[10] = (uint8_t)pin->version.revision;
	out[11] = (uint8_t)(pin->version.revision >> 8);
	put32(out + 12, pin->version.build);
	memcpy(out + 16, pin->sha256, GOLDEN_HASH_SIZE);
}

static void pin_decode(const uint8_t in[48], struct golden_pin *pin)
{
	pin->counter = get32(in);
	pin->size = get32(in + 4);
	pin->version.major = in[8];
	pin->version.minor = in[9];
	pin->version.revision = (uint16_t)(in[10] | (in[11] << 8));
	pin->version.build = get32(in + 12);
	memcpy(pin->sha256, in + 16, GOLDEN_HASH_SIZE);
}

bool golden_record_parse(const uint8_t *bytes, size_t len, struct golden_record *out)
{
	if (bytes == NULL || out == NULL || len != GOLDEN_RECORD_SIZE) {
		return false;
	}

	if (bytes[0] != GOLDEN_RECORD_MAGIC_0 || bytes[1] != GOLDEN_RECORD_MAGIC_1 ||
	    bytes[2] != GOLDEN_RECORD_MAGIC_2 || bytes[3] != GOLDEN_RECORD_MAGIC_3 ||
	    bytes[4] != GOLDEN_RECORD_FORMAT || bytes[5] != 0 || bytes[6] != 0 || bytes[7] != 0) {
		return false;
	}

	memset(out, 0, sizeof(*out));
	pin_decode(bytes + 8, &out->pin);
	out->sig_len = bytes[GOLDEN_RECORD_SIGNED];

	if (out->pin.counter == 0 || out->pin.size == 0 || bytes[GOLDEN_RECORD_SIGNED + 1] != 0 ||
	    out->sig_len < GOLDEN_RECORD_SIG_MIN || out->sig_len > GOLDEN_RECORD_SIG_MAX) {
		return false;
	}

	/* What follows the signature is zero, so that one record has one encoding. */
	for (size_t i = GOLDEN_RECORD_SIGNED + 2 + out->sig_len; i < GOLDEN_RECORD_SIZE; i++) {
		if (bytes[i] != 0) {
			return false;
		}
	}

	memcpy(out->sig, bytes + GOLDEN_RECORD_SIGNED + 2, out->sig_len);
	return true;
}

void golden_record_encode(const struct golden_record *record, uint8_t out[GOLDEN_RECORD_SIZE])
{
	memset(out, 0, GOLDEN_RECORD_SIZE);
	out[0] = GOLDEN_RECORD_MAGIC_0;
	out[1] = GOLDEN_RECORD_MAGIC_1;
	out[2] = GOLDEN_RECORD_MAGIC_2;
	out[3] = GOLDEN_RECORD_MAGIC_3;
	out[4] = GOLDEN_RECORD_FORMAT;
	pin_encode(&record->pin, out + 8);
	out[GOLDEN_RECORD_SIGNED] = record->sig_len;
	if (record->sig_len <= GOLDEN_RECORD_SIG_MAX) {
		memcpy(out + GOLDEN_RECORD_SIGNED + 2, record->sig, record->sig_len);
	}
}

bool golden_erased(const uint8_t *bytes, size_t len)
{
	for (size_t i = 0; i < len; i++) {
		if (bytes[i] != 0xff) {
			return false;
		}
	}

	return true;
}

uint32_t golden_status_word(enum golden_status status)
{
	return status == GOLDEN_STATUS_PENDING ? 0xffffffffu : GOLDEN_STATUS_TAG | (uint32_t)status;
}

enum golden_status golden_status_from_word(uint32_t word)
{
	if (word == 0xffffffffu) {
		return GOLDEN_STATUS_PENDING;
	}

	if ((word & 0xffffff00u) != GOLDEN_STATUS_TAG || (word & 0xffu) == 0 ||
	    (word & 0xffu) >= GOLDEN_STATUS_UNKNOWN) {
		return GOLDEN_STATUS_UNKNOWN;
	}

	return (enum golden_status)(word & 0xffu);
}

const char *golden_status_name(enum golden_status status)
{
	switch (status) {
	case GOLDEN_STATUS_PENDING:
		return "pending";
	case GOLDEN_STATUS_SEALED:
		return "sealed";
	case GOLDEN_STATUS_BAD_RECORD:
		return "bad_record";
	case GOLDEN_STATUS_BAD_SIGNATURE:
		return "bad_signature";
	case GOLDEN_STATUS_NOT_NEWER:
		return "not_newer";
	case GOLDEN_STATUS_NOT_RUNNING:
		return "not_running";
	case GOLDEN_STATUS_NOT_CONFIRMED:
		return "not_confirmed";
	case GOLDEN_STATUS_FLASH_ERROR:
		return "flash_error";
	default:
		return "unknown";
	}
}

/* One DER INTEGER at *at, into 32 bytes. */
static bool der_integer(const uint8_t *der, size_t end, size_t *at, uint8_t out[32])
{
	size_t len;

	if (*at + 2 > end || der[*at] != 0x02) {
		return false;
	}

	len = der[*at + 1];
	*at += 2;
	if (len == 0 || len > 33 || *at + len > end || (der[*at] & 0x80) != 0) {
		return false;
	}

	/* A leading zero only where the next byte would read as negative, as DER has it. */
	if (der[*at] == 0) {
		if (len == 1 || (der[*at + 1] & 0x80) == 0) {
			return false;
		}
		(*at)++;
		len--;
	}

	if (len > 32) {
		return false;
	}

	memset(out, 0, 32 - len);
	memcpy(out + 32 - len, der + *at, len);
	*at += len;
	return true;
}

bool golden_der_signature(const uint8_t *der, size_t len, uint8_t rs[64])
{
	size_t at = 2;

	if (der == NULL || len < 8 || len > GOLDEN_RECORD_SIG_MAX || der[0] != 0x30 ||
	    der[1] != len - 2) {
		return false;
	}

	return der_integer(der, len, &at, rs) && der_integer(der, len, &at, rs + 32) && at == len;
}

int golden_version_compare(const struct golden_version *a, const struct golden_version *b)
{
	if (a->major != b->major) {
		return a->major < b->major ? -1 : 1;
	}
	if (a->minor != b->minor) {
		return a->minor < b->minor ? -1 : 1;
	}
	if (a->revision != b->revision) {
		return a->revision < b->revision ? -1 : 1;
	}
	if (a->build != b->build) {
		return a->build < b->build ? -1 : 1;
	}

	return 0;
}

bool golden_pin_equal(const struct golden_pin *a, const struct golden_pin *b)
{
	return a->counter == b->counter && a->size == b->size &&
	       golden_version_compare(&a->version, &b->version) == 0 &&
	       memcmp(a->sha256, b->sha256, GOLDEN_HASH_SIZE) == 0;
}

enum golden_status golden_promote_decide(const struct golden_record *record, bool signature_ok,
					 uint32_t floor, const struct golden_running *running)
{
	/* The signature first: nothing else in an unsigned record is worth an answer. */
	if (!signature_ok) {
		return GOLDEN_STATUS_BAD_SIGNATURE;
	}

	/* Equal is refused too: a record already used, sent again, does nothing. */
	if (record->pin.counter <= floor) {
		return GOLDEN_STATUS_NOT_NEWER;
	}

	if (!running->valid || running->size != record->pin.size ||
	    golden_version_compare(&running->version, &record->pin.version) != 0 ||
	    memcmp(running->sha256, record->pin.sha256, GOLDEN_HASH_SIZE) != 0) {
		return GOLDEN_STATUS_NOT_RUNNING;
	}

	if (!running->confirmed) {
		return GOLDEN_STATUS_NOT_CONFIRMED;
	}

	return GOLDEN_STATUS_SEALED;
}

/*
 *   0   48  the pin
 *   48  4   check: the counter's complement
 *   52  8   0xff
 *   60  4   magic, written last
 */
void golden_state_entry_encode(const struct golden_pin *pin, uint8_t out[GOLDEN_STATE_ENTRY_SIZE])
{
	memset(out, 0xff, GOLDEN_STATE_ENTRY_SIZE);
	pin_encode(pin, out);
	put32(out + 48, ~pin->counter);
	put32(out + 60, GOLDEN_STATE_MAGIC);
}

void golden_state_scan_entry(struct golden_state_scan *scan, const uint8_t entry[GOLDEN_STATE_ENTRY_SIZE])
{
	struct golden_pin pin;

	if (golden_erased(entry, GOLDEN_STATE_ENTRY_SIZE)) {
		if (!scan->next_set) {
			scan->next = scan->offset;
			scan->next_set = true;
		}
	} else if (get32(entry + 60) == GOLDEN_STATE_MAGIC && get32(entry + 48) == ~get32(entry)) {
		pin_decode(entry, &pin);
		if (pin.counter != 0 && (!scan->found || pin.counter > scan->best.counter)) {
			scan->best = pin;
			scan->found = true;
		}
	}

	/* An entry that is neither, cut off while it was written, is skipped and never written over. */
	scan->offset += GOLDEN_STATE_ENTRY_SIZE;
}

bool golden_state_scan(const uint8_t *page, size_t page_size, struct golden_pin *found, size_t *next)
{
	struct golden_state_scan scan;

	memset(&scan, 0, sizeof(scan));
	for (size_t at = 0; at + GOLDEN_STATE_ENTRY_SIZE <= page_size; at += GOLDEN_STATE_ENTRY_SIZE) {
		golden_state_scan_entry(&scan, page + at);
	}

	*next = scan.next_set ? scan.next : page_size;
	if (scan.found) {
		*found = scan.best;
	}

	return scan.found;
}
