import XCTest

/// The Mac app's own logic beside CraniumKit's (whose tests, swift test, cover the Touch ID gate, the
/// live client, the lock's settings and the serial lines): the sidebar and the board windows.
final class SectionsTests: XCTestCase {
    func testTheSidebarHasTheConsolesPagesInOrder() {
        XCTAssertEqual(TeamSection.allCases.map(\.title),
                       ["Overview", "Boards", "Firmware", "Deployments", "Events", "Activity", "Bluetooth update", "Serial console", "Search", "API tokens", "History", "Help"])
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
        XCTAssertEqual(CustomerSection.allCases.map(\.title), ["Your boards", "Activity", "Account", "Help"])
    }
}
