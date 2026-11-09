/*
 * Host-side tests of src/mflt/mflt_link.c: how the board's Memfault chunks go to the cloud, one at a
 * time and in order, each answered before the next, and what happens to one whose answer does not
 * come. The packetizer and the MQTT connection are fakes: a queue of chunks, and a list of what
 * was published.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mflt_link.h"

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

#define ANSWER_MS 20000
#define MAX_CHUNKS 64
#define MAX_FRAMES 256

static struct {
	/* What the packetizer still has: chunk i is chunk_len[i] bytes of the value i + 1. */
	size_t chunk_len[MAX_CHUNKS];
	int chunks;
	int taken;
	/* The buffer size the link last offered the packetizer. */
	size_t offered;
	/* What was published, in order. */
	uint8_t frame[MAX_FRAMES][MFLT_LINK_HEADER + MFLT_LINK_CHUNK_LIMIT];
	size_t frame_len[MAX_FRAMES];
	int frames;
	/* The MQTT library refuses the next publishes. */
	int refuse;
} fake;

static bool next_chunk(void *context, uint8_t *buf, size_t *len)
{
	CHECK(context == &fake);
	fake.offered = *len;
	if (fake.taken >= fake.chunks) {
		return false;
	}

	/* As the packetizer does: never more than the buffer it is given. */
	CHECK(fake.chunk_len[fake.taken] <= *len);
	memset(buf, fake.taken + 1, fake.chunk_len[fake.taken]);
	*len = fake.chunk_len[fake.taken];
	fake.taken++;
	return true;
}

static int publish(void *context, const uint8_t *frame, size_t len)
{
	CHECK(context == &fake);
	CHECK(len <= MFLT_LINK_HEADER + MFLT_LINK_CHUNK_LIMIT);
	if (fake.refuse > 0) {
		fake.refuse--;
		return -128;
	}
	if (fake.frames < MAX_FRAMES) {
		memcpy(fake.frame[fake.frames], frame, len);
		fake.frame_len[fake.frames] = len;
	}
	fake.frames++;
	return 0;
}

static const struct mflt_link_io io = {
	.next_chunk = next_chunk,
	.publish = publish,
	.context = &fake,
};

static struct mflt_link link;

static void start_over(size_t chunk_max, uint16_t first_seq)
{
	memset(&fake, 0, sizeof(fake));
	mflt_link_init(&link, &io, chunk_max, ANSWER_MS, first_seq);
}

static void add_chunk(size_t len)
{
	fake.chunk_len[fake.chunks++] = len;
}

static uint16_t seq_of(int frame)
{
	return (uint16_t)((fake.frame[frame][1] << 8) | fake.frame[frame][2]);
}

/* The frame carries chunk `chunk` (from 0), whole, after its header. */
static bool carries(int frame, int chunk)
{
	size_t len = fake.chunk_len[chunk];

	if (fake.frame_len[frame] != MFLT_LINK_HEADER + len || fake.frame[frame][0] != 1) {
		return false;
	}
	for (size_t i = 0; i < len; i++) {
		if (fake.frame[frame][MFLT_LINK_HEADER + i] != (uint8_t)(chunk + 1)) {
			return false;
		}
	}
	return true;
}

static void test_chunks_go_in_order_each_after_its_answer(void)
{
	int64_t now = 1000;

	start_over(400, 41);
	add_chunk(400);
	add_chunk(17);
	add_chunk(250);

	/* The first goes, and nothing more until it is answered, however often the loop asks. */
	CHECK(mflt_link_poll(&link, now, false));
	CHECK(fake.frames == 1 && fake.taken == 1);
	CHECK(carries(0, 0));
	CHECK(seq_of(0) == 42);
	CHECK(fake.offered == 400);
	for (int i = 0; i < 10; i++) {
		CHECK(!mflt_link_poll(&link, now + i * 1000, false));
		CHECK(!mflt_link_poll(&link, now + i * 1000, true));
	}
	CHECK(fake.frames == 1 && fake.taken == 1);

	/* Its answer: it is gone, and the next goes on the next poll. */
	CHECK(mflt_link_answer(&link, 42));
	CHECK(link.state == MFLT_LINK_IDLE);
	CHECK(mflt_link_poll(&link, now, false));
	CHECK(carries(1, 1) && seq_of(1) == 43);
	CHECK(mflt_link_answer(&link, 43));
	CHECK(mflt_link_poll(&link, now, false));
	CHECK(carries(2, 2) && seq_of(2) == 44);
	CHECK(mflt_link_answer(&link, 44));

	/* Nothing left: nothing goes. */
	CHECK(!mflt_link_poll(&link, now, true));
	CHECK(fake.frames == 3);
	CHECK(link.sent == 3 && link.answered == 3 && link.late == 0);
}

