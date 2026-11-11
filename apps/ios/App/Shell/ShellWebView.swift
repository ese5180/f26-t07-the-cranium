import CraniumKit
import SwiftUI
import UIKit
import WebKit

/// The shell's web view (docs/mobile-apps.md, "The app shell"; apps/shared/bridge.json "navigation"). It
/// shows the bundle's origin, `cranium-app://bundle`, and nothing else: every file comes from the bundle on
/// the phone through `BundleSchemeHandler`, never from the network, and any other address goes to the system
/// or nowhere (`ShellPolicy.navigation`). Only the main frame of that origin can reach the bridge.
struct ShellWebView: UIViewRepresentable {
    @ObservedObject var model: ShellModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(context.coordinator.schemes, forURLScheme: ShellPolicy.scheme)
        // Nothing of the page is kept on disk between runs: its sign-in is the app's (the bridge).
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(WeakMessageHandler(context.coordinator), contentWorld: .page, name: "cranium")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "PagePaper") ?? .systemBackground
        webView.scrollView.backgroundColor = webView.backgroundColor
        // The page keeps clear of the Dynamic Island, the home indicator and the sides itself, with
        // env(safe-area-inset-*) (viewport-fit=cover): the scroll view adds no inset of its own, or there
        // would be two, and a sticky bar would stick under the island.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        context.coordinator.webView = webView
        model.webView = webView
        if let config = model.config {
            webView.load(URLRequest(url: ShellPolicy.startURL(config: config)))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "cranium", contentWorld: .page)
        webView.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: ShellModel
        let schemes: BundleSchemeHandler
        weak var webView: WKWebView?

        init(model: ShellModel) {
            self.model = model
            self.schemes = BundleSchemeHandler(model: model)
        }

        // MARK: The bridge

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // The main frame of the bundle's own origin, in this web view, and text: anything else is not heard.
            guard message.name == "cranium", message.frameInfo.isMainFrame, let webView, message.webView === webView else { return }
            let origin = message.frameInfo.securityOrigin
            guard origin.protocol == ShellPolicy.scheme, origin.host == ShellPolicy.host, origin.port == 0,
                  let text = message.body as? String else { return }
            model.host.receive(text)
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else {
                decisionHandler(.cancel)
                return
            }
            let newWindow = action.targetFrame == nil
            switch ShellPolicy.navigation(to: url, mainFrame: action.targetFrame?.isMainFrame ?? false, newWindow: newWindow,
                                                 console: model.config?.consoleURL) {
            case .allow:
                decisionHandler(.allow)
            case .openOutside(let outside):
                decisionHandler(.cancel)
                UIApplication.shared.open(outside)
            case .drop:
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            // A download or anything the web view cannot show is not kept.
            decisionHandler(response.canShowMIMEType ? .allow : .cancel)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: Windows

        /// `window.open`: never a second web view; the address goes to the system if it may.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, case .openOutside(let outside) = ShellPolicy.navigation(to: url, mainFrame: true,
                                                                                                      newWindow: true, console: model.config?.consoleURL) {
                UIApplication.shared.open(outside)
            }
            return nil
        }
    }
}

/// The page's messages without a strong reference back: WKUserContentController keeps its handlers.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Answers `cranium-app://bundle/<path>` from the bundle on the phone: a route's page with its policy, or a
/// file by its path, each with its type from the end of its path and no sniffing. The path is only ever a
/// key into the manifest (`BundleManifest.lookup`); nothing is decoded or joined to a folder. Anything else
/// is a 404.
@MainActor
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private weak var model: ShellModel?

    init(model: ShellModel) {
        self.model = model
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let method = task.request.httpMethod ?? "GET"
        if ShellPolicy.isBundle(url), method == "GET" || method == "HEAD", let model, let config = model.config,
           let served = model.bundle?.serve(ShellPolicy.requestPath(url)),
           let headers = ShellPolicy.headers(type: served.type, policy: served.policy, config: config),
           let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            task.didReceive(response)
            if method == "GET" { task.didReceive(served.data) }
            task.didFinish()
            return
        }
        let headers = ["Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"]
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(Data("Not found\n".utf8))
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Every answer is whole before start returns: nothing to stop.
    }
}
