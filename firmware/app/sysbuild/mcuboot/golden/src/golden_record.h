/*
 * The golden image's promotion record, and what the bootloader keeps of it: formats and decisions,
 * with no flash, no crypto and no Zephyr in them. The bootloader (golden.c, golden_promote.c) and the
 * application (src/ota/golden_promote.c) build this same file, and
 * firmware/tests/host/test_golden_record.c runs it on the build machine. tools/golden_promote.py
 * writes and reads the same bytes.
 *
 * A promotion record names one signed image: its SHA-256 (the hash TLV, as the pin always was), its
 * size, its version, and a golden counter that only goes up. It is signed with the golden key, an
 * ECDSA P-256 key that is not the image signing key and is kept offline; the bootloader has its
 * public key compiled in. All numbers are little-endian.
 *
 *   offset  size  what
 *   0       4     magic "CGLD"
 *   4       1     format, 1
 *   5       3     zero
 *   8       4     golden counter, 1 or more
 *   12      4     size of the signed image, to the end of its TLVs
 *   16      1     version major
 *   17      1     version minor
 *   18      2     version revision
 *   20      4     version build
 *   24      32    SHA-256 of the image (its hash TLV)
 *   56      1     length of the signature, 8 to 72
 *   57      1     zero
 *   58      72    the signature, ASN.1 DER, zero after its length
 *
 * The signature covers bytes 0 to 55: ECDSA with SHA-256 over them.
 */

#ifndef GOLDEN_RECORD_H_
#define GOLDEN_RECORD_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GOLDEN_RECORD_MAGIC_0  'C'
#define GOLDEN_RECORD_MAGIC_1  'G'
#define GOLDEN_RECORD_MAGIC_2  'L'
#define GOLDEN_RECORD_MAGIC_3  'D'
#define GOLDEN_RECORD_FORMAT   1
#define GOLDEN_RECORD_SIGNED   56
#define GOLDEN_RECORD_SIG_MIN  8
#define GOLDEN_RECORD_SIG_MAX  72
#define GOLDEN_RECORD_SIZE     (GOLDEN_RECORD_SIGNED + 2 + GOLDEN_RECORD_SIG_MAX)
#define GOLDEN_HASH_SIZE       32

/*
 * External flash, past the end of golden_partition and outside every partition, so that no flash
 * layout changes (firmware/app/flash_layout.py): the application writes the request sector, the
 * bootloader writes its answer into it and the info sector. Offsets in the MX25R64.
 */
#define GOLDEN_REQUEST_OFFSET  0x7e4000
#define GOLDEN_INFO_OFFSET     0x7e5000
#define GOLDEN_EXT_SECTOR      0x1000
/* In the request sector: the bootloader's answer, one word, erased while the request is pending. */
#define GOLDEN_STATUS_OFFSET   0x100

struct golden_version {
	uint8_t major;
	uint8_t minor;
	uint16_t revision;
	uint32_t build;
};

/* What a record or a stored pin says about one image. */
struct golden_pin {
	uint32_t counter;
	uint32_t size;
	struct golden_version version;
	uint8_t sha256[GOLDEN_HASH_SIZE];
};

struct golden_record {
	struct golden_pin pin;
	uint8_t sig_len;
	uint8_t sig[GOLDEN_RECORD_SIG_MAX];
};

/* Reads a record's format; the signature is not checked here. False for anything malformed. */
bool golden_record_parse(const uint8_t *bytes, size_t len, struct golden_record *out);

/* The bytes of a record, as the parser reads them. */
void golden_record_encode(const struct golden_record *record, uint8_t out[GOLDEN_RECORD_SIZE]);

/* Whether a sector's bytes hold nothing: all erased. */
bool golden_erased(const uint8_t *bytes, size_t len);

/* The bootloader's answer in the request sector. Erased flash (0xffffffff) is "pending". */
enum golden_status {
	GOLDEN_STATUS_PENDING = 0,
	GOLDEN_STATUS_SEALED = 1,
	GOLDEN_STATUS_BAD_RECORD = 2,
	GOLDEN_STATUS_BAD_SIGNATURE = 3,
	GOLDEN_STATUS_NOT_NEWER = 4,
	GOLDEN_STATUS_NOT_RUNNING = 5,
	GOLDEN_STATUS_NOT_CONFIRMED = 6,
	GOLDEN_STATUS_FLASH_ERROR = 7,
	GOLDEN_STATUS_UNKNOWN = 8,
};

#define GOLDEN_STATUS_TAG 0xc6000000u

uint32_t golden_status_word(enum golden_status status);
enum golden_status golden_status_from_word(uint32_t word);
/* Short and machine-readable, for the job's status and the shadow: "sealed", "not_newer". */
const char *golden_status_name(enum golden_status status);

/* The image in the primary slot, as the bootloader found it. */
struct golden_running {
	/* Its signature is good, with the image signing key. */
	bool valid;
	/* Confirmed: a trailer with image_ok set, or no trailer at all. Not an image on trial. */
	bool confirmed;
	uint32_t size;
	struct golden_version version;
	uint8_t sha256[GOLDEN_HASH_SIZE];
};

/*
 * Whether a record whose format parsed may be sealed: signature good, counter above the floor, and it
 * names the image that runs and has proved itself. GOLDEN_STATUS_SEALED means go.
 */
enum golden_status golden_promote_decide(const struct golden_record *record, bool signature_ok,
					 uint32_t floor, const struct golden_running *running);

/*
 * What the bootloader keeps, in the last page of its own partition, which it write-protects before the
 * application starts: one 64-byte entry per promotion, appended, so that the page is erased only once
 * every GOLDEN_STATE_ENTRIES promotions. An entry counts when its magic, written last, is there.
 */
#define GOLDEN_STATE_ENTRY_SIZE 64
#define GOLDEN_STATE_MAGIC      0x50444c47u /* "GLDP" */

/* One entry: the pin, a check word, and the magic in its last word. */
void golden_state_entry_encode(const struct golden_pin *pin, uint8_t out[GOLDEN_STATE_ENTRY_SIZE]);

/* A walk over a page of entries, one entry at a time: start zeroed, feed each in order. */
struct golden_state_scan {
	/* The good entry with the highest counter, if found. */
	struct golden_pin best;
	bool found;
	/* Offset of the first entry that is all erased, once next_set; page size when the page is full. */
	size_t next;
	bool next_set;
	size_t offset;
};

void golden_state_scan_entry(struct golden_state_scan *scan, const uint8_t entry[GOLDEN_STATE_ENTRY_SIZE]);

/*
 * The same over a whole page in memory. Returns whether a good entry was found, in *found; the
 * bootloader then uses it, and otherwise the pin compiled in, with counter 0. *next is where the next
 * entry goes, or page_size when the page is full and has to be erased first.
 */
bool golden_state_scan(const uint8_t *page, size_t page_size, struct golden_pin *found, size_t *next);

/*
 * The two numbers of an ECDSA P-256 signature in ASN.1 DER, as 32 bytes each, big-endian: what
 * tinycrypt's uECC_verify() takes. False for anything but SEQUENCE { INTEGER r, INTEGER s } in
 * exactly len bytes, each positive and at most 32 bytes long.
 */
bool golden_der_signature(const uint8_t *der, size_t len, uint8_t rs[64]);

int golden_version_compare(const struct golden_version *a, const struct golden_version *b);

/* The same image under the same counter. */
bool golden_pin_equal(const struct golden_pin *a, const struct golden_pin *b);

#endif /* GOLDEN_RECORD_H_ */
