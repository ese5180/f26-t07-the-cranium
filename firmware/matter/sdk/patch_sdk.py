#!/usr/bin/env python3
"""The changes to nRF Connect SDK v3.4.0 that the Matter variant needs (docs/matter-thread.md, "SDK changes").

    python3 -I firmware/matter/sdk/patch_sdk.py <SDK workspace> [--check]

1 and 2 fix the SPAKE2+ prover side of the Oberon PSA driver (the commissioner's side of PASE, which no Nordic
build uses): the two confirmation steps in either order. 3 to 6 let Zephyr's OpenThread border router (its glue
and its platform code: backbone interface, mDNS socket, UDP) build against the OpenThread in this SDK, which is
older than the one it was written for; this SDK does not build that code, and firmware/matter/CMakeLists.txt
does. Each patch is guarded by a marker, so
running it twice changes nothing, and every anchor is checked: an SDK whose code moved fails here, not later in the
build. --check only says whether each file is patched, unpatched, or cannot be.

Never point it at a shared SDK install that other builds use: patch a copy (cp -c -R makes a copy-on-write clone on
macOS) or, as CI does, the job's own SDK.
"""
import os
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
CHECK = "--check" in sys.argv[1:]
if len(args) != 1:
    sys.exit(__doc__)
NCS = os.path.abspath(args[0])
OB = os.path.join(NCS, "modules/crypto/oberon-psa-crypto")

OB_CORE = os.path.join(OB, "core/psa_crypto.c")
OB_DRV = os.path.join(OB, "oberon/drivers/oberon_spake2p.c")
OTBR = os.path.join(NCS, "zephyr/subsys/net/l2/openthread/openthread_border_router.c")
OTPLAT = os.path.join(NCS, "zephyr/modules/openthread/platform")

rc = 0


def patch(path, marker, edits):
    """edits: (old, new) pairs, applied in order. Skipped when the marker is already there."""
    global rc
    rel = os.path.relpath(path, NCS)
    with open(path) as f:
        s = f.read()
    if marker in s:
        print(f"  [done] {rel}")
        return
    for old, new in edits:
        if old not in s:
            print(f"  [FAIL] anchor not found in {rel}: {old.splitlines()[0][:80]!r}")
            rc = 1
            return
        s = s.replace(old, new, 1)
    if CHECK:
        print(f"  [todo] {rel}")
        return
    with open(path, "w") as f:
        f.write(s)
    print(f"  [ok]   {rel}")


# ---- 1) Oberon PSA core: accept SPAKE2+ CONFIRM steps in either order ----
# The two SPAKE2+ confirmation MACs are derived independently after the key-share
# exchange, so their output/input order is cryptographically irrelevant. Matter's
# PASESession emits output(CONFIRM) (ComputeRoundTwo) BEFORE input(CONFIRM)
# (KeyConfirm); the stock sequence check demanded the reverse -> BAD_STATE (-137).
patch(OB_CORE, 'first confirm step', [
    ('    case 2: // confirmV\n'
     '        if (first || step != PSA_PAKE_STEP_CONFIRM) return PSA_ERROR_BAD_STATE;\n'
     '        break;\n'
     '    case 3: // confirmP\n'
     '        if (!first || step != PSA_PAKE_STEP_CONFIRM) return PSA_ERROR_BAD_STATE;\n',
     '    // [on-device commissioner] accept CONFIRM output/input in either order; the\n'
     '    // MACs are independent and read_confirm still verifies the peer MAC.\n'
     '    case 2: // first confirm step (either direction)\n'
     '        (void) first;\n'
     '        if (step != PSA_PAKE_STEP_CONFIRM) return PSA_ERROR_BAD_STATE;\n'
     '        break;\n'
     '    case 3: // second confirm step\n'
     '        if (step != PSA_PAKE_STEP_CONFIRM) return PSA_ERROR_BAD_STATE;\n'),
])

# ---- 2) Oberon SPAKE2+ driver: CLIENT confirm-keys when write runs before read ----
# The CLIENT confirmation keys (and op->mac_len) are normally derived lazily in
# read_confirm; with the commissioner's output-before-input order, write_confirm ran first with
# mac_len still 0 -> PSA_ERROR_BUFFER_TOO_SMALL (-138). Compute the keys in
# write_confirm when needed; guard both sites so the non-idempotent hash finalize
# runs exactly once.
patch(OB_DRV, 'mac_len == 0', [
    ('    if (op->role == PSA_PAKE_ROLE_SERVER) {\n'
     '        status = oberon_get_confirmation_keys(op, op->KconfVP, op->KconfPV);\n'
     '        if (status) return status;\n'
     '    }\n',
     '    if (op->role == PSA_PAKE_ROLE_SERVER) {\n'
     '        status = oberon_get_confirmation_keys(op, op->KconfVP, op->KconfPV);\n'
     '        if (status) return status;\n'
     '    } else if (op->mac_len == 0) {\n'
     '        // [on-device commissioner] Matter PASE emits output(CONFIRM) before input(CONFIRM);\n'
     '        // derive the CLIENT keys here if read_confirm has not run yet (mac_len==0).\n'
     '        status = oberon_get_confirmation_keys(op, op->KconfPV, op->KconfVP);\n'
     '        if (status) return status;\n'
     '    }\n'),
    ('    if (op->role == PSA_PAKE_ROLE_CLIENT) {\n'
     '        status = oberon_get_confirmation_keys(op, op->KconfPV, op->KconfVP);\n'
     '        if (status) return status;\n'
     '    }\n',
     '    if (op->role == PSA_PAKE_ROLE_CLIENT && op->mac_len == 0) {\n'
     '        // [on-device commissioner] skip if write_confirm already derived the keys\n'
     '        // (the hash finalize inside is not idempotent).\n'
     '        status = oberon_get_confirmation_keys(op, op->KconfPV, op->KconfVP);\n'
     '        if (status) return status;\n'
     '    }\n'),
])

