/*
 * Host-side tests of image_compat.c and image_compat_slot.c: what the board makes of the protected
 * TLVs of an image in its secondary slot, before it would mark it to test. Good images for this
 * board, legacy ones without the TLVs, images for another board type or flash layout, an 0xa1 that
 * is outside the protected area, and every kind of TLV area that is broken or cut short. The real
 * files are compiled here, against a slot in memory whose reads must stay inside it.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "image_compat.c"
#include "image_compat_slot.c"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

#define SLOT_SIZE   8192
#define HEADER_SIZE 0x200
#define BODY_SIZE   1000

/* ---- the slot ------------------------------------------------------------------------ */

static struct {
	uint8_t data[SLOT_SIZE];
	size_t size;
	bool open_fails;
	/* The read at this offset fails, -1 for none. */
	long fail_at;
	int reads;
	bool opened;
} slot;

int flash_area_open(uint8_t id, const struct flash_area **area)
{
	static struct flash_area the_area;

	CHECK(id == 1);
	if (slot.open_fails) {
		return -EIO;
	}
	the_area.fa_id = id;
	the_area.fa_size = slot.size;
	*area = &the_area;
	slot.opened = true;
	return 0;
}

int flash_area_read(const struct flash_area *area, long offset, void *data, size_t length)
{
	slot.reads++;
	/* Every read inside the slot: the sizes in an image are never taken on trust. */
	CHECK(offset >= 0 && (size_t)offset + length <= area->fa_size);
	if (offset == slot.fail_at || offset < 0 || (size_t)offset + length > area->fa_size) {
		return -EIO;
	}
	memcpy(data, slot.data + offset, length);
	return 0;
}

void flash_area_close(const struct flash_area *area)
{
	ARG_UNUSED(area);
	CHECK(slot.opened);
	slot.opened = false;
}

/* ---- images ----------------------------------------------------------------------------- */

struct tlv {
	uint16_t type;
	const char *value;
	/* For a value with bytes strlen() would not count: its length, else 0. */
	uint16_t length;
};

#define END { 0, NULL, 0 }

static size_t put_u16(uint8_t *at, uint16_t value)
{
	at[0] = (uint8_t)value;
	at[1] = (uint8_t)(value >> 8);
	return 2;
}

static size_t put_u32(uint8_t *at, uint32_t value)
{
	put_u16(at, (uint16_t)value);
	put_u16(at + 2, (uint16_t)(value >> 16));
	return 4;
}

static size_t put_entries(uint8_t *at, const struct tlv *entries)
{
	size_t used = 0;

	for (const struct tlv *e = entries; e != NULL && e->value != NULL; e++) {
		uint16_t length = e->length != 0 ? e->length : (uint16_t)strlen(e->value);

		used += put_u16(at + used, e->type);
		used += put_u16(at + used, length);
		memcpy(at + used, e->value, length);
		used += length;
	}
	return used;
}

/*
 * An image as imgtool lays one out, into the slot: header, body, the protected area if it has
 * entries, then the TLV area with a SHA-256, a key hash and a signature that are only their size.
 * Returns where the protected area starts.
 */
static size_t image(const struct tlv *protected, const struct tlv *unprotected)
{
	static const struct tlv signature[] = {
		{ 0x10, "0123456789abcdef0123456789abcdef", 0 },
		{ 0x01, "0123456789abcdef0123456789abcdef", 0 },
		{ 0x22, "a signature of seventy-one bytes, or about that, as ECDSA has them ...", 0 },
		END,
	};
	uint8_t *at = slot.data;
	size_t prot_at = HEADER_SIZE + BODY_SIZE;
	size_t prot_size = 0;
	size_t tlv_size;

	memset(slot.data, 0xff, sizeof(slot.data));
	slot.size = SLOT_SIZE;
	slot.open_fails = false;
	slot.fail_at = -1;

	if (protected != NULL && protected[0].value != NULL) {
		prot_size = 4 + put_entries(at + prot_at + 4, protected);
		put_u16(at + prot_at, IMAGE_COMPAT_PROT_MAGIC);
		put_u16(at + prot_at + 2, (uint16_t)prot_size);
	}

	tlv_size = 4 + put_entries(at + prot_at + prot_size + 4, signature);
	tlv_size += put_entries(at + prot_at + prot_size + tlv_size, unprotected);
	put_u16(at + prot_at + prot_size, IMAGE_COMPAT_TLV_MAGIC);
	put_u16(at + prot_at + prot_size + 2, (uint16_t)tlv_size);

	memset(at, 0, HEADER_SIZE);
	put_u32(at, IMAGE_COMPAT_IMAGE_MAGIC);
	put_u32(at + 4, 0x30000);
	put_u16(at + 8, HEADER_SIZE);
	put_u16(at + 10, (uint16_t)prot_size);
	put_u32(at + 12, BODY_SIZE);
	put_u32(at + 16, 0x100);
	at[20] = 1;
	at[21] = 13;
	memset(at + HEADER_SIZE, 0x5a, BODY_SIZE);
	return prot_at;
}