static void test_an_answer_that_is_not_the_chunks_does_nothing(void)
{
	start_over(400, 100);
	add_chunk(30);
	add_chunk(30);

	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(seq_of(0) == 101);
	/* The one before it, from an earlier boot, or one from much later: not this chunk's. */
	CHECK(!mflt_link_answer(&link, 100));
	CHECK(!mflt_link_answer(&link, 102));
	CHECK(!mflt_link_answer(&link, 0));
	CHECK(link.state == MFLT_LINK_WAITING);
	CHECK(!mflt_link_poll(&link, 1000, false));
	CHECK(fake.frames == 1 && fake.taken == 1);

	/* Answered twice: the second is for a chunk that is gone already. */
	CHECK(mflt_link_answer(&link, 101));
	CHECK(!mflt_link_answer(&link, 101));
	CHECK(mflt_link_poll(&link, 1000, false));
	CHECK(carries(1, 1) && seq_of(1) == 102);

	/* With no chunk held, an answer is nothing. */
	start_over(400, 7);
	CHECK(!mflt_link_answer(&link, 7));
	CHECK(!mflt_link_answer(&link, 8));
}

static void test_no_answer_sends_the_same_chunk_again_with_a_wait_that_doubles(void)
{
	int64_t now = 0;
	uint32_t wait = MFLT_LINK_RETRY_FIRST_MS;

	start_over(400, 9);
	add_chunk(99);
	add_chunk(5);

	CHECK(mflt_link_poll(&link, now, false));

	/* Until the answer is late, nothing. Then the same chunk, by number and by content. */
	for (int round = 0; round < 12; round++) {
		CHECK(!mflt_link_poll(&link, now + ANSWER_MS - 1, false));
		CHECK(!mflt_link_poll(&link, now + ANSWER_MS, false));
		CHECK(link.state == MFLT_LINK_HOLDING);
		now += ANSWER_MS;
		CHECK(!mflt_link_poll(&link, now + wait - 1, false));
		CHECK(mflt_link_poll(&link, now + wait, false));
		CHECK(carries(fake.frames - 1, 0));
		CHECK(seq_of(fake.frames - 1) == 10);
		now += wait;
		wait = wait >= MFLT_LINK_RETRY_MAX_MS / 2 ? MFLT_LINK_RETRY_MAX_MS : wait * 2;
	}

	/* Never more than an hour, and the packetizer gave up nothing more meanwhile. */
	CHECK(wait == MFLT_LINK_RETRY_MAX_MS);
	CHECK(link.retry_ms == MFLT_LINK_RETRY_MAX_MS);
	CHECK(fake.taken == 1);
	CHECK(link.late == 12);

	/* The answer, at last: the wait starts again from 30 s, and the next chunk goes. */
	CHECK(mflt_link_answer(&link, 10));
	CHECK(link.retry_ms == MFLT_LINK_RETRY_FIRST_MS);
	CHECK(mflt_link_poll(&link, now, false));
	CHECK(carries(fake.frames - 1, 1) && seq_of(fake.frames - 1) == 11);
}

