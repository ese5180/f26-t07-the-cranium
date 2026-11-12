/*
 * The parts of Zephyr's OpenThread border router this board leaves out to save memory: TREL (Thread over the
 * Wi-Fi link), DHCPv6 prefix delegation, the upstream DNS resolver, and the border agent's meshcop advertisement.
 * Zephyr's border router code calls their set-up unconditionally; here each is a no-op, and OpenThread's own
 * border agent still starts by itself.
 */
#include <openthread/instance.h>
#include <zephyr/net/net_if.h>
#include <platform-zephyr.h>

otError trel_plat_init(otInstance *instance, struct net_if *ail_iface)
{
	ARG_UNUSED(instance);
	ARG_UNUSED(ail_iface);
	return OT_ERROR_NONE;
}

otError dhcpv6_pd_client_init(otInstance *ot_instance, uint32_t ail_iface_index)
{
	ARG_UNUSED(ot_instance);
	ARG_UNUSED(ail_iface_index);
	return OT_ERROR_NONE;
}

otError dns_upstream_resolver_init(otInstance *ot_instance)
{
	ARG_UNUSED(ot_instance);
	return OT_ERROR_NONE;
}

otError border_agent_init(otInstance *instance)
{
	ARG_UNUSED(instance);
	return OT_ERROR_NONE;
}

void border_agent_deinit(void)
{
}
