/*
 * ControllerClient implementation — on-device Matter commissioner.
 *
 * Init()  : storage/keystore/opcertstore/groupdata + DeviceControllerFactory::Init
 * SetupCommissioner() : attestation + ExampleOperationalCredentialsIssuer +
 *                       NOC chain + SetupCommissioner + IPK
 * PairBleThread() / PairCode() / Unpair() : pairing entry-points.
 *
 * All CHIP API calls are dispatched on the Matter thread via ScheduleWork or
 * called directly from context that is already on the Matter thread.
 *
 * See main.cpp for the call sequence this
 * follows (steps 1a-2p).
 *
 * In plain English:
 * This file is the "brain" of the smart-home hub — the part that actually sets a
 * new smart device up and takes ownership of it. It does two big jobs. First, at
 * startup, it builds everything the hub needs to be a trusted authority in your
 * home's network: on-chip storage that survives reboots, a secure vault for the
 * hub's private crypto keys, and the hub's own digital "ID cards" (certificates)
 * proving it's the boss of this home (a "fabric"). Second, when you want to add a
 * gadget (say a light bulb), it runs the whole pairing dance: reach the new
 * device over Bluetooth, prove you're allowed to pair with it using its secret
 * setup code, hand it the Thread mesh network's "name + password", and move it onto
 * that mesh. Because all this Matter logic must run on one special background
 * thread, the public entry-points here carefully hand their work over to that
 * thread so nothing runs in the wrong place. There's also a "watchdog" that gives
 * up on a pairing attempt that gets stuck, so the hub can cleanly try again.
 */

#include "controller_client.h"
#include "matter_policy.h"

#include <cstring>
#include "attestation.h"
#include "empty_provider.h"

#include <controller/AutoCommissioner.h>
#include <controller/CHIPDeviceControllerFactory.h>
#include <controller/CommissioningDelegate.h>
#include <controller/DevicePairingDelegate.h>
#include <controller/ExampleOperationalCredentialsIssuer.h>
#include <controller/SetUpCodePairer.h>
#include <credentials/GroupDataProvider.h>
#include <crypto/CHIPCryptoPAL.h>
#include <data-model-providers/codegen/Instance.h>
#include <include/platform/KvsPersistentStorageDelegate.h>
#include <lib/core/CASEAuthTag.h>
#include <lib/core/CHIPError.h>
#include <lib/support/CodeUtils.h>
#include <lib/support/ScopedBuffer.h>
#include <lib/support/TestGroupData.h>
#include <lib/support/logging/CHIPLogging.h>
#include <platform/CHIPDeviceLayer.h>
#include <platform/KeyValueStoreManager.h>
#include <platform/PlatformManager.h>
#include <protocols/secure_channel/RendezvousParameters.h>
#include <system/SystemClock.h>
#include <system/SystemLayer.h>
#include <transport/raw/PeerAddress.h>

namespace nrf {
namespace controller {

// These three module-wide flags/values track the state of any in-progress pairing.
// They are "volatile" because they are read from a DIFFERENT thread than the one
// that writes them. The writes all happen on the Matter thread (inside the delegate
// callbacks below); the cross-thread reads come from the public IsCommissioned() /
// IsPairingActive() accessors, which the shell (or any other thread) can call at any
// time. "volatile" tells the compiler not to cache these in a register so those
// other-thread reads always see the latest written value.
// (Note: the auto-commission retry loop and the pairing watchdog both run ON the
// Matter thread via SystemLayer timers, so they are same-thread readers, not the
// reason for volatile.)
//
// Set once a node finishes commissioning; read by the auto-commission retry loop.
static volatile bool gCommissioned = false;
// True while a pairing/commissioning attempt is in flight (from PairDevice until a
// terminal pairing/commissioning callback). Prevents the retry loop from starting a
// second PairDevice on top of a live one (which returns CHIP_ERROR_INCORRECT_STATE).
static volatile bool gPairingActive = false;
// Node id of the in-flight attempt, so the watchdog can StopPairing() it.
static chip::NodeId gPairingNodeId = 0;

// Returns true once at least one device has been fully added to this home. Lets
// callers (e.g. the retry loop, UI, shell) check whether setup succeeded.
bool ControllerClient::IsCommissioned()
{
    return gCommissioned;
}

// Returns true while a pairing attempt is currently running. Callers use this to
// avoid launching a second, overlapping attempt.
bool ControllerClient::IsPairingActive()
{
    return gPairingActive;
}

// ---------------------------------------------------------------------------
// Simple DevicePairingDelegate that logs every callback.
// ---------------------------------------------------------------------------

// An anonymous namespace: everything inside is private to this file only.
namespace {

// A "pairing delegate" is a set of callbacks the Matter code calls to keep us
// posted on how a pairing is going (progress, success, failure). This one just
// logs each event and flips the global flags above so the retry loop knows the
// outcome. All of these callbacks run on the Matter thread.
class LoggingPairingDelegate : public chip::Controller::DevicePairingDelegate
{
public:
    // Called with generic progress updates during the early setup handshake.
    // We just print the status number for debugging.
    void OnStatusUpdate(chip::Controller::DevicePairingDelegate::Status status) override
    {
        ChipLogProgress(Controller, "PairingDelegate::OnStatusUpdate status=%d",
                        static_cast<int>(status));
    }