static void test_a_late_answer_still_counts_and_force_does_not_wait(void)
{
	start_over(400, 0);
	add_chunk(40);
	add_chunk(41);

	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(!mflt_link_poll(&link, ANSWER_MS, false));
	CHECK(link.state == MFLT_LINK_HOLDING);

	/* The answer came after all, while the chunk waits to go again: it is gone. */
	CHECK(mflt_link_answer(&link, 1));
	CHECK(mflt_link_poll(&link, ANSWER_MS + 1, false));
	CHECK(carries(1, 1));

	/* Forced, a held chunk goes at once; one whose answer can still come does not go again. */
	CHECK(!mflt_link_poll(&link, ANSWER_MS + 2, true));
	CHECK(!mflt_link_poll(&link, 2 * ANSWER_MS + 1, false));
	CHECK(link.state == MFLT_LINK_HOLDING);
	CHECK(mflt_link_poll(&link, 2 * ANSWER_MS + 2, true));
	CHECK(fake.frames == 3 && carries(2, 1) && seq_of(2) == 2);
}

static void test_a_publish_that_fails_and_a_lost_connection_keep_the_chunk(void)
{
	start_over(400, 500);
	add_chunk(60);
	add_chunk(61);

	/* The MQTT library did not take it: held, for the usual wait, never dropped. */
	fake.refuse = 1;
	CHECK(!mflt_link_poll(&link, 0, false));
	CHECK(link.state == MFLT_LINK_HOLDING);
	CHECK(fake.taken == 1 && fake.frames == 0);
	CHECK(!mflt_link_poll(&link, MFLT_LINK_RETRY_FIRST_MS - 1, false));
	CHECK(mflt_link_poll(&link, MFLT_LINK_RETRY_FIRST_MS, false));
	CHECK(carries(0, 0) && seq_of(0) == 501);

	/* The connection ends before the answer: it goes again as soon as the next one is up. */
	mflt_link_disconnected(&link, 40000);
	CHECK(link.state == MFLT_LINK_HOLDING);
	CHECK(mflt_link_poll(&link, 40000, false));
	CHECK(carries(1, 0) && seq_of(1) == 501);
	CHECK(fake.taken == 1);
	CHECK(mflt_link_answer(&link, 501));

	/* A lost connection with nothing waiting changes nothing. */
	mflt_link_disconnected(&link, 50000);
	CHECK(link.state == MFLT_LINK_IDLE);
	CHECK(mflt_link_poll(&link, 50000, false));
	CHECK(carries(2, 1) && seq_of(2) == 502);
}

static void test_sizes(void)
{
	/* What the packetizer is offered: the chunk limit, never past what a frame can carry. */
	start_over(400, 0);
	add_chunk(400);
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(fake.offered == 400 && fake.frame_len[0] == 403);
	CHECK(link.frame_len == MFLT_LINK_HEADER + 400);

	start_over(10000, 0);
	add_chunk(MFLT_LINK_CHUNK_LIMIT);
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(fake.offered == MFLT_LINK_CHUNK_LIMIT);
	CHECK(fake.frame_len[0] == MFLT_LINK_HEADER + MFLT_LINK_CHUNK_LIMIT);

	start_over(1, 0);
	add_chunk(MFLT_LINK_CHUNK_LEAST);
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(fake.offered == MFLT_LINK_CHUNK_LEAST);

	/* A chunk of nothing is no chunk. */
	start_over(400, 0);
	add_chunk(0);
	CHECK(!mflt_link_poll(&link, 0, false));
	CHECK(fake.frames == 0 && link.state == MFLT_LINK_IDLE);

	/* The number wraps from 65535 to 0, most significant byte first. */
	start_over(400, 65534);
	add_chunk(1);
	add_chunk(2);
	add_chunk(3);
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(fake.frame[0][1] == 0xff && fake.frame[0][2] == 0xff);
	CHECK(mflt_link_answer(&link, 65535));
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(seq_of(1) == 0);
	CHECK(mflt_link_answer(&link, 0));
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(seq_of(2) == 1 && fake.frame[2][1] == 0 && fake.frame[2][2] == 1);
}

