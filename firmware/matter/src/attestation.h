/*
 * The device attestation verifier the commissioner uses to check a new device's certificates (its DAC, PAI and
 * certification declaration).
 *
 * Two modes, chosen with CONFIG_CRANIUM_MATTER_ATTESTATION_PARTIAL:
 *   - partial (default during development): the DAC and PAI are parsed and their signatures checked, but the
 *     chain is not taken up to a trusted PAA and the certification declaration is not checked. Retail devices,
 *     whose PAAs are not built in, pass.
 *   - test trust store: only devices with Matter test certificates (vendor 0xFFF1, the test PAA) pass.
 * A product needs a third mode: the full check against the production PAAs from the Distributed Compliance Ledger.
 */
#pragma once

#include <credentials/attestation_verifier/DeviceAttestationVerifier.h>

namespace nrf {
namespace controller {

/* Installs the verifier as the stack's default and returns it. */
chip::Credentials::DeviceAttestationVerifier * GetBringupDacVerifier();

} // namespace controller
} // namespace nrf
