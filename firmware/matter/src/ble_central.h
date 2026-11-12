/*
 * BLE *central* role for Matter commissioning on Zephyr.
 *
 * The stock NCS Zephyr BLEManagerImpl implements only the peripheral/accessory
 * role; a commissioner must be GATT *client*. This object supplies the missing
 * glue: scan-by-discriminator, connect, GATT-discover the CHIPoBLE service,
 * subscribe to TX (indications), write RX, and bridge GATT events back to the
 * CHIP BleLayer. A small patch to the SDK BLEManagerImpl (patches/0001) wires
 * BleLayer::Init's connDelegate to BleCentral and forwards the three central
 * BlePlatformDelegate ops here. See firmware/matter/sdk/patch_sdk.py
 * ("Zephyr Platform BLE Central Glue Layer") for the verified bt_* contract.
 */

/*
 * In plain English:
 *   This is the header (the "table of contents") for the Bluetooth code that lets
 *   our hub PAIR with a brand-new smart device. Matter is a smart-home standard
 *   that lets gadgets from different brands work together; our hub is the
 *   "commissioner" that adds and controls those gadgets. To first reach a new
 *   gadget we use BLE (Bluetooth Low Energy, short-range Bluetooth). In Bluetooth
 *   terms our hub is the "central" (the scanner/connector, like a phone) and the
 *   gadget is the "peripheral" (the advertiser). Nordic's ready-made SDK only knows
 *   how to be the peripheral, so we had to write the central side ourselves — that
 *   is the BleCentral class declared here. It scans the airwaves, connects, reads
 *   the gadget's menu of data slots, subscribes for incoming messages, and passes
 *   everything up to the Matter software.
 */
#pragma once

#include <ble/Ble.h>
#include <ble/BleConnectionDelegate.h>
#include <ble/BleLayer.h>
#include <ble/BleUUID.h>
#include <lib/core/CHIPError.h>
#include <setup_payload/SetupPayload.h>
#include <system/SystemPacketBuffer.h>

#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>

namespace nrf {
namespace controller {

// CHIPoBLE service + characteristic UUIDs (16-bit service 0xFFF6; 128-bit chars).
// Values mirror the Zephyr BLEManagerImpl declarations (already in BT byte order).
// The "name tag" (UUID) that every Matter device broadcasts over Bluetooth during
// setup. CHIPoBLE / service 0xFFF6 is the Bluetooth service a Matter device advertises;
// when we scan, we look for exactly this number to know a device is a Matter gadget.
inline constexpr uint16_t kCHIPoBLEServiceUuid16 = 0xFFF6;

/**
 * Singleton implementing BLE central for commissioning. Also a BleConnectionDelegate
 * (installed into BleLayer by the BLEManagerImpl patch via the 4-arg BleLayer::Init).
 */
// The one-and-only Bluetooth-central object for the whole program (a "singleton":
// exactly one instance exists). It also plays the role Matter expects for making new
// Bluetooth connections during pairing, so Matter can ask it to reach a new device.
class BleCentral final : public chip::Ble::BleConnectionDelegate
{
public:
    // Get the single shared BleCentral object (creates it the first time it's asked for).
    static BleCentral & Instance();

    /// Register the central bt_conn_cb / scan callbacks. Called once at stack init.
    // One-time setup: tell Bluetooth to call our functions when scans find devices and
    // when connections come and go. Run once when the Bluetooth stack starts up.
    CHIP_ERROR Init();

    // ===== chip::Ble::BleConnectionDelegate =====
    // Matter calls this to say "please find and connect to a new device that is
    // broadcasting this discriminator (its ID number, e.g. 3321)." Kicks off scanning.
    void NewConnection(chip::Ble::BleLayer * bleLayer, void * appState,
                       const chip::SetupDiscriminator & connDiscriminator) override;
    // Overload for when Matter already has a live Bluetooth connection object in hand
    // and just wants us to adopt/use it, rather than scanning for a device first.
    void NewConnection(chip::Ble::BleLayer * bleLayer, void * appState, BLE_CONNECTION_OBJECT connObj) override;
    // Matter calls this to abort an in-progress connection attempt (stop scanning /
    // drop the pending connection), e.g. if pairing was cancelled or timed out.
    CHIP_ERROR CancelConnection() override;

