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
}