    // Called when the FIRST secure handshake over Bluetooth (PASE, using the setup
    // code) finishes. Success here just means the Bluetooth link is trusted — the
    // full add-to-network process continues afterward. On failure we clear the busy
    // flag so a retry can start.
    void OnPairingComplete(CHIP_ERROR error) override
    {
        if (error == CHIP_NO_ERROR)
        {
            ChipLogProgress(Controller, "PairingDelegate::OnPairingComplete — success");
        }
        else
        {
            gPairingActive = false; // PASE failed / discovery timed out — allow a retry
            ChipLogError(Controller, "PairingDelegate::OnPairingComplete — error: %" CHIP_ERROR_FORMAT,
                         error.Format());
        }
    }

    // Called when a previously established pairing session is torn down. We just log
    // it; nothing else to do here.
    void OnPairingDeleted(CHIP_ERROR error) override
    {
        ChipLogProgress(Controller, "PairingDelegate::OnPairingDeleted error=%" CHIP_ERROR_FORMAT,
                        error.Format());
    }

    // Called after EACH step ("stage") of the full add-to-network process finishes
    // (e.g. checking the device's certificate, handing over Thread credentials).
    // Purely informational logging so we can see how far along we got.
    void OnCommissioningStatusUpdate(chip::PeerId peerId, chip::Controller::CommissioningStage stageCompleted,
                                     CHIP_ERROR error) override
    {
        ChipLogProgress(Controller,
                        "PairingDelegate::OnCommissioningStatusUpdate "
                        "node=0x" ChipLogFormatX64 " stage=%d err=%" CHIP_ERROR_FORMAT,
                        ChipLogValueX64(peerId.GetNodeId()),
                        static_cast<int>(stageCompleted),
                        error.Format());
    }

    // Called when the ENTIRE add-a-device process succeeds: the gadget is now a
    // trusted member of this home and is running on the Thread mesh. We record the
    // win and clear the busy flag.
    void OnCommissioningSuccess(chip::PeerId peerId) override
    {
        gCommissioned  = true;
        gPairingActive = false;
        ChipLogProgress(Controller,
                        "PairingDelegate::OnCommissioningSuccess node=0x" ChipLogFormatX64,
                        ChipLogValueX64(peerId.GetNodeId()));
    }

