import AppKit
import CraniumKit
import SwiftUI
import WebKit

struct ConsoleWebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(home: url) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let home: URL

        init(home: URL) {
            self.home = home
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if WebPageTarget.stays(url, on: home) || url.scheme == "about" { return decisionHandler(.allow) }
            decisionHandler(.cancel)
            if url.scheme == "https" { NSWorkspace.shared.open(url) }
        }
    }
}

/// A console page in a web view, for the team: scheduled deployments, the weekly report.
struct TeamWebPage: View {
    let route: String

    var body: some View {
        if let url = WebPageTarget.console(WebPageTarget.loaded, route: route) {
            ConsoleWebView(url: url)
        } else {
            PageState(kind: .empty, text: "This build has no console address, so the page cannot open.")
        }
    }
}

/// Your listening, on the customer site: the week on the decks, worked out by the site from the sessions.
struct CustomerListeningPage: View {

    var body: some View {
        if let url = WebPageTarget.customer(WebPageTarget.loaded, route: "#/mixes/listening") {
            ConsoleWebView(url: url)
        } else {
            PageState(kind: .empty, text: "Your listening needs the customer site, which this build is not set up for.")
        }
    }
}
