/*
 * ble_central.cpp — BLE central role for Matter commissioning on Zephyr.
 *
 * Implements the BleCentral singleton (BleConnectionDelegate + GATT client)
 * and the four free shim functions declared in ble_central_shim.h.
 *
 * In plain English:
 *   This is the heart of how the hub first REACHES a brand-new smart device over
 *   Bluetooth. Before a device can join the low-power Thread mesh, the hub has to
 *   talk to it over short-range Bluetooth Low Energy (BLE). This file plays the
 *   "phone" role (BLE Central): it listens for a specific new device broadcasting
 *   itself, connects to it, walks its Bluetooth "menu" of data slots (GATT) to find
 *   the two slots Matter uses to talk (one to WRITE to the device, one the device
 *   sends back on), turns on message push from the device, and then acts as a pipe
 *   that shuttles Matter's setup handshake back and forth. The single hardest part:
 *   Bluetooth events arrive on Bluetooth's own background thread, but all Matter
 *   logic must run on the one "Matter thread" — so almost every callback here copies
 *   what it needs and hands the work over to the Matter thread (ScheduleWork) so
 *   Matter code never runs on the wrong thread.
 *
 * Call sequence (E4 contract):
 *   NewConnection → bt_le_scan_start → ScanRecvCb (match) →
 *   [CHIP thread] bt_le_scan_stop + bt_conn_le_create →
 *   CentralConnectedCb → OnConnectionComplete →
 *   SubscribeCharacteristic → bt_gatt_discover (PRIMARY → CHAR → DESC) →
 *   bt_gatt_subscribe (INDICATE) → GattSubscribedCb → HandleSubscribeComplete
 *   SendWriteRequest → bt_gatt_write → GattWriteCb → HandleWriteConfirmation
 *   GattNotifyCb → HandleIndicationReceived
 *   CentralDisconnectedCb → HandleConnectionError
 */

#include "ble_central.h"
#include "ble_central_shim.h"

#include <ble/BleLayer.h>
#include <ble/BleUUID.h>
#include <ble/CHIPBleServiceData.h>
#include <lib/support/CodeUtils.h>
#include <lib/support/logging/CHIPLogging.h>
#include <platform/CHIPDeviceLayer.h>
#include <platform/internal/CHIPDeviceLayerInternal.h>
#include <setup_payload/SetupPayload.h>
#include <system/SystemPacketBuffer.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/assigned_numbers.h>

#include <cstring>

// ─── Zephyr UUID objects for GATT discovery ────────────────────────────────
// Byte order matches BT (little-endian), copied from BLEManagerImpl.cpp:78-81.
// These are the fixed ID numbers (UUIDs) that identify the exact Bluetooth
// "service" and "data slots" (characteristics) a Matter device exposes during
// setup. We use them below to recognize the right slots while walking the
// device's GATT menu.
// 0xFFF6 = the CHIPoBLE service: the Bluetooth service every Matter device
// advertises while it is waiting to be set up. This is what we match on.
static bt_uuid_16  sUUID16_CHIPoBLEService  = BT_UUID_INIT_16(0xFFF6);
// The 128-bit ID of the RX characteristic — the slot WE WRITE to (our messages
// TO the device).
static bt_uuid_128 sUUID128_CHIPoBLEChar_RX =
    BT_UUID_INIT_128(0x11, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95,
                     0x59, 0x45, 0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);
// The 128-bit ID of the TX characteristic — the slot the DEVICE sends back on
// (its messages TO us). We subscribe to this one so the device can push data.
static bt_uuid_128 sUUID128_CHIPoBLEChar_TX =
    BT_UUID_INIT_128(0x12, 0x9D, 0x9F, 0x42, 0x9C, 0x4F, 0x9F, 0x95,
                     0x59, 0x45, 0x3D, 0x26, 0xF5, 0x2E, 0xEE, 0x18);

// CCC descriptor UUID (standard 0x2902)
// The CCC (0x2902) is the little on/off switch attached to the TX slot that lets
// us tell the device "yes, please push messages to me." We must find its handle
// (its numeric address) to flip it on.
static bt_uuid_16 sUUID16_CCC = BT_UUID_INIT_16(BT_UUID_GATT_CCC_VAL);