static enum image_compat_verdict check(struct image_compat *found)
{
	enum image_compat_verdict verdict = image_compat_check_slot(1, found);

	CHECK(!slot.opened);
	return verdict;
}

static const struct tlv this_board[] = {
	{ IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 }, END,
};

/* ---- tests -------------------------------------------------------------------------------- */

static void test_an_image_for_this_board(void)
{
	struct image_compat found;

	image(this_board, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OK);
	CHECK(strcmp(found.board, "nrf7002dk") == 0);
	CHECK(found.layout == 1);

	/* Among other protected TLVs, before and after: a security counter, and a vendor's own. */
	{
		static const struct tlv mixed[] = {
			{ 0x50, "\x01\x00\x00\x00", 4 }, { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 },
			{ 0xa3, "", 0 }, { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 },
			{ 0x1a1, "nrf5340dk", 0 }, END,
		};

		image(mixed, NULL);
		CHECK(check(&found) == IMAGE_COMPAT_OK);
	}
}

static void test_an_image_for_another_board_or_layout(void)
{
	static const struct tlv other_board[] = {
		{ IMAGE_COMPAT_TLV_BOARD, "nrf5340dk", 0 }, { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 }, END,
	};
	static const struct tlv other_layout[] = {
		{ IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, { IMAGE_COMPAT_TLV_LAYOUT, "2", 0 }, END,
	};
	static const struct tlv both[] = {
		{ IMAGE_COMPAT_TLV_BOARD, "nrf5340dk", 0 }, { IMAGE_COMPAT_TLV_LAYOUT, "7", 0 }, END,
	};
	static const struct tlv big_layout[] = {
		{ IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 },
		{ IMAGE_COMPAT_TLV_LAYOUT, "999999999", 0 }, END,
	};
	struct image_compat found;

	image(other_board, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OTHER_BOARD);
	CHECK(strcmp(found.board, "nrf5340dk") == 0 && found.layout == 1);

	image(other_layout, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OTHER_LAYOUT);
	CHECK(strcmp(found.board, "nrf7002dk") == 0 && found.layout == 2);

	/* The type is said first. */
	image(both, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OTHER_BOARD);
	CHECK(found.layout == 7);

	image(big_layout, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OTHER_LAYOUT);
	CHECK(found.layout == 999999999U);

	CHECK(strcmp(image_compat_reason(IMAGE_COMPAT_OTHER_BOARD), "incompatible_board") == 0);
	CHECK(strcmp(image_compat_reason(IMAGE_COMPAT_OTHER_LAYOUT), "incompatible_layout") == 0);
	CHECK(strcmp(image_compat_reason(IMAGE_COMPAT_MALFORMED), "header_mismatch") == 0);
	CHECK(strcmp(image_compat_reason(IMAGE_COMPAT_UNREADABLE), "flash_error") == 0);
}

static void test_a_legacy_image_is_for_the_nrf7002dk_and_layout_1(void)
{
	static const struct tlv board_only[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, END };
	static const struct tlv layout_only[] = { { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 }, END };
	static const struct tlv layout_2_only[] = { { IMAGE_COMPAT_TLV_LAYOUT, "2", 0 }, END };
	static const struct tlv something_else[] = { { 0x50, "\x01\x00\x00\x00", 4 }, END };
	struct image_compat found;

	/* Every image before 1.13.0: no protected area at all. */
	image(NULL, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OK);
	CHECK(strcmp(found.board, IMAGE_COMPAT_LEGACY_BOARD) == 0);
	CHECK(found.layout == IMAGE_COMPAT_LEGACY_LAYOUT);

	image(board_only, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OK && found.layout == 1);
	image(layout_only, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OK && strcmp(found.board, "nrf7002dk") == 0);
	image(layout_2_only, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OTHER_LAYOUT);
	image(something_else, NULL);
	CHECK(check(&found) == IMAGE_COMPAT_OK);
}

static void test_a_board_type_outside_the_protected_area_counts_for_nothing(void)
{
	static const struct tlv outside[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf5340dk", 0 },
					      { IMAGE_COMPAT_TLV_LAYOUT, "9", 0 }, END };
	struct image_compat found;

	/* Not signed, so not believed: a legacy image, for this board. */
	image(NULL, outside);
	CHECK(check(&found) == IMAGE_COMPAT_OK);
	CHECK(strcmp(found.board, "nrf7002dk") == 0 && found.layout == 1);

	/* Nor does one there change what the protected area says. */
	{
		static const struct tlv other[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf5340dk", 0 }, END };
		static const struct tlv ours[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, END };

		image(other, ours);
		CHECK(check(&found) == IMAGE_COMPAT_OTHER_BOARD);
		image(ours, other);
		CHECK(check(&found) == IMAGE_COMPAT_OK);
	}
}

static void test_values_that_cannot_be_a_type_or_a_layout(void)
{
	static const char *const boards[] = {
		"", "NRF7002DK", "nrf-7002", "nrf7002dk ", "abcdefghijklmnopq", "nrf7002dk\xff",
	};
	static const char *const layouts[] = {
		"", "0", "01", "-1", "+1", "1 ", " 1", "1.0", "abc", "1234567890", "0x1",
	};
	struct image_compat found;

	for (size_t i = 0; i < ARRAY_SIZE(boards); i++) {
		const struct tlv entries[] = { { IMAGE_COMPAT_TLV_BOARD, boards[i], 0 }, END };
		const struct tlv empty[] = { { IMAGE_COMPAT_TLV_BOARD, "x", 0 }, END };

		image(boards[i][0] != '\0' ? entries : empty, NULL);
		if (boards[i][0] == '\0') {
			/* An entry of length 0. */
			put_u16(slot.data + HEADER_SIZE + BODY_SIZE + 6, 0);
			put_u16(slot.data + HEADER_SIZE + BODY_SIZE + 2, 8);
			put_u16(slot.data + 10, 8);
			put_u16(slot.data + HEADER_SIZE + BODY_SIZE + 8, IMAGE_COMPAT_TLV_MAGIC);
			put_u16(slot.data + HEADER_SIZE + BODY_SIZE + 10, 4);
		}
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}

	/* A NUL inside the value. */
	{
		const struct tlv entries[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk\0x", 11 }, END };

		image(entries, NULL);
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}

	for (size_t i = 1; i < ARRAY_SIZE(layouts); i++) {
		const struct tlv entries[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 },
					       { IMAGE_COMPAT_TLV_LAYOUT, layouts[i], 0 }, END };

		image(entries, NULL);
		if (check(&found) != IMAGE_COMPAT_MALFORMED) {
			printf("layout \"%s\" was taken\n", layouts[i]);
		}
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}

	/* Each once. */
	{
		static const struct tlv two_boards[] = { { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 },
							 { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, END };
		static const struct tlv two_layouts[] = { { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 },
							  { IMAGE_COMPAT_TLV_LAYOUT, "1", 0 }, END };

		image(two_boards, NULL);
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
		image(two_layouts, NULL);
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}
}

static void test_tlv_areas_that_are_broken_or_cut_short(void)
{
	struct image_compat found;
	size_t prot;

	/* The protected area's magic, and its size against the header's. */
	prot = image(this_board, NULL);
	put_u16(slot.data + prot, IMAGE_COMPAT_TLV_MAGIC);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);

	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 2, 22 + 1);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);

	/* The header says one byte more: an entry header is cut. Or one less: a value is. */
	for (int change = -5; change <= 5; change++) {
		if (change == 0) {
			continue;
		}
		prot = image(this_board, NULL);
		put_u16(slot.data + 10, (uint16_t)(22 + change));
		put_u16(slot.data + prot + 2, (uint16_t)(22 + change));
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}

	/* An entry longer than the area, by one, and by all it could be. */
	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 6, 10);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 6, 0xffff);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);

	/* An area too small for its own info header. */
	for (uint16_t size = 1; size < 4; size++) {
		prot = image(this_board, NULL);
		put_u16(slot.data + 10, size);
		CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	}

	/* The image header: not an image's, a header smaller than one, sizes past the slot. */
	image(this_board, NULL);
	slot.data[0] ^= 1;
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	image(this_board, NULL);
	put_u16(slot.data + 8, 31);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	image(this_board, NULL);
	put_u32(slot.data + 12, SLOT_SIZE);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	image(this_board, NULL);
	put_u32(slot.data + 12, 0xffffffffU);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	image(this_board, NULL);
	put_u16(slot.data + 8, 0xffff);
	put_u32(slot.data + 12, 0xffffffffU);
	put_u16(slot.data + 10, 0xffff);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);

	/* The unprotected area has to follow, and end inside the slot. */
	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 22, 0x1234);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 24, 3);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);
	prot = image(this_board, NULL);
	put_u16(slot.data + prot + 24, 0xffff);
	CHECK(check(&found) == IMAGE_COMPAT_MALFORMED);

	/* A slot that ends inside the image, at every point from the header to the TLVs. */
	for (size_t size = 0; size < HEADER_SIZE + BODY_SIZE + 22 + 4; size += 7) {
		image(this_board, NULL);
		slot.size = size;
		CHECK(check(&found) != IMAGE_COMPAT_OK);
	}
}

