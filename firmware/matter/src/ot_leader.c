/*
 * See ot_leader.h. Lessons from the earlier commissioner: OpenThread's heap is the system heap
 * (CONFIG_OPENTHREAD_EXTERNAL_HEAP), or the SRP server starts with no domain and refuses every registration; the
 * domain is checked here as well.
 */
#include "ot_leader.h"

#include <errno.h>
#include <string.h>

#include <openthread.h>
#include <openthread/dataset.h>
#include <openthread/dataset_ftd.h>
#include <openthread/ip6.h>
#include <openthread/srp_server.h>
#include <openthread/thread.h>
#include <openthread/thread_ftd.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(ot_leader, LOG_LEVEL_INF);

int ot_leader_start(void)
{
	otInstance *ot = openthread_get_default_instance();
	otError err = OT_ERROR_NONE;
	int ret = 0;

	if (ot == NULL) {
		return -ENODEV;
	}
	openthread_mutex_lock();
	if (!otDatasetIsCommissioned(ot)) {
		otOperationalDataset ds;

		memset(&ds, 0, sizeof(ds));
		err = otDatasetCreateNewNetwork(ot, &ds);
		if (err == OT_ERROR_NONE) {
			ds.mChannel = CONFIG_CRANIUM_THREAD_CHANNEL;
			ds.mComponents.mIsChannelPresent = true;
			err = otDatasetSetActive(ot, &ds);
		}
		if (err != OT_ERROR_NONE) {
			LOG_ERR("no Thread network could be formed: %d", err);
			ret = -EIO;
			goto out;
		}
		LOG_INF("new Thread network: channel %u, PAN 0x%04x", ds.mChannel, ds.mPanId);
	}
	err = otIp6SetEnabled(ot, true);
	if (err == OT_ERROR_NONE) {
		err = otThreadSetEnabled(ot, true);
	}
	if (err == OT_ERROR_NONE && otThreadGetDeviceRole(ot) != OT_DEVICE_ROLE_LEADER) {
		/* A new network: lead it at once instead of waiting to find no other leader. */
		(void)otThreadBecomeLeader(ot);
	}
	if (err != OT_ERROR_NONE) {
		LOG_ERR("Thread could not start: %d", err);
		ret = -EIO;
		goto out;
	}

	const char *domain = otSrpServerGetDomain(ot);

	if (domain == NULL || domain[0] == '\0') {
		(void)otSrpServerSetDomain(ot, "default.service.arpa.");
	}
	otSrpServerSetEnabled(ot, true);
out:
	openthread_mutex_unlock();
	return ret;
}

int ot_leader_dataset(uint8_t *out, size_t cap, size_t *len)
{
	otOperationalDatasetTlvs tlvs;
	otError err;

	openthread_mutex_lock();
	err = otDatasetGetActiveTlvs(openthread_get_default_instance(), &tlvs);
	openthread_mutex_unlock();
	if (err != OT_ERROR_NONE) {
		return -ENOENT;
	}
	if (tlvs.mLength > cap) {
		return -ENOBUFS;
	}
	memcpy(out, tlvs.mTlvs, tlvs.mLength);
	*len = tlvs.mLength;
	return 0;
}

const char *ot_leader_role(void)
{
	otDeviceRole role;

	openthread_mutex_lock();
	role = otThreadGetDeviceRole(openthread_get_default_instance());
	openthread_mutex_unlock();
	switch (role) {
	case OT_DEVICE_ROLE_LEADER:
		return "leader";
	case OT_DEVICE_ROLE_ROUTER:
		return "router";
	case OT_DEVICE_ROLE_CHILD:
		return "child";
	case OT_DEVICE_ROLE_DETACHED:
		return "detached";
	default:
		return "disabled";
	}
}