namespace nrf {
namespace controller {

// ─── Per-connection slot table ─────────────────────────────────────────────
// Indexed by bt_conn_index(); CONFIG_BT_MAX_CONN is 2 here.
// The hub can hold several Bluetooth connections at once. Each one gets its own
// "slot" of bookkeeping (its found handles, pending write, etc.), and we look up
// the right slot by the connection's index number.
static constexpr int kMaxConns = CONFIG_BT_MAX_CONN;

// Payload buffer kept alive while bt_gatt_write is pending.
// When we send data to the device, Bluetooth borrows our data buffer until the
// send finishes. This little holder keeps that buffer from being freed too early.
struct WriteContext
{
    chip::System::PacketBufferHandle buf;
};

// Extended per-connection state; connState is declared in the class header.
// One bookkeeping slot per possible connection (found handles, subscribe/write
// params, etc.).
static BleCentral::ConnState sConnSlots[kMaxConns];
// WriteContext per slot (kept separate to avoid bloating ConnState).
// One in-flight-write holder per connection.
static WriteContext sWriteCtx[kMaxConns];

// ─── MTU exchange params (one per slot) ────────────────────────────────────
// Scratch space for negotiating MTU (the biggest single Bluetooth message size)
// right after connecting — one per connection.
static bt_gatt_exchange_params sMtuParams[kMaxConns];

// ─── Scan state ────────────────────────────────────────────────────────────
// Copied address from ScanRecvCb; lives until CHIP thread processes it.
// When the scan spots the device we want, we stash its Bluetooth address here so
// the Matter thread can pick it up and start connecting.
static bt_addr_le_t sScanMatchAddr;
// True once we've spotted a match but haven't finished connecting yet — stops us
// from trying to connect to the same device twice.
static bool         sScanMatchPending = false;

// ─── Static scan-cb object ─────────────────────────────────────────────────
// The registration object that tells Bluetooth "call ScanRecvCb for each advert
// I hear." Filled in during Init().
static bt_le_scan_cb sScanCb; // zero-init; fields filled in Init()

// ─── Second bt_conn_cb for CENTRAL role ────────────────────────────────────
// A separate connect/disconnect-callback registration for OUR "phone" (central)
// role, running alongside the one the Matter stack already registered for its own
// peripheral role. Filled in during Init().
static bt_conn_cb sCentralConnCb; // zero-init; fields filled in Init()

// ══════════════════════════════════════════════════════════════════════════════
// BleCentral singleton
// ══════════════════════════════════════════════════════════════════════════════

// Returns THE one and only BleCentral object for the whole program (singleton).
// Everyone who needs the BLE-central logic calls this to reach the same instance.
BleCentral & BleCentral::Instance()
{
    static BleCentral sInstance;
    return sInstance;
}

// ─── Slot helpers ──────────────────────────────────────────────────────────

// Given a Bluetooth connection, hand back its dedicated bookkeeping slot. We use
// the connection's small index number to pick the right entry in the slot table.
BleCentral::ConnState & BleCentral::Slot(const bt_conn * conn)
{
    uint8_t idx = bt_conn_index(conn);
    // idx is always < CONFIG_BT_MAX_CONN by Zephyr guarantee.
    return sConnSlots[idx];
}

// ─── Init ──────────────────────────────────────────────────────────────────

// One-time setup, called at startup. Clears all bookkeeping and registers our
// callbacks with Bluetooth so that connect/disconnect events and scan results get
// routed to this file. Does NOT start scanning yet — that happens per commission.
CHIP_ERROR BleCentral::Init()
{
    // Zero out slot tables.
    // Wipe all per-connection bookkeeping to a clean slate.
    memset(sConnSlots,  0, sizeof(sConnSlots));
    memset(sWriteCtx,   0, sizeof(sWriteCtx));
    memset(sMtuParams,  0, sizeof(sMtuParams));
    sScanMatchPending = false;

    // Register CENTRAL bt_conn_cb (a second one alongside BLEManagerImpl's).
    // Tell Bluetooth to call our functions when a central-role connection is made
    // or dropped. This registration lives beside the Matter stack's own one.
    memset(&sCentralConnCb, 0, sizeof(sCentralConnCb));
    sCentralConnCb.connected    = CentralConnectedCb;
    sCentralConnCb.disconnected = CentralDisconnectedCb;
    bt_conn_cb_register(&sCentralConnCb);

    // Register scan callback (list-based; does NOT start a scan).
    // Tell Bluetooth to call ScanRecvCb for each advertisement it hears once a
    // scan is running. This only wires up the callback; scanning starts later.
    memset(&sScanCb, 0, sizeof(sScanCb));
    sScanCb.recv = ScanRecvCb;
    bt_le_scan_cb_register(&sScanCb);

    ChipLogProgress(DeviceLayer, "BleCentral: Init complete");
    return CHIP_NO_ERROR;
}

// ─── BleConnectionDelegate overrides ───────────────────────────────────────

// The Matter stack calls this (on the Matter thread) to say "go find and connect
// to the new device broadcasting this discriminator." The discriminator is the
// number (e.g. 3321) a new device broadcasts to tell itself apart from other
// nearby devices. We kick off a Bluetooth scan; ScanRecvCb handles the results.
void BleCentral::NewConnection(chip::Ble::BleLayer * bleLayer, void * appState,
                               const chip::SetupDiscriminator & connDiscriminator)
{
    ChipLogProgress(DeviceLayer, "BleCentral: NewConnection discriminator=%u (short=%d)",
                    connDiscriminator.IsShortDiscriminator()
                        ? (uint16_t) connDiscriminator.GetShortValue()
                        : connDiscriminator.GetLongValue(),
                    (int) connDiscriminator.IsShortDiscriminator());

    // Remember what the Matter stack handed us so later callbacks can report back:
    // the BleLayer to talk to, an opaque app pointer to pass along, and which
    // device's discriminator we're hunting for.
    mBleLayer          = bleLayer;
    mAppState          = appState;
    mTargetDiscriminator = connDiscriminator;
    mScanning          = false;
    mPendingConn       = nullptr;

    // How to scan: "active" means we also ask advertisers for extra info; we skip
    // duplicate adverts; interval/window control how aggressively we listen.
    static bt_le_scan_param scanParams = {
        .type     = BT_LE_SCAN_TYPE_ACTIVE,
        .options  = BT_LE_SCAN_OPT_FILTER_DUPLICATE,
        .interval = 0x0060, // 60 ms
        .window   = 0x0030, // 30 ms
        .timeout  = 0,
    };

    // Start listening for adverts. Results arrive via the ScanRecvCb we registered
    // in Init(). -EALREADY (a scan is already running) is treated as fine.
    int err = bt_le_scan_start(&scanParams, nullptr); // recv via registered sScanCb
    if (err != 0 && err != -EALREADY)
    {
        // Couldn't even start scanning — tell Matter this attempt failed.
        ChipLogError(DeviceLayer, "BleCentral: bt_le_scan_start failed: %d", err);
        if (OnConnectionError != nullptr)
        {
            OnConnectionError(mAppState, CHIP_ERROR_INTERNAL);
        }
        return;
    }
    mScanning = true;
    ChipLogProgress(DeviceLayer, "BleCentral: scan started");
}

// A second, rarely-used form of NewConnection: the Matter stack already has a live
// Bluetooth connection object and just wants us to treat it as ready. We simply
// report it complete rather than scanning/connecting ourselves.
void BleCentral::NewConnection(chip::Ble::BleLayer * bleLayer, void * appState,
                               BLE_CONNECTION_OBJECT connObj)
{
    // BleLayer calls this when it already has a bt_conn* (rare path).
    ChipLogProgress(DeviceLayer, "BleCentral: NewConnection by connObj=%p", connObj);
    if (OnConnectionComplete != nullptr)
    {
        OnConnectionComplete(appState, connObj);
    }
}

// Abort an in-progress attempt: stop any running scan and drop any connection we
// were in the middle of opening. Called if the Matter stack gives up on this pair.
CHIP_ERROR BleCentral::CancelConnection()
{
    if (mScanning)
    {
        bt_le_scan_stop();
        mScanning = false;
    }
    if (mPendingConn != nullptr)
    {
        bt_conn_disconnect(mPendingConn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
        bt_conn_unref(mPendingConn);
        mPendingConn = nullptr;
    }
    return CHIP_NO_ERROR;
}

// Forward declarations for the connect-time discovery helpers (defined below).
// These three helpers run the post-connect steps: subscribe to the device's TX
// slot, walk its GATT menu, and finally tell Matter the link is ready.
static void DoSubscribe(bt_conn * conn);
static void StartDiscovery(bt_conn * conn);
static void FireConnComplete(bt_conn * conn);

// ─── SubscribeCharacteristic ───────────────────────────────────────────────
// Called by the patched BLEManagerImpl stub on the CHIP thread.

// Matter asks us to "subscribe" — turn on message push from the device's TX slot —
// so the device can send its handshake replies back to us. Because we already
// discovered the needed handles at connect time, this just flips the switch now.
CHIP_ERROR BleCentral::SubscribeCharacteristic(BLE_CONNECTION_OBJECT conId,
                                               const chip::Ble::ChipBleUUID * svcId,
                                               const chip::Ble::ChipBleUUID * charId)
{
    VerifyOrReturnError(conId != nullptr, CHIP_ERROR_INVALID_ARGUMENT);
    ConnState & cs = Slot(conId);

    // GATT discovery already ran at connect time (StartDiscovery), so the TX
    // value + CCC handles are cached. Subscribe straight away. The central BTP
    // handshake WRITES the capabilities request BEFORE it subscribes
    // (BLEEndPoint::StartConnect), so handles must be ready at connect, not here.
    VerifyOrReturnError(cs.txValueHandle != 0 && cs.txCccHandle != 0, CHIP_ERROR_INCORRECT_STATE);
    DoSubscribe(conId);
    return CHIP_NO_ERROR;
}

// Internal helper called once discovery is done.
// Actually flips on the device's push switch (the CCC) for its TX slot, and wires
// up which of our functions Bluetooth should call when the device pushes a message
// (GattNotifyCb) or confirms the subscription took effect (GattSubscribedCb).
static void DoSubscribe(bt_conn * conn)
{
    uint8_t idx = bt_conn_index(conn);
    BleCentral::ConnState & cs = sConnSlots[idx];

    // Safety check: we can't subscribe unless discovery already found both the TX
    // slot's handle and its push-switch (CCC) handle.
    if (cs.txValueHandle == 0 || cs.txCccHandle == 0)
    {
        ChipLogError(DeviceLayer, "BleCentral: DoSubscribe — handles not ready");
        return;
    }

    // Fill in the subscription request: callbacks, which slot, its CCC switch, and
    // that we want "indications" (acknowledged pushes) — the flavor CHIPoBLE uses.
    cs.sub.notify        = BleCentral::GattNotifyCb;
    cs.sub.subscribe     = BleCentral::GattSubscribedCb;
    cs.sub.value_handle  = cs.txValueHandle;
    cs.sub.ccc_handle    = cs.txCccHandle;
    cs.sub.value         = BT_GATT_CCC_INDICATE; // CHIPoBLE uses indications

    int err = bt_gatt_subscribe(conn, &cs.sub);
    if (err != 0 && err != -EALREADY)
    {
        ChipLogError(DeviceLayer, "BleCentral: bt_gatt_subscribe err=%d", err);
    }
    else
    {
        ChipLogProgress(DeviceLayer, "BleCentral: bt_gatt_subscribe issued (vHandle=%u cccHandle=%u)",
                        cs.txValueHandle, cs.txCccHandle);
    }
}

// Notify the CHIP stack (on the Matter thread) that the BLE connection is ready.
// BleLayer takes ownership of the conn ref the connect handler took.
// Runs once discovery has cached all needed handles. Because Matter code must run
// on the Matter thread, this hands the "connection ready" call over via
// ScheduleWork rather than calling it directly from the Bluetooth thread.
static void FireConnComplete(bt_conn * conn)
{
    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        // This lambda runs on the Matter thread: it tells Matter the BLE link is up.
        [](intptr_t arg) {
            bt_conn * c    = reinterpret_cast<bt_conn *>(arg);
            BleCentral & s = BleCentral::Instance();
            if (s.OnConnectionComplete != nullptr)
            {
                s.OnConnectionComplete(s.AppState(), c);
            }
        },
        reinterpret_cast<intptr_t>(conn));
}

// Start CHIPoBLE GATT discovery (PRIMARY -> RX/TX chars -> CCC). Runs right after
// the MTU exchange, BEFORE OnConnectionComplete, so the RX handle is cached before
// CHIP's central BTP handshake issues its first SendWriteRequest. GattDiscoverCb
// fires OnConnectionComplete once the CCC descriptor is found.
// In plain English: this begins "walking the device's menu" of Bluetooth data
// slots to find the exact ones Matter needs. We do it here, before telling Matter
// the link is ready, because Matter will immediately try to WRITE — so we must
// already know where the write slot is. Results arrive step by step in
// GattDiscoverCb below.
static void StartDiscovery(bt_conn * conn)
{
    // Reset this connection's slot and clear any stale handles before discovering.
    BleCentral::ConnState & cs = sConnSlots[bt_conn_index(conn)];
    cs.conn          = conn;
    cs.inUse         = true;
    cs.rxValueHandle = 0;
    cs.txValueHandle = 0;
    cs.txCccHandle   = 0;

    // Step 1 of the walk: search the whole device for the CHIPoBLE service (0xFFF6).
    // "PRIMARY" means we're looking for a top-level service entry.
    cs.disc.uuid         = &sUUID16_CHIPoBLEService.uuid;
    cs.disc.func         = BleCentral::GattDiscoverCb;
    cs.disc.start_handle = BT_ATT_FIRST_ATTRIBUTE_HANDLE;
    cs.disc.end_handle   = BT_ATT_LAST_ATTRIBUTE_HANDLE;
    cs.disc.type         = BT_GATT_DISCOVER_PRIMARY;

    ChipLogProgress(DeviceLayer, "BleCentral: starting GATT discovery conn=%p", static_cast<void *>(conn));
    int err = bt_gatt_discover(conn, &cs.disc);
    if (err != 0)
    {
        // Couldn't even start the walk — report failure on the Matter thread.
        ChipLogError(DeviceLayer, "BleCentral: StartDiscovery bt_gatt_discover err=%d", err);
        chip::DeviceLayer::PlatformMgr().ScheduleWork(
            [](intptr_t) {
                BleCentral & s = BleCentral::Instance();
                if (s.OnConnectionError != nullptr)
                {
                    s.OnConnectionError(s.AppState(), CHIP_ERROR_INTERNAL);
                }
            },
            0);
    }
}

// ─── UnsubscribeCharacteristic ─────────────────────────────────────────────

// Matter asks us to stop the device's message push (turn the TX slot's CCC switch
// back off). Runs on the Matter thread; the reverse of SubscribeCharacteristic.
CHIP_ERROR BleCentral::UnsubscribeCharacteristic(BLE_CONNECTION_OBJECT conId,
                                                 const chip::Ble::ChipBleUUID * svcId,
                                                 const chip::Ble::ChipBleUUID * charId)
{
    VerifyOrReturnError(conId != nullptr, CHIP_ERROR_INVALID_ARGUMENT);
    ConnState & cs = Slot(conId);

    if (cs.txValueHandle != 0)
    {
        // bt_gatt_unsubscribe uses the existing sub params.
        int err = bt_gatt_unsubscribe(conId, &cs.sub);
        if (err != 0)
        {
            ChipLogError(DeviceLayer, "BleCentral: bt_gatt_unsubscribe err=%d", err);
            return CHIP_ERROR_INTERNAL;
        }
    }
    return CHIP_NO_ERROR;
}

// ─── SendWriteRequest ──────────────────────────────────────────────────────

// Matter asks us to send a chunk of its setup handshake TO the device. Runs on the
// Matter thread. We write it into the device's RX slot (the slot we write to). The
// data buffer is kept alive until GattWriteCb confirms the send finished.
CHIP_ERROR BleCentral::SendWriteRequest(BLE_CONNECTION_OBJECT conId,
                                        const chip::Ble::ChipBleUUID * svcId,
                                        const chip::Ble::ChipBleUUID * charId,
                                        chip::System::PacketBufferHandle pBuf)
{
    VerifyOrReturnError(conId != nullptr, CHIP_ERROR_INVALID_ARGUMENT);
    VerifyOrReturnError(!pBuf.IsNull(), CHIP_ERROR_INVALID_ARGUMENT);

    ConnState & cs  = Slot(conId);
    uint8_t    idx  = bt_conn_index(conId);

    // Can't write until discovery found the device's RX (write-target) slot.
    VerifyOrReturnError(cs.rxValueHandle != 0, CHIP_ERROR_INCORRECT_STATE);

    // Keep buffer alive until GattWriteCb fires.
    // Bluetooth reads directly from our buffer during the send, so we hold on to it
    // (move it into this connection's holder) until the send completes.
    sWriteCtx[idx].buf = std::move(pBuf);

    // Fill in the write request: which of our functions to call when done, which
    // slot to write to (the RX handle), and where/how much data to send.
    cs.write.func   = GattWriteCb;
    cs.write.handle = cs.rxValueHandle;
    cs.write.offset = 0;
    cs.write.data   = sWriteCtx[idx].buf->Start();
    cs.write.length = sWriteCtx[idx].buf->DataLength();

    int err = bt_gatt_write(conId, &cs.write);
    if (err != 0)
    {
        // Send couldn't be queued — drop the buffer and report failure.
        ChipLogError(DeviceLayer, "BleCentral: bt_gatt_write err=%d", err);
        sWriteCtx[idx].buf = nullptr;
        return CHIP_ERROR_INTERNAL;
    }
    return CHIP_NO_ERROR;
}

// ══════════════════════════════════════════════════════════════════════════════
// BT-thread callbacks — all marshal to CHIP thread via ScheduleWork
// ══════════════════════════════════════════════════════════════════════════════

// ─── ScanRecvCb [BT RX thread] ─────────────────────────────────────────────

// Runs on Bluetooth's receive thread once for every advertisement the scan hears.
// It inspects each advert to see if it's a Matter device broadcasting the exact
// discriminator we're hunting for. On a match, it copies the device's address and
// hands off to the Matter thread to actually connect. Because it runs on the BT
// thread, it does NOT call Matter code directly.
void BleCentral::ScanRecvCb(const bt_le_scan_recv_info * info, net_buf_simple * buf)
{
    // Ignore adverts if we're not scanning, or if we already found our match and
    // are busy connecting to it.
    BleCentral & self = Instance();
    if (!self.mScanning || sScanMatchPending)
    {
        return;
    }

    // Walk advertisement data looking for BT_DATA_SVC_DATA16 with UUID 0xFFF6.
    // An advert is a packed list of little chunks; we save our read position so we
    // can restore it afterward (we don't want to consume the caller's buffer).
    struct net_buf_simple_state state;
    net_buf_simple_save(buf, &state);

    // Step through the advert's chunks one at a time.
    bool matched = false;
    while (buf->len > 1)
    {
        // Each chunk starts with its length, then a type byte, then its data.
        uint8_t adLen  = net_buf_simple_pull_u8(buf);
        if (adLen == 0 || adLen > buf->len)
        {
            break;
        }
        uint8_t adType = net_buf_simple_pull_u8(buf);
        uint8_t dataLen = adLen - 1u;

        // We only care about "16-bit service data" chunks big enough to hold a
        // Matter device-identification blob (plus its 2-byte service UUID).
        if (adType == BT_DATA_SVC_DATA16 && dataLen >= sizeof(chip::Ble::ChipBLEDeviceIdentificationInfo) + 2u)
        {
            // First 2 bytes: UUID16 little-endian.
            uint16_t uuid16 = net_buf_simple_pull_le16(buf);
            dataLen -= 2u;

            // If this is the CHIPoBLE service (0xFFF6) and the remaining data is big
            // enough, it's a commissionable Matter device — read its details.
            if (uuid16 == nrf::controller::kCHIPoBLEServiceUuid16 &&
                dataLen >= sizeof(chip::Ble::ChipBLEDeviceIdentificationInfo))
            {
                // NOTE: despite the line just below (inherited from the original),
                // no opcode byte is pulled or skipped here — the code casts buf->data
                // straight into the device-info blob. The opcode is simply part of the
                // ChipBLEDeviceIdentificationInfo struct layout, so there is no separate
                // "next byte" step at this point.
                // Next byte should be the OpCode (0x01 = DeviceIdentificationInfo).
                // Interpret the remaining bytes as the Matter device-info blob so we
                // can pull out the discriminator it's broadcasting.
                const chip::Ble::ChipBLEDeviceIdentificationInfo * devInfo =
                    reinterpret_cast<const chip::Ble::ChipBLEDeviceIdentificationInfo *>(buf->data);

                // Does this device's broadcast discriminator match the one we want?
                uint16_t devDisc = devInfo->GetDeviceDiscriminator();
                bool match       = self.mTargetDiscriminator.MatchesLongDiscriminator(devDisc);

                // Progress level during bring-up: this fires only for CHIPoBLE
                // service-data adverts, so it shows every commissionable Matter
                // device the scan sees (and whether its discriminator matches).
                ChipLogProgress(DeviceLayer, "BleCentral: scan recv UUID=0x%04x devDisc=%u match=%d",
                                uuid16, devDisc, (int) match);

                if (match)
                {
                    // Copy address for CHIP thread.
                    // Save the device's Bluetooth address and mark that a match is
                    // now pending so we don't act on further adverts.
                    bt_addr_le_copy(&sScanMatchAddr, info->addr);
                    sScanMatchPending = true;
                    matched           = true;

                    // Marshal connect to CHIP thread.
                    // Hand the actual connect over to the Matter thread (scanning
                    // must be stopped and the connection opened from there).
                    chip::DeviceLayer::PlatformMgr().ScheduleWork(
                        [](intptr_t) {
                            BleCentral & s = Instance();
                            s.mScanning    = false;
                            bt_le_scan_stop(); // must stop before bt_conn_le_create

                            bt_conn * conn = nullptr;
                            // Use named params: the BT_CONN_LE_CREATE_CONN / BT_LE_CONN_PARAM_DEFAULT
                            // macros are C compound literals (temporary arrays) whose address C++ refuses.
                            // createParam = how to open the link; connParam = timing
                            // and a 4-second give-up timeout for the connection.
                            static const bt_conn_le_create_param createParam = BT_CONN_LE_CREATE_PARAM_INIT(
                                BT_CONN_LE_OPT_NONE, BT_GAP_SCAN_FAST_INTERVAL, BT_GAP_SCAN_FAST_INTERVAL);
                            static const bt_le_conn_param connParam = BT_LE_CONN_PARAM_INIT(
                                BT_GAP_INIT_CONN_INT_MIN, BT_GAP_INIT_CONN_INT_MAX, 0, BT_GAP_MS_TO_CONN_TIMEOUT(4000));
                            // Actually open the Bluetooth connection to the matched
                            // device. CentralConnectedCb fires when it's up.
                            int err = bt_conn_le_create(&sScanMatchAddr, &createParam, &connParam, &conn);
                            if (err != 0)
                            {
                                // Couldn't start connecting — report failure to Matter.
                                ChipLogError(DeviceLayer,
                                             "BleCentral: bt_conn_le_create err=%d", err);
                                sScanMatchPending = false;
                                if (s.OnConnectionError != nullptr)
                                {
                                    s.OnConnectionError(s.mAppState, CHIP_ERROR_INTERNAL);
                                }
                                return;
                            }
                            // Store create-ref; unref after connected cb fires.
                            // Remember the pending connection until the connected
                            // callback runs. We simply keep the reference that
                            // bt_conn_le_create already handed back — no extra
                            // bt_conn_ref is taken here.
                            s.mPendingConn = conn;
                        },
                        0);
                }
                // Skip past this chunk's remaining data to reach the next chunk.
                net_buf_simple_pull(buf, dataLen);
            }
            else
            {
                // Right chunk type but not the CHIPoBLE service we want — skip it.
                net_buf_simple_pull(buf, dataLen);
            }
        }
        else
        {
            // This branch also covers a 16-bit-service-data chunk that is present but
            // too small to hold a full device-info blob (here dataLen still counts the
            // 2 UUID bytes, since we haven't pulled them). Either way — wrong chunk
            // type, or a service-data chunk too short to be useful — skip its data.
            // Some other kind of advert chunk — skip its data.
            net_buf_simple_pull(buf, dataLen);
        }

        if (matched) break;
    }

    // Put the buffer's read position back where we found it.
    net_buf_simple_restore(buf, &state);
}

// ─── CentralConnectedCb [BT RX thread] ────────────────────────────────────

// Runs on Bluetooth's thread the moment a connection attempt finishes (succeed or
// fail). We only care about connections where WE are the "phone" (central role);
// the Matter stack handles its own peripheral connections. On success we negotiate
// the max message size, then start walking the device's GATT menu.
void BleCentral::CentralConnectedCb(bt_conn * conn, uint8_t err)
{
    // Look up this connection's info; bail if we can't.
    bt_conn_info info;
    if (bt_conn_get_info(conn, &info) != 0)
    {
        return;
    }
    // Ignore connections where we're the peripheral — not ours to handle here.
    if (info.role != BT_CONN_ROLE_CENTRAL)
    {
        return; // peripheral events handled by BLEManagerImpl's cb
    }

    BleCentral & self = Instance();

    if (err != 0)
    {
        // The connection attempt failed. Clean up and report the error to Matter.
        ChipLogError(DeviceLayer, "BleCentral: central connected err=0x%02x", err);
        sScanMatchPending = false;
        if (self.mPendingConn != nullptr)
        {
            bt_conn_unref(self.mPendingConn);
            self.mPendingConn = nullptr;
        }
        if (self.OnConnectionError != nullptr)
        {
            // Must call on CHIP thread.
            // Package the error details and hand them to the Matter thread, which
            // owns the callback. (ctx is heap-allocated and freed inside the lambda.)
            struct ErrCtx { CHIP_ERROR chipErr; void * appState; BleCentral * self; };
            // Simple lambda capture — use static for small context.
            // TODO(verify): lambda capture of CHIP_ERROR across ScheduleWork
            chip::DeviceLayer::PlatformMgr().ScheduleWork(
                [](intptr_t arg) {
                    auto * ctx = reinterpret_cast<ErrCtx *>(arg);
                    if (ctx->self->OnConnectionError)
                        ctx->self->OnConnectionError(ctx->appState, ctx->chipErr);
                    delete ctx;
                },
                reinterpret_cast<intptr_t>(new ErrCtx{ CHIP_ERROR_INTERNAL, self.mAppState, &self }));
        }
        return;
    }

    // Keep a ref for the CHIP thread callback; unref the create-ref.
    // Take a fresh reference to keep the connection object alive for the handoff,
    // and release the reference we held while the connection was being opened.
    bt_conn_ref(conn);
    if (self.mPendingConn != nullptr)
    {
        bt_conn_unref(self.mPendingConn);
        self.mPendingConn = nullptr;
    }
    sScanMatchPending = false;

    // Init slot.
    // Mark this connection's bookkeeping slot as in use.
    ConnState & cs = self.Slot(conn);
    cs.conn        = conn;
    cs.inUse       = true;

    // Trigger MTU exchange then fire OnConnectionComplete on CHIP thread.
    struct ConnCtx
    {
        bt_conn * conn;
        void *    appState;
        BleCentral * self;
    };
    ConnCtx * ctx  = new ConnCtx{ conn, self.mAppState, &self };

    // MTU exchange first; callback will fire OnConnectionComplete.
    // First negotiate the MTU (biggest single Bluetooth message size). When that
    // finishes, the lambda below runs and kicks off GATT discovery.
    uint8_t idx                   = bt_conn_index(conn);
    sMtuParams[idx].func          = [](bt_conn * c, uint8_t mtuErr,
                                       bt_gatt_exchange_params * /* p */) {
        if (mtuErr != 0)
        {
            ChipLogError(DeviceLayer, "BleCentral: MTU exchange err=%u", mtuErr);
        }
        else
        {
            ChipLogProgress(DeviceLayer, "BleCentral: MTU=%u", bt_gatt_get_mtu(c));
        }
        // Discover CHIPoBLE service/characteristics NOW (BT thread), before
        // OnConnectionComplete. StartDiscovery -> GattDiscoverCb -> FireConnComplete
        // once the RX/TX/CCC handles are cached. The conn ref taken above is owned
        // by BleLayer after FireConnComplete.
        // Walk the device's GATT menu now, even if MTU negotiation failed — we need
        // the slot handles before Matter's first write either way.
        StartDiscovery(c);
    };

    int mtuErr = bt_gatt_exchange_mtu(conn, &sMtuParams[idx]);
    if (mtuErr != 0)
    {
        ChipLogError(DeviceLayer, "BleCentral: bt_gatt_exchange_mtu err=%d — proceeding", mtuErr);
        // Skip straight to discovery (still needed before the first write).
        // Couldn't even start MTU negotiation, so go straight to discovery.
        StartDiscovery(conn);
    }
    // Free the ConnCtx we allocated above. Note: the MTU-callback lambda captures
    // nothing ([]) and never reads ctx, so this allocation ends up unused here — it
    // is created and immediately deleted without being referenced by the lambda.
    delete ctx; // ctx was allocated but only used to set up sMtuParams lambda context above
}

// ─── CentralDisconnectedCb [BT RX thread] ─────────────────────────────────

// Runs on Bluetooth's thread when one of our central connections drops. Clears the
// connection's bookkeeping and tells the Matter stack (on the Matter thread) that
// the link is gone so it can fail the commissioning cleanly.
void BleCentral::CentralDisconnectedCb(bt_conn * conn, uint8_t reason)
{
    // Only handle drops of connections where we're the central. Bail otherwise.
    bt_conn_info info;
    if (bt_conn_get_info(conn, &info) != 0)
    {
        return;
    }
    if (info.role != BT_CONN_ROLE_CENTRAL)
    {
        return;
    }

    ChipLogProgress(DeviceLayer, "BleCentral: central disconnected reason=0x%02x", reason);

    // Free up this connection's slot and forget its discovered handles.
    ConnState & cs = Instance().Slot(conn);
    cs.inUse       = false;
    cs.rxValueHandle = 0;
    cs.txValueHandle = 0;
    cs.txCccHandle   = 0;

    // Marshal to CHIP thread.
    // Hand the "connection lost" news to the Matter thread. We hold a reference to
    // the connection so it stays valid until that work runs.
    struct DiscCtx { bt_conn * conn; };
    DiscCtx * ctx = new DiscCtx{ conn };
    bt_conn_ref(conn); // keep alive until ScheduleWork fires

    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        [](intptr_t arg) {
            auto * ctx = reinterpret_cast<DiscCtx *>(arg);
            chip::Ble::BleLayer * ble = chip::DeviceLayer::ConnectivityMgr().GetBleLayer();
            if (ble != nullptr)
            {
                ble->HandleConnectionError(ctx->conn, BLE_ERROR_REMOTE_DEVICE_DISCONNECTED);
            }
            bt_conn_unref(ctx->conn);
            delete ctx;
        },
        reinterpret_cast<intptr_t>(ctx));