    // Called when the add-a-device process fails partway through, telling us which
    // step broke. We clear the busy flag so the retry loop can try again, and log
    // the failing stage and error.
    void OnCommissioningFailure(chip::PeerId peerId, CHIP_ERROR error,
                                chip::Controller::CommissioningStage stageFailed,
                                chip::Optional<chip::Credentials::AttestationVerificationResult> additionalErrorInfo) override
    {
        gPairingActive = false; // commissioning failed — allow a retry
        ChipLogError(Controller,
                     "PairingDelegate::OnCommissioningFailure "
                     "node=0x" ChipLogFormatX64 " stage=%d err=%" CHIP_ERROR_FORMAT,
                     ChipLogValueX64(peerId.GetNodeId()),
                     static_cast<int>(stageFailed),
                     error.Format());
    }
};

// Process-lifetime delegate instance — allocated once, lives forever.
LoggingPairingDelegate gLoggingPairingDelegate;

// ---------------------------------------------------------------------------
// Async work items for ScheduleWork paths.
// ---------------------------------------------------------------------------
//
// The public Pair*/Unpair methods can be called from any thread, but the actual
// Matter calls must run on the Matter thread. So each method copies its inputs into
// a small heap struct and hands it to the Matter thread via ScheduleWork; the
// matching Do*() function below unpacks the struct, does the work, and frees it.

// Bundle of everything a BLE+Thread pairing needs: the ID to assign the device, its
// secret setup passcode, the number it broadcasts to identify itself
// (discriminator), and a copy of the Thread network credentials (dataset).
struct PairBleThreadArgs
{
    chip::NodeId nodeId;
    uint32_t     setupPasscode;
    uint16_t     discriminator;
    // Dataset copy lives immediately after this struct in the same allocation.
    size_t       datasetLen;
    // uint8_t datasetTlv[datasetLen] follows.

    // The dataset bytes are stored right after this struct in the same memory block;
    // this returns a pointer to them (this + 1 = just past the end of the struct).
    uint8_t * dataset() { return reinterpret_cast<uint8_t *>(this + 1); }
};

// [rank 5] If a pairing attempt is still in flight after this long, it is stuck
// (e.g. a BLE drop that produced no terminal callback). Abort it so the
// auto-commission retry loop can start a clean attempt. StopPairing also clears the
// commissioner's mDeviceInPASEEstablishment, without which a retry hits
// CHIP_ERROR_INCORRECT_STATE. Fires before the 55s retry spacing, and no-ops if the
// attempt already completed, so no timer-cancel bookkeeping is needed.
// 120s (was 45): PASE alone finishes in <10s, but the FULL pipeline — DAC/PAI cert chain,
// attestation, CSR, NOC install, AddOrUpdateThreadNetwork + ConnectNetwork (light attaches to
// our mesh), operational SRP registration + DNS-SD resolution, then CASE over 802.15.4 — routinely
// runs 30-90s. gPairingActive stays true across all of it (cleared only on OnCommissioning
// Success/Failure), so the 55s auto-commission re-arm correctly no-ops mid-flight; the only thing
// that would wrongly abort a healthy long commission is THIS watchdog, so give it real headroom.
constexpr uint16_t kPairingWatchdogSeconds = 120;

// The watchdog timer callback: runs on the Matter thread ~45s after a pairing
// starts. If that attempt is still marked busy (and nothing got commissioned), it's
// wedged — so we forcibly abort it and clear the busy flag so a fresh attempt can
// begin. If the attempt already finished, this quietly does nothing.
void PairingWatchdog(chip::System::Layer *, void *)
{
    if (!gPairingActive || gCommissioned)
    {
        return; // attempt already finished (or a node is commissioned)
    }
    ChipLogError(Controller, "PairingWatchdog: attempt stuck >%us — aborting so retry can proceed",
                 static_cast<unsigned>(kPairingWatchdogSeconds));
    ControllerClient::Instance().Commissioner().StopPairing(gPairingNodeId);
    gPairingActive = false;
}

// Runs on the Matter thread (handed here via ScheduleWork). This actually kicks off
// the BLE+Thread pairing: it describes how to reach and prove identity to the new
// device (over Bluetooth, using its passcode + discriminator), attaches the Thread
// credentials to hand over, then tells the commissioner to start pairing. On a
// successful start it marks the attempt busy and arms the stuck-attempt watchdog.
// Finally it frees the argument block it was given.
void DoPairBleThread(intptr_t arg)
{
    auto * a = reinterpret_cast<PairBleThreadArgs *>(arg);

    // "Rendezvous" params = how to first find and reach the new device: use its
    // setup PIN, match on the number it broadcasts (discriminator), and connect over
    // Bluetooth Low Energy.
    chip::RendezvousParameters rp;
    rp.SetSetupPINCode(a->setupPasscode)
      .SetDiscriminator(a->discriminator)
      .SetPeerAddress(chip::Transport::PeerAddress::BLE());

    // The extra settings for the full setup: hand the device this home's Thread
    // network name+password so it can move onto the mesh.
    chip::Controller::CommissioningParameters cp;
    cp.SetThreadOperationalDataset(chip::ByteSpan(a->dataset(), a->datasetLen));

    ControllerClient & client = ControllerClient::Instance();
    // Hook up our logging callbacks for this attempt.
    client.Commissioner().RegisterPairingDelegate(&gLoggingPairingDelegate);

    // Start the whole pairing pipeline. This kicks it off and returns immediately;
    // progress and the final result arrive via the delegate callbacks above.
    CHIP_ERROR err = client.Commissioner().PairDevice(a->nodeId, rp, cp);
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(Controller, "PairDevice(BLE-Thread) failed: %" CHIP_ERROR_FORMAT, err.Format());
    }
    else
    {
        // The attempt is now live: flag it busy, remember its node ID, and start the
        // watchdog that will abort it if it hangs.
        gPairingActive = true; // cleared by a terminal pairing/commissioning callback
        gPairingNodeId = a->nodeId;
        chip::DeviceLayer::SystemLayer().StartTimer(
            chip::System::Clock::Seconds16(kPairingWatchdogSeconds), PairingWatchdog, nullptr);
    }

