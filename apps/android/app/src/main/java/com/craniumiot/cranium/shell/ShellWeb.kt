package com.craniumiot.cranium.shell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.craniumiot.cranium.BuildConfig
import java.io.ByteArrayInputStream

/** The name of the object the page talks to the app through (apps/shared/bridge.json, transport). */
const val BRIDGE_OBJECT = "craniumNative"

/** Whether this phone's WebView can run the shell: the bridge needs WebMessageListener (WebView 82 and later). */
fun shellSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

private fun response(served: Served): WebResourceResponse =
    WebResourceResponse(served.mimeType, served.encoding, served.status, served.reason, served.headers, ByteArrayInputStream(served.body))

/**
 * The web view of the new app. It shows the bundle's origin, https://appassets.androidplatform.net, and
 * nothing else: every request to that origin is answered from the launched bundle in memory (ShellServe),
 * never the network; a main-frame load of any other origin is stopped, and a link to one goes to the
 * system (ShellPolicy). No file or content access, no mixed content, no windows; JavaScript and DOM storage
 * on, which the pages need. The bridge's object is offered to the bundle's origin only.
 */
@SuppressLint("SetJavaScriptEnabled")
fun shellWebView(
    context: Context,
    vm: ShellViewModel,
    chooseFiles: (WebChromeClient.FileChooserParams, ValueCallback<Array<Uri>>) -> Unit,
): WebView {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    val loader = WebViewAssetLoader.Builder()
        .setDomain(ShellPolicy.HOST)
        .setHttpAllowed(false)
        .addPathHandler("/") { path -> response(ShellServe.serve(vm.launched, "/$path", vm.shellConfig)) }
        .build()
    val web = WebView(context)
    web.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(true)
        setGeolocationEnabled(false)
        mediaPlaybackRequiresUserGesture = true
        cacheMode = WebSettings.LOAD_NO_CACHE
    }
    // The pages follow the phone's light and dark themselves.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
    }
    WebViewCompat.addWebMessageListener(web, BRIDGE_OBJECT, setOf(ShellPolicy.ORIGIN)) { _, message, origin, isMainFrame, reply ->
        val text = message.data ?: return@addWebMessageListener
        vm.onMessage(text, origin.toString().trimEnd('/'), isMainFrame, reply)
    }
    web.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (ShellPolicy.isBundle(request.url.toString())) {
                return loader.shouldInterceptRequest(request.url) ?: response(ShellServe.notFound())
            }
            // The pages' own requests to the console and Cognito go out (the CSP names them); a page never does.
            return if (request.isForMainFrame) response(ShellServe.blocked()) else null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!request.isForMainFrame) return !ShellPolicy.isBundle(url)
            return when (ShellPolicy.navigation(url)) {
                ShellPolicy.Navigation.IN_APP -> false
                ShellPolicy.Navigation.SYSTEM -> {
                    vm.openOutside(url)
                    true
                }
                ShellPolicy.Navigation.DROP -> true
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            vm.pageStarted()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            vm.rendererGone()
            return true
        }
    }
    web.webChromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            chooseFiles(fileChooserParams, filePathCallback)
            return true
        }

        /**
         * A link with target=_blank: a web view of its own that loads nothing, only to learn the address,
         * which goes to the system if it may.
         */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val probe = WebView(view.context)
            probe.settings.javaScriptEnabled = false
            var done = false
            fun take(url: String) {
                if (done) return
                done = true
                if (ShellPolicy.navigation(url) == ShellPolicy.Navigation.SYSTEM) vm.openOutside(url)
                probe.post { probe.destroy() }
            }
            probe.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    take(request.url.toString())
                    return true
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val url = request.url.toString()
                    if (request.isForMainFrame) probe.post { take(url) }
                    return response(ShellServe.blocked())
                }
            }
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            transport.webView = probe
            resultMsg.sendToTarget()
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }
    web.setDownloadListener { url, _, _, _, _ ->
        if (ShellPolicy.navigation(url) == ShellPolicy.Navigation.SYSTEM) vm.openOutside(url)
    }
    vm.attach(web)
    web.loadUrl(ShellPolicy.startUrl(vm.shellConfig.hasCustomer))
    return web
}