    // Release the ref we took in CentralConnectedCb.
    bt_conn_unref(conn);
}

// Report a PRE-OnConnectionComplete establishment failure to CHIP (via the
// ConnectionDelegate) on the Matter thread — used when GATT discovery dead-ends.
// In plain English: if setup fails BEFORE we ever told Matter the link was ready
// (e.g. we couldn't find the expected data slots), use this to report the failure
// on the Matter thread so the pairing attempt gives up instead of hanging.
static void ReportConnError()
{
    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        [](intptr_t) {
            BleCentral & s = BleCentral::Instance();
            if (s.OnConnectionError != nullptr)
            {
                s.OnConnectionError(s.AppState(), CHIP_ERROR_INTERNAL);
            }
        },
        0);
}

// Tear down an ALREADY-established BLE endpoint on error (post-OnConnectionComplete:
// a failed GATT write or subscribe) so BTP/commissioning fails fast instead of
// hanging to the BLE supervision timeout.
// In plain English: if something breaks AFTER Matter was already using the link
// (a failed write or subscribe), use this to tell Matter to tear the link down
// right away rather than waiting ~15 seconds for Bluetooth to notice it's dead.
static void ReportEndpointError(bt_conn * conn)
{
    bt_conn_ref(conn);
    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        [](intptr_t arg) {
            bt_conn * c               = reinterpret_cast<bt_conn *>(arg);
            chip::Ble::BleLayer * ble = chip::DeviceLayer::ConnectivityMgr().GetBleLayer();
            if (ble != nullptr)
            {
                ble->HandleConnectionError(c, CHIP_ERROR_INTERNAL);
            }
            bt_conn_unref(c);
        },
        reinterpret_cast<intptr_t>(conn));
}

