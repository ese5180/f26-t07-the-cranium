import Foundation
import Testing
@testable import CraniumKit

/// Scan board's check of a board's QR code (BoardLink): only a board's page on this console is opened.
@Suite struct BoardLinkTests {
    static let console = URL(string: "https://console.example.test")!
    static let thing = "cranium-fe5b26c0c5b1dcd7"

    @Test func aBoardsLinkOnThisConsoleGivesItsThingName() {
        for text in ["https://console.example.test/#/devices/\(Self.thing)",
                     "https://console.example.test#/devices/\(Self.thing)",
                     "HTTPS://Console.Example.Test/#/devices/\(Self.thing)",
                     "https://console.example.test:443/#/devices/\(Self.thing)"] {
            #expect(BoardLink.thing(in: text, console: Self.console) == .success(Self.thing), "\(text)")
        }
        // A console with a trailing slash in the configuration, and the preview on this computer.
        #expect(BoardLink.thing(in: "https://console.example.test/#/devices/b1",
                                console: URL(string: "https://console.example.test/")!) == .success("b1"))
        #expect(BoardLink.thing(in: "http://127.0.0.1:8080/#/devices/b1",
                                console: URL(string: "http://127.0.0.1:8080")!) == .success("b1"))
        let longest = String(repeating: "x", count: 128)
        #expect(BoardLink.thing(in: "https://console.example.test/#/devices/\(longest)", console: Self.console) == .success(longest))
    }

    @Test func anotherOriginIsRefused() {
        for text in ["https://evil.example.test/#/devices/\(Self.thing)",
                     "https://console.example.test.evil.test/#/devices/\(Self.thing)",
                     "https://console.example.test:8443/#/devices/\(Self.thing)",
                     "http://console.example.test/#/devices/\(Self.thing)",
                     "https://user:pw@console.example.test/#/devices/\(Self.thing)",
                     "https://user@console.example.test/#/devices/\(Self.thing)",
                     "cranium-app://bundle/admin#/devices/\(Self.thing)"] {
            #expect(BoardLink.thing(in: text, console: Self.console) == .failure(.otherConsole), "\(text)")
        }
    }

    @Test func aPathQueryOrFragmentThatIsNotABoardsPageIsRefused() {
        for text in ["https://console.example.test/admin#/devices/\(Self.thing)",
                     "https://console.example.test/?next=x#/devices/\(Self.thing)",
                     "https://console.example.test/#/devices/\(Self.thing)/more",
                     "https://console.example.test/#/devices/",
                     "https://console.example.test/#/deployments/\(Self.thing)",
                     "https://console.example.test/#/devices/a%2Fb",
                     "https://console.example.test/#/devices/\(String(repeating: "x", count: 129))",
                     "https://console.example.test/"] {
            #expect(BoardLink.thing(in: text, console: Self.console) == .failure(.notABoard), "\(text)")
        }
    }

    @Test func whatIsNotALinkIsRefused() {
        for text in ["", "cranium-fe5b26c0c5b1dcd7", "WIFI:S:lab;T:WPA;P:secret;;", "mailto:a@b.test",
                     "https://console.example.test/#/devices/\(String(repeating: "x", count: 3000))"] {
            #expect(BoardLink.thing(in: text, console: Self.console) == .failure(.notALink), "\(text)")
        }
        // A configuration whose console a label never has: plain http elsewhere, a path, a user.
        for console in ["http://console.example.test", "https://console.example.test/admin", "https://u@console.example.test"] {
            #expect(BoardLink.thing(in: "\(console)/#/devices/b1", console: URL(string: console)!) == .failure(.notALink), "\(console)")
        }
        #expect(BoardLink.Refusal.otherConsole.message == "That code is for another console, so the app did not open it.")
    }
}