    // Release the heap block we copied the inputs into.
    chip::Platform::MemoryFree(a);
}

// Bundle for code-based pairing: the ID to assign the device, plus the full setup
// code string (the QR-code payload or manual code from the device's label), stored
// right after the struct.
struct PairCodeArgs
{
    chip::NodeId nodeId;
    // null-terminated setup code follows immediately after struct.
    // Pointer to the code text, which lives in the same allocation just past this
    // struct.
    char * code() { return reinterpret_cast<char *>(this + 1); }
};

// Runs on the Matter thread. Pairs a device from its printed/QR setup code: the
// SDK's code pairer decodes the code and discovers the device itself, so we don't
// pass network params or a discriminator here. Frees the argument block when done.
void DoPairCode(intptr_t arg)
{
    auto * a = reinterpret_cast<PairCodeArgs *>(arg);

    chip::Controller::CommissioningParameters cp;
    // No extra network params for code-based pairing; AutoCommissioner handles discovery.

    ControllerClient & client = ControllerClient::Instance();
    // Hook up our logging callbacks for this attempt.
    client.Commissioner().RegisterPairingDelegate(&gLoggingPairingDelegate);

    // DiscoveryType::kAll — SetUpCodePairer handles QR + manual codes over all transports.
    // TODO(verify): DiscoveryType::kAll is the correct value here (kBLEOnly does not exist in
    // this version of the SDK per SetUpCodePairer.h enum; kAll includes BLE scanning).
    CHIP_ERROR err = client.Commissioner().PairDevice(a->nodeId, a->code(),
                                                      cp, chip::Controller::DiscoveryType::kAll);
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(Controller, "PairDevice(code) failed: %" CHIP_ERROR_FORMAT, err.Format());
    }

    chip::Platform::MemoryFree(a);
}

// Bundle for removing a device: just the ID of the device to forget.
struct UnpairArgs
{
    chip::NodeId nodeId;
};

// Runs on the Matter thread. Removes a previously added device from this home,
// tearing down its trust relationship. Frees the argument block when done.
void DoUnpair(intptr_t arg)
{
    auto * a = reinterpret_cast<UnpairArgs *>(arg);
    CHIP_ERROR err = ControllerClient::Instance().Commissioner().UnpairDevice(a->nodeId);
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(Controller, "UnpairDevice failed: %" CHIP_ERROR_FORMAT, err.Format());
    }
    chip::Platform::MemoryFree(a);
}

} // anonymous namespace

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

// Returns the one-and-only ControllerClient for the whole program (the "singleton"
// pattern). Created the first time it's called and reused forever after.
ControllerClient & ControllerClient::Instance()
{
    static ControllerClient sInstance;
    return sInstance;
}

// ---------------------------------------------------------------------------
// Init — steps 1a-1j (+1k-1m omitted: ICD optional, add if CONFIG_CHIP_ICD_CLIENT)
// ---------------------------------------------------------------------------