// ─── GattDiscoverCb [BT RX thread] ────────────────────────────────────────
// Three-stage discovery: PRIMARY → CHARACTERISTIC (RX then TX) → DESCRIPTOR (CCC).
// Each MATCHED stage chains the next bt_gatt_discover INLINE then returns
// BT_GATT_ITER_STOP — Zephyr delivers NO attr==NULL completion after ITER_STOP on
// a matched attr, so an attr==NULL callback here always means "not found".

// Runs on Bluetooth's thread, once per step of the GATT-menu walk. It's a small
// state machine: first it finds the CHIPoBLE service, then the RX slot, then the
// TX slot, then the TX slot's push-switch (CCC). Each successful step launches the
// next one. When the final CCC is found, it tells Matter the link is ready.
uint8_t BleCentral::GattDiscoverCb(bt_conn * conn, const bt_gatt_attr * attr,
                                    bt_gatt_discover_params * params)
{
    ConnState & cs = Instance().Slot(conn);

    if (attr == nullptr)
    {
        // A matched stage chains the next discovery inline + returns ITER_STOP, so
        // reaching attr==NULL means the expected attribute was NOT found. Fail fast
        // instead of leaving the link idle until the 0x08 supervision timeout.
        const char * what = (params->type == BT_GATT_DISCOVER_PRIMARY)        ? "CHIPoBLE service 0xFFF6"
            : (params->type == BT_GATT_DISCOVER_CHARACTERISTIC)               ? "CHIPoBLE RX/TX characteristic"
            : (params->type == BT_GATT_DISCOVER_DESCRIPTOR)                   ? "CHIPoBLE TX CCC descriptor"
                                                                             : "GATT attribute";
        ChipLogError(DeviceLayer, "BleCentral: %s not found during discovery — connection error", what);
        ReportConnError();
        return BT_GATT_ITER_STOP;
    }

    // Stage 1 result: we found the CHIPoBLE service. Now search WITHIN it for the
    // RX (write-target) slot.
    if (params->type == BT_GATT_DISCOVER_PRIMARY)
    {
        // Found the CHIPoBLE service; narrow characteristic search to this range.
        const bt_gatt_service_val * svc =
            reinterpret_cast<const bt_gatt_service_val *>(attr->user_data);
        ChipLogProgress(DeviceLayer, "BleCentral: found PRIMARY service handle=%u endH=%u",
                      attr->handle, svc->end_handle);

        // Restrict the next search to the handle range this service occupies.
        params->uuid         = &sUUID128_CHIPoBLEChar_RX.uuid;
        params->start_handle = attr->handle + 1u;
        params->end_handle   = svc->end_handle;
        params->type         = BT_GATT_DISCOVER_CHARACTERISTIC;

        int err = bt_gatt_discover(conn, params);
        if (err != 0)
        {
            ChipLogError(DeviceLayer, "BleCentral: bt_gatt_discover(CHAR-RX) err=%d", err);
            ReportConnError();
        }
        return BT_GATT_ITER_STOP;
    }
    // Stage 2 result: we found a characteristic. It's either the RX slot (then go
    // find TX) or the TX slot (then go find its CCC push-switch).
    else if (params->type == BT_GATT_DISCOVER_CHARACTERISTIC)
    {
        const bt_gatt_chrc * chrc =
            reinterpret_cast<const bt_gatt_chrc *>(attr->user_data);

        if (bt_uuid_cmp(chrc->uuid, &sUUID128_CHIPoBLEChar_RX.uuid) == 0)
        {
            // This is the RX (write-target) slot — remember its handle.
            cs.rxValueHandle = chrc->value_handle;
            ChipLogProgress(DeviceLayer, "BleCentral: RX handle=%u", cs.rxValueHandle);

            // Continue to find TX characteristic.
            params->uuid         = &sUUID128_CHIPoBLEChar_TX.uuid;
            params->start_handle = attr->handle + 1u;
            // end_handle unchanged (service range).
            int err = bt_gatt_discover(conn, params);
            if (err != 0)
            {
                ChipLogError(DeviceLayer, "BleCentral: bt_gatt_discover(CHAR-TX) err=%d", err);
                ReportConnError();
            }
            return BT_GATT_ITER_STOP;
        }
        else if (bt_uuid_cmp(chrc->uuid, &sUUID128_CHIPoBLEChar_TX.uuid) == 0)
        {
            // This is the TX (device-sends-back) slot — remember its handle, then
            // go find its CCC push-switch descriptor.
            cs.txValueHandle = chrc->value_handle;
            ChipLogProgress(DeviceLayer, "BleCentral: TX handle=%u", cs.txValueHandle);

            // [rank 1] Launch CCC (DESCRIPTOR) discovery INLINE. Returning
            // BT_GATT_ITER_STOP on a matched attr ends the read-by-type procedure with
            // NO attr==NULL completion (Zephyr gatt.c parse_characteristic /
            // gatt_read_type_rsp), so the next stage MUST be issued here — same idiom
            // as the PRIMARY->RX and RX->TX chains above.
            params->uuid         = &sUUID16_CCC.uuid;
            params->start_handle = cs.txValueHandle + 1u;
            // end_handle stays the service range (set in the PRIMARY branch).
            params->type         = BT_GATT_DISCOVER_DESCRIPTOR;
            int err = bt_gatt_discover(conn, params);
            if (err != 0)
            {
                ChipLogError(DeviceLayer, "BleCentral: bt_gatt_discover(DESC/CCC) err=%d", err);
                ReportConnError();
            }
            return BT_GATT_ITER_STOP;
        }
    }
    // Stage 3 result: we found the TX slot's CCC push-switch. That's the last piece
    // we needed — hand the ready connection over to Matter.
    else if (params->type == BT_GATT_DISCOVER_DESCRIPTOR)
    {
        if (bt_uuid_cmp(attr->uuid, &sUUID16_CCC.uuid) == 0)
        {
            // Remember the CCC handle so we can later flip on message push.
            cs.txCccHandle = attr->handle;
            // [rank 2] Complete the handoff INLINE. Returning BT_GATT_ITER_STOP on a
            // matched attr yields NO attr==NULL completion (Zephyr gatt_find_info_rsp),
            // so the connection must be handed to CHIP here.
            ChipLogProgress(DeviceLayer, "BleCentral: discovery complete rxH=%u txH=%u cccH=%u",
                            cs.rxValueHandle, cs.txValueHandle, cs.txCccHandle);
            // Only declare success if all three handles were actually found.
            if (cs.rxValueHandle == 0 || cs.txValueHandle == 0 || cs.txCccHandle == 0)
            {
                ChipLogError(DeviceLayer, "BleCentral: discovery incomplete — connection error");
                ReportConnError();
            }
            else
            {
                // All slots located — tell Matter the BLE link is ready.
                FireConnComplete(conn);
            }
            return BT_GATT_ITER_STOP;
        }
    }

    // Not the attribute we were after yet — keep iterating this discovery stage.
    return BT_GATT_ITER_CONTINUE;
}

