import Foundation

/// The bridge between the app's native shell and the pages of the web bundle (docs/mobile-apps.md,
/// "The bridge"; apps/shared/bridge.json, which this follows to the letter and which the tests compare it
/// with). The page's side is cloud/web/src/site/assets/bridge.js.
///
/// A request is one JSON text, `{"v": 1, "id": n, "method": "...", "params": {...}}`. Before a handler
/// runs, the request is checked against `BridgeSpec`: a method that is not there is `unknown_method`, a
/// method whose feature this phone does not offer is `unavailable`, and a parameter that is not in the
/// method's list, is missing, of another type, too long, out of range, not of its pattern or not one of
/// its values is `bad_request`. So a handler only ever sees what the contract allows.
public enum Bridge {
    public static let version = 1
    /// The longest request taken, in bytes of UTF-8 (`envelope.maxRequestBytes`).
    public static let maxRequestBytes = 4_194_304
}

// MARK: JSON

/// A JSON value, as the bridge carries it: the page's requests and the app's answers and events.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// From what `JSONSerialization` read. A boolean stays a boolean, not a number.
    public init?(any value: Any) {
        switch value {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let text as String:
            self = .string(text)
        case let list as [Any]:
            var items: [JSONValue] = []
            for item in list {
                guard let value = JSONValue(any: item) else { return nil }
                items.append(value)
            }
            self = .array(items)
        case let dictionary as [String: Any]:
            var fields: [String: JSONValue] = [:]
            for (key, item) in dictionary {
                guard let value = JSONValue(any: item) else { return nil }
                fields[key] = value
            }
            self = .object(fields)
        default:
            return nil
        }
    }

    /// For `JSONSerialization`.
    public var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value):
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 { return Int64(value) }
            return value
        case .string(let value): return value
        case .array(let items): return items.map(\.any)
        case .object(let fields): return fields.mapValues(\.any)
        }
    }

    /// The value as JSON text.
    public var text: String {
        let data = (try? JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed, .sortedKeys])) ?? Data("null".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// A whole number, exactly; nil for a fraction, a boolean or anything else.
    public var integerValue: Int? {
        guard case .number(let value) = self, value.isFinite, value.rounded() == value,
              abs(value) <= 9_007_199_254_740_991 else { return nil }
        return Int(value)
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// Reads JSON text: nil when it is not JSON.
    public static func parse(_ text: String) -> JSONValue? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) else {
            return nil
        }
        return JSONValue(any: object)
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByNilLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(nilLiteral: ()) { self = .null }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { $1 }))
    }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

public extension JSONValue {
    /// A string, or null for nil.
    static func string(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
    static func int(_ value: Int) -> JSONValue { .number(Double(value)) }
}

// MARK: Errors

/// The errors of the bridge, by the codes of `errors` in bridge.json.
public struct BridgeError: Error, Equatable, Sendable {
    public enum Code: String, CaseIterable, Sendable {
        case badRequest = "bad_request"
        case unknownMethod = "unknown_method"
        case unavailable
        case notAllowed = "not_allowed"
        case cancelled
        case locked
        case signedOut = "signed_out"
        case busy
        case network
        case failed
    }

    public let code: Code
    public let message: String

    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }

    public static func badRequest(_ message: String) -> BridgeError { BridgeError(.badRequest, message) }
    public static func failed(_ message: String) -> BridgeError { BridgeError(.failed, message) }
}

// MARK: The contract

/// What a parameter may be.
public struct BridgeParam: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case string(max: Int, pattern: String?)
        case integer(min: Int, max: Int)
        case boolean
        case enumeration([String])
    }

    public let kind: Kind
    public let optional: Bool

    public static func string(max: Int, pattern: String? = nil, optional: Bool = false) -> BridgeParam {
        BridgeParam(kind: .string(max: max, pattern: pattern), optional: optional)
    }

    public static func integer(min: Int, max: Int, optional: Bool = false) -> BridgeParam {
        BridgeParam(kind: .integer(min: min, max: max), optional: optional)
    }

    public static let boolean = BridgeParam(kind: .boolean, optional: false)

    public static func enumeration(_ values: [String], optional: Bool = false) -> BridgeParam {
        BridgeParam(kind: .enumeration(values), optional: optional)
    }
}

