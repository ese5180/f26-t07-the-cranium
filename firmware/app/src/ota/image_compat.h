/*
 * What an image is compatible with, from 1.13.0: see "Board type and compatibility" in
 * firmware/README.md and "Compatibility" in docs/fleet.md.
 *
 * Every signed image carries two TLVs in its protected area, which the image's SHA-256 covers and
 * the signature signs, as MCUboot checks them:
 *
 *   0xa1  the board type, 1 to IMAGE_COMPAT_BOARD_MAX lower-case letters and digits ("nrf7002dk")
 *   0xa2  the flash layout, a positive whole number in ASCII digits, with no leading zero ("1")
 *
 * An image without one is a legacy image, for IMAGE_COMPAT_LEGACY_BOARD and
 * IMAGE_COMPAT_LEGACY_LAYOUT: every image before 1.13.0. Before the board marks an image to test,
 * it reads these from the secondary slot (image_compat_check_slot()) and refuses one for another
 * board type or another flash layout.
 *
 * The reader takes the protected area's bytes in order, a few at a time, as a slot read or an
 * upload over Bluetooth brings them, and keeps nothing but the two values: no buffer of the area.
 * It is strict: the area's info header must have the protected magic and the size the image header
 * gives, its entries must fill it exactly, each of the two may come once, and anything else in the
 * area is taken as it is. A TLV outside the protected area is never read, so an 0xa1 there counts
 * for nothing.
 */

#ifndef IMAGE_COMPAT_H_
#define IMAGE_COMPAT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define IMAGE_COMPAT_TLV_BOARD     0xa1
#define IMAGE_COMPAT_TLV_LAYOUT    0xa2
#define IMAGE_COMPAT_BOARD_MAX     16
/* At most 9 digits, so that the number fits 32 bits whatever they are. */
#define IMAGE_COMPAT_LAYOUT_DIGITS 9
#define IMAGE_COMPAT_LEGACY_BOARD  "nrf7002dk"
#define IMAGE_COMPAT_LEGACY_LAYOUT 1

/* MCUboot's (bootutil/image.h). */
#define IMAGE_COMPAT_IMAGE_MAGIC   0x96f3b83dU
#define IMAGE_COMPAT_HEADER_SIZE   32
#define IMAGE_COMPAT_PROT_MAGIC    0x6908
#define IMAGE_COMPAT_TLV_MAGIC     0x6907

enum image_compat_verdict {
	IMAGE_COMPAT_OK,
	IMAGE_COMPAT_OTHER_BOARD,
	IMAGE_COMPAT_OTHER_LAYOUT,
	/* The header or the TLV areas are not what an image's are: nothing can be said of it. */
	IMAGE_COMPAT_MALFORMED,
	/* The slot could not be read. */
	IMAGE_COMPAT_UNREADABLE,
};

/* What an image is for. */
struct image_compat {
	char board[IMAGE_COMPAT_BOARD_MAX + 1];
	uint32_t layout;
};

/* Where an image keeps what matters here, from its header. */
struct image_compat_header {
	uint16_t header_size;
	uint16_t protected_size;
	uint32_t image_size;
};

struct image_compat_reader {
	/* The protected area's size, from the image header, and how much of it has come. */
	uint32_t total;
	uint32_t at;
	/* The info header or an entry's header, while it comes in. */
	uint8_t head[4];
	uint8_t head_used;
	bool in_value;
	uint16_t type;
	uint16_t left;
	/* The value of an 0xa1 or 0xa2 entry, and how long it is, which can be more than fits. */
	uint8_t value[IMAGE_COMPAT_BOARD_MAX];
	uint16_t value_length;
	bool bad;
	bool seen_board;
	bool seen_layout;
	struct image_compat found;
};

/*
 * The image header, from its first IMAGE_COMPAT_HEADER_SIZE bytes: 0, or -EINVAL if it is not an
 * MCUboot image's.
 */
int image_compat_parse_header(const uint8_t *data, size_t len, struct image_compat_header *out);

void image_compat_begin(struct image_compat_reader *reader, uint16_t protected_size);

/* The next bytes of the protected area. What comes after its end makes it bad. */
void image_compat_feed(struct image_compat_reader *reader, const uint8_t *data, size_t len);

/* The whole area has come: what image_compat_finish() says is final. */
bool image_compat_complete(const struct image_compat_reader *reader);

/*
 * What the image is for, with the legacy values for what it does not say, against this board's
 * type and layout. IMAGE_COMPAT_MALFORMED for an area that is bad or not complete.
 */
enum image_compat_verdict image_compat_finish(const struct image_compat_reader *reader,
					      const char *board, uint32_t layout,
					      struct image_compat *found);

/*
 * The reason an update ends with: incompatible_board, incompatible_layout, header_mismatch (as
 * for a header that is not the job's) or flash_error.
 */
const char *image_compat_reason(enum image_compat_verdict verdict);

/*
 * The secondary slot's image, from flash, against this board (CONFIG_APP_BOARD_TYPE and
 * CONFIG_APP_IMAGE_LAYOUT): image_compat_slot.c. The image must lie inside the slot, and the
 * unprotected TLV area's info header must follow the protected area, inside the slot too. found
 * is filled in whenever the verdict is OK, OTHER_BOARD or OTHER_LAYOUT. Reads the slot only.
 */
enum image_compat_verdict image_compat_check_slot(uint8_t area_id, struct image_compat *found);

#endif /* IMAGE_COMPAT_H_ */
