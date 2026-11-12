#!/usr/bin/env python3
"""The nine changes to nRF Connect SDK v3.4.0 that the Matter commissioner needs (docs/matter-thread.md, "SDK changes").

    python3 -I firmware/matter/sdk/patch_sdk.py <SDK workspace> [--check]

1-3 let the Matter controller library build and plug this project's Bluetooth central into the SDK's Bluetooth
manager; 4-6 fix the SPAKE2+ prover side (the commissioner's side of PASE), which no Nordic sample uses; 7 lets
the certificate code that reads a device's public key build with mbedTLS 4, which SDK v3.4.0 has (only a
commissioner reads other devices' certificates, so no Nordic build compiles it); 8 makes Matter's own Wi-Fi
support follow CONFIG_CHIP_WIFI rather than the presence of the nRF70 chip, so that a board can run Matter over
Thread with Wi-Fi as the border router's backbone (CHIP_WIFI selects WIFI_NRF70, so Matter-over-Wi-Fi builds are
unchanged); 9 lets Zephyr's OpenThread border router build against the OpenThread in this SDK, which is older
than the one it was written for (no otMdnsSetLocalHostName(), and a border agent that starts by itself). Each patch
is guarded by a marker, so running it twice changes nothing, and every anchor is checked: an SDK whose code moved
fails here, not later in the build. --check only says whether each file is patched, unpatched, or cannot be.

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
M = os.path.join(NCS, "modules/lib/matter")
OB = os.path.join(NCS, "modules/crypto/oberon-psa-crypto")

BLE = os.path.join(M, "src/platform/Zephyr/BLEManagerImpl.cpp")
CMAKE = os.path.join(M, "config/nrfconnect/chip-module/CMakeLists.txt")
KCONF = os.path.join(M, "config/nrfconnect/chip-module/Kconfig")
SPAKE = os.path.join(M, "src/crypto/PSASpake2p.cpp")
OB_CORE = os.path.join(OB, "core/psa_crypto.c")
OB_DRV = os.path.join(OB, "oberon/drivers/oberon_spake2p.c")
CERT = os.path.join(M, "src/crypto/CHIPCryptoPALmbedTLSCert.cpp")
NRFC = os.path.join(M, "src/platform/nrfconnect")
OTBR = os.path.join(NCS, "zephyr/subsys/net/l2/openthread/openthread_border_router.c")

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


# ---- 1) BLEManagerImpl.cpp: BLE-central wiring ----
patch(BLE, 'BleCentralConnectionDelegate', [
    # a) inline the forwarding decls (the chip GN build can't see the app src/ dir,
    #    so we declare here and DEFINE in the app's ble_central.cpp).
    ('#include <platform/Zephyr/BLEManagerImpl.h>\n',
     '#include <platform/Zephyr/BLEManagerImpl.h>\n'
     '#include <utility>\n'
     '// On-device commissioner: BLE-central forwarding decls (defined in app ble_central.cpp).\n'
     'namespace nrf { namespace controller {\n'
     'chip::Ble::BleConnectionDelegate * BleCentralConnectionDelegate();\n'
     'CHIP_ERROR BleCentralSubscribe(bt_conn *, const chip::Ble::ChipBleUUID *, const chip::Ble::ChipBleUUID *);\n'
     'CHIP_ERROR BleCentralUnsubscribe(bt_conn *, const chip::Ble::ChipBleUUID *, const chip::Ble::ChipBleUUID *);\n'
     'CHIP_ERROR BleCentralWrite(bt_conn *, const chip::Ble::ChipBleUUID *, const chip::Ble::ChipBleUUID *, chip::System::PacketBufferHandle);\n'
     '} }\n'),
    # b) install BleCentral as the BleConnectionDelegate (4-arg BleLayer::Init)
    ('ReturnErrorOnFailure(BleLayer::Init(this, this, &DeviceLayer::SystemLayer()));',
     'ReturnErrorOnFailure(BleLayer::Init(this, ::nrf::controller::BleCentralConnectionDelegate(), this, '
     '&DeviceLayer::SystemLayer()));'),
    # c) SubscribeCharacteristic -> forward
    ('CHIP_ERROR BLEManagerImpl::SubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId,\n'
     '                                                   const ChipBleUUID * charId)\n'
     '{\n'
     '    ChipLogDetail(DeviceLayer, "BLE central not implemented");\n'
     '    return CHIP_ERROR_NOT_IMPLEMENTED;\n'
     '}',
     'CHIP_ERROR BLEManagerImpl::SubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId,\n'
     '                                                   const ChipBleUUID * charId)\n'
     '{\n'
     '    return ::nrf::controller::BleCentralSubscribe(conId, svcId, charId);\n'
     '}'),
    # d) UnsubscribeCharacteristic -> forward
    ('CHIP_ERROR BLEManagerImpl::UnsubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId,\n'
     '                                                     const ChipBleUUID * charId)\n'
     '{\n'
     '    ChipLogDetail(DeviceLayer, "BLE central not implemented");\n'
     '    return CHIP_ERROR_NOT_IMPLEMENTED;\n'
     '}',
     'CHIP_ERROR BLEManagerImpl::UnsubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId,\n'
     '                                                     const ChipBleUUID * charId)\n'
     '{\n'
     '    return ::nrf::controller::BleCentralUnsubscribe(conId, svcId, charId);\n'
     '}'),
    # e) SendWriteRequest -> forward
    ('CHIP_ERROR BLEManagerImpl::SendWriteRequest(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId, const ChipBleUUID * charId,\n'
     '                                            PacketBufferHandle pBuf)\n'
     '{\n'
     '    ChipLogDetail(DeviceLayer, "BLE central not implemented");\n'
     '    return CHIP_ERROR_NOT_IMPLEMENTED;\n'
     '}',
     'CHIP_ERROR BLEManagerImpl::SendWriteRequest(BLE_CONNECTION_OBJECT conId, const ChipBleUUID * svcId, const ChipBleUUID * charId,\n'
     '                                            PacketBufferHandle pBuf)\n'
     '{\n'
     '    return ::nrf::controller::BleCentralWrite(conId, svcId, charId, std::move(pBuf));\n'
     '}'),
])

# ---- 2) chip-module CMakeLists.txt: expose chip_build_controller GN arg ----
patch(CMAKE, 'chip_build_controller', [
    ('matter_add_gn_arg_bool  ("chip_enable_read_client"                CONFIG_CHIP_ENABLE_READ_CLIENT)\n',
     'matter_add_gn_arg_bool  ("chip_enable_read_client"                CONFIG_CHIP_ENABLE_READ_CLIENT)\n'
     'matter_add_gn_arg_bool  ("chip_build_controller"                  CONFIG_CHIP_CONTROLLER)\n'),
])

# ---- 3) chip-module Kconfig: CONFIG_CHIP_CONTROLLER symbol ----
patch(KCONF, 'config CHIP_CONTROLLER', [
    ('config CHIP_ENABLE_READ_CLIENT\n',
     'config CHIP_CONTROLLER\n'
     '\tbool "Build the Matter controller/commissioner library"\n'
     '\tselect CHIP_ENABLE_READ_CLIENT\n'
     '\thelp\n'
     '\t  Compile connectedhomeip src/controller (DeviceCommissioner, SetUpCodePairer,\n'
     '\t  AutoCommissioner) into libCHIP so the device can act as an on-device Matter\n'
     '\t  commissioner. Sets the GN arg chip_build_controller=true.\n'
     '\n'
     'config CHIP_ENABLE_READ_CLIENT\n'),
])

# ---- 4) PSASpake2p.cpp: SPAKE2+ PROVER (commissioner) key import ----
# The NCS PSA SPAKE2+ drivers (Oberon and CRACEN) require the prover key pair as two
# 32-byte REDUCED scalars (w0:w1 mod n, 64 bytes total); CHIP's BeginProver passes the
# two 40-byte un-reduced PBKDF2 wS values (80 bytes) -> psa_import_key returns
# PSA_ERROR_NOT_SUPPORTED (-134) and PASE dies right after PBKDFParamResponse.
# Reduce each half mod n with the nrf_oberon ocrypto primitive before importing.
patch(SPAKE, 'ocrypto_spake2p_p256_reduce', [
    ('#include <psa/crypto.h>\n',
     '#include <psa/crypto.h>\n'
     '\n'
     '// [on-device commissioner] Reduce a 40-byte PBKDF2 wS to a 32-byte scalar mod n.\n'
     '// Symbol lives in the linked nrf_oberon library; header not on the CHIP include path.\n'
     'extern "C" void ocrypto_spake2p_p256_reduce(uint8_t x[32], const uint8_t * xs, size_t xs_len);\n'),
    ('    memcpy(password + 0, w0sin, w0sin_len);\n'
     '    memcpy(password + w0sin_len, w1sin, w1sin_len);\n',
     '    // [on-device commissioner] drivers need w0:w1 as 2x32B reduced scalars, not 2x40B wS.\n'
     '    ocrypto_spake2p_p256_reduce(password + 0, w0sin, w0sin_len);\n'
     '    ocrypto_spake2p_p256_reduce(password + 32, w1sin, w1sin_len);\n'
     '    const size_t reducedKeyLen = 64;\n'),
    ('    psa_status_t status = psa_import_key(&attributes, password, w0sin_len + w1sin_len, &mKey);\n',
     '    psa_status_t status = psa_import_key(&attributes, password, reducedKeyLen, &mKey);\n'),
])

# ---- 5) Oberon PSA core: accept SPAKE2+ CONFIRM steps in either order ----
# The two SPAKE2+ confirmation MACs are derived independently after the key-share
# exchange, so their output/input order is cryptographically irrelevant. CHIP's
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

# ---- 6) Oberon SPAKE2+ driver: CLIENT confirm-keys when write runs before read ----
# The CLIENT confirmation keys (and op->mac_len) are normally derived lazily in
# read_confirm; with CHIP's output-before-input order, write_confirm ran first with
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
     '        // [on-device commissioner] CHIP emits output(CONFIRM) before input(CONFIRM);\n'
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

# ---- 7) CHIPCryptoPALmbedTLSCert.cpp: public keys from certificates and CSRs with mbedTLS 4 ----
# mbedTLS 4 (TF-PSA-crypto) has no mbedtls_pk_ec() or mbedtls_ecp_point_write_binary(): a PK context holds the
# raw public key, which mbedtls_pk_write_pubkey_psa() copies out in the uncompressed point format CHIP wants.
patch(CERT, 'mbedtls_pk_write_pubkey_psa', [
    ('    mbedtls_ecp_keypair * keypair = nullptr;\n\n    P256ECDSASignature signature;',
     '#if (MBEDTLS_VERSION_NUMBER < 0x04000000)\n    mbedtls_ecp_keypair * keypair = nullptr;\n#endif\n\n    P256ECDSASignature signature;'),
    ('    VerifyOrExit(csr.CHIP_CRYPTO_PAL_PRIVATE(sig_pk) == MBEDTLS_PK_ECDSA, error = CHIP_ERROR_WRONG_KEY_TYPE);\n\n'
     '    keypair = mbedtls_pk_ec(csr.CHIP_CRYPTO_PAL_PRIVATE_X509(pk));\n\n'
     '    // Copy the public key from the CSR\n'
     '    result = mbedtls_ecp_point_write_binary(&keypair->CHIP_CRYPTO_PAL_PRIVATE(grp), &keypair->CHIP_CRYPTO_PAL_PRIVATE(Q),\n'
     '                                            MBEDTLS_ECP_PF_UNCOMPRESSED, &pubkey_size, Uint8::to_uchar(pubkey), pubkey.Length());\n',
     '#if (MBEDTLS_VERSION_NUMBER >= 0x04000000)\n'
     '    // [on-device commissioner] mbedTLS 4: the PK context holds the raw public key.\n'
     '    VerifyOrExit(csr.CHIP_CRYPTO_PAL_PRIVATE(sig_pk) == MBEDTLS_PK_SIGALG_ECDSA, error = CHIP_ERROR_WRONG_KEY_TYPE);\n'
     '    result = mbedtls_pk_write_pubkey_psa(&csr.CHIP_CRYPTO_PAL_PRIVATE_X509(pk), Uint8::to_uchar(pubkey), pubkey.Length(),\n'
     '                                         &pubkey_size);\n'
     '#else\n'
     '    VerifyOrExit(csr.CHIP_CRYPTO_PAL_PRIVATE(sig_pk) == MBEDTLS_PK_ECDSA, error = CHIP_ERROR_WRONG_KEY_TYPE);\n\n'
     '    keypair = mbedtls_pk_ec(csr.CHIP_CRYPTO_PAL_PRIVATE_X509(pk));\n\n'
     '    // Copy the public key from the CSR\n'
     '    result = mbedtls_ecp_point_write_binary(&keypair->CHIP_CRYPTO_PAL_PRIVATE(grp), &keypair->CHIP_CRYPTO_PAL_PRIVATE(Q),\n'
     '                                            MBEDTLS_ECP_PF_UNCOMPRESSED, &pubkey_size, Uint8::to_uchar(pubkey), pubkey.Length());\n'
     '#endif\n'),
    ('    mbedtls_x509_crt mbed_cert;\n    mbedtls_ecp_keypair * keypair = nullptr;\n    size_t pubkey_size            = 0;\n',
     '    mbedtls_x509_crt mbed_cert;\n#if (MBEDTLS_VERSION_NUMBER < 0x04000000)\n    mbedtls_ecp_keypair * keypair = nullptr;\n#endif\n    size_t pubkey_size            = 0;\n'),
    ('    VerifyOrExit(mbedtls_pk_get_type(&(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk))) == MBEDTLS_PK_ECKEY,\n'
     '                 error = CHIP_ERROR_INVALID_ARGUMENT);\n\n'
     '    keypair = mbedtls_pk_ec(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk));\n'
     '    VerifyOrExit(keypair->CHIP_CRYPTO_PAL_PRIVATE(grp).id == MapECPGroupId(pubkey.Type()), error = CHIP_ERROR_INVALID_ARGUMENT);\n'
     '    // Copy the public key from the cert in raw point format\n'
     '    result =\n'
     '        mbedtls_ecp_point_write_binary(&keypair->CHIP_CRYPTO_PAL_PRIVATE(grp), &keypair->CHIP_CRYPTO_PAL_PRIVATE(Q),\n'
     '                                       MBEDTLS_ECP_PF_UNCOMPRESSED, &pubkey_size, Uint8::to_uchar(pubkey.Bytes()), pubkey.Length());\n',
     '#if (MBEDTLS_VERSION_NUMBER >= 0x04000000)\n'
     '    // [on-device commissioner] mbedTLS 4: a P-256 public key, copied out as the raw uncompressed point.\n'
     '    VerifyOrExit(mbedtls_pk_get_key_type(&(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk))) ==\n'
     '                         PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1) &&\n'
     '                     mbedtls_pk_get_bitlen(&(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk))) == 256 &&\n'
     '                     pubkey.Type() == SupportedECPKeyTypes::ECP256R1,\n'
     '                 error = CHIP_ERROR_INVALID_ARGUMENT);\n'
     '    result = mbedtls_pk_write_pubkey_psa(&(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk)), Uint8::to_uchar(pubkey.Bytes()),\n'
     '                                         pubkey.Length(), &pubkey_size);\n'
     '#else\n'
     '    VerifyOrExit(mbedtls_pk_get_type(&(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk))) == MBEDTLS_PK_ECKEY,\n'
     '                 error = CHIP_ERROR_INVALID_ARGUMENT);\n\n'
     '    keypair = mbedtls_pk_ec(mbed_cert.CHIP_CRYPTO_PAL_PRIVATE_X509(pk));\n'
     '    VerifyOrExit(keypair->CHIP_CRYPTO_PAL_PRIVATE(grp).id == MapECPGroupId(pubkey.Type()), error = CHIP_ERROR_INVALID_ARGUMENT);\n'
     '    // Copy the public key from the cert in raw point format\n'
     '    result =\n'
     '        mbedtls_ecp_point_write_binary(&keypair->CHIP_CRYPTO_PAL_PRIVATE(grp), &keypair->CHIP_CRYPTO_PAL_PRIVATE(Q),\n'
     '                                       MBEDTLS_ECP_PF_UNCOMPRESSED, &pubkey_size, Uint8::to_uchar(pubkey.Bytes()), pubkey.Length());\n'
     '#endif\n'),
])

# ---- 8) Matter's Wi-Fi support follows CONFIG_CHIP_WIFI, not the presence of the nRF70 ----
# Stock, any build with the nRF70 driver compiles Matter's Wi-Fi network layer and minimal mDNS, even when Matter
# runs over Thread and Wi-Fi only carries the border router's backbone.
WIFI = "[on-device commissioner] Matter over Wi-Fi only when CHIP_WIFI"
patch(CMAKE, WIFI, [
    ('matter_add_gn_arg_bool  ("chip_enable_wifi"                       CONFIG_WIFI_NRF70)\n',
     '# ' + WIFI + '\nmatter_add_gn_arg_bool  ("chip_enable_wifi"                       CONFIG_CHIP_WIFI)\n'),
    ('matter_add_gn_arg_bool  ("chip_mdns_minimal"                      CONFIG_WIFI_NRF70)\n',
     'matter_add_gn_arg_bool  ("chip_mdns_minimal"                      CONFIG_CHIP_WIFI)\n'),
    ('if(CONFIG_WIFI_NRF70)\n    matter_add_gn_arg_string("chip_mdns" "minimal")',
     'if(CONFIG_CHIP_WIFI)\n    matter_add_gn_arg_string("chip_mdns" "minimal")'),
])
patch(os.path.join(NRFC, "CHIPDevicePlatformConfig.h"), WIFI, [
    ('#ifdef CONFIG_WIFI_NRF70\n#define CHIP_DEVICE_CONFIG_ENABLE_WIFI CONFIG_WIFI_NRF70\n',
     '// ' + WIFI + '\n#ifdef CONFIG_CHIP_WIFI\n#define CHIP_DEVICE_CONFIG_ENABLE_WIFI CONFIG_CHIP_WIFI\n'),
])
patch(os.path.join(NRFC, "SystemPlatformConfig.h"), WIFI, [
    ('#ifndef CHIP_SYSTEM_CONFIG_PACKETBUFFER_CAPACITY_MAX\n#ifdef CONFIG_WIFI_NRF70\n',
     '#ifndef CHIP_SYSTEM_CONFIG_PACKETBUFFER_CAPACITY_MAX\n// ' + WIFI + '\n#ifdef CONFIG_CHIP_WIFI\n'),
])
patch(os.path.join(NRFC, "DiagnosticDataProviderImplNrf.h"), WIFI, [
    ('#ifdef CONFIG_WIFI_NRF70\n', '// ' + WIFI + '\n#ifdef CONFIG_CHIP_WIFI\n'),
])
patch(os.path.join(NRFC, "DiagnosticDataProviderImplNrf.cpp"), WIFI, [
    ('#ifdef CONFIG_WIFI_NRF70\n', '// ' + WIFI + '\n#ifdef CONFIG_CHIP_WIFI\n'),
    ('#ifdef CONFIG_WIFI_NRF70\n', '#ifdef CONFIG_CHIP_WIFI\n'),
])

# ---- 9) Zephyr's OpenThread border router against this SDK's OpenThread ----
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
])

print("PATCH_RESULT:", "OK" if rc == 0 else "FAILED")
sys.exit(rc)
