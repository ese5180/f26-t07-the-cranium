/*
 * See mt_identity.h.
 */
#include "mt_identity.h"

#include <string.h>

#include "mt_attest.h"
#include "mt_cert.h"
#include "mt_fabric.h"
#include "mt_node.h"

bool mt_identity_get(enum mt_identity_kind kind, struct mt_case_identity *out)
{
	memset(out, 0, sizeof(*out));
	out->kind = kind;
	if (kind == MT_ID_OWN_FABRIC) {
		const struct mt_fabric *f = mt_fabric();

		if (f->rcac_len == 0) {
			return false;
		}
		out->root_public_key = f->root_public_key;
		out->fabric_id = f->fabric_id;
		out->ipk = f->operational_ipk;
		out->compressed_id = f->compressed_id;
		out->own_node_id = f->own_node_id;
		out->noc = f->own_noc;
		out->noc_len = f->own_noc_len;
		out->sign = mt_fabric_sign_own;
		return true;
	}
	const struct mt_node_fabric *n = mt_node_fabric();

	if (!n->present) {
		return false;
	}
	out->root_public_key = n->root_public_key;
	out->fabric_id = n->fabric_id;
	out->ipk = n->ipk;
	out->compressed_id = n->compressed_id;
	out->own_node_id = n->node_id;
	out->noc = n->noc;
	out->noc_len = n->noc_len;
	out->icac = n->icac_len ? n->icac : NULL;
	out->icac_len = n->icac_len;
	out->sign = mt_node_sign_operational;
	return true;
}

static bool signed_by(const uint8_t *cert, size_t len, const uint8_t issuer_pub[65])
{
	uint8_t der[MT_CERT_DER_MAX];
	struct mt_x509 x;
	int n = mt_cert_to_der(cert, len, der, sizeof(der), NULL, NULL);

	return n > 0 && mt_x509_parse(der, (size_t)n, &x) && mt_verify(issuer_pub, x.tbs, x.tbs_len, x.signature);
}

bool mt_identity_check_peer(const struct mt_case_identity *id, const uint8_t *noc, size_t noc_len,
			    const uint8_t *icac, size_t icac_len, uint64_t expected_node, uint8_t pub[65],
			    uint64_t *node)
{
	uint64_t fabric;
	uint8_t icac_pub[65];
	uint64_t x;
	uint64_t y;

	if (!mt_cert_read(noc, noc_len, pub, node, &fabric) || fabric != id->fabric_id ||
	    (expected_node && *node != expected_node)) {
		return false;
	}
	if (icac) {
		return mt_cert_read(icac, icac_len, icac_pub, &x, &y) && signed_by(icac, icac_len, id->root_public_key) &&
		       signed_by(noc, noc_len, icac_pub);
	}
	return signed_by(noc, noc_len, id->root_public_key);
}
