/*
 * ControllerClient — the on-device Matter commissioner singleton.
 *
 * Mirrors esp-matter's matter_controller_client (init + setup_commissioner)
 * onto connectedhomeip's own controller library. Owns the storage/keystore/
 * opcertstore/group-data objects, the DeviceControllerFactory wiring, the
 * ExampleOperationalCredentialsIssuer, and the DeviceCommissioner. See
 * the init order in main.cpp for the exact
 * ordered init sequence this implements.
 *
 * In plain English:
 * This file declares the "brain" of our smart-home hub. Matter is the
 * industry standard that lets smart devices from different brands work
 * together; the "commissioner" (also called the controller) is the piece
 * that actually adds new devices to your home and then controls them.
 * THIS firmware is that commissioner. This header lists everything the
 * commissioner owns (its secure storage, its cryptographic keys, its digital
 * "ID card" tools) and the handful of actions it can perform: start up,
 * set itself up, pair a new device, and remove a device. The .cpp file holds
 * the real logic; this file is just the "table of contents" / blueprint.
 */
#pragma once

// These #include lines pull in pieces of "connectedhomeip" (also called CHIP),
// the open-source code that implements Matter. (CHIP was Matter's old name.)
// Each header below gives us one building block: the device controller itself,
// the factory that wires everything together, the credential/certificate tools,
// on-chip storage, and cryptography helpers.
#include <controller/CHIPDeviceController.h>
#include <controller/CHIPDeviceControllerFactory.h>
#include <controller/AutoCommissioner.h>
#include <controller/ExampleOperationalCredentialsIssuer.h>
#include <credentials/GroupDataProviderImpl.h>
#include <credentials/PersistentStorageOpCertStore.h>
#include <crypto/PersistentStorageOperationalKeystore.h>
#include <crypto/PSASessionKeystore.h>
#include <include/platform/KvsPersistentStorageDelegate.h>
#include <lib/core/CHIPError.h>
#include <lib/core/DataModelTypes.h>
#include <lib/support/Span.h>

namespace nrf {
namespace controller {

// The one and only commissioner object for this firmware. It is a "singleton":
// there is exactly one instance for the whole program, reached via Instance().
// It holds the hub's identity and secure storage and runs every pairing.
class ControllerClient
{
public:
    // Returns the single shared ControllerClient. Everyone who needs the hub
    // calls this instead of creating their own copy.
    static ControllerClient & Instance();

    // Step 1 of startup: turn on all the plumbing the hub needs before it can
    // do anything — its on-chip storage (survives reboots), its secure key
    // storage, and the factory that builds the commissioner. Call this first.
    // The default arguments give this hub its own numeric identity: a Node ID
    // (its address on the network), a Fabric ID (which "home" it belongs to —
    // a fabric is the set of devices that trust each other under one owner),
    // and a network port to listen on.
    /// Step 1: build storage/keystore/groupdata + DeviceControllerFactory::Init.
    CHIP_ERROR Init(chip::NodeId localNodeId = 0x000000000001B2C3ULL, chip::FabricId fabricId = 1,
                    uint16_t udpListenPort = 5580);

    // Step 2 of startup: create the hub's own identity (its certificate / "ID
    // card"), load the tools that check whether a new device is genuine, and
    // build the "commissioner" object that actually runs pairings. It also
    // installs the shared fabric secret (IPK) used to protect group messages.
    // Call this after Init().
    /// Step 2: attestation + issuer + controller NOC chain + SetupCommissioner + IPK.
    CHIP_ERROR SetupCommissioner();

    // Pair a brand-new device using Bluetooth + Thread. This is the main way we
    // add a device: talk to it over short-range Bluetooth (BLE), prove it's
    // genuine, hand it the "network name + password" (the Thread dataset) so it
    // can join this home's low-power wireless mesh, then finish over Thread.
    // Arguments: which Node ID to give the new device, its secret setup passcode
    // (PIN from its QR/label), its discriminator (a number it broadcasts so we
    // pick the right nearby device), and the Thread credentials as raw bytes.
    /// `matter controller pairing ble-thread <node> <datasetHex> <pin> <disc>`
    CHIP_ERROR PairBleThread(chip::NodeId nodeId, uint32_t setupPasscode, uint16_t discriminator,
                             const uint8_t * datasetTlv, size_t datasetLen);

