import AppKit
import CraniumKit
import SwiftUI
import WebKit

/// The Mac app's web view, the iPhone app's `ShellWebView` for a Mac (apps/shared/bridge.json "navigation").
/// It shows the bundle's origin, `cranium-app://bundle`, and nothing else: every file comes from the bundle
/// kept on the Mac through `MacBundleSchemeHandler`, never from the network, and any other address goes to
/// the browser or nowhere (`MacNavigation`). Only the main frame of that origin can reach the bridge.
struct MacWebView: NSViewRepresentable {
    @ObservedObject var model: MacShellModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> WKWebView {
        Self.make(model: model, coordinator: context.coordinator)
    }

    static func make(model: MacShellModel, coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(coordinator.schemes, forURLScheme: ShellPolicy.scheme)
        // Nothing of the page is kept on disk between runs: its sign-in is the app's (the bridge).
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(MacWeakMessageHandler(coordinator), contentWorld: .page, name: "cranium")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif
        coordinator.webView = webView
        model.webView = webView
        if let config = model.config {
            webView.load(URLRequest(url: ShellPolicy.startURL(config: config)))
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "cranium", contentWorld: .page)
        webView.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: MacShellModel
        let schemes: MacBundleSchemeHandler
        weak var webView: WKWebView?

        init(model: MacShellModel) {
            self.model = model
            self.schemes = MacBundleSchemeHandler(model: model)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // The main frame of the bundle's own origin, in this web view, and text: anything else is not heard.
            guard message.name == "cranium", message.frameInfo.isMainFrame, let webView, message.webView === webView else { return }
            let origin = message.frameInfo.securityOrigin
            guard origin.protocol == ShellPolicy.scheme, origin.host == ShellPolicy.host, origin.port == 0,
                  let text = message.body as? String else { return }
            model.host.receive(text)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else {
                decisionHandler(.cancel)
                return
            }
            switch MacNavigation.decide(url, mainFrame: action.targetFrame?.isMainFrame ?? false, newWindow: action.targetFrame == nil,
                                        console: model.config?.consoleURL) {
            case .load:
                decisionHandler(.allow)
            case .browser(let outside):
                decisionHandler(.cancel)
                NSWorkspace.shared.open(outside)
            case .drop:
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .cancel)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        /// `window.open`: never a second web view; the address goes to the browser if it may.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url,
               case .browser(let outside) = MacNavigation.decide(url, mainFrame: true, newWindow: true, console: model.config?.consoleURL) {
                NSWorkspace.shared.open(outside)
            }
            return nil
        }
    }
}

/// The page's messages without a strong reference back: WKUserContentController keeps its handlers.
final class MacWeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Answers `cranium-app://bundle/<path>` from the bundle on the Mac, as the iPhone app's handler does: a
/// route's page with its policy, or a file by its path, each with its type and no sniffing. The path is only
/// ever a key into the manifest; anything else is a 404.
@MainActor
final class MacBundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private weak var model: MacShellModel?

    init(model: MacShellModel) {
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

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