static void test_a_slot_that_cannot_be_read(void)
{
	struct image_compat found;
	size_t prot;

	image(this_board, NULL);
	slot.open_fails = true;
	CHECK(check(&found) == IMAGE_COMPAT_UNREADABLE);

	image(this_board, NULL);
	slot.fail_at = 0;
	CHECK(check(&found) == IMAGE_COMPAT_UNREADABLE);

	prot = image(this_board, NULL);
	slot.fail_at = (long)prot;
	CHECK(check(&found) == IMAGE_COMPAT_UNREADABLE);

	prot = image(this_board, NULL);
	slot.fail_at = (long)prot + 22;
	CHECK(check(&found) == IMAGE_COMPAT_UNREADABLE);
}

/* The reader takes the area in pieces of any size, as an upload over Bluetooth brings it. */
static void test_the_reader_gives_the_same_whatever_the_pieces(void)
{
	const struct tlv *const images[] = {
		this_board,
		(const struct tlv[]){ { 0x50, "\x01\x00\x00\x00", 4 },
				      { IMAGE_COMPAT_TLV_BOARD, "nrf5340dk", 0 }, END },
		(const struct tlv[]){ { IMAGE_COMPAT_TLV_LAYOUT, "12", 0 }, END },
		(const struct tlv[]){ { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 },
				      { IMAGE_COMPAT_TLV_BOARD, "nrf7002dk", 0 }, END },
	};

	for (size_t i = 0; i < ARRAY_SIZE(images); i++) {
		struct image_compat whole_found;
		enum image_compat_verdict whole;
		size_t prot = image(images[i], NULL);
		uint16_t size = (uint16_t)(slot.data[10] | (slot.data[11] << 8));

		whole = check(&whole_found);

		for (size_t piece = 1; piece <= size; piece++) {
			struct image_compat_reader reader;
			struct image_compat found;

			image_compat_begin(&reader, size);
			for (size_t at = 0; at < size; at += piece) {
				CHECK(!image_compat_complete(&reader) || reader.bad);
				image_compat_feed(&reader, slot.data + prot + at, MIN(piece, size - at));
			}
			CHECK(image_compat_complete(&reader));
			CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == whole);
			CHECK(whole == IMAGE_COMPAT_MALFORMED ||
			      (strcmp(found.board, whole_found.board) == 0 &&
			       found.layout == whole_found.layout));
		}

		/* Anything after the end of the area makes it bad. */
		{
			struct image_compat_reader reader;
			struct image_compat found;

			image_compat_begin(&reader, size);
			image_compat_feed(&reader, slot.data + prot, (size_t)size + 1);
			CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == IMAGE_COMPAT_MALFORMED);
		}
	}

	/* Not all there yet: not complete, and not a verdict to go by. */
	{
		struct image_compat_reader reader;
		struct image_compat found;
		size_t prot = image(this_board, NULL);

		image_compat_begin(&reader, 22);
		image_compat_feed(&reader, slot.data + prot, 21);
		CHECK(!image_compat_complete(&reader));
		CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == IMAGE_COMPAT_MALFORMED);
	}
}