// ─── GattNotifyCb (indication received) [BT RX thread] ────────────────────

// Runs on Bluetooth's thread each time the device PUSHES us a message on its TX
// slot (an indication) — these carry Matter's handshake replies. We copy the bytes
// into a Matter buffer and hand them to the Matter stack on the Matter thread.
uint8_t BleCentral::GattNotifyCb(bt_conn * conn, bt_gatt_subscribe_params * params,
                                  const void * data, uint16_t length)
{
    if (data == nullptr)
    {
        // Subscription cancelled.
        // A null payload means the subscription ended — stop listening.
        return BT_GATT_ITER_STOP;
    }

    // Allocate PacketBuffer and copy indication payload.
    // Copy the pushed bytes into a Matter-owned buffer we can safely hand across
    // threads (the original bytes belong to Bluetooth and won't outlive this call).
    chip::System::PacketBufferHandle buf =
        chip::System::PacketBufferHandle::NewWithData(data, length);
    if (buf.IsNull())
    {
        // Out of memory — drop this message but stay subscribed.
        ChipLogError(DeviceLayer, "BleCentral: GattNotifyCb — OOM");
        return BT_GATT_ITER_CONTINUE;
    }

    // Marshal to CHIP thread.
    // Package the connection and buffer, take a reference to keep the connection
    // alive, and hand delivery over to the Matter thread.
    struct IndicCtx
    {
        bt_conn *                       conn;
        chip::System::PacketBuffer *    rawBuf;
    };
    IndicCtx * ctx = new IndicCtx{ conn, std::move(buf).UnsafeRelease() };
    bt_conn_ref(conn);

    CHIP_ERROR schedErr = chip::DeviceLayer::PlatformMgr().ScheduleWork(
        // Runs on the Matter thread: hand the received bytes to the Matter stack.
        [](intptr_t arg) {
            auto * ctx = reinterpret_cast<IndicCtx *>(arg);
            chip::System::PacketBufferHandle pBuf =
                chip::System::PacketBufferHandle::Adopt(ctx->rawBuf);

            chip::Ble::BleLayer * ble = chip::DeviceLayer::ConnectivityMgr().GetBleLayer();
            if (ble != nullptr)
            {
                ble->HandleIndicationReceived(ctx->conn,
                                              &chip::Ble::CHIP_BLE_SVC_ID,
                                              &chip::Ble::CHIP_BLE_CHAR_2_UUID,
                                              std::move(pBuf));
            }
            bt_conn_unref(ctx->conn);
            delete ctx;
        },
        reinterpret_cast<intptr_t>(ctx));

    if (schedErr != CHIP_NO_ERROR)
    {
        // [rank 9] Event queue full: the lambda will never run, so undo the ref, free
        // the PacketBuffer pool block, and delete ctx here to avoid a leak.
        chip::System::PacketBufferHandle::Adopt(ctx->rawBuf);
        bt_conn_unref(ctx->conn);
        delete ctx;
    }

    return BT_GATT_ITER_CONTINUE; // stay subscribed
}

