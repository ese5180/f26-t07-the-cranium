import XCTest

/// The Mac app's own logic beside CraniumKit's (whose tests, swift test, cover the Touch ID gate, the
/// live client, the lock's settings and the serial lines): the sidebar and the board windows.
final class SectionsTests: XCTestCase {
    func testTheSidebarHasTheConsolesPagesInOrder() {
        XCTAssertEqual(TeamSection.allCases.map(\.title),
                       ["Overview", "Boards", "Firmware", "Deployments", "Events", "Activity", "Bluetooth update", "Serial console", "Search", "API tokens", "History", "Scheduled deployments", "Weekly report", "Help"])
        XCTAssertEqual(TeamSection.Group.allCases.map(\.rawValue), ["Console", "In the room", "More"])
        XCTAssertEqual(TeamSection.serial.group, .inTheRoom)
    }

    func testAViewerHasNoBluetoothUpdate() {
        XCTAssertFalse(TeamSection.visible(canWrite: false).contains(.bluetooth))
        XCTAssertFalse(TeamSection.visible(canWrite: false).contains(.tokens))
        XCTAssertTrue(TeamSection.visible(canWrite: true).contains(.bluetooth))
        // Everything else is the same for both.
        XCTAssertEqual(TeamSection.visible(canWrite: false).count, TeamSection.allCases.count - 2)
    }

    func testEachSectionHasItsCommandNumber() {
        XCTAssertEqual(TeamSection.overview.shortcut, "1")
        XCTAssertEqual(TeamSection.serial.shortcut, "8")
        XCTAssertNil(TeamSection.help.shortcut)
        XCTAssertEqual(Set(TeamSection.allCases.compactMap(\.shortcut)).count, 9)
    }

    func testABoardWindowOpensOnlyForAThingName() {
        XCTAssertTrue(BoardWindowID.valid("cranium-0011223344556677"))
        XCTAssertFalse(BoardWindowID.valid("cranium-00112233"))
        XCTAssertFalse(BoardWindowID.valid("cranium-0011223344556677/../x"))
        XCTAssertFalse(BoardWindowID.valid("CRVIHAAN01"))
    }

    func testTheCustomerSideHasTheSitesSections() {
        XCTAssertEqual(CustomerSection.allCases.map(\.title), ["Your boards", "Activity", "Your listening", "Account", "Help"])
    }
}

final class WebPageTargetTests: XCTestCase {
    func testAPageIsTheHttpsAddressWithItsHashRoute() {
        let base = URL(string: "https://console.example.com/admin?x=1")!
        XCTAssertEqual(WebPageTarget.page(base, route: "#/reports")?.absoluteString, "https://console.example.com/admin#/reports")
        XCTAssertNil(WebPageTarget.page(URL(string: "http://console.example.com")!, route: "#/reports"))
        XCTAssertNil(WebPageTarget.page(base, route: "/reports"))
    }

    func testOnlyTheSameHostStays() {
        let home = URL(string: "https://console.example.com/")!
        XCTAssertTrue(WebPageTarget.stays(URL(string: "https://console.example.com/x")!, on: home))
        XCTAssertFalse(WebPageTarget.stays(URL(string: "https://other.example.com/")!, on: home))
        XCTAssertFalse(WebPageTarget.stays(URL(string: "http://console.example.com/")!, on: home))
    }
}
