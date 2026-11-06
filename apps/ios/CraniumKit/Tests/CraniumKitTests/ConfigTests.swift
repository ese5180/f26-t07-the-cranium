import Foundation
import Testing
@testable import CraniumKit

@Suite struct ConfigTests {
    /// apps/config/, from this file's place in the repository.
    static let configDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // CraniumKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // CraniumKit
        .deletingLastPathComponent()  // ios
        .deletingLastPathComponent()  // apps
        .appendingPathComponent("config")

    func temporaryFile(_ text: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cranium-config-\(UUID().uuidString).json")
        try Data(text.utf8).write(to: url)
        return url
    }

    let good = """
    {"consoleUrl": "https://console.test/", "loginDomain": "https://login.test",
     "mobileClientId": "abc123", "redirectUri": "cranium://signin"}
    """

    @Test func theExampleInTheRepositoryLoadsAndSaysItIsTheExample() throws {
        let example = Self.configDir.appendingPathComponent("cranium.example.json")
        let missing = Self.configDir.appendingPathComponent("does-not-exist.json")
        let loaded = try CraniumConfig.load(deployed: missing, example: example)
        #expect(loaded.source == .example)
        #expect(loaded.config.redirectURI == "cranium://signin")
        #expect(loaded.config.callbackScheme == "cranium")
    }

    @Test func theDeployedFileWins() throws {
        let deployed = try temporaryFile(good)
        let example = Self.configDir.appendingPathComponent("cranium.example.json")
        let loaded = try CraniumConfig.load(deployed: deployed, example: example)
        #expect(loaded.source == .deployed)
        #expect(loaded.config.consoleURL.absoluteString == "https://console.test")  // slash dropped
        #expect(loaded.config.mobileClientId == "abc123")
    }

    @Test func aBrokenDeployedFileIsAnErrorNotAFallback() throws {
        let deployed = try temporaryFile("{\"consoleUrl\": 1}")
        let example = Self.configDir.appendingPathComponent("cranium.example.json")
        #expect(throws: ConfigError.unreadable(file: "cranium.json")) {
            try CraniumConfig.load(deployed: deployed, example: example)
        }
    }

    @Test func noFileAtAll() {
        #expect(throws: ConfigError.missing) {
            try CraniumConfig.load(deployed: nil, example: nil)
        }
    }

    @Test(arguments: [
        ("consoleUrl", "http://console.secret-value.test"),
        ("consoleUrl", "https://console.secret-value.test/path"),
        ("consoleUrl", "https://console.secret-value.test?x=1"),
        ("loginDomain", "login.secret-value.test"),
        ("mobileClientId", ""),
        ("mobileClientId", "secret-value with spaces"),
        ("redirectUri", "cranium://secret-value"),
    ])
    func badValuesAreNamedButNeverRepeated(key: String, value: String) throws {
        var object: [String: String] = ["consoleUrl": "https://console.test", "loginDomain": "https://login.test",
                                        "mobileClientId": "abc123", "redirectUri": "cranium://signin"]
        object[key] = value
        do {
            _ = try CraniumConfig.parse(json(object))
            Issue.record("\(key) = \(value) was accepted")
        } catch let error as ConfigError {
            guard case .invalid(let named, _) = error else {
                Issue.record("unexpected \(error)")
                return
            }
            #expect(named == key)
            #expect(!(error.errorDescription ?? "").contains("secret-value"))
        }
    }

    // The live API's WebSocket (docs/live.md): optional, and when it is there exactly the stack's LiveUrl,
    // in the user pool's Region, since its origin goes into the pages' policy.

    let staff: [String: String] = ["consoleUrl": "https://console.test", "loginDomain": "https://login.test",
                                   "mobileClientId": "abc123", "redirectUri": "cranium://signin",
                                   "region": "us-east-1", "userPoolId": "us-east-1_Staff"]

    @Test func theLiveAPIIsTakenWhenItIsThereAndLeftOutWhenNot() throws {
        var object = staff
        #expect(try CraniumConfig.parse(json(object)).liveURL == nil)
        object["liveUrl"] = "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live"
        #expect(try CraniumConfig.parse(json(object)).liveURL?.absoluteString == "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live")
        let example = try CraniumConfig.load(deployed: nil, example: Self.configDir.appendingPathComponent("cranium.example.json"))
        #expect(example.config.liveURL != nil)
    }

    @Test(arguments: [
        "wss://secret-value.example.com/live",
        "ws://abc123def4.execute-api.us-east-1.amazonaws.com/live",
        "https://abc123def4.execute-api.us-east-1.amazonaws.com/live",
        "wss://abc123def4.execute-api.us-east-1.amazonaws.com",
        "wss://abc123def4.execute-api.us-east-1.amazonaws.com/",
        "wss://abc123def4.execute-api.eu-west-1.amazonaws.com/live",
        "wss://ABC123DEF4.execute-api.us-east-1.amazonaws.com/live",
        "wss://abc123def4x.execute-api.us-east-1.amazonaws.com/live",
        "wss://abc123def4.execute-api.us-east-1.amazonaws.com.secret-value.test/live",
        "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live/more",
        "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live?x=1",
        "wss://user@abc123def4.execute-api.us-east-1.amazonaws.com/live",
    ])
    func anyOtherLiveAddressIsAnErrorNamedButNeverRepeated(value: String) throws {
        var object = staff
        object["liveUrl"] = value
        do {
            _ = try CraniumConfig.parse(json(object))
            Issue.record("\(value) was accepted")
        } catch let error as ConfigError {
            #expect(error == .invalid(key: "liveUrl", reason: "is not the live API's address (wss://<id>.execute-api.<region>.amazonaws.com/<stage>)"))
            #expect(!(error.errorDescription ?? "").contains("secret-value"))
        }
    }

    @Test func aLiveAddressNeedsTheUserPoolsRegion() {
        var object: [String: String] = ["consoleUrl": "https://console.test", "loginDomain": "https://login.test",
                                        "mobileClientId": "abc123", "redirectUri": "cranium://signin"]
        object["liveUrl"] = "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live"
        #expect(throws: ConfigError.self) { try CraniumConfig.parse(json(object)) }
    }
}
