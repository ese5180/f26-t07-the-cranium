import Testing
@testable import CraniumKit

@Suite struct FirmwareVersionTests {
    @Test func releaseForm() {
        let version = FirmwareVersion(release: "1.8.0+0")
        #expect(version == FirmwareVersion(major: 1, minor: 8, revision: 0, build: 0))
        #expect(version?.description == "1.8.0+0")
        #expect(FirmwareVersion(release: "255.255.65535+4294967295")?.build == 4_294_967_295)
    }

    @Test(arguments: ["1.8.0", "1.8+0", "1.8.0.0", "01.8.0+0", "1.8.0+", "+0", "1.8.0+01", "256.0.0+0",
                      "0.256.0+0", "0.0.65536+0", "1.8.0+4294967296", "1.8.0+-1", " 1.8.0+0", "1.8.0+0 ",
                      "1.8.0+0+0", "a.b.c+d", "", "１.8.0+0"])
    func releaseFormRefusesAnythingElse(_ text: String) {
        #expect(FirmwareVersion(release: text) == nil)
    }

    @Test func imageListForm() {
        // Zephyr's img_mgmt_ver_str(): "%hu.%hu.%hu", then ".%u" only when the build is not 0.
        #expect(FirmwareVersion(imageList: "1.8.0") == FirmwareVersion(release: "1.8.0+0"))
        #expect(FirmwareVersion(imageList: "1.8.0.5") == FirmwareVersion(release: "1.8.0+5"))
        #expect(FirmwareVersion(imageList: "1.8.0+5") == FirmwareVersion(release: "1.8.0+5"))
        for text in ["1.8", "1.8.0.0.0", "1.8.0.", "v1.8.0", "1.8.x", ""] {
            #expect(FirmwareVersion(imageList: text) == nil, "\(text)")
        }
    }

    @Test func orderComparesAllFourIncludingTheBuild() {
        func v(_ text: String) -> FirmwareVersion { FirmwareVersion(release: text)! }
        #expect(v("1.7.9+0") < v("1.8.0+0"))
        #expect(v("1.8.0+0") < v("1.8.0+1"))
        #expect(v("1.8.0+9") < v("1.8.1+0"))
        #expect(v("1.255.0+0") < v("2.0.0+0"))
        #expect(v("1.8.2+0") < v("1.8.10+0"))
        #expect(!(v("1.8.0+0") < v("1.8.0+0")))
    }
}