// ─── GattSubscribedCb [BT RX / workqueue thread] ──────────────────────────

// Runs on Bluetooth's thread once the device confirms our subscribe request (the
// CCC push-switch write) landed. On success we tell Matter the subscription is up
// so its handshake can proceed; on failure we tear the link down fast.
void BleCentral::GattSubscribedCb(bt_conn * conn, uint8_t err,
                                   bt_gatt_subscribe_params * /* params */)
{
    if (err != 0)
    {
        // [rank 7] A failed CCC write wedges BTP (only HandleSubscribeComplete clears
        // the in-flight flag). Fail the connection instead of stalling ~15s to timeout.
        ChipLogError(DeviceLayer, "BleCentral: GattSubscribedCb err=%u — failing connection", err);
        ReportEndpointError(conn);
        return;
    }

    ChipLogProgress(DeviceLayer, "BleCentral: GattSubscribed — notifying CHIP stack");

    // Keep the connection alive and tell Matter (on the Matter thread) that the
    // device's message push is now on.
    bt_conn_ref(conn);
    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        [](intptr_t arg) {
            bt_conn * c = reinterpret_cast<bt_conn *>(arg);
            chip::Ble::BleLayer * ble = chip::DeviceLayer::ConnectivityMgr().GetBleLayer();
            if (ble != nullptr)
            {
                ble->HandleSubscribeComplete(c,
                                             &chip::Ble::CHIP_BLE_SVC_ID,
                                             &chip::Ble::CHIP_BLE_CHAR_2_UUID);
            }
            bt_conn_unref(c);
        },
        reinterpret_cast<intptr_t>(conn));
}