// First-stage startup, run once at boot. Wires up all the plumbing the hub needs
// before it can act as a commissioner: reboot-surviving storage, a secure vault for
// its private keys, certificate storage, group-key storage, and the master factory
// object that builds the commissioner. Does NOT yet create the hub's identity/certs
// — that's SetupCommissioner() below. Returns an error (and stays uninitialized) if
// any piece fails. Expected to run on the Matter thread.
CHIP_ERROR ControllerClient::Init(chip::NodeId localNodeId, chip::FabricId fabricId,
                                  uint16_t udpListenPort)
{
    // Refuse to run twice — Init is a once-only step.
    VerifyOrReturnError(!mInitialized, CHIP_ERROR_INCORRECT_STATE);

    // Remember who WE are: our own node ID and which home (fabric) we run.
    mLocalNodeId = localNodeId;
    mFabricId    = fabricId;

    // 1a. Storage — backed by Zephyr KVS (NVS).
    // Set up simple on-chip key/value storage that survives reboots (used to hold
    // config, keys, certs). Backed by the operating system's flash storage.
    ReturnErrorOnFailure(mStorage.Init(&chip::DeviceLayer::PersistedStorage::KeyValueStoreMgr()));

    // 1b. Operational keystore.
    // Set up the secure vault for the hub's private crypto keys, using the storage
    // above.
    ReturnErrorOnFailure(mOpKeystore.Init(&mStorage));

    // 1c. Op-cert store.  (ICD client storage init omitted — add if needed.)
    // Set up storage for the operational certificates (the digital ID cards).
    ReturnErrorOnFailure(mOpCertStore.Init(&mStorage));

    // 1d-1g. Group data provider.
    // Set up storage for group (multicast) keys/info: point it at our storage and
    // the key store, then initialize it. A commissioner barely uses groups, but the
    // machinery still needs to exist.
    mGroupDataProvider.SetStorageDelegate(&mStorage);
    mGroupDataProvider.SetSessionKeystore(&mSessionKeystore);
    // Note: SetListener omitted — the listener requires a GroupDataProviderListener
    // concrete impl (multicasting glue). Add when multicast groups are needed.
    ReturnErrorOnFailure(mGroupDataProvider.Init());

    // 1h. Publish the group data provider globally.
    // Register our group store as the one the rest of the Matter code should use.
    chip::Credentials::SetGroupDataProvider(&mGroupDataProvider);

    // 1i-1j. Factory init.
    // Fill in the "recipe" the device-controller factory needs, pointing it at all
    // the pieces we just built, then initialize the factory. The factory is what
    // later stamps out the actual commissioner object.
    chip::Controller::FactoryInitParams fp;
    // Which UDP network port to listen on for Matter traffic.
    fp.listenPort                = udpListenPort;
    // The rest of the pointers below hand the factory each subsystem we set up.
    fp.fabricIndependentStorage  = &mStorage;
    fp.operationalKeystore       = &mOpKeystore;
    fp.opCertStore               = &mOpCertStore;
    fp.sessionKeystore           = &mSessionKeystore;
    fp.groupDataProvider         = &mGroupDataProvider;
    // We are a controller only — we don't act as a device others control, so no
    // server-side advertising.
    fp.enableServerInteractions  = false; // controller-only, no server advertising
    // dataModelProvider must not be null (asserted inside factory Init). We use an
    // EMPTY provider rather than the codegen/ember one: a commissioner is a pure
    // client (ReadClient/CommandSender) and hosts no clusters, so it needs no
    // server-side data model. The codegen provider's per-cluster Startup() (e.g.
    // AccessControlCluster) requires Server::Init() subsystems this image skips,
    // which otherwise aborts during InteractionModelEngine init.
    static EmptyDataModelProvider sEmptyProvider;
    fp.dataModelProvider         = &sEmptyProvider;

    // Hand the filled-in recipe to the factory and initialize it. After this the
    // factory is ready to produce the commissioner (done in SetupCommissioner).
    ReturnErrorOnFailure(chip::Controller::DeviceControllerFactory::GetInstance().Init(fp));

    ChipLogProgress(Controller, "ControllerClient::Init done (node=0x" ChipLogFormatX64 " fabric=%u port=%u)",
                    ChipLogValueX64(mLocalNodeId), static_cast<unsigned>(mFabricId),
                    static_cast<unsigned>(udpListenPort));
    return CHIP_NO_ERROR;
}