public struct BridgeMethod: Equatable, Sendable {
    /// The feature of `features` that the method belongs to; nil for those every app has.
    public let feature: String?
    public let params: [String: BridgeParam]
}

/// bridge.json's methods, features and error codes, as this app knows them. BridgeSpecTests reads the
/// file and compares it with this, entry by entry.
public enum BridgeSpec {
    public static let features = ["auth", "biometric", "ble", "clipboard", "haptics", "share", "open", "keepAwake", "settings",
                                  "appUpdate", "storage", "usb", "camera", "bleOffline"]

    static let pool = BridgeParam.enumeration(["admin", "customer"])
    static let storageKey = BridgeParam.string(max: 208, pattern: "^cranium\\.[!-~]{1,200}$")

    public static let methods: [String: BridgeMethod] = [
        "app.hello": BridgeMethod(feature: nil, params: [:]),
        "app.config": BridgeMethod(feature: nil, params: [:]),
        "app.ready": BridgeMethod(feature: nil, params: [:]),
        "app.reload": BridgeMethod(feature: nil, params: [:]),
        "app.open": BridgeMethod(feature: "open", params: ["url": .string(max: 4096)]),
        "app.settings": BridgeMethod(feature: "settings", params: [:]),
        "app.keepAwake": BridgeMethod(feature: "keepAwake", params: ["on": .boolean]),
        "auth.store": BridgeMethod(feature: "auth", params: [
            "pool": pool,
            "refreshToken": .string(max: 8192),
            "accessToken": .string(max: 8192),
            "idToken": .string(max: 8192, optional: true),
            "expiresIn": .integer(min: 1, max: 86400),
        ]),
        "auth.session": BridgeMethod(feature: "auth", params: ["pool": pool]),
        "auth.signOut": BridgeMethod(feature: "auth", params: ["pool": pool]),
        "biometric.status": BridgeMethod(feature: "biometric", params: ["pool": pool]),
        "biometric.set": BridgeMethod(feature: "biometric", params: ["pool": pool, "enabled": .boolean]),
        "clipboard.write": BridgeMethod(feature: "clipboard", params: [
            "text": .string(max: 1024),
            "expiresIn": .integer(min: 1, max: 600, optional: true),
        ]),
        "haptics.play": BridgeMethod(feature: "haptics", params: [
            "kind": .enumeration(["success", "warning", "error", "selection", "impact"]),
        ]),
        "file.share": BridgeMethod(feature: "share", params: [
            "name": .string(max: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$"),
            "type": .enumeration(["text/csv", "application/json", "text/plain", "application/pdf"]),
            "data": .string(max: 11_184_812),
        ]),
        "storage.get": BridgeMethod(feature: "storage", params: ["key": storageKey]),
        "storage.set": BridgeMethod(feature: "storage", params: ["key": storageKey, "value": .string(max: 3_000_000)]),
        "storage.remove": BridgeMethod(feature: "storage", params: ["key": storageKey]),
        "ble.state": BridgeMethod(feature: "ble", params: [:]),
        "ble.scan": BridgeMethod(feature: "ble", params: ["on": .boolean]),
        "ble.connect": BridgeMethod(feature: "ble", params: ["id": .string(max: 64, pattern: "^[A-Za-z0-9:-]{1,64}$")]),
        "ble.images": BridgeMethod(feature: "ble", params: [:]),
        "ble.upload": BridgeMethod(feature: "ble", params: [
            "image": .string(max: 3_495_256),
            "sha256": .string(max: 64, pattern: "^[0-9a-f]{64}$"),
        ]),
        "ble.cancel": BridgeMethod(feature: "ble", params: [:]),
        "ble.status": BridgeMethod(feature: "ble", params: [:]),
        "ble.disconnect": BridgeMethod(feature: "ble", params: [:]),
        "ble.watch": BridgeMethod(feature: "ble", params: [
            "on": .boolean,
            "version": .string(max: 40, pattern: "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,5}\\+\\d{1,10}$", optional: true),
            "hash": .string(max: 16, pattern: "^[0-9a-f]{16}$", optional: true),
        ]),
        // Offline mode (firmware 1.19.0): the board's own GATT service, on a link paired with its passkey.
        "ble.offline.connect": BridgeMethod(feature: "bleOffline", params: ["id": .string(max: 64, pattern: "^[A-Za-z0-9:-]{1,64}$")]),
        "ble.offline.status": BridgeMethod(feature: "bleOffline", params: [:]),
        "ble.offline.accept": BridgeMethod(feature: "bleOffline", params: ["version": .string(max: 7, pattern: "^\\d{1,3}\\.\\d{1,3}$")]),
        "ble.offline.disconnect": BridgeMethod(feature: "bleOffline", params: [:]),
        // Android only: this app never offers `usb` (an iPhone has no USB serial port for an app).
        "usb.open": BridgeMethod(feature: "usb", params: ["baudRate": .integer(min: 1200, max: 1_000_000)]),
        "usb.write": BridgeMethod(feature: "usb", params: [
            "port": .integer(min: 0, max: 7),
            "data": .string(max: 16384, pattern: "^[A-Za-z0-9+/]*={0,2}$"),
        ]),
        "usb.close": BridgeMethod(feature: "usb", params: ["port": .integer(min: 0, max: 7)]),
        // Scan board: one QR code read with the camera, checked by BoardLink before the page hears of it.
        "camera.scan": BridgeMethod(feature: "camera", params: [:]),
        "update.check": BridgeMethod(feature: "appUpdate", params: [:]),
        "update.install": BridgeMethod(feature: "appUpdate", params: [:]),
    ]

    public static let events = ["app.lifecycle", "app.bundleReady", "auth.locked", "ble.boards", "ble.link", "ble.progress",
                                "ble.status", "ble.offline.status", "ble.offline.link", "usb.data", "usb.closed"]
}

// MARK: A request

/// A request's parameters, once they have passed the method's checks.
public struct BridgeParams: Sendable {
    public let values: [String: JSONValue]