// ─── GattWriteCb [BT RX / workqueue thread] ───────────────────────────────

// Runs on Bluetooth's thread once a write WE sent to the device's RX slot finishes.
// We free the sent buffer, then either tell Matter the write was confirmed (so it
// can send the next chunk) or tear the link down if the write failed.
void BleCentral::GattWriteCb(bt_conn * conn, uint8_t err,
                              bt_gatt_write_params * /* params */)
{
    // Release the payload buffer (write is done or failed).
    // The send is over, so we no longer need to hold the data buffer alive.
    uint8_t idx = bt_conn_index(conn);
    sWriteCtx[idx].buf = nullptr;

    if (err != 0)
    {
        // [rank 3] A failed C1 write wedges the BTP send engine (its in-flight flag
        // clears only on a successful confirmation, and CHIP has no GATT-write
        // timeout). Tear the endpoint down so commissioning fails fast.
        ChipLogError(DeviceLayer, "BleCentral: GattWriteCb err=%u — tearing down endpoint", err);
        ReportEndpointError(conn);
        return;
    }

    // Write succeeded — tell Matter (on the Matter thread) so it can continue.
    bt_conn_ref(conn);
    chip::DeviceLayer::PlatformMgr().ScheduleWork(
        [](intptr_t arg) {
            bt_conn * c = reinterpret_cast<bt_conn *>(arg);
            chip::Ble::BleLayer * ble = chip::DeviceLayer::ConnectivityMgr().GetBleLayer();
            if (ble != nullptr)
            {
                // RX characteristic (CHAR_1) is the write target.
                ble->HandleWriteConfirmation(c,
                                             &chip::Ble::CHIP_BLE_SVC_ID,
                                             &chip::Ble::CHIP_BLE_CHAR_1_UUID);
            }
            bt_conn_unref(c);
        },
        reinterpret_cast<intptr_t>(conn));
}

} // namespace controller
} // namespace nrf

