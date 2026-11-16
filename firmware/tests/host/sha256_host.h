/*
 * SHA-256, HMAC-SHA256 and HKDF-SHA256 (FIPS 180-4, RFC 2104, RFC 5869) for host tests only, to check Matter test
 * vectors that need a hash. The firmware uses PSA.
 */
#ifndef SHA256_HOST_H_
#define SHA256_HOST_H_

#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct sha256 {
	uint32_t h[8];
	uint8_t buf[64];
	size_t buf_len;
	uint64_t total;
};

static const uint32_t sha256_k[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(struct sha256 *s, const uint8_t *p)
{
	uint32_t w[64];
	uint32_t a[8];

	for (int i = 0; i < 16; i++) {
		w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	}
	for (int i = 16; i < 64; i++) {
		uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
		uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);

		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	memcpy(a, s->h, sizeof(a));
	for (int i = 0; i < 64; i++) {
		uint32_t t1 = a[7] + (ROR(a[4], 6) ^ ROR(a[4], 11) ^ ROR(a[4], 25)) + ((a[4] & a[5]) ^ (~a[4] & a[6])) +
			      sha256_k[i] + w[i];
		uint32_t t2 = (ROR(a[0], 2) ^ ROR(a[0], 13) ^ ROR(a[0], 22)) + ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]));

		memmove(&a[1], &a[0], 7 * sizeof(uint32_t));
		a[4] += t1;
		a[0] = t1 + t2;
	}
	for (int i = 0; i < 8; i++) {
		s->h[i] += a[i];
	}
}

static void sha256_init(struct sha256 *s)
{
	static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
				       0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

	memcpy(s->h, iv, sizeof(iv));
	s->buf_len = 0;
	s->total = 0;
}

static void sha256_update(struct sha256 *s, const uint8_t *d, size_t n)
{
	s->total += n;
	while (n--) {
		s->buf[s->buf_len++] = *d++;
		if (s->buf_len == 64) {
			sha256_block(s, s->buf);
			s->buf_len = 0;
		}
	}
}

static void sha256_final(struct sha256 *s, uint8_t out[32])
{
	uint64_t bits = s->total * 8;
	uint8_t pad = 0x80;
	uint8_t zero = 0;
	uint8_t len[8];

	sha256_update(s, &pad, 1);
	while (s->buf_len != 56) {
		sha256_update(s, &zero, 1);
	}
	for (int i = 0; i < 8; i++) {
		len[i] = (uint8_t)(bits >> (56 - 8 * i));
	}
	sha256_update(s, len, 8);
	for (int i = 0; i < 8; i++) {
		out[4 * i] = (uint8_t)(s->h[i] >> 24);
		out[4 * i + 1] = (uint8_t)(s->h[i] >> 16);
		out[4 * i + 2] = (uint8_t)(s->h[i] >> 8);
		out[4 * i + 3] = (uint8_t)s->h[i];
	}
}

static void hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *msg, size_t len, uint8_t out[32])
{
	uint8_t k[64] = {0};
	uint8_t pad[64];
	uint8_t inner[32];
	struct sha256 s;

	if (key_len > 64) {
		sha256_init(&s);
		sha256_update(&s, key, key_len);
		sha256_final(&s, k);
	} else {
		memcpy(k, key, key_len);
	}
	for (int i = 0; i < 64; i++) {
		pad[i] = k[i] ^ 0x36;
	}
	sha256_init(&s);
	sha256_update(&s, pad, 64);
	sha256_update(&s, msg, len);
	sha256_final(&s, inner);
	for (int i = 0; i < 64; i++) {
		pad[i] = k[i] ^ 0x5c;
	}
	sha256_init(&s);
	sha256_update(&s, pad, 64);
	sha256_update(&s, inner, 32);
	sha256_final(&s, out);
}

static void hkdf_sha256(const uint8_t *salt, size_t salt_len, const uint8_t *ikm, size_t ikm_len,
			const uint8_t *info, size_t info_len, uint8_t *out, size_t out_len)
{
	uint8_t prk[32];
	uint8_t t[32];
	uint8_t msg[32 + 64 + 1];
	size_t t_len = 0;
	static const uint8_t zeros[32];

	hmac_sha256(salt_len ? salt : zeros, salt_len ? salt_len : 32, ikm, ikm_len, prk);
	for (uint8_t c = 1; out_len > 0; c++) {
		memcpy(msg, t, t_len);
		memcpy(&msg[t_len], info, info_len);
		msg[t_len + info_len] = c;
		hmac_sha256(prk, 32, msg, t_len + info_len + 1, t);
		t_len = 32;
		size_t n = out_len < 32 ? out_len : 32;

		memcpy(out, t, n);
		out += n;
		out_len -= n;
	}
}

#endif /* SHA256_HOST_H_ */