// ---------------------------------------------------------------------------
// SetupCommissioner — steps 2a-2p
// ---------------------------------------------------------------------------

// Second-stage startup, run once after Init(). This creates the hub's identity and
// turns it into a working commissioner: it sets up how we'll check that devices are
// genuine, builds the hub's own chain of digital ID cards (root/intermediate/node
// certs), stamps out the actual commissioner object, and installs the shared fabric
// secret (IPK). After this returns successfully the hub is ready to pair devices.
// Expected to run on the Matter thread.
CHIP_ERROR ControllerClient::SetupCommissioner()
{
    // 2a. BLE central glue is handled outside this file (ZephyrBleConnectionDelegate
    //     wired into BleLayer). Nothing to do here.

    // 2b-2c. Attestation verifier (PartialDACVerifier for bring-up via attestation.h).
    // Get and register the checker that verifies a device's maker-issued certificate
    // proving it's a genuine certified product (a relaxed checker used during
    // development). Bail out if none is available.
    chip::Credentials::DeviceAttestationVerifier * dacVerifier = GetBringupDacVerifier();
    VerifyOrReturnError(dacVerifier != nullptr, CHIP_ERROR_INTERNAL);
    chip::Credentials::SetDeviceAttestationVerifier(dacVerifier);

    // 2d-2e. Initialise the example credentials issuer.
    // Start up the component that creates and signs the digital ID cards
    // (certificates) for the hub and for each device it later adds.
    ReturnErrorOnFailure(mOpCredsIssuer.Initialize(mStorage));

    // 2f. Ephemeral operational keypair for the controller NOC.
    // Stored as a member so it outlives this function (SetupParams holds the pointer).
    // Using a heap-allocated P256Keypair so the pointer stays valid.
    // TODO(verify): The ephemeral key must remain alive for the commissioner lifetime.
    //               It is kept as a heap object below; add it to the class if needed.
    // Create a fresh public/private key pair for the hub's own operational identity.
    // Allocated on the heap so it stays alive for the commissioner's whole life
    // (the setup params below just hold a pointer to it).
    auto * ephemeralKey = chip::Platform::New<chip::Crypto::P256Keypair>();
    VerifyOrReturnError(ephemeralKey != nullptr, CHIP_ERROR_NO_MEMORY);
    ReturnErrorOnFailure(ephemeralKey->Initialize(chip::Crypto::ECPKeyTarget::ECDSA));

    // 2g. Generate controller RCAC / ICAC / NOC chain.
    // Scratch buffers to hold the hub's three stacked ID cards: the root cert (RCAC,
    // top authority), an intermediate cert (ICAC), and the hub's own node cert (NOC).
    static uint8_t rcacBuf[chip::Controller::kMaxCHIPDERCertLength];
    static uint8_t icacBuf[chip::Controller::kMaxCHIPDERCertLength];
    static uint8_t nocBuf [chip::Controller::kMaxCHIPDERCertLength];

    // Spans describe each buffer (pointer + size) so the generator can fill them and
    // report back how many bytes it actually wrote.
    chip::MutableByteSpan rcacSpan(rcacBuf);
    chip::MutableByteSpan icacSpan(icacBuf);
    chip::MutableByteSpan nocSpan (nocBuf);

    // Actually generate the hub's full chain of ID cards, tied to our node ID,
    // fabric, and the public half of the key pair above.
    ReturnErrorOnFailure(mOpCredsIssuer.GenerateNOCChainAfterValidation(
        mLocalNodeId, mFabricId,
        chip::CATValues{},            // no CASE auth tags for the controller
        ephemeralKey->Pubkey(),
        rcacSpan, icacSpan, nocSpan));

    // 2h. Populate SetupParams.
    // Fill in the "recipe" for building the commissioner: hand it the cert issuer,
    // the hub's key pair and freshly made ID cards, its vendor ID, the attestation
    // checker, and the auto-commissioner that drives the multi-step pairing flow.
    chip::Controller::SetupParams sp;
    sp.operationalCredentialsDelegate    = &mOpCredsIssuer;
    sp.operationalKeypair                = ephemeralKey;
    sp.hasExternallyOwnedOperationalKeypair = true; // we manage the lifetime
    sp.controllerRCAC                    = rcacSpan;
    sp.controllerICAC                    = icacSpan;
    sp.controllerNOC                     = nocSpan;
    sp.controllerVendorId                = chip::VendorId::TestVendor1; // 0xFFF1
    sp.deviceAttestationVerifier         = dacVerifier;
    sp.defaultCommissioner               = &mAutoCommissioner;
    sp.enableServerInteractions          = false;

    // 2i. SetupCommissioner via factory.
    // Ask the factory to actually build our commissioner object from the recipe
    // above. After this, mCommissioner is the live object that pairs devices.
    ReturnErrorOnFailure(
        chip::Controller::DeviceControllerFactory::GetInstance().SetupCommissioner(sp, mCommissioner));

    // 2j. Fabric index after commissioner is set up.
    // Grab the small local index number assigned to our home (fabric) in storage.
    chip::FabricIndex fabricIndex = mCommissioner.GetFabricIndex();

    // 2k. (ICD) UpdateFabricList omitted — add if CONFIG_CHIP_ICD_CLIENT is enabled.

    // 2l. Compressed fabric id for IPK.
    // Compute a short, hashed form of the fabric ID, needed as an input when
    // installing the shared fabric secret (IPK) below.
    uint8_t compressedFabricIdBuf[sizeof(uint64_t)];
    chip::MutableByteSpan compressedFabricIdSpan(compressedFabricIdBuf);
    ReturnErrorOnFailure(mCommissioner.GetCompressedFabricIdBytes(compressedFabricIdSpan));

    // 2m. NOTE: deliberately NOT calling GroupTesting::InitData here. That test
    //     helper provisions 3 demo groups + endpoints + key sets, which exceeds the
    //     group/endpoint capacity on this build and fails with
    //     CHIP_ERROR_INVALID_LIST_LENGTH (0x1f). A commissioner only needs the IPK
    //     key set (installed below); it does no group multicast. This matches what
    //     chip-tool's SetupCommissioner actually does.

    // 2n-2o. Install the well-known test IPK (single key set, keyset id 0).
    // Store the shared fabric secret (IPK) that protects group messages. We use the
    // standard well-known test value, which is all a commissioner needs.
    chip::ByteSpan defaultIpk = chip::GroupTesting::DefaultIpkValue::GetDefaultIpk();
    ReturnErrorOnFailure(chip::Credentials::SetSingleIpkEpochKey(
        &mGroupDataProvider, fabricIndex, defaultIpk, compressedFabricIdSpan));

    // 2p. Clear the pairing delegate — will be set per-pairing session.
    // Detach any callbacks for now; each pairing attempt registers its own.
    mCommissioner.RegisterPairingDelegate(nullptr);

    // Mark setup complete so the Pair*/Unpair entry-points will now accept calls.
    mInitialized = true;

    ChipLogProgress(Controller,
                    "ControllerClient::SetupCommissioner done (fabricIndex=%u)",
                    static_cast<unsigned>(fabricIndex));
    return CHIP_NO_ERROR;
}

