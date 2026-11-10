import CraniumKit
import XCTest

final class MacNavigationTests: XCTestCase {
    private let console = URL(string: "https://console.example.com")!

    private func decide(_ text: String, mainFrame: Bool = true, newWindow: Bool = false) -> MacNavigation.Decision {
        MacNavigation.decide(URL(string: text)!, mainFrame: mainFrame, newWindow: newWindow, console: console)
    }

    func testOnlyTheBundlesOwnOriginLoadsInTheView() {
        XCTAssertEqual(decide("cranium-app://bundle/"), .load)
        XCTAssertEqual(decide("cranium-app://bundle/admin#/boards"), .load)
        XCTAssertEqual(decide("cranium-app://other/"), .drop)
    }

    func testAnOutsideLinkOpensInTheBrowser() {
        XCTAssertEqual(decide("https://example.org/page"), .browser(URL(string: "https://example.org/page")!))
        XCTAssertEqual(decide("https://example.org/", newWindow: true), .browser(URL(string: "https://example.org/")!))
    }

    func testOtherSchemesAndFramesAreDropped() {
        XCTAssertEqual(decide("http://example.org/"), .drop)
        XCTAssertEqual(decide("file:///etc/hosts"), .drop)
        XCTAssertEqual(decide("cranium-app://bundle/", mainFrame: false), .drop)
    }

    func testTheSerialPagesLoadBecauseTheAppGivesThemAPort() {
        XCTAssertEqual(decide("cranium-app://bundle/admin#/serial"), .load)
        XCTAssertEqual(decide("cranium-app://bundle/admin#/setup/flash"), .load)
        XCTAssertEqual(decide("cranium-app://bundle/admin#/serial", mainFrame: false), .drop)
        XCTAssertEqual(decide("cranium-app://other/admin#/serial"), .drop)
    }
}
