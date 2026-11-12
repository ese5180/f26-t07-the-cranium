/*
 * ble_central_shim.h — minimal forwarding surface used by the PATCHED SDK
 * Zephyr BLEManagerImpl.cpp (patches/0001) so it can hand the BLE-central role
 * to the in-project implementation without depending on the full ble_central.h.
 * Implemented in src/ble_central.cpp. Visible to the chip module via the
 * zephyr_include_directories() line in CMakeLists.txt.
 *
 * In plain English:
 * This is a tiny "bridge" header. Nordic's Bluetooth code (BLEManagerImpl.cpp,
 * which we've patched) normally only knows how to be the gadget/advertiser side
 * of Bluetooth. To pair brand-new smart devices, THIS hub needs to be the
 * scanner/connector side instead (BLE Central — the "phone" role). Our own code
 * that does that lives in a C++ class called BleCentral. But the patched Nordic
 * file shouldn't have to know about that whole class; it just needs a few simple
 * "do this for me" entry points. This file declares exactly those few plain
 * functions (connect, subscribe, unsubscribe, write). The Nordic file calls them,
 * and behind the scenes they forward the work to our BleCentral implementation in
 * ble_central.cpp. Keeping the surface this small avoids tangling the two files
 * together.
 */
#pragma once

// The "delegate" interface (a helper object Matter calls to open BLE connections)
// that we hand back below.
#include <ble/BleConnectionDelegate.h>
// Matter's Bluetooth UUID type — a UUID names a Bluetooth service or data slot.
#include <ble/BleUUID.h>
// Matter's error/status type (CHIP_ERROR) returned by the functions below.
#include <lib/core/CHIPError.h>
// Matter's packet buffer — a chunk of bytes to send over Bluetooth.
#include <system/SystemPacketBuffer.h>
// Zephyr's Bluetooth connection type (bt_conn) — a live link to one device.
#include <zephyr/bluetooth/conn.h>

// Everything here lives under nrf::controller, this project's own namespace,
// so these helper names don't collide with SDK names.
namespace nrf {
namespace controller {

/// The BleConnectionDelegate installed into BleLayer (4-arg BleLayer::Init).
// In plain English: hand back the single object that knows how to make our hub
// act as the scanner/connector (BLE Central) so it can reach a brand-new device.
// Matter's Bluetooth layer (BleLayer) is told to use this object at startup, and
// calls into it whenever it needs to open a Bluetooth link to a device we're pairing.
chip::Ble::BleConnectionDelegate * BleCentralConnectionDelegate();

/// Central GATT-client ops forwarded from BLEManagerImpl's (formerly stubbed) methods.
// The next three are the actual "do this over Bluetooth" actions the patched
// Nordic file forwards to us. GATT is Bluetooth's menu of data slots on a device
// (services -> characteristics). "svcId" names a service; "charId" names one data
// slot (characteristic) inside it; "conn" is the live link to that device.

// Turn ON receiving pushed messages from the device on a given data slot
// (subscribe = flip the device's "you may push messages to me" switch, its CCC).
// Used so the device can send its handshake replies back to us. Returns a status.
CHIP_ERROR BleCentralSubscribe(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                               const chip::Ble::ChipBleUUID * charId);
// The reverse: stop receiving pushed messages from that data slot (unsubscribe).
// Used when tearing the Bluetooth link down. Returns a status.
CHIP_ERROR BleCentralUnsubscribe(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                                 const chip::Ble::ChipBleUUID * charId);
// Send bytes TO the device by writing them into one of its data slots.
// "pBuf" holds the bytes to send (e.g. a piece of the pairing handshake).
// Returns a status.
CHIP_ERROR BleCentralWrite(bt_conn * conn, const chip::Ble::ChipBleUUID * svcId,
                           const chip::Ble::ChipBleUUID * charId, chip::System::PacketBufferHandle pBuf);

} // namespace controller
} // namespace nrf
