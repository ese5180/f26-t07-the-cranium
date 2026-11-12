/*
 * Who this board is in a CASE session: on its own fabric (as commissioner, mt_fabric.c) or on the phone's
 * (as a device, mt_node.c). CASE in both directions takes one of these.
 */
#ifndef MT_IDENTITY_H_
#define MT_IDENTITY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum mt_identity_kind { MT_ID_OWN_FABRIC, MT_ID_PHONE_FABRIC };

struct mt_case_identity {
	enum mt_identity_kind kind;
	const uint8_t *root_public_key; /* 65 */
	uint64_t fabric_id;
	const uint8_t *ipk;             /* operational IPK, 16 */
	const uint8_t *compressed_id;   /* 8 */
	uint64_t own_node_id;
	const uint8_t *noc;
	size_t noc_len;
	const uint8_t *icac;            /* NULL when there is none */
	size_t icac_len;
	int (*sign)(const uint8_t *data, size_t len, uint8_t sig[64]);
};

/* False when that fabric does not exist (yet). */
bool mt_identity_get(enum mt_identity_kind kind, struct mt_case_identity *out);

/*
 * Checks a peer's NOC (and ICAC) against the identity's root: signatures, the fabric ID, and the node ID when
 * expected_node is not 0. Gives the NOC's public key and node ID.
 */
bool mt_identity_check_peer(const struct mt_case_identity *id, const uint8_t *noc, size_t noc_len,
			    const uint8_t *icac, size_t icac_len, uint64_t expected_node, uint8_t pub[65],
			    uint64_t *node);

#endif /* MT_IDENTITY_H_ */
