/*
 * How the board's Memfault chunks get to Memfault, from 1.14.0: one at a time, over AWS IoT, each
 * one answered before the next goes (docs/memfault.md). This module has no side effects and no
 * hardware dependencies, so it can be tested on a host; src/mflt.c gives it the Memfault SDK's
 * packetizer and the MQTT connection.
 *
 * A frame is what goes on cranium/<thing name>/memfault, at QoS 0:
 *
 *   byte 0      1, the version of this frame
 *   bytes 1-2   the frame's sequence number, most significant byte first
 *   the rest    one Memfault chunk, as memfault_packetizer_get_chunk() gave it
 *
 * The function in AWS posts the chunk to Memfault and answers on the commands topic with
 * {"id":"...","cmd":"memfault_ack","seq":<n>} (command.h). Only then is the chunk gone from here
 * and the next one taken. The SDK has deleted a message once its last chunk is taken, so a chunk
 * is never dropped here: one that gets no answer in time goes again, after 30 s, and the wait
 * doubles with every one that gets none, up to an hour; an answer sets it back. A late answer
 * to a chunk that is waiting to go again still counts, and one whose number is not the chunk's
 * does nothing. Order is kept because nothing else is sent meanwhile. A chunk that Memfault got
 * and whose answer was lost goes twice.
 *
 * AWS IoT closes the connection of a board that publishes where its device policy does not allow,
 * as on a cloud from before 1.14.0. As for the events and the location: a connection that ends
 * within MFLT_LINK_PROOF_MS of a frame is counted, unless an answer or a connection that lasted
 * that long has shown the topic to be allowed, and after MFLT_LINK_REFUSALS_MAX of those nothing
 * more is sent until a restart. Updates go on as before.
 */

#ifndef MFLT_LINK_H_
#define MFLT_LINK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MFLT_LINK_FRAME_VERSION 1
#define MFLT_LINK_HEADER        3
/* The largest chunk a frame may carry. The function in AWS takes no more. */
#define MFLT_LINK_CHUNK_LIMIT   460
/* The packetizer takes no buffer smaller than this (MEMFAULT_PACKETIZER_MIN_BUF_LEN). */
#define MFLT_LINK_CHUNK_LEAST   9
#define MFLT_LINK_RETRY_FIRST_MS (30 * 1000)
#define MFLT_LINK_RETRY_MAX_MS   (60 * 60 * 1000)
#define MFLT_LINK_PROOF_MS       5000
#define MFLT_LINK_REFUSALS_MAX   2

struct mflt_link_io {
	/* The next chunk, of at most *len bytes, into buf, and its size into *len: false for none. */
	bool (*next_chunk)(void *context, uint8_t *buf, size_t *len);
	/* Publish one frame: 0 if the MQTT library took it. */
	int (*publish)(void *context, const uint8_t *frame, size_t len);
	void *context;
};

enum mflt_link_state {
	/* No chunk is held. The next poll takes one, if there is one. */
	MFLT_LINK_IDLE,
	/* The chunk was published and its answer has not come yet. */
	MFLT_LINK_WAITING,
	/* The chunk got no answer in time, or could not be published: it goes again at due_ms. */
	MFLT_LINK_HOLDING,
};

struct mflt_link {
	const struct mflt_link_io *io;
	size_t chunk_max;
	uint32_t answer_ms;
	enum mflt_link_state state;
	/* The number of the frame held, or of the last one. */
	uint16_t seq;
	uint8_t frame[MFLT_LINK_HEADER + MFLT_LINK_CHUNK_LIMIT];
	size_t frame_len;
	/* WAITING: when the answer is late. HOLDING: when the frame goes again. */
	int64_t due_ms;
	/* What the next wait is after an answer that did not come. */
	uint32_t retry_ms;
	uint32_t sent;
	uint32_t answered;
	uint32_t late;
	/* When the last frame was published on this connection, -1 for none. */
	int64_t published_ms;
	/* The topic is allowed: an answer came, or a connection lasted MFLT_LINK_PROOF_MS after a frame. */
	bool proven;
	uint8_t refusals;
	/* AWS IoT closed the connection right after a frame too often: nothing more until a restart. */
	bool off;
};

/*
 * chunk_max is brought into MFLT_LINK_CHUNK_LEAST..MFLT_LINK_CHUNK_LIMIT. answer_ms is how long an
 * answer may take. The first frame is first_seq + 1: a number drawn at boot, so that an answer
 * meant for the boot before is not taken for one of this boot.
 */
void mflt_link_init(struct mflt_link *link, const struct mflt_link_io *io, size_t chunk_max,
		    uint32_t answer_ms, uint16_t first_seq);

/*
 * Do what is due at now_ms, with the connection up: take and publish the next chunk, give up
 * waiting for an answer, or publish a held frame again. force publishes a held frame now instead
 * of at its time; it never publishes again a frame whose answer can still come. True if a frame
 * was published.
 */
bool mflt_link_poll(struct mflt_link *link, int64_t now_ms, bool force);

/* The cloud's answer for frame seq. True if it was the frame held, which is then gone. */
bool mflt_link_answer(struct mflt_link *link, uint16_t seq);

/*
 * The connection ended: a frame that waits for its answer goes again on the next one, at once. If
 * it ended right after a frame, and the topic was not shown to be allowed, that is counted.
 */
void mflt_link_disconnected(struct mflt_link *link, int64_t now_ms);

/* Sending stopped until a restart: see the device policy, above. */
bool mflt_link_off(const struct mflt_link *link);

#endif /* MFLT_LINK_H_ */