// ---------------------------------------------------------------------------
// PairBleThread — must be safe to call from any thread.
// ---------------------------------------------------------------------------

// Public entry-point to pair a brand-new device over Bluetooth and move it onto the
// Thread mesh. SAFE TO CALL FROM ANY THREAD: it just validates its inputs, copies
// them (plus the Thread credentials) into a heap block, and hands the real work to
// the Matter thread via ScheduleWork (DoPairBleThread does the actual pairing).
CHIP_ERROR ControllerClient::PairBleThread(chip::NodeId nodeId, uint32_t setupPasscode,
                                           uint16_t discriminator,
                                           const uint8_t * datasetTlv, size_t datasetLen)
{
    // Refuse if setup hasn't finished, or the Thread credentials are missing/empty.
    VerifyOrReturnError(mInitialized, CHIP_ERROR_INCORRECT_STATE);
    VerifyOrReturnError(datasetTlv != nullptr && datasetLen > 0, CHIP_ERROR_INVALID_ARGUMENT);

    // Allocate a single block: args struct + dataset copy.
    // One allocation holds the fixed fields plus room for a copy of the dataset
    // right after them, so the Matter thread can free it all in one go.
    size_t totalSize = sizeof(PairBleThreadArgs) + datasetLen;
    auto * args      = static_cast<PairBleThreadArgs *>(chip::Platform::MemoryAlloc(totalSize));
    VerifyOrReturnError(args != nullptr, CHIP_ERROR_NO_MEMORY);

    // Copy all inputs into the block (including the Thread credential bytes) so the
    // caller's buffers don't need to outlive this call.
    args->nodeId         = nodeId;
    args->setupPasscode  = setupPasscode;
    args->discriminator  = discriminator;
    args->datasetLen     = datasetLen;
    memcpy(args->dataset(), datasetTlv, datasetLen);

    // Hand the work over to the Matter thread; DoPairBleThread runs it there.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoPairBleThread,
                                                         reinterpret_cast<intptr_t>(args));
}