    // Pair a device from just its setup code (the "MT:..." QR-code string or the
    // typed manual code). The code carries the passcode and discriminator, so
    // the commissioner figures out the rest and discovers the device itself.
    /// `matter controller pairing code <node> <MT:.../manual>`
    CHIP_ERROR PairCode(chip::NodeId nodeId, const char * setupCode);

    // Remove a previously-paired device from this home (forget/reset it).
    CHIP_ERROR Unpair(chip::NodeId nodeId);

    // Hand out the underlying commissioner object so other code can issue lower-
    // level Matter calls (e.g. reading or controlling an already-paired device).
    chip::Controller::DeviceCommissioner & Commissioner() { return mCommissioner; }
    // True once Init() + SetupCommissioner() have completed successfully.
    bool IsInitialized() const { return mInitialized; }

    // True once we've successfully added at least one device to this home. It
    // gets flipped on when a pairing finishes (the code that watches a pairing
    // reports "OnCommissioningSuccess" — Matter's "the device is now fully set
    // up" signal). The hub can retry pairing on its own; that automatic retry
    // loop checks this so it knows when to stop trying.
    /// True once a node has been fully commissioned (set by the pairing delegate's
    /// OnCommissioningSuccess). Used by the auto-commission retry loop to stop.
    static bool IsCommissioned();

    // True while a pairing attempt is currently underway ("in flight" = started
    // but not yet finished). The automatic retry loop checks this so it doesn't
    // kick off a second pairing on top of one that's already running.
    /// True while a pairing/commissioning attempt is in flight. The retry loop uses
    /// this to avoid starting a second PairDevice on top of a live one.
    static bool IsPairingActive();

private:
    // Private constructor: nobody can build their own ControllerClient. The only
    // way to get one is Instance() — that's what makes this a singleton (exactly
    // one for the whole program). "= default" means "use the compiler's empty
    // default; we don't need any special setup here."
    ControllerClient() = default;

    // Have startup (Init + SetupCommissioner) finished yet? Guards against using
    // the hub before it's ready.
    bool mInitialized = false;
    // This hub's own numeric address on the network (its Node ID).
    chip::NodeId mLocalNodeId = 0;
    // Which "home" (fabric) this hub belongs to — the set of devices that trust
    // each other under one owner.
    chip::FabricId mFabricId  = 1;

    // Storage / crypto plumbing (must outlive the commissioner).
    // These five objects are the hub's secure foundation. They're listed here so
    // they stay alive for the whole program (the commissioner points at them, so
    // they must not disappear first — that's what "must outlive" means).
    // On-chip storage that survives reboots (KVS = key/value store): keeps keys,
    // certs, and config across power cycles.
    chip::KvsPersistentStorageDelegate mStorage;
    // Secure storage for the hub's own private crypto keys (its operational keys).
    chip::PersistentStorageOperationalKeystore mOpKeystore;
    // Storage for the operational certificates — the digital "ID cards" (NOCs)
    // that prove membership in this home's network.
    chip::Credentials::PersistentStorageOpCertStore mOpCertStore;
    // The chip's in-memory session cryptography (PSA = the chip's secure crypto
    // system): protects the live encrypted sessions with devices.
    chip::Crypto::PSASessionKeystore mSessionKeystore;
    // Keys/info for group (one-to-many / multicast) control of devices, plus the
    // shared fabric secret (IPK) that protects group messages.
    chip::Credentials::GroupDataProviderImpl mGroupDataProvider;

    // Controller objects.
    // The main commissioner: the object that actually runs pairings and controls
    // devices. Other code borrows it via Commissioner().
    chip::Controller::DeviceCommissioner mCommissioner;
    // The SDK's helper that can drive the step-by-step pairing sequence
    // automatically (connect, verify, hand over Thread credentials, finish) so
    // the steps don't have to be scripted by hand. (Declared here as part of the
    // commissioner's plumbing; how it's plugged in is set up in the .cpp file.)
    chip::Controller::AutoCommissioner mAutoCommissioner;
    // The tool that creates and signs the digital "ID cards" (NOCs) — for this
    // hub and for each new device. "Example" = the SDK's reference issuer, fine
    // for development.
    chip::Controller::ExampleOperationalCredentialsIssuer mOpCredsIssuer;
};

} // namespace controller
} // namespace nrf
