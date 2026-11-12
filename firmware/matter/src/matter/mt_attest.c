/*
 * See mt_attest.h.
 */
#include "mt_attest.h"

#include <string.h>

#include "mt_der.h"
#include "mt_tlv.h"

static const uint8_t oid_ecdsa_sha256[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02};
static const uint8_t oid_ec_public_key[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01};
static const uint8_t oid_prime256v1[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07};
/* 1.3.6.1.4.1.37244.2.1 (vendor ID) and .2.2 (product ID) */
static const uint8_t oid_vid[] = {0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xa2, 0x7c, 0x02, 0x01};
static const uint8_t oid_pid[] = {0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xa2, 0x7c, 0x02, 0x02};
static const uint8_t oid_basic[] = {0x55, 0x1d, 0x13};
static const uint8_t oid_skid[] = {0x55, 0x1d, 0x0e};
static const uint8_t oid_akid[] = {0x55, 0x1d, 0x23};

static bool is_oid(const struct mt_der_elem *e, const uint8_t *oid, size_t len)
{
	return e->tag == DER_OID && e->len == len && memcmp(e->value, oid, len) == 0;
}

static int32_t hex4(const struct mt_der_elem *e)
{
	int32_t v = 0;

	if ((e->tag != DER_UTF8 && e->tag != DER_PRINTABLE) || e->len != 4) {
		return -2;
	}
	for (size_t i = 0; i < 4; i++) {
		uint8_t c = e->value[i];
		int d = c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;

		if (d < 0) {
			return -2;
		}
		v = v * 16 + d;
	}
	return v;
}

static bool read_name(const struct mt_der_elem *name, int32_t *vid, int32_t *pid)
{
	struct mt_der_elem rdn;
	struct mt_der_elem atv;
	struct mt_der_elem oid;
	struct mt_der_elem val;

	*vid = -1;
	*pid = -1;
	if (name->tag != DER_SEQUENCE) {
		return false;
	}
	for (unsigned int i = 0; mt_der_child(name, i, &rdn); i++) {
		for (unsigned int j = 0; mt_der_child(&rdn, j, &atv); j++) {
			if (!mt_der_child(&atv, 0, &oid) || !mt_der_child(&atv, 1, &val)) {
				return false;
			}
			if (is_oid(&oid, oid_vid, sizeof(oid_vid))) {
				*vid = hex4(&val);
			} else if (is_oid(&oid, oid_pid, sizeof(oid_pid))) {
				*pid = hex4(&val);
			}
		}
	}
	return *vid >= -1 && *pid >= -1;
}

static bool read_extensions(const struct mt_der_elem *exts, struct mt_x509 *out)
{
	struct mt_der_elem seq;
	struct mt_der_elem ext;
	struct mt_der_elem oid;
	struct mt_der_elem val;

	if (!mt_der_child(exts, 0, &seq) || seq.tag != DER_SEQUENCE) {
		return false;
	}
	for (unsigned int i = 0; mt_der_child(&seq, i, &ext); i++) {
		if (!mt_der_child(&ext, 0, &oid)) {
			return false;
		}
		/* the value is the last child, after an optional "critical" */
		if (!mt_der_child(&ext, 1, &val)) {
			return false;
		}
		if (val.tag == DER_BOOLEAN && !mt_der_child(&ext, 2, &val)) {
			return false;
		}
		if (val.tag != DER_OCTETS) {
			return false;
		}
		struct mt_der_elem inner;

		if (!mt_der_read(val.value, val.len, &inner)) {
			return false;
		}
		if (is_oid(&oid, oid_basic, sizeof(oid_basic))) {
			struct mt_der_elem ca;

			out->is_ca = mt_der_child(&inner, 0, &ca) && ca.tag == DER_BOOLEAN && ca.len == 1 &&
				     ca.value[0] != 0;
		} else if (is_oid(&oid, oid_skid, sizeof(oid_skid))) {
			if (inner.tag != DER_OCTETS || inner.len != 20) {
				return false;
			}
			memcpy(out->skid, inner.value, 20);
			out->has_skid = true;
		} else if (is_oid(&oid, oid_akid, sizeof(oid_akid))) {
			struct mt_der_elem keyid;

			if (!mt_der_child(&inner, 0, &keyid) || keyid.tag != 0x80 || keyid.len != 20) {
				return false;
			}
			memcpy(out->akid, keyid.value, 20);
			out->has_akid = true;
		}
	}
	return true;
}