static void test_the_header_parser(void)
{
	struct image_compat_header header;

	image(this_board, NULL);
	CHECK(image_compat_parse_header(slot.data, IMAGE_COMPAT_HEADER_SIZE, &header) == 0);
	CHECK(header.header_size == HEADER_SIZE && header.image_size == BODY_SIZE);
	CHECK(header.protected_size == 22);
	CHECK(image_compat_parse_header(slot.data, IMAGE_COMPAT_HEADER_SIZE - 1, &header) == -EINVAL);
	CHECK(image_compat_parse_header(NULL, 64, &header) == -EINVAL);

	/* A header smaller than a header, and not an image's at all. */
	put_u16(slot.data + 8, IMAGE_COMPAT_HEADER_SIZE - 1);
	CHECK(image_compat_parse_header(slot.data, IMAGE_COMPAT_HEADER_SIZE, &header) == -EINVAL);
	put_u16(slot.data + 8, IMAGE_COMPAT_HEADER_SIZE);
	CHECK(image_compat_parse_header(slot.data, IMAGE_COMPAT_HEADER_SIZE, &header) == 0);
	slot.data[3] ^= 0x80;
	CHECK(image_compat_parse_header(slot.data, IMAGE_COMPAT_HEADER_SIZE, &header) == -EINVAL);
}

