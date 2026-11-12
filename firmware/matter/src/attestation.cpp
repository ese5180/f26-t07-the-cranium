/*
 * See attestation.h.
 */
#include "attestation.h"

#include <credentials/attestation_verifier/DacOnlyPartialAttestationVerifier.h>
#include <credentials/attestation_verifier/DefaultDeviceAttestationVerifier.h>
#include <lib/support/logging/CHIPLogging.h>

namespace nrf {
namespace controller {

chip::Credentials::DeviceAttestationVerifier * GetBringupDacVerifier()
{
#if defined(CONFIG_CRANIUM_MATTER_ATTESTATION_PARTIAL)
    static chip::Credentials::PartialDACVerifier sVerifier;
    chip::Credentials::SetDeviceAttestationVerifier(&sVerifier);
    ChipLogProgress(Controller, "Attestation: partial (no PAA chain, no certification declaration): development only");
    return &sVerifier;
#else
    const chip::Credentials::AttestationTrustStore * trustStore = chip::Credentials::GetTestAttestationTrustStore();
    chip::Credentials::DeviceAttestationVerifier * verifier = chip::Credentials::GetDefaultDACVerifier(trustStore);
    chip::Credentials::SetDeviceAttestationVerifier(verifier);
    ChipLogProgress(Controller, "Attestation: Matter test PAA only (vendor 0xFFF1 test devices)");
    return verifier;
#endif
}

} // namespace controller
} // namespace nrf