bool mt_x509_parse(const uint8_t *der, size_t len, struct mt_x509 *out)
{
	struct mt_der_elem cert;
	struct mt_der_elem tbs;
	struct mt_der_elem alg;
	struct mt_der_elem alg_oid;
	struct mt_der_elem sig;
	struct mt_der_elem e;
	unsigned int i = 0;

	memset(out, 0, sizeof(*out));
	if (!mt_der_read(der, len, &cert) || cert.tag != DER_SEQUENCE || cert.total != len ||
	    !mt_der_child(&cert, 0, &tbs) || tbs.tag != DER_SEQUENCE || !mt_der_child(&cert, 1, &alg) ||
	    !mt_der_child(&alg, 0, &alg_oid) || !is_oid(&alg_oid, oid_ecdsa_sha256, sizeof(oid_ecdsa_sha256)) ||
	    !mt_der_child(&cert, 2, &sig) || sig.tag != DER_BITSTRING || sig.len < 2 || sig.value[0] != 0 ||
	    !mt_der_sig_to_raw(sig.value + 1, sig.len - 1, out->signature)) {
		return false;
	}
	out->tbs = tbs.start;
	out->tbs_len = tbs.total;
	/* version [0], serial, signature algorithm, issuer, validity, subject, key, extensions [3] */
	if (!mt_der_child(&tbs, i, &e)) {
		return false;
	}
	if (e.tag == 0xA0) {
		i++;
	}
	i += 3; /* serial, algorithm, issuer */
	if (!mt_der_child(&tbs, i + 1, &e) || !read_name(&e, &out->vid, &out->pid)) {
		return false;
	}
	struct mt_der_elem spki;
	struct mt_der_elem spki_alg;
	struct mt_der_elem a;
	struct mt_der_elem b;
	struct mt_der_elem key;

	if (!mt_der_child(&tbs, i + 2, &spki) || !mt_der_child(&spki, 0, &spki_alg) ||
	    !mt_der_child(&spki_alg, 0, &a) || !mt_der_child(&spki_alg, 1, &b) ||
	    !is_oid(&a, oid_ec_public_key, sizeof(oid_ec_public_key)) ||
	    !is_oid(&b, oid_prime256v1, sizeof(oid_prime256v1)) || !mt_der_child(&spki, 1, &key) ||
	    key.tag != DER_BITSTRING || key.len != 66 || key.value[0] != 0 || key.value[1] != 0x04) {
		return false;
	}
	memcpy(out->public_key, &key.value[1], 65);
	for (unsigned int k = i + 3; mt_der_child(&tbs, k, &e); k++) {
		if (e.tag == 0xA3 && !read_extensions(&e, out)) {
			return false;
		}
	}
	return true;
}

static bool issued_by(const struct mt_x509 *child, const struct mt_x509 *parent, mt_verify_fn verify)
{
	if (!parent->is_ca || !child->has_akid || !parent->has_skid || memcmp(child->akid, parent->skid, 20) != 0) {
		return false;
	}
	return verify(parent->public_key, child->tbs, child->tbs_len, child->signature);
}

