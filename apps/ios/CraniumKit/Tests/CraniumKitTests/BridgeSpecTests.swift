import Foundation
import Testing
@testable import CraniumKit

/// apps/shared/, beside this package: the bridge's contract and the sample bundle, which the website's tests
/// and the Android app's read too.
enum Shared {
    static let folder = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // CraniumKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // CraniumKit
        .deletingLastPathComponent()  // ios
        .deletingLastPathComponent()  // apps
        .appendingPathComponent("shared", isDirectory: true)

    static func json(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: folder.appendingPathComponent(name))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

/// The bridge as this app knows it (`BridgeSpec`) is bridge.json, method for method and parameter for
/// parameter; and what a request may be is checked before any handler runs.
@MainActor
@Suite struct BridgeSpecTests {
    @Test func theTableIsTheContract() throws {
        let spec = try Shared.json("bridge.json")
        #expect(spec["bridge"] as? Int == Bridge.version)
        #expect((spec["origins"] as? [String: String])?["ios"] == ShellPolicy.origin)
        #expect(spec["features"] as? [String] == BridgeSpec.features)
        let errors = try #require(spec["errors"] as? [String: Any])
        #expect(Set(errors.keys) == Set(BridgeError.Code.allCases.map(\.rawValue)))
        #expect(((spec["envelope"] as? [String: Any])?["maxRequestBytes"] as? Int) == Bridge.maxRequestBytes)
        #expect(Set((spec["events"] as? [String: Any] ?? [:]).keys) == Set(BridgeSpec.events))

        let methods = try #require(spec["methods"] as? [String: [String: Any]])
        #expect(Set(methods.keys) == Set(BridgeSpec.methods.keys))
        for (name, entry) in methods {
            let mine = try #require(BridgeSpec.methods[name], "\(name)")
            #expect(entry["feature"] as? String == mine.feature, "\(name): feature")
            let params = try #require(entry["params"] as? [String: [String: Any]], "\(name): params")
            #expect(Set(params.keys) == Set(mine.params.keys), "\(name): the parameters")
            for (param, rule) in params {
                let known = try #require(mine.params[param])
                #expect((rule["optional"] as? Bool ?? false) == known.optional, "\(name).\(param): optional")
                switch known.kind {
                case .string(let max, let pattern):
                    #expect(rule["type"] as? String == "string", "\(name).\(param)")
                    #expect(rule["max"] as? Int == max, "\(name).\(param): max")
                    #expect(rule["pattern"] as? String == pattern, "\(name).\(param): pattern")
                case .integer(let min, let max):
                    #expect(rule["type"] as? String == "integer", "\(name).\(param)")
                    #expect(rule["min"] as? Int == min && rule["max"] as? Int == max, "\(name).\(param): range")
                case .boolean:
                    #expect(rule["type"] as? String == "boolean", "\(name).\(param)")
                case .enumeration(let values):
                    #expect(rule["type"] as? String == "enum", "\(name).\(param)")
                    #expect(rule["values"] as? [String] == values, "\(name).\(param): values")
                }
            }
        }
        // The policies are the file's, word for word.
        let policies = try #require(spec["policies"] as? [String: String])
        #expect(policies["console"] == ShellPolicy.templates["console"])
        #expect(policies["customer"] == ShellPolicy.templates["customer"])
    }

    // MARK: Requests

    func request(_ method: String, _ params: String = "{}", id: Int = 7, v: Int = 1) -> String {
        "{\"v\":\(v),\"id\":\(id),\"method\":\"\(method)\",\"params\":\(params)}"
    }

