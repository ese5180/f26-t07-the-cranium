import Foundation

/// The Bluetooth relay's frames (firmware 1.21.0, docs/ble-relay.md): what the app and a board say on the
/// L2CAP channel. The same as firmware/app/src/policy/ble_relay_proto.h; RelayProtocolTests holds the board's
/// own sample bytes (`build/ble_relay_tests --print` in firmware/tests/host), as the Android app's test does.
///
/// Each frame is a type byte, a 16-bit little-endian length and that many bytes, at most 512.
public enum RelayProtocol {
    /// The relay's GATT service, which the board advertises, and its one characteristic: the PSM, 2 bytes LE.
    public static let serviceUUID = "D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0"
    public static let psmUUID = "D38F3C15-34A8-4CDD-8E9A-BDB7FE83A2F0"
    public static let version: UInt8 = 1
    public static let headerLength = 3
    public static let payloadMax = 512
    /// AWS IoT's MQTT over TLS: the only port the app relays to.
    public static let port: UInt16 = 8883

    public enum FrameType: UInt8 {
        case hello = 0x01, open = 0x02, opened = 0x03, data = 0x04, close = 0x05
    }

    public enum Reason: UInt8 {
        case normal = 0, refused, connectFailed, peerClosed, timeout, protocolError, handback, link
    }

    public static func frame(_ type: FrameType, _ payload: Data = Data()) -> Data {
        precondition(payload.count <= payloadMax, "a frame carries at most 512 bytes")
        var out = Data([type.rawValue, UInt8(payload.count & 0xff), UInt8(payload.count >> 8)])
        out.append(payload)
        return out
    }

    public static func opened() -> Data { frame(.opened) }

    public static func close(_ reason: Reason) -> Data { frame(.close, Data([reason.rawValue])) }

    /// Stream bytes as DATA frames of at most `max` bytes each.
    public static func data(_ bytes: Data, max: Int = payloadMax) -> Data {
        let size = Swift.max(1, Swift.min(max, payloadMax))
        var out = Data()
        var at = bytes.startIndex
        while at < bytes.endIndex {
            let end = bytes.index(at, offsetBy: size, limitedBy: bytes.endIndex) ?? bytes.endIndex
            out.append(frame(.data, Data(bytes[at..<end])))
            at = end
        }
        return out
    }

    /// Whether the app may open TCP to this host and port for a board: AWS IoT's ATS data endpoint, in the
    /// region this app is configured for, on 8883. No endpoint is written into the app; a board, or anything
    /// that says it is one, cannot use the phone to reach anywhere else.
    public static func allowed(host: String, port: UInt16, region: String) -> Bool {
        guard port == Self.port, !region.isEmpty, region.range(of: "^[a-z0-9-]{1,32}$", options: .regularExpression) != nil
        else { return false }
        let pattern = "^[a-z0-9]{1,64}-ats\\.iot\\.\(NSRegularExpression.escapedPattern(for: region))\\.amazonaws\\.com$"
        return host.range(of: pattern, options: .regularExpression) != nil
    }
}

/// HELLO: what the board says first on a channel.
public struct RelayHello: Equatable, Sendable {
    public let version: UInt8
    public let flags: UInt8
    /// The largest DATA payload the board takes.
    public let dataMax: Int
    /// Its thing name, `cranium-<16 hex digits>`.
    public let thing: String
}

public enum RelayMessage: Equatable, Sendable {
    case hello(RelayHello)
    case open(host: String, port: UInt16)
    case opened
    case data(Data)
    case close(UInt8)
}

/// Reads frames out of the channel's byte stream as they come, whatever the pieces. A type it does not know
/// is skipped, so that a newer board can add frames; a length over 512, or a frame that cannot be read, breaks
/// the stream for good.
public struct RelayReader: Sendable {
    private var buffer = Data()
    public private(set) var broken = false

    public init() {}

    public mutating func feed(_ bytes: Data) -> [RelayMessage] {
        guard !broken else { return [] }
        buffer.append(bytes)
        var messages: [RelayMessage] = []
        while buffer.count >= RelayProtocol.headerLength {
            let start = buffer.startIndex
            let type = buffer[start]
            let length = Int(buffer[start + 1]) | Int(buffer[start + 2]) << 8
            guard length <= RelayProtocol.payloadMax else {
                broken = true
                buffer.removeAll()
                return messages
            }
            guard buffer.count >= RelayProtocol.headerLength + length else { break }
            let payload = Data(buffer[(start + RelayProtocol.headerLength)..<(start + RelayProtocol.headerLength + length)])
            buffer.removeFirst(RelayProtocol.headerLength + length)
            guard let known = RelayProtocol.FrameType(rawValue: type) else { continue }
            guard let message = Self.message(known, payload) else {
                broken = true
                buffer.removeAll()
                return messages
            }
            messages.append(message)
        }
        return messages
    }

    static func message(_ type: RelayProtocol.FrameType, _ payload: Data) -> RelayMessage? {
        let bytes = [UInt8](payload)
        switch type {
        case .hello:
            guard bytes.count >= 4, let thing = String(bytes: bytes[4...], encoding: .utf8) else { return nil }
            return .hello(RelayHello(version: bytes[0], flags: bytes[1], dataMax: Int(bytes[2]) | Int(bytes[3]) << 8,
                                     thing: thing))
        case .open:
            guard bytes.count >= 3, let host = String(bytes: bytes[2...], encoding: .utf8) else { return nil }
            return .open(host: host, port: UInt16(bytes[0]) | UInt16(bytes[1]) << 8)
        case .opened:
            return bytes.isEmpty ? .opened : nil
        case .data:
            return .data(payload)
        case .close:
            return .close(bytes.first ?? RelayProtocol.Reason.normal.rawValue)
        }
    }
}