static void test_a_coredump_and_a_heartbeat_in_one_go(void)
{
	/* What a crash leaves: a coredump of 13 chunks, the reboot and a heartbeat after it. */
	int64_t now = 0;

	start_over(400, 3000);
	for (int i = 0; i < 13; i++) {
		add_chunk(i == 12 ? 123 : 400);
	}
	add_chunk(80);
	add_chunk(200);

	for (int i = 0; i < 15; i++) {
		CHECK(mflt_link_poll(&link, now, false));
		CHECK(!mflt_link_poll(&link, now, true));
		/* Every third chunk's first answer is lost, and the chunk goes again. */
		if (i % 3 == 0) {
			now += ANSWER_MS;
			CHECK(!mflt_link_poll(&link, now, false));
			now += link.retry_ms / 2;
			CHECK(mflt_link_poll(&link, now, false));
		}
		CHECK(mflt_link_answer(&link, (uint16_t)(3001 + i)));
		now += 700;
	}

	CHECK(!mflt_link_poll(&link, now, true));
	CHECK(fake.taken == 15);
	CHECK(fake.frames == 20);
	/* In order: frame by frame, each chunk once or twice, and never one before the last. */
	for (int f = 0, chunk = 0; f < fake.frames; f++) {
		if (!carries(f, chunk)) {
			chunk++;
		}
		CHECK(carries(f, chunk));
		CHECK(seq_of(f) == 3001 + chunk);
	}
}

/*
 * On a cloud whose device policy does not allow the topic, AWS IoT closes the connection right after
 * each frame. Twice, and nothing more goes until a restart, so that the board stays connected.
 */
static void test_a_cloud_whose_policy_does_not_allow_the_topic(void)
{
	start_over(400, 0);
	add_chunk(10);
	add_chunk(11);

	CHECK(mflt_link_poll(&link, 1000, false));
	mflt_link_disconnected(&link, 1500);
	CHECK(!mflt_link_off(&link) && link.refusals == 1);
	/* On the next connection the same frame goes again, and the same happens. */
	CHECK(mflt_link_poll(&link, 30000, false));
	CHECK(carries(1, 0));
	mflt_link_disconnected(&link, 30000 + MFLT_LINK_PROOF_MS - 1);
	CHECK(mflt_link_off(&link));
	CHECK(!mflt_link_poll(&link, 100000, false));
	CHECK(!mflt_link_poll(&link, 200000, true));
	CHECK(fake.frames == 2 && fake.taken == 1);
	/* More connections that end change nothing. */
	mflt_link_disconnected(&link, 300000);
	CHECK(mflt_link_off(&link) && link.refusals == MFLT_LINK_REFUSALS_MAX);

	/* A connection that ends later than that after a frame is not counted. */
	start_over(400, 0);
	add_chunk(10);
	add_chunk(11);
	add_chunk(12);
	CHECK(mflt_link_poll(&link, 0, false));
	mflt_link_disconnected(&link, MFLT_LINK_PROOF_MS);
	CHECK(link.refusals == 0);
	/* An answer shows the topic is allowed: after it, no end of a connection counts. */
	CHECK(mflt_link_poll(&link, MFLT_LINK_PROOF_MS, false));
	CHECK(mflt_link_answer(&link, 1));
	for (int i = 0; i < 4; i++) {
		int64_t at = 10000 + i * 40000;

		(void)mflt_link_poll(&link, at, true);
		mflt_link_disconnected(&link, at + 10);
	}
	CHECK(link.refusals == 0 && !mflt_link_off(&link));

	/* So does a connection that lasted long enough after a frame, with no answer at all. */
	start_over(400, 0);
	add_chunk(10);
	CHECK(mflt_link_poll(&link, 0, false));
	CHECK(!mflt_link_poll(&link, MFLT_LINK_PROOF_MS, false));
	CHECK(link.proven);
	for (int i = 0; i < 4; i++) {
		int64_t at = 100000 + i * 100000;

		(void)mflt_link_poll(&link, at, true);
		mflt_link_disconnected(&link, at + 10);
	}
	CHECK(!mflt_link_off(&link));
}

int main(void)
{
	test_chunks_go_in_order_each_after_its_answer();
	test_an_answer_that_is_not_the_chunks_does_nothing();
	test_no_answer_sends_the_same_chunk_again_with_a_wait_that_doubles();
	test_a_late_answer_still_counts_and_force_does_not_wait();
	test_a_publish_that_fails_and_a_lost_connection_keep_the_chunk();
	test_sizes();
	test_a_coredump_and_a_heartbeat_in_one_go();
	test_a_cloud_whose_policy_does_not_allow_the_topic();

	printf("%d memfault link checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