    func answer(_ text: String?) throws -> [String: Any] {
        let text = try #require(text)
        return try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    func errorCode(_ text: String?) throws -> String? {
        let reply = try answer(text)
        #expect(reply["ok"] as? Bool == false)
        return (reply["error"] as? [String: Any])?["code"] as? String
    }

    func dispatcher(_ features: Set<String> = Set(BridgeSpec.features)) -> (BridgeDispatcher, Box) {
        let box = Box()
        let bridge = BridgeDispatcher(features: features)
        for name in BridgeSpec.methods.keys {
            bridge.register(name) { params in
                box.calls.append((name, params.values))
                return ["method": .string(name)]
            }
        }
        return (bridge, box)
    }

    final class Box {
        var calls: [(String, [String: JSONValue])] = []
    }

    @Test func aGoodRequestReachesItsHandler() async throws {
        let (bridge, box) = dispatcher()
        let reply = try answer(await bridge.handle(request("haptics.play", "{\"kind\":\"success\"}")))
        #expect(reply["id"] as? Int == 7)
        #expect(reply["ok"] as? Bool == true)
        #expect((reply["result"] as? [String: Any])?["method"] as? String == "haptics.play")
        #expect(box.calls.count == 1 && box.calls[0].1["kind"] == "success")
        // No params at all is no params.
        _ = await bridge.handle("{\"v\":1,\"id\":8,\"method\":\"app.hello\"}")
        #expect(box.calls.count == 2)
    }

    @Test func whatIsNotARequestHasNoAnswer() async {
        let (bridge, box) = dispatcher()
        #expect(await bridge.handle("not json") == nil)
        #expect(await bridge.handle("[1,2]") == nil)
        #expect(await bridge.handle("{\"v\":1,\"method\":\"app.hello\"}") == nil)
        #expect(await bridge.handle(request("app.hello", id: 0)) == nil)
        #expect(await bridge.handle(request("app.hello", id: 2_147_483_648)) == nil)
        #expect(await bridge.handle("{\"v\":1,\"id\":1.5,\"method\":\"app.hello\"}") == nil)
        #expect(box.calls.isEmpty)
    }

    @Test func theEnvelopeIsChecked() async throws {
        let (bridge, box) = dispatcher()
        #expect(try errorCode(await bridge.handle(request("app.hello", v: 2))) == "bad_request")
        #expect(try errorCode(await bridge.handle(request("app.hello", "[]"))) == "bad_request")
        #expect(try errorCode(await bridge.handle("{\"v\":1,\"id\":3,\"params\":{}}")) == "bad_request")
        let huge = request("clipboard.write", "{\"text\":\"\(String(repeating: "a", count: Bridge.maxRequestBytes))\"}")
        #expect(try errorCode(await bridge.handle(huge)) == "bad_request")
        #expect(box.calls.isEmpty)
    }

    @Test func anUnknownMethodAndAMissingFeature() async throws {
        let (bridge, _) = dispatcher(["auth"])
        #expect(try errorCode(await bridge.handle(request("app.erase"))) == "unknown_method")
        #expect(try errorCode(await bridge.handle(request("ble.scan", "{\"on\":true}"))) == "unavailable")
        #expect(try errorCode(await bridge.handle(request("update.check"))) == "unavailable")
        // A method with no feature, but no handler either.
        let bare = BridgeDispatcher(features: [])
        #expect(try errorCode(await bare.handle(request("app.hello"))) == "unavailable")
        #expect(bare.featureList.isEmpty)
        #expect(BridgeDispatcher(features: ["ble", "auth", "nonsense"]).featureList == ["auth", "ble"])
    }

    @Test func parametersAreCheckedBeforeAnyHandler() async throws {
        let (bridge, box) = dispatcher()
        let refused = [
            // Unknown, missing, of another type.
            ("haptics.play", "{\"kind\":\"success\",\"loud\":true}"),
            ("haptics.play", "{}"),
            ("haptics.play", "{\"kind\":1}"),
            ("haptics.play", "{\"kind\":\"boom\"}"),
            ("app.keepAwake", "{\"on\":1}"),
            ("app.keepAwake", "{\"on\":\"true\"}"),
            ("auth.session", "{\"pool\":\"root\"}"),
            ("auth.session", "{\"pool\":null}"),
            // Out of range, a fraction, too long, not of the pattern.
            ("auth.store", "{\"pool\":\"admin\",\"refreshToken\":\"r\",\"accessToken\":\"a\",\"expiresIn\":0}"),
            ("auth.store", "{\"pool\":\"admin\",\"refreshToken\":\"r\",\"accessToken\":\"a\",\"expiresIn\":86401}"),
            ("auth.store", "{\"pool\":\"admin\",\"refreshToken\":\"r\",\"accessToken\":\"a\",\"expiresIn\":3.5}"),
            ("clipboard.write", "{\"text\":\"\(String(repeating: "1", count: 1025))\"}"),
            ("clipboard.write", "{\"text\":\"123456\",\"expiresIn\":601}"),
            ("ble.upload", "{\"image\":\"AAAA\",\"sha256\":\"\(String(repeating: "A", count: 64))\"}"),
            ("ble.upload", "{\"image\":\"AAAA\",\"sha256\":\"abc\"}"),
            ("ble.connect", "{\"id\":\"../x\"}"),
            ("ble.watch", "{\"on\":true,\"version\":\"1.14.0\"}"),
            ("ble.watch", "{\"on\":true,\"version\":\"1.14.0+0\",\"hash\":\"xyz\"}"),
            ("file.share", "{\"name\":\"../log.csv\",\"type\":\"text/csv\",\"data\":\"\"}"),
            ("file.share", "{\"name\":\"log.csv\",\"type\":\"text/html\",\"data\":\"\"}"),
            ("app.open", "{\"url\":\"\(String(repeating: "a", count: 4097))\"}"),
        ]
        for (method, params) in refused {
            #expect(try errorCode(await bridge.handle(request(method, params))) == "bad_request", "\(method) \(params)")
        }
        #expect(box.calls.isEmpty)

        let taken = [
            ("auth.store", "{\"pool\":\"customer\",\"refreshToken\":\"r\",\"accessToken\":\"a\",\"expiresIn\":3600}"),
            ("auth.store", "{\"pool\":\"admin\",\"refreshToken\":\"r\",\"accessToken\":\"a\",\"idToken\":\"i\",\"expiresIn\":1}"),
            ("clipboard.write", "{\"text\":\"123456\",\"expiresIn\":120}"),
            ("clipboard.write", "{\"text\":\"123456\",\"expiresIn\":null}"),
            ("ble.upload", "{\"image\":\"AAAA\",\"sha256\":\"\(String(repeating: "a", count: 64))\"}"),
            ("ble.connect", "{\"id\":\"8F3C2A1B-0000-4000-8000-00000000ABCD\"}"),
            ("ble.watch", "{\"on\":true,\"version\":\"1.14.0+0\",\"hash\":\"deadbeef01020304\"}"),
            ("ble.watch", "{\"on\":false}"),
            ("file.share", "{\"name\":\"Board log 2026-11-05.csv\",\"type\":\"text/csv\",\"data\":\"YQ==\"}"),
            ("app.keepAwake", "{\"on\":false}"),
        ]
        for (method, params) in taken {
            let reply = try answer(await bridge.handle(request(method, params)))
            #expect(reply["ok"] as? Bool == true, "\(method) \(params)")
        }
        #expect(box.calls.count == taken.count)
        // An optional parameter given as null is left out.
        #expect(box.calls[3].1["expiresIn"] == nil)
    }

    @Test func aHandlersErrorsAreTheContractsCodes() async throws {
        let bridge = BridgeDispatcher(features: ["auth"])
        bridge.register("auth.session") { _ in throw BridgeError(.locked, "Face ID changed.") }
        bridge.register("auth.signOut") { _ in throw URLError(.notConnectedToInternet) }
        let locked = try answer(await bridge.handle(request("auth.session", "{\"pool\":\"admin\"}")))
        #expect((locked["error"] as? [String: Any])?["code"] as? String == "locked")
        #expect((locked["error"] as? [String: Any])?["message"] as? String == "Face ID changed.")
        #expect(try errorCode(await bridge.handle(request("auth.signOut", "{\"pool\":\"admin\"}"))) == "failed")
    }

    @Test func eventsAndAnswersAreJSON() throws {
        let event = try answer(BridgeEnvelope.event("ble.progress", ["sent": 512, "total": 2048]))
        #expect(event["event"] as? String == "ble.progress")
        #expect((event["data"] as? [String: Any])?["sent"] as? Int == 512)
        let failure = try answer(BridgeEnvelope.failure(id: 3, BridgeError(.busy, "An upload is under way.")))
        #expect(failure["id"] as? Int == 3 && failure["ok"] as? Bool == false)
        // A string with quotes and newlines stays one string.
        let text = "a\"b\n</script>"
        let success = try answer(BridgeEnvelope.success(id: 4, result: ["text": .string(text)]))
        #expect((success["result"] as? [String: Any])?["text"] as? String == text)
    }
}