    public func string(_ name: String) -> String { values[name]?.stringValue ?? "" }
    public func optionalString(_ name: String) -> String? { values[name]?.stringValue }
    public func int(_ name: String) -> Int { values[name]?.integerValue ?? 0 }
    public func optionalInt(_ name: String) -> Int? { values[name]?.integerValue }
    public func bool(_ name: String) -> Bool { values[name]?.boolValue ?? false }
}

public struct BridgeRequest: Sendable {
    public let id: Int
    public let method: String
    public let params: [String: JSONValue]

    /// Reads an envelope. Nil, with no answer at all, when there is no id to answer to; otherwise the
    /// request, or the error to answer it with.
    public static func read(_ text: String) -> (id: Int, result: Result<BridgeRequest, BridgeError>)? {
        guard text.utf8.count <= Bridge.maxRequestBytes else {
            // Not read at all; answered if its id is where the page puts it, at the start.
            guard let id = leadingId(text) else { return nil }
            return (id, .failure(.badRequest("The request is larger than the bridge takes.")))
        }
        guard let value = JSONValue.parse(text), let fields = value.objectValue,
              let id = fields["id"]?.integerValue, (1...2_147_483_647).contains(id) else { return nil }
        guard fields["v"]?.integerValue == Bridge.version else {
            return (id, .failure(.badRequest("This app speaks version \(Bridge.version) of the bridge.")))
        }
        guard let method = fields["method"]?.stringValue, !method.isEmpty, method.count <= 64 else {
            return (id, .failure(.badRequest("The request names no method.")))
        }
        let params: [String: JSONValue]
        switch fields["params"] {
        case nil, .some(.null): params = [:]
        case .some(.object(let given)): params = given
        default: return (id, .failure(.badRequest("The parameters are not an object.")))
        }
        return (id, .success(BridgeRequest(id: id, method: method, params: params)))
    }

    /// `"id":<digits>` in the first 64 characters, as bridge.js writes a request: `{"v":1,"id":7,...`.
    static func leadingId(_ text: String) -> Int? {
        let head = String(text.prefix(64))
        guard let range = head.range(of: "\"id\":") else { return nil }
        let digits = head[range.upperBound...].prefix { $0.isASCII && $0.isNumber }
        guard let id = Int(digits), (1...2_147_483_647).contains(id) else { return nil }
        return id
    }
}

public enum BridgeValidation {
    /// The method's parameters, checked; or why they are refused.
    public static func check(_ params: [String: JSONValue], against method: BridgeMethod) -> Result<BridgeParams, BridgeError> {
        for key in params.keys where method.params[key] == nil {
            return .failure(.badRequest("Unknown parameter \(key.prefix(40))."))
        }
        var checked: [String: JSONValue] = [:]
        for (name, spec) in method.params {
            let given = params[name]
            if given == nil || given == .null {
                if spec.optional { continue }
                return .failure(.badRequest("\(name) is missing."))
            }
            guard let value = given, valid(value, spec.kind) else {
                return .failure(.badRequest("\(name) is not what the bridge takes."))
            }
            checked[name] = value
        }
        return .success(BridgeParams(values: checked))
    }

