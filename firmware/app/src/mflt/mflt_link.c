/*
 * Memfault chunks to the cloud, one at a time: see mflt_link.h.
 */

#include "mflt_link.h"

#include <string.h>

static void hold(struct mflt_link *link, int64_t now_ms)
{
	link->state = MFLT_LINK_HOLDING;
	link->due_ms = now_ms + link->retry_ms;
	link->retry_ms = link->retry_ms >= MFLT_LINK_RETRY_MAX_MS / 2 ? MFLT_LINK_RETRY_MAX_MS
								    : link->retry_ms * 2;
}

static bool publish_held(struct mflt_link *link, int64_t now_ms)
{
	if (link->io->publish(link->io->context, link->frame, link->frame_len) != 0) {
		hold(link, now_ms);
		return false;
	}

	link->sent++;
	link->published_ms = now_ms;
	link->state = MFLT_LINK_WAITING;
	link->due_ms = now_ms + link->answer_ms;
	return true;
}

void mflt_link_init(struct mflt_link *link, const struct mflt_link_io *io, size_t chunk_max,
		    uint32_t answer_ms, uint16_t first_seq)
{
	memset(link, 0, sizeof(*link));
	link->io = io;
	link->chunk_max = chunk_max < MFLT_LINK_CHUNK_LEAST   ? MFLT_LINK_CHUNK_LEAST
			  : chunk_max > MFLT_LINK_CHUNK_LIMIT ? MFLT_LINK_CHUNK_LIMIT
							      : chunk_max;
	link->answer_ms = answer_ms;
	link->state = MFLT_LINK_IDLE;
	link->seq = first_seq;
	link->retry_ms = MFLT_LINK_RETRY_FIRST_MS;
	link->published_ms = -1;
}

bool mflt_link_poll(struct mflt_link *link, int64_t now_ms, bool force)
{
	size_t len = link->chunk_max;

	if (link->off) {
		return false;
	}

	if (!link->proven && link->published_ms >= 0 &&
	    now_ms - link->published_ms >= MFLT_LINK_PROOF_MS) {
		link->proven = true;
	}

	if (link->state == MFLT_LINK_WAITING) {
		if (now_ms < link->due_ms) {
			return false;
		}
		link->late++;
		hold(link, now_ms);
	}

	if (link->state == MFLT_LINK_HOLDING) {
		if (!force && now_ms < link->due_ms) {
			return false;
		}
		return publish_held(link, now_ms);
	}

	if (!link->io->next_chunk(link->io->context, link->frame + MFLT_LINK_HEADER, &len) ||
	    len == 0 || len > link->chunk_max) {
		return false;
	}

	link->seq++;
	link->frame[0] = MFLT_LINK_FRAME_VERSION;
	link->frame[1] = (uint8_t)(link->seq >> 8);
	link->frame[2] = (uint8_t)link->seq;
	link->frame_len = MFLT_LINK_HEADER + len;
	return publish_held(link, now_ms);
}

bool mflt_link_answer(struct mflt_link *link, uint16_t seq)
{
	/* Any answer at all: a frame got through, so the topic is allowed. */
	link->proven = true;

	if (link->state == MFLT_LINK_IDLE || seq != link->seq) {
		return false;
	}

	link->answered++;
	link->frame_len = 0;
	link->state = MFLT_LINK_IDLE;
	link->retry_ms = MFLT_LINK_RETRY_FIRST_MS;
	return true;
}

void mflt_link_disconnected(struct mflt_link *link, int64_t now_ms)
{
	/* Right after a frame, and AWS IoT may have closed the connection for it. */
	if (!link->proven && !link->off && link->published_ms >= 0 &&
	    now_ms - link->published_ms < MFLT_LINK_PROOF_MS &&
	    ++link->refusals >= MFLT_LINK_REFUSALS_MAX) {
		link->off = true;
	}
	link->published_ms = -1;

	/* Its answer would have come on this connection. The cloud was not slow: no longer wait. */
	if (link->state == MFLT_LINK_WAITING) {
		link->state = MFLT_LINK_HOLDING;
		link->due_ms = now_ms;
	}
}

bool mflt_link_off(const struct mflt_link *link)
{
	return link->off;
}
