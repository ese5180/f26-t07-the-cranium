import Foundation
import Testing
@testable import CraniumKit

@Suite struct ReleaseOfferTests {
    func entry(_ version: String, _ status: String = "active") -> FirmwareRelease {
        FirmwareRelease(version: version, size: 1, sha256: String(repeating: "a", count: 64), status: status)
    }

    var list: [FirmwareRelease] {
        [entry("1.7.0+0"), entry("1.9.0+0", "revoked"), entry("1.8.0+1"), entry("1.8.0+0"),
         entry("not a version"), entry("1.6.0+0")]
    }

    @Test func activeOnlyNewestFirst() {
        #expect(ReleaseOffer.active(list).map(\.version) == ["1.8.0+1", "1.8.0+0", "1.7.0+0", "1.6.0+0"])
    }

    @Test func theDefaultIsTheNewestActive() {
        #expect(ReleaseOffer.newest(list)?.version == "1.8.0+1")
        #expect(ReleaseOffer.newest([entry("2.0.0+0", "revoked")]) == nil)
    }

    @Test func onlyStrictlyNewerThanWhatRuns() {
        let running = FirmwareVersion(imageList: "1.8.0")!  // 1.8.0+0
        #expect(ReleaseOffer.newer(than: running, in: list).map(\.version) == ["1.8.0+1"])
        let newest = FirmwareVersion(release: "1.8.0+1")!
        #expect(ReleaseOffer.newer(than: newest, in: list).isEmpty)
    }

    @Test func revokedIsNeverOfferedEvenWhenNewer() {
        let running = FirmwareVersion(release: "1.0.0+0")!
        #expect(!ReleaseOffer.newer(than: running, in: list).map(\.version).contains("1.9.0+0"))
    }

    @Test func theEarlierChoiceIsKeptWhenStillOnOffer() {
        let offered = [entry("1.8.0+1"), entry("1.8.0+0")]
        #expect(ReleaseOffer.choice(keeping: "1.8.0+0", in: offered)?.version == "1.8.0+0")
        #expect(ReleaseOffer.choice(keeping: "1.7.0+0", in: offered)?.version == "1.8.0+1")
        #expect(ReleaseOffer.choice(keeping: nil, in: []) == nil)
    }
}
