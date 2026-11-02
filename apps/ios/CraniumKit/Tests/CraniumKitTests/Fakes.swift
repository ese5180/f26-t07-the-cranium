import Foundation
@testable import CraniumKit

/// Made-up values. Nothing in the tests names the real stack.
let testConfig = CraniumConfig(
    consoleURL: URL(string: "https://console.test")!,
    loginDomain: URL(string: "https://login.test")!,
    mobileClientId: "testclient123"
)

/// Answers requests with a handler, and keeps every request it was sent.
final class FakeHTTP: HTTPClient, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> (Int, Data)
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private let handler: Handler

    init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    var requests: [URLRequest] {
        lock.withLock { _requests }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        let (status, data) = try await handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, response)
    }
}

/// A fixed access token.
struct FixedToken: AccessTokenProvider {
    var token = "token-1"
    var replacement = "token-2"
    func accessToken() async throws -> String { token }
    func accessToken(replacing rejected: String) async throws -> String { replacement }
}

func json(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
}

/// The form fields of a request body, decoded.
func formFields(_ request: URLRequest) -> [String: String] {
    guard let body = request.httpBody, let text = String(data: body, encoding: .utf8) else { return [:] }
    var fields: [String: String] = [:]
    for pair in text.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map {
            String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? ""
        }
        fields[parts[0]] = parts.count > 1 ? parts[1] : ""
    }
    return fields
}

/// A minimal MCUboot image: a 32-byte header, a body, and some trailing bytes for the TLVs.
func makeImage(version: FirmwareVersion, body: Int = 200, tlvs: Int = 40, magic: UInt32 = MCUbootHeader.magic,
               imageSizeOverride: UInt32? = nil) -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    func put32(_ value: UInt32, at offset: Int) {
        for i in 0..<4 { bytes[offset + i] = UInt8(truncatingIfNeeded: value >> (8 * UInt32(i))) }
    }
    func put16(_ value: UInt16, at offset: Int) {
        bytes[offset] = UInt8(truncatingIfNeeded: value)
        bytes[offset + 1] = UInt8(truncatingIfNeeded: value >> 8)
    }
    put32(magic, at: 0)
    put32(0x0001_0000, at: 4)
    put16(32, at: 8)
    put16(0, at: 10)
    put32(imageSizeOverride ?? UInt32(body), at: 12)
    put32(0, at: 16)
    bytes[20] = version.major
    bytes[21] = version.minor
    put16(version.revision, at: 22)
    put32(version.build, at: 24)
    bytes += (0..<body).map { UInt8(truncatingIfNeeded: $0 &* 7) }
    bytes += [UInt8](repeating: 0xAB, count: tlvs)
    return Data(bytes)
}

func release(for data: Data, version: String, status: String = "active") -> FirmwareRelease {
    FirmwareRelease(version: version, size: data.count, sha256: ImageCheck.sha256Hex(data), status: status)
}

/// A board that answers from a script, and records every call.
final class FakeBoard: BoardTransport, @unchecked Sendable {
    enum Call: Equatable { case connect, list, upload(String), disconnect }

    let name = "Cranium-1A2B"
    private let lock = NSLock()
    private var _calls: [Call] = []
    var slots: [ImageSlot]
    var connectError: Error?
    var uploadError: Error?
    var uploadStarted: (@Sendable () async -> Void)?

    init(running: String = "1.7.0", secondary: String? = nil) {
        var slots = [ImageSlot(image: 0, slot: 0, version: running, active: true, confirmed: true)]
        if let secondary { slots.append(ImageSlot(image: 0, slot: 1, version: secondary)) }
        self.slots = slots
    }

    var calls: [Call] {
        lock.withLock { _calls }
    }

    private func record(_ call: Call) {
        lock.withLock { _calls.append(call) }
    }

    func connect() async throws {
        record(.connect)
        if let connectError { throw connectError }
    }

    func readImageState() async throws -> [ImageSlot] {
        record(.list)
        return slots
    }

    func upload(_ image: VerifiedImage, progress: @escaping @Sendable (UploadProgress) -> Void) async throws {
        record(.upload(image.release))
        await uploadStarted?()
        progress(UploadProgress(sent: image.data.count / 2, total: image.data.count))
        if let uploadError { throw uploadError }
        progress(UploadProgress(sent: image.data.count, total: image.data.count))
    }

    func disconnect() async {
        record(.disconnect)
    }
}