/*
 * What the reader decides by itself, with no unprotected area after it to give a broken one away:
 * as an upload over Bluetooth has it, piece by piece.
 */
static void test_the_reader_alone_on_what_a_slot_check_would_also_catch(void)
{
	static const uint8_t info_of_6[] = { 0x08, 0x69, 6, 0, 0xa1, 0x00 };
	static const uint8_t long_entry[] = { 0x08, 0x69, 22, 0, 0xa1, 0x00, 30, 0 };
	struct image_compat_reader reader;
	struct image_compat found;

	/* An area smaller than its own info header is no area, though all of it came. */
	for (uint16_t size = 1; size < 4; size++) {
		image_compat_begin(&reader, size);
		image_compat_feed(&reader, info_of_6, size);
		CHECK(image_compat_complete(&reader));
		CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == IMAGE_COMPAT_MALFORMED);
	}

	/* An area that ends inside an entry's header. */
	image_compat_begin(&reader, 6);
	image_compat_feed(&reader, info_of_6, sizeof(info_of_6));
	CHECK(image_compat_complete(&reader));
	CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == IMAGE_COMPAT_MALFORMED);

	/* An entry longer than the area is bad as soon as its header has come, not at the end. */
	image_compat_begin(&reader, 22);
	image_compat_feed(&reader, long_entry, sizeof(long_entry));
	CHECK(image_compat_complete(&reader));
	CHECK(image_compat_finish(&reader, "nrf7002dk", 1, &found) == IMAGE_COMPAT_MALFORMED);
}

/* Random bytes in the protected area and its sizes: never a bad read, and only OK for what is ours. */
static void test_whatever_is_in_the_area(void)
{
	unsigned int seed = 4242;
	int ok = 0;

	for (int round = 0; round < 100000; round++) {
		struct image_compat found;
		enum image_compat_verdict verdict;
		size_t prot = image(this_board, NULL);
		int changes;

		seed = seed * 1103515245U + 12345U;
		changes = 1 + (int)((seed >> 8) % 4);
		for (int i = 0; i < changes; i++) {
			seed = seed * 1103515245U + 12345U;
			if ((seed >> 4) % 8 == 0) {
				put_u16(slot.data + 10, (uint16_t)(seed >> 16));
			} else {
				slot.data[prot + (seed >> 8) % 32] = (uint8_t)(seed >> 20);
			}
		}

		verdict = check(&found);
		CHECK(verdict <= IMAGE_COMPAT_UNREADABLE);
		if (verdict == IMAGE_COMPAT_OK) {
			ok++;
			CHECK(strcmp(found.board, "nrf7002dk") == 0 && found.layout == 1);
		}
	}
	CHECK(ok > 0);
}

int main(void)
{
	test_an_image_for_this_board();
	test_an_image_for_another_board_or_layout();
	test_a_legacy_image_is_for_the_nrf7002dk_and_layout_1();
	test_a_board_type_outside_the_protected_area_counts_for_nothing();
	test_values_that_cannot_be_a_type_or_a_layout();
	test_tlv_areas_that_are_broken_or_cut_short();
	test_a_slot_that_cannot_be_read();
	test_the_reader_gives_the_same_whatever_the_pieces();
	test_the_header_parser();
	test_the_reader_alone_on_what_a_slot_check_would_also_catch();
	test_whatever_is_in_the_area();

	printf("%d image compatibility checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