// ══════════════════════════════════════════════════════════════════════════════
// Free shim functions (ble_central_shim.h)
// ══════════════════════════════════════════════════════════════════════════════

namespace nrf {
namespace controller {

// These four tiny "shim" functions are the plain-C-style doorway into this file.
// Other parts of the firmware (like the patched Matter BLE glue) call these, and
// each one simply forwards to the matching method on the single BleCentral object.

// Hand back the object the Matter stack should use to open BLE connections for
// commissioning (our BleCentral, which plays the connection-delegate role).
chip::Ble::BleConnectionDelegate * BleCentralConnectionDelegate()
{
    return &BleCentral::Instance();
}

// Turn on message push from the device's TX slot (forwards to SubscribeCharacteristic).
CHIP_ERROR BleCentralSubscribe(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                                const chip::Ble::ChipBleUUID * charId)
{
    return BleCentral::Instance().SubscribeCharacteristic(conn, svcId, charId);
}

// Turn message push back off (forwards to UnsubscribeCharacteristic).
CHIP_ERROR BleCentralUnsubscribe(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                                  const chip::Ble::ChipBleUUID * charId)
{
    return BleCentral::Instance().UnsubscribeCharacteristic(conn, svcId, charId);
}

// Send a chunk of data to the device's RX slot (forwards to SendWriteRequest).
CHIP_ERROR BleCentralWrite(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                            const chip::Ble::ChipBleUUID * charId,
                            chip::System::PacketBufferHandle pBuf)
{
    return BleCentral::Instance().SendWriteRequest(conn, svcId, charId, std::move(pBuf));
}

} // namespace controller
} // namespace nrf