// ---------------------------------------------------------------------------
// PairCode
// ---------------------------------------------------------------------------

// Public entry-point to pair a device straight from its printed/QR setup code (the
// SDK discovers the device itself). SAFE TO CALL FROM ANY THREAD: validates inputs,
// copies the code string into a heap block, and hands the work to the Matter thread
// (DoPairCode does the real work).
CHIP_ERROR ControllerClient::PairCode(chip::NodeId nodeId, const char * setupCode)
{
    // Refuse if setup hasn't finished or no code was given.
    VerifyOrReturnError(mInitialized, CHIP_ERROR_INCORRECT_STATE);
    VerifyOrReturnError(setupCode != nullptr, CHIP_ERROR_INVALID_ARGUMENT);

    // Check the code before anything starts, so that a typo never leaves the commissioner busy
    // (src/policy/matter_policy.c).
    if (strncmp(setupCode, "MT:", 3) == 0)
    {
        VerifyOrReturnError(mp_qr_code_plausible(setupCode), CHIP_ERROR_INVALID_ARGUMENT,
                            ChipLogError(Controller, "PairCode: not a Matter QR code payload"));
    }
    else
    {
        enum mp_code_error codeErr = mp_parse_manual_code(setupCode, nullptr);
        VerifyOrReturnError(codeErr == MP_CODE_OK, CHIP_ERROR_INVALID_ARGUMENT,
                            ChipLogError(Controller, "PairCode: manual code refused (%d)", static_cast<int>(codeErr)));
    }

    // One allocation holds the fixed fields plus the code text (with room for its
    // terminating null) right after them.
    size_t codeLen  = strlen(setupCode) + 1;
    size_t total    = sizeof(PairCodeArgs) + codeLen;
    auto * args     = static_cast<PairCodeArgs *>(chip::Platform::MemoryAlloc(total));
    VerifyOrReturnError(args != nullptr, CHIP_ERROR_NO_MEMORY);

    // Copy the inputs in so the caller's string doesn't need to outlive this call.
    args->nodeId = nodeId;
    memcpy(args->code(), setupCode, codeLen);

    // Hand the work over to the Matter thread; DoPairCode runs it there.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoPairCode,
                                                         reinterpret_cast<intptr_t>(args));
}

// ---------------------------------------------------------------------------
// Unpair
// ---------------------------------------------------------------------------

// Public entry-point to remove/forget a previously added device. SAFE TO CALL FROM
// ANY THREAD: copies the target node ID into a heap block and hands the work to the
// Matter thread (DoUnpair does the real work).
CHIP_ERROR ControllerClient::Unpair(chip::NodeId nodeId)
{
    // Refuse if setup hasn't finished.
    VerifyOrReturnError(mInitialized, CHIP_ERROR_INCORRECT_STATE);

    // Stash the node ID to remove in a small heap block for the Matter thread.
    auto * args = static_cast<UnpairArgs *>(chip::Platform::MemoryAlloc(sizeof(UnpairArgs)));
    VerifyOrReturnError(args != nullptr, CHIP_ERROR_NO_MEMORY);
    args->nodeId = nodeId;

    // Hand the work over to the Matter thread; DoUnpair runs it there.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoUnpair,
                                                         reinterpret_cast<intptr_t>(args));
}

} // namespace controller
} // namespace nrf