# ---- 3) Zephyr's OpenThread border router against this SDK's OpenThread ----
# Zephyr's border router code calls otMdnsSetLocalHostName(), otBorderAgentIsEnabled() and
# otBorderAgentSetEnabled(), which the OpenThread in nRF Connect SDK v3.4.0 does not have: there, mDNS needs no
# local host name set and the border agent starts by itself once Thread is up.
OTBR_MARK = "[on-device commissioner] OpenThread of SDK v3.4.0"
patch(OTBR, OTBR_MARK, [
    ('\tif (otMdnsSetLocalHostName(instance,\n'
     '\t\t\t\t   create_base_name(instance, otbr_vendor_name)) != OT_ERROR_NONE) {\n'
     '\t\terror = -EIO;\n'
     '\t\tgoto exit;\n'
     '\t}\n',
     '\t/* ' + OTBR_MARK + ': no otMdnsSetLocalHostName(). */\n'
     '\t(void)create_base_name;\n'),
    ('\tif (!otBorderAgentIsEnabled(instance)) {\n'
     '\t\totBorderAgentSetEnabled(instance, true);\n'
     '\t}\n',
     '\t/* ' + OTBR_MARK + ': the border agent starts by itself. */\n'),
    ('\t\totBorderAgentSetEnabled(instance, false);\n',
     '\t\t/* ' + OTBR_MARK + ': the border agent stops with Thread. */\n'),
    ('\totBorderRoutingDhcp6PdSetEnabled(instance, true);\n',
     '\tif (IS_ENABLED(CONFIG_OPENTHREAD_BORDER_ROUTING_DHCP6_PD)) { /* ' + OTBR_MARK + ' */\n'
     '\t\totBorderRoutingDhcp6PdSetEnabled(instance, true);\n'
     '\t}\n'),
])

# ---- 4) to 6) Zephyr's border-router platform code against this SDK's OpenThread ----
# This OpenThread has no otPlatGetInfraIfLinkLayerAddress() (and never calls it), no host-address events for its
# mDNS (it reads the addresses itself), and only OT_NETIF_THREAD and OT_NETIF_BACKBONE.
patch(os.path.join(OTPLAT, "infra_if.c"), OTBR_MARK, [
    ('otError otPlatGetInfraIfLinkLayerAddress(otInstance *aInstance, uint32_t aIfIndex,\n'
     '\t\t\t\t\t otPlatInfraIfLinkLayerAddress *aInfraIfLinkLayerAddress)\n'
     '{\n'
     '\tOT_UNUSED_VARIABLE(aInstance);\n'
     '\tstruct net_if *iface = net_if_get_by_index(aIfIndex);\n'
     '\tstruct net_linkaddr *link_addr = net_if_get_link_addr(iface);\n'
     '\n'
     '\taInfraIfLinkLayerAddress->mLength = link_addr->len;\n'
     '\tmemcpy(aInfraIfLinkLayerAddress->mAddress, link_addr->addr, link_addr->len);\n'
     '\n'
     '\treturn OT_ERROR_NONE;\n'
     '}\n',
     '/* ' + OTBR_MARK + ': no otPlatGetInfraIfLinkLayerAddress(). */\n'),
])
patch(os.path.join(OTPLAT, "mdns_socket.c"), OTBR_MARK, [
    ('void mdns_plat_monitor_interface(struct net_if *ail_iface)\n{\n',
     'void mdns_plat_monitor_interface(struct net_if *ail_iface)\n{\n'
     '\t/* ' + OTBR_MARK + ': its mDNS reads the host addresses itself. */\n'
     '\tARG_UNUSED(ail_iface);\n'
     '}\n\n'
     '#if 0\n'
     'void mdns_plat_monitor_interface_newer_openthread(struct net_if *ail_iface)\n{\n'),
    ('\tnet_if_unlock(ail_iface);\n}\n', '\tnet_if_unlock(ail_iface);\n}\n#endif\n'),
])
UDP_CASE_OLD = '\tcase OT_NETIF_THREAD_INTERNAL:\n\t\tassert(false);\n'
patch(os.path.join(OTPLAT, "udp.c"), OTBR_MARK, [
    ('#include <zephyr/sys/util.h>\n',
     '#include <zephyr/sys/util.h>\n\n'
     '/* ' + OTBR_MARK + ': one Thread interface, and no otIp6IsLinkLocalUnicast(). */\n'
     '#define OT_NETIF_THREAD_HOST OT_NETIF_THREAD\n'
     '#define otIp6IsLinkLocalUnicast(a) ((a)->mFields.m8[0] == 0xfe && ((a)->mFields.m8[1] & 0xc0) == 0x80)\n'),
    (UDP_CASE_OLD, ''),
    (UDP_CASE_OLD, ''),
    (UDP_CASE_OLD, ''),
])

print("PATCH_RESULT:", "OK" if rc == 0 else "FAILED")
sys.exit(rc)