enum mt_attest_result mt_attest_verify(const struct mt_attest_input *in, mt_verify_fn verify,
				       uint8_t dac_public_key[65], uint16_t *vid, uint16_t *pid)
{
	struct mt_x509 dac;
	struct mt_x509 pai;
	struct mt_x509 paa;
	bool found = false;

	if (!mt_x509_parse(in->dac, in->dac_len, &dac) || !mt_x509_parse(in->pai, in->pai_len, &pai)) {
		return MT_ATTEST_BAD_FORMAT;
	}
	for (size_t i = 0; i < mt_trusted_paa_count && !found; i++) {
		if (mt_x509_parse(mt_trusted_paa[i], mt_trusted_paa_len[i], &paa) && paa.has_skid && pai.has_akid &&
		    memcmp(paa.skid, pai.akid, 20) == 0) {
			found = true;
		}
	}
	if (!found) {
		return MT_ATTEST_NO_TRUSTED_PAA;
	}
	if (dac.is_ca || !issued_by(&dac, &pai, verify) || !issued_by(&pai, &paa, verify)) {
		return MT_ATTEST_CHAIN;
	}
	/* The DAC has both IDs; the PAI the same vendor and, if any, the same product; the PAA, if any, the vendor. */
	if (dac.vid < 0 || dac.pid < 0 || pai.vid != dac.vid || (pai.pid >= 0 && pai.pid != dac.pid) ||
	    (paa.vid >= 0 && paa.vid != dac.vid)) {
		return MT_ATTEST_VID_PID;
	}
	/* AttestationElements: { 1: certification declaration, 2: our nonce, 3: timestamp, ... } */
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool nonce_ok = false;
	bool has_cd = false;

	mt_tlv_reader_init(&r, in->elements, in->elements_len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return MT_ATTEST_BAD_FORMAT;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES) {
			has_cd = e.len > 0;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_BYTES) {
			nonce_ok = e.len == 32 && memcmp(e.data, in->nonce, 32) == 0;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return MT_ATTEST_BAD_FORMAT;
			}
		}
	}
	if (r.error || r.depth != 0 || !has_cd) {
		return MT_ATTEST_BAD_FORMAT;
	}
	if (!nonce_ok) {
		return MT_ATTEST_NONCE;
	}
	/* The signature covers the elements followed by the attestation challenge. */
	uint8_t tbs[900 + 16];

	if (in->elements_len > 900) {
		return MT_ATTEST_BAD_FORMAT;
	}
	memcpy(tbs, in->elements, in->elements_len);
	memcpy(&tbs[in->elements_len], in->challenge, 16);
	if (!verify(dac.public_key, tbs, in->elements_len + 16, in->signature)) {
		return MT_ATTEST_SIGNATURE;
	}
	memcpy(dac_public_key, dac.public_key, 65);
	*vid = (uint16_t)dac.vid;
	*pid = (uint16_t)dac.pid;
	return MT_ATTEST_OK;
}

/* The public key out of a PKCS#10 CSR, whose own signature it also checks. */
static bool csr_public_key(const uint8_t *der, size_t len, mt_verify_fn verify, uint8_t key_out[65])
{
	struct mt_der_elem csr;
	struct mt_der_elem info;
	struct mt_der_elem spki;
	struct mt_der_elem key;
	struct mt_der_elem sig;
	uint8_t raw[64];

	if (!mt_der_read(der, len, &csr) || csr.tag != DER_SEQUENCE || !mt_der_child(&csr, 0, &info) ||
	    !mt_der_child(&info, 2, &spki) || !mt_der_child(&spki, 1, &key) || key.tag != DER_BITSTRING ||
	    key.len != 66 || key.value[0] != 0 || key.value[1] != 0x04 || !mt_der_child(&csr, 2, &sig) ||
	    sig.tag != DER_BITSTRING || sig.len < 2 || !mt_der_sig_to_raw(sig.value + 1, sig.len - 1, raw)) {
		return false;
	}
	if (!verify(&key.value[1], info.start, info.total, raw)) {
		return false;
	}
	memcpy(key_out, &key.value[1], 65);
	return true;
}

bool mt_attest_csr(const uint8_t *elements, size_t elements_len, const uint8_t sig[64], const uint8_t *nonce,
		   const uint8_t *challenge, const uint8_t dac_public_key[65], mt_verify_fn verify,
		   uint8_t node_public_key[65])
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	const uint8_t *csr = NULL;
	size_t csr_len = 0;
	bool nonce_ok = false;
	uint8_t tbs[600 + 16];

	/* NOCSRElements: { 1: CSR (DER), 2: our nonce, ... } */
	mt_tlv_reader_init(&r, elements, elements_len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES) {
			csr = e.data;
			csr_len = e.len;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_BYTES) {
			nonce_ok = e.len == 32 && memcmp(e.data, nonce, 32) == 0;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	if (r.error || r.depth != 0 || csr == NULL || !nonce_ok || elements_len > 600) {
		return false;
	}
	memcpy(tbs, elements, elements_len);
	memcpy(&tbs[elements_len], challenge, 16);
	if (!verify(dac_public_key, tbs, elements_len + 16, sig)) {
		return false;
	}
	return csr_public_key(csr, csr_len, verify, node_public_key);
}
