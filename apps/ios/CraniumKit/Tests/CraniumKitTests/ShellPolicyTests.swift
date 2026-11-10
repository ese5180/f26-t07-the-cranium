import Foundation
import Testing
@testable import CraniumKit

/// What the shell's web view shows and sends: only the bundle, with its policy, and everything else outside.
@Suite struct ShellPolicyTests {
    static let pool = CognitoUserPool(id: "xx-test-1_Staff", region: "xx-test-1")!
    static let customerPool = CognitoUserPool(id: "xx-test-2_Customers", region: "xx-test-2")!
    static let config = CraniumConfig(
        consoleURL: URL(string: "https://console.test")!, loginDomain: URL(string: "https://login.test")!,
        mobileClientId: "client", userPool: pool,
        customer: CustomerConfig(apiURL: URL(string: "https://customer.test")!, clientId: "customer", pool: customerPool))

    @Test func theConsolesPolicy() throws {
        let csp = try #require(ShellPolicy.contentSecurityPolicy("console", config: Self.config))
        #expect(csp == "default-src 'none'; script-src 'self' cranium-app://bundle; style-src 'self' cranium-app://bundle; "
            + "img-src 'self' cranium-app://bundle data: https://tile.openstreetmap.org; "
            + "connect-src 'self' cranium-app://bundle https://console.test https://customer.test "
            + "https://cognito-idp.xx-test-1.amazonaws.com https://cognito-idp.xx-test-2.amazonaws.com; "
            + "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'")
        #expect(!csp.contains("{"))
        #expect(ShellPolicy.contentSecurityPolicy("none", config: Self.config) == nil)
    }

    @Test func theCustomerSitesPolicyAndOneWithoutTheCustomerPool() throws {
        let csp = try #require(ShellPolicy.contentSecurityPolicy("customer", config: Self.config))
        #expect(csp.hasSuffix("require-trusted-types-for 'script'; trusted-types 'none'"))
        #expect(!csp.contains("tile.openstreetmap.org"))
        let staffOnly = CraniumConfig(consoleURL: URL(string: "https://console.test:8443")!, loginDomain: URL(string: "https://login.test")!,
                                      mobileClientId: "client", userPool: Self.pool)
        let alone = try #require(ShellPolicy.contentSecurityPolicy("console", config: staffOnly))
        #expect(alone.contains("connect-src 'self' cranium-app://bundle https://console.test:8443 https://cognito-idp.xx-test-1.amazonaws.com;"))
        #expect(!alone.contains("  "))
        // One pool's Region once, and the customer API on the console's own name once.
        let same = CraniumConfig(consoleURL: URL(string: "https://console.test")!, loginDomain: URL(string: "https://login.test")!,
                                 mobileClientId: "client", userPool: Self.pool,
                                 customer: CustomerConfig(apiURL: URL(string: "https://console.test")!, clientId: "c",
                                                          pool: CognitoUserPool(id: "xx-test-1_Customers", region: "xx-test-1")!))
        let shared = try #require(ShellPolicy.contentSecurityPolicy("customer", config: same))
        #expect(shared.components(separatedBy: "https://console.test").count == 2)
        #expect(shared.components(separatedBy: "cognito-idp").count == 2)
    }

    @Test func theLiveAPIIsInBothPoliciesOnlyFromTheAppsOwnConfiguration() throws {
        let live = URL(string: "wss://abc123def4.execute-api.xx-test-1.amazonaws.com/live")!
        let withLive = CraniumConfig(consoleURL: Self.config.consoleURL, loginDomain: Self.config.loginDomain,
                                     mobileClientId: "client", userPool: Self.pool, customer: Self.config.customer, liveURL: live)
        for policy in ["console", "customer"] {
            let csp = try #require(ShellPolicy.contentSecurityPolicy(policy, config: withLive))
            // Its origin, after the user pools': never its path.
            #expect(csp.contains("https://cognito-idp.xx-test-2.amazonaws.com wss://abc123def4.execute-api.xx-test-1.amazonaws.com;"))
            #expect(!csp.contains("/live"))
            // Without it, nothing is left where it would be.
            let without = try #require(ShellPolicy.contentSecurityPolicy(policy, config: Self.config))
            #expect(!without.contains("wss:") && !without.contains("{live}") && !without.contains("  "))
        }
    }

    @Test func theSerialPagesAreNotShown() throws {
        for address in ["/admin#/serial", "/admin#/setup", "/admin#/setup/", "/admin#/serial?x=1"] {
            let url = try #require(URL(string: "\(ShellPolicy.origin)\(address)"))
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == .drop, "\(address)")
        }
        for address in ["/admin#/history", "/admin#/serials", "/admin#/devices/setup", "/admin", "/"] {
            let url = try #require(URL(string: "\(ShellPolicy.origin)\(address)"))
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == .allow, "\(address)")
        }
    }

    @Test func onlyTheBundleIsShown() {
        let bundle = URL(string: "cranium-app://bundle/admin#/devices")!
        #expect(ShellPolicy.navigation(to: bundle, mainFrame: true, newWindow: false) == .allow)
        // Its own pages in an iframe, or a window of their own: not.
        #expect(ShellPolicy.navigation(to: bundle, mainFrame: false, newWindow: false) == .drop)
        #expect(ShellPolicy.navigation(to: bundle, mainFrame: true, newWindow: true) == .drop)
        // The console's own website, an S3 link, GitHub: the system browser.
        for address in ["https://console.test/", "https://bucket.s3.amazonaws.com/x?X-Amz-Signature=1", "https://github.com/x"] {
            let url = URL(string: address)!
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == .openOutside(url), "\(address)")
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: true) == .openOutside(url), "\(address)")
        }
        // SideStore, with this console's source, and an authenticator app.
        let source = URL(string: "sidestore://source?url=https%3A%2F%2Fconsole.test%2Fapi%2Fsidestore%2F\(Self.key)%2Fsource.json")!
        #expect(ShellPolicy.navigation(to: source, mainFrame: true, newWindow: false, console: Self.config.consoleURL) == .openOutside(source))
        // Not without knowing the console.
        #expect(ShellPolicy.navigation(to: source, mainFrame: true, newWindow: false) == .drop)
        let otp = URL(string: "otpauth://totp/Cranium:me?secret=ABC&issuer=Cranium")!
        #expect(ShellPolicy.navigation(to: otp, mainFrame: true, newWindow: true) == .openOutside(otp))
        // Nothing else, and nothing at all in an iframe.
        for address in ["http://console.test/", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "about:blank",
                        "tel:123", "cranium-app://other/", "cranium-app://bundle:8080/", "https://user:pw@console.test/"] {
            let url = URL(string: address)!
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == .drop, "\(address)")
        }
        #expect(ShellPolicy.navigation(to: URL(string: "https://console.test/")!, mainFrame: false, newWindow: false) == .drop)
    }

    @Test func whatAppOpenTakes() {
        #expect(ShellPolicy.mayOpenOutside(URL(string: "https://docs.sidestore.io/docs/installation/prerequisites")!))
        #expect(!ShellPolicy.mayOpenOutside(URL(string: "https:///nohost")!))
        #expect(!ShellPolicy.mayOpenOutside(URL(string: "itms-services://?action=download-manifest")!))
        #expect(!ShellPolicy.mayOpenOutside(URL(string: "mailto:x@example.org")!))
    }

    static let key = "crs_" + String(repeating: "A", count: 43)
    static let s3 = "https://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/ios/cranium-ios-0.8.10.ipa?versionId=v1&X-Amz-Signature=abc"

    static func sidestore(_ host: String, _ inner: String) -> URL {
        URL(string: "sidestore://\(host)?url=\(inner.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")!
    }

    /// SideStore's two forms, for this console, and nothing else of SideStore's.
    @Test func exactlyTheSideStoreLinksAllowed() {
        let console = Self.config.consoleURL
        let allowed = [
            Self.sidestore("source", "https://console.test/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("install", Self.s3),
            Self.sidestore("install", "https://console.test/api/sidestore/\(Self.key)/cranium-ios-0.8.10.ipa"),
            // The scheme and host in capitals, and an unencoded inner link, are the same address.
            URL(string: "SIDESTORE://Source?url=https://console.test/api/sidestore/\(Self.key)/source.json")!,
        ]
        for url in allowed {
            #expect(ShellPolicy.mayOpenOutside(url, console: console), "\(url)")
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: true, console: console) == .openOutside(url), "\(url)")
            // Without the console, no SideStore address at all.
            #expect(!ShellPolicy.mayOpenOutside(url), "\(url)")
        }
        var refused = [
            // SideStore's other hosts: a pairing file or a signing certificate sent elsewhere.
            "sidestore://pairing?urlname=https://evil.test/x",
            "sidestore://certificate?callback_template=https://evil.test/$(BASE64_CERT)",
            "sidestore://appbackupresponse/success",
            "sidestore://source", "sidestore://install", "sidestore://",
            "sidestore://source?url=x",
        ].map { URL(string: $0)! }
        refused += [
            // Another console's source, or this console's over http, a port, a user, another path.
            Self.sidestore("source", "https://evil.test/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("source", "http://console.test/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("source", "https://console.test:8443/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("source", "https://me@console.test/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("source", "https://console.test/api/sidestore/crs_short/source.json"),
            Self.sidestore("source", "https://console.test/api/sidestore/\(Self.key)/source.json?token=x"),
            Self.sidestore("source", "https://console.test/api/apps"),
            // An IPA anywhere else: another host, not signed, another object, http, the source as an IPA.
            Self.sidestore("install", "https://evil.test/apps/ios/cranium-ios-0.8.10.ipa?X-Amz-Signature=abc"),
            Self.sidestore("install", "https://evil.s3.us-east-1.amazonaws.com.evil.test/apps/ios/cranium-ios-0.8.10.ipa?X-Amz-Signature=abc"),
            Self.sidestore("install", "https://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/ios/cranium-ios-0.8.10.ipa"),
            Self.sidestore("install", "https://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/android/cranium-0.8.10.apk?X-Amz-Signature=abc"),
            Self.sidestore("install", "http://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/ios/cranium-ios-0.8.10.ipa?X-Amz-Signature=abc"),
            Self.sidestore("install", "https://console.test/api/sidestore/\(Self.key)/source.json"),
            Self.sidestore("install", "https://console.test/api/apps/ios/0.8.10/download"),
        ]
        // Two url items, another item, a path, a fragment.
        refused += [
            URL(string: Self.sidestore("install", Self.s3).absoluteString + "&url=https%3A%2F%2Fevil.test%2Fx.ipa")!,
            URL(string: Self.sidestore("install", Self.s3).absoluteString + "&x=1")!,
            URL(string: Self.sidestore("install", Self.s3).absoluteString.replacingOccurrences(of: "install?", with: "install/x?"))!,
            URL(string: Self.sidestore("install", Self.s3).absoluteString + "#x")!,
        ]
        for url in refused {
            #expect(!ShellPolicy.mayOpenOutside(url, console: console), "\(url)")
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false, console: console) == .drop, "\(url)")
        }
    }

    @Test func whereItStartsAndHowAPathIsRead() {
        #expect(ShellPolicy.startURL(config: Self.config).absoluteString == "cranium-app://bundle/")
        let staffOnly = CraniumConfig(consoleURL: URL(string: "https://console.test")!, loginDomain: URL(string: "https://login.test")!,
                                      mobileClientId: "client", userPool: Self.pool)
        #expect(ShellPolicy.startURL(config: staffOnly).absoluteString == "cranium-app://bundle/admin")
        #expect(ShellPolicy.requestPath(URL(string: "cranium-app://bundle/assets/abc/app.js?x=1#y")!) == "/assets/abc/app.js")
        #expect(ShellPolicy.requestPath(URL(string: "cranium-app://bundle/assets/abc/app%2Ejs")!) == "/assets/abc/app%2Ejs")
        #expect(ShellPolicy.requestPath(URL(string: "cranium-app://bundle")!) == "/")
        #expect(ShellPolicy.isBundle(URL(string: "CRANIUM-APP://BUNDLE/")!))
    }

    @Test func theHeadersOfAPageAndOfAFile() throws {
        let page = try #require(ShellPolicy.headers(type: "text/html; charset=utf-8", policy: "console", config: Self.config))
        #expect(page["Cache-Control"] == "no-store")
        #expect(page["X-Content-Type-Options"] == "nosniff")
        #expect(page["Content-Security-Policy"]?.hasPrefix("default-src 'none'") == true)
        let file = try #require(ShellPolicy.headers(type: "text/javascript; charset=utf-8", policy: nil, config: Self.config))
        #expect(file["Content-Security-Policy"] == nil)
        #expect(file["Content-Type"] == "text/javascript; charset=utf-8")
        #expect(ShellPolicy.headers(type: "text/html", policy: "other", config: Self.config) == nil)
    }
}