    static func valid(_ value: JSONValue, _ kind: BridgeParam.Kind) -> Bool {
        switch kind {
        case .string(let max, let pattern):
            // The length as the page counts it: UTF-16 code units.
            guard let text = value.stringValue, text.utf16.count <= max else { return false }
            guard let pattern else { return true }
            return matches(text, pattern)
        case .integer(let min, let max):
            guard let number = value.integerValue else { return false }
            return (min...max).contains(number)
        case .boolean:
            return value.boolValue != nil
        case .enumeration(let values):
            guard let text = value.stringValue else { return false }
            return values.contains(text)
        }
    }

    static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [.anchored], range: range) else { return false }
        return match.range == range
    }
}

// MARK: Answers

public enum BridgeEnvelope {
    public static func success(id: Int, result: [String: JSONValue]) -> String {
        JSONValue.object(["id": .int(id), "ok": true, "result": .object(result)]).text
    }

    public static func failure(id: Int, _ error: BridgeError) -> String {
        JSONValue.object(["id": .int(id), "ok": false,
                          "error": ["code": .string(error.code.rawValue), "message": .string(error.message)]]).text
    }

    public static func event(_ name: String, _ data: [String: JSONValue]) -> String {
        JSONValue.object(["event": .string(name), "data": .object(data)]).text
    }
}

/// Takes a request's text and answers it: checks it against the contract, then runs the handler
/// registered for its method. Handlers throw `BridgeError` for the contract's errors; any other error is
/// `failed`, with its description.
@MainActor
public final class BridgeDispatcher {
    public typealias Handler = @MainActor (BridgeParams) async throws -> [String: JSONValue]

    /// The features this app offers, in `app.hello`.
    public let features: Set<String>
    private var handlers: [String: Handler] = [:]

    public init(features: Set<String>) {
        self.features = features.intersection(BridgeSpec.features)
    }

    /// The features in the contract's order, for `app.hello`.
    public var featureList: [String] { BridgeSpec.features.filter(features.contains) }

    public func register(_ method: String, _ handler: @escaping Handler) {
        precondition(BridgeSpec.methods[method] != nil, "\(method) is not a method of the bridge")
        handlers[method] = handler
    }

    public var registered: Set<String> { Set(handlers.keys) }

    /// The answer's text, or nil when the request had no id to answer to.
    public func handle(_ text: String) async -> String? {
        guard let (id, read) = BridgeRequest.read(text) else { return nil }
        switch read {
        case .failure(let error):
            return BridgeEnvelope.failure(id: id, error)
        case .success(let request):
            switch await answer(request) {
            case .success(let result): return BridgeEnvelope.success(id: id, result: result)
            case .failure(let error): return BridgeEnvelope.failure(id: id, error)
            }
        }
    }

    public func answer(_ request: BridgeRequest) async -> Result<[String: JSONValue], BridgeError> {
        guard let method = BridgeSpec.methods[request.method] else {
            return .failure(BridgeError(.unknownMethod, "This app has no \(request.method.prefix(64))."))
        }
        if let feature = method.feature, !features.contains(feature) {
            return .failure(BridgeError(.unavailable, "This app or this phone has no \(feature)."))
        }
        guard let handler = handlers[request.method] else {
            return .failure(BridgeError(.unavailable, "This app has no \(request.method)."))
        }
        let params: BridgeParams
        switch BridgeValidation.check(request.params, against: method) {
        case .failure(let error): return .failure(error)
        case .success(let checked): params = checked
        }
        do {
            return .success(try await handler(params))
        } catch let error as BridgeError {
            return .failure(error)
        } catch {
            return .failure(.failed(error.localizedDescription))
        }
    }
}