    // ===== central BlePlatformDelegate ops, forwarded from the patched BLEManagerImpl =====
    // Turn ON incoming messages from the device on its TX slot (flip the CCC switch)
    // so the device can push its handshake replies to us. Matter asks for this once
    // the connection is ready. svcId/charId identify which service+slot to subscribe to.
    CHIP_ERROR SubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const chip::Ble::ChipBleUUID * svcId,
                                       const chip::Ble::ChipBleUUID * charId);
    // Turn OFF those incoming messages again (the reverse of Subscribe), used at teardown.
    CHIP_ERROR UnsubscribeCharacteristic(BLE_CONNECTION_OBJECT conId, const chip::Ble::ChipBleUUID * svcId,
                                         const chip::Ble::ChipBleUUID * charId);
    // Send one chunk of Matter's handshake data to the device by writing it into the
    // device's RX slot (the slot we write to). Matter calls this to talk to the device.
    CHIP_ERROR SendWriteRequest(BLE_CONNECTION_OBJECT conId, const chip::Ble::ChipBleUUID * svcId,
                                const chip::Ble::ChipBleUUID * charId, chip::System::PacketBufferHandle pBuf);

private:
    // Private constructor: nobody can build a BleCentral directly; use Instance() above.
    BleCentral() = default;

public:
    // Per-connection GATT handle table (discovered before subscribe/write).
    // Everything we need to remember about ONE connected device. GATT is Bluetooth's
    // menu of data slots a device exposes; a "handle" is the numeric address of a slot.
    // We look these addresses up (discovery) right after connecting, then reuse them.
    struct ConnState
    {
        // The Bluetooth connection this state belongs to (null = empty/unused slot).
        bt_conn * conn               = nullptr;
        // Address of the slot we WRITE to, to send data to the device (the RX slot).
        uint16_t rxValueHandle       = 0; // CHIPoBLE C1 (RX): write target
        // Address of the slot the device sends data back on, which we subscribe to (TX).
        uint16_t txValueHandle       = 0; // CHIPoBLE C2 (TX): indications
        // Address of the little on/off switch (CCC) that enables those incoming messages.
        uint16_t txCccHandle         = 0;
        // True while this record is holding a live connection (marks the slot as taken).
        bool inUse                   = false;
        // Bluetooth's bookkeeping for our "please push me messages" subscription.
        bt_gatt_subscribe_params sub = {};
        // Bluetooth's bookkeeping for walking the device's menu of slots (discovery).
        bt_gatt_discover_params disc = {};
        // Bluetooth's bookkeeping for an in-flight write to the device.
        bt_gatt_write_params write   = {};
    };
    // Find (or set up) the ConnState record for a given Bluetooth connection.
    ConnState & Slot(const bt_conn * conn);

    // App state (BleLayer) passed to the OnConnection* callbacks. Exposed so the
    // file-static connect/discovery helpers in the .cpp can forward it.
    // Hand back the opaque "context" pointer Matter gave us, so helper code in the .cpp
    // can pass it along when reporting connection results back up to Matter.
    void * AppState() const { return mAppState; }

    // BT-RX-thread callbacks marshal to the CHIP thread via PlatformMgr().
    // IMPORTANT: every callback below is fired by the Bluetooth stack on its own
    // (BT-RX) thread, NOT the Matter thread. Each one hands the work over to the single
    // Matter thread (marshalling) before touching Matter code, because Matter logic must
    // only ever run on that one thread.
    // Fires when a scan finds a nearby advertising device; we check if it's the one we want.
    static void ScanRecvCb(const bt_le_scan_recv_info * info, net_buf_simple * buf);
    // Fires when a connection attempt finishes (err says success or failure).
    static void CentralConnectedCb(bt_conn * conn, uint8_t err);
    // Fires when a device disconnects (reason says why); we clean up its state.
    static void CentralDisconnectedCb(bt_conn * conn, uint8_t reason);
    // Fires repeatedly while walking the device's menu of slots (discovery), once per
    // slot found, so we can record the RX/TX/CCC handle addresses we need.
    static uint8_t GattDiscoverCb(bt_conn * conn, const bt_gatt_attr * attr, bt_gatt_discover_params * params);
    // Fires when the device pushes us a message on its TX slot (an incoming notification/
    // indication); we forward that data up to Matter.
    static uint8_t GattNotifyCb(bt_conn * conn, bt_gatt_subscribe_params * params, const void * data, uint16_t length);
    // Fires once the "please push me messages" subscription is confirmed set up.
    static void GattSubscribedCb(bt_conn * conn, uint8_t err, bt_gatt_subscribe_params * params);
    // Fires once a write we sent to the device's RX slot has completed.
    static void GattWriteCb(bt_conn * conn, uint8_t err, bt_gatt_write_params * params);

private:
    // Matter's Bluetooth layer we report events to (the software above us). Null until set.
    chip::Ble::BleLayer * mBleLayer  = nullptr;
    // Opaque context pointer Matter gave us to hand back with connection results.
    void * mAppState                 = nullptr;
    // The ID number (discriminator) of the specific device we're currently hunting for.
    chip::SetupDiscriminator mTargetDiscriminator;
    // True while we're actively scanning the airwaves for that device.
    bool mScanning                   = false;
    // The connection we've started but not yet finished setting up (null if none).
    bt_conn * mPendingConn           = nullptr;
};

} // namespace controller
} // namespace nrf
