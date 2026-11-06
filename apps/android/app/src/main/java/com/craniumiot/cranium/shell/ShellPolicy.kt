package com.craniumiot.cranium.shell

import com.craniumiot.cranium.CraniumConfig
import java.net.URI

/** The public configuration the pages get (app.config), from apps/config/cranium.json. */
data class ShellConfig(
    val consoleUrl: String,
    val region: String,
    val userPoolId: String,
    val mobileClientId: String,
    val customerApiUrl: String?,
    val customerRegion: String?,
    val customerUserPoolId: String?,
    val customerClientId: String?,
    val example: Boolean,
    /** The live API's WebSocket (docs/live.md), from the build's configuration; null without one, and the pages poll. */
    val liveUrl: String? = null,
) {
    val hasCustomer: Boolean get() = customerApiUrl != null && customerRegion != null && customerUserPoolId != null && customerClientId != null

    /** Never the values: the configuration is not to be printed. */
    override fun toString(): String = "ShellConfig(example=$example, hasCustomer=$hasCustomer)"

    companion object {
        fun of(config: CraniumConfig) = ShellConfig(
            consoleUrl = config.consoleUrl.trimEnd('/'),
            region = config.region,
            userPoolId = config.userPoolId,
            mobileClientId = config.mobileClientId,
            customerApiUrl = config.customerApiUrl.takeIf { config.hasCustomer }?.trimEnd('/'),
            customerRegion = config.customerRegion.takeIf { config.hasCustomer },
            customerUserPoolId = config.customerUserPoolId.takeIf { config.hasCustomer },
            customerClientId = config.customerClientId.takeIf { config.hasCustomer },
            example = config.isExample,
            liveUrl = config.liveUrl.takeIf { it.isNotEmpty() },
        )
    }
}

/**
 * What the shell lets the web view do (apps/shared/bridge.json, "policies" and "navigation"): the
 * Content-Security-Policy of each page of the bundle, which addresses stay in the web view (the
 * bundle's origin, and nothing else), and which go to the system instead.
 */
object ShellPolicy {
    const val ORIGIN = BridgeSpec.ORIGIN
    const val HOST = "appassets.androidplatform.net"

    /** bridge.json's templates, word for word (ShellPolicyTest compares them). */
    const val CONSOLE_TEMPLATE = "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; " +
        "img-src 'self' {self} data: https://tile.openstreetmap.org; connect-src 'self' {self} {console} {customer} {idp} {live}; " +
        "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"
    const val CUSTOMER_TEMPLATE = "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; " +
        "img-src 'self' {self} data:; connect-src 'self' {self} {console} {customer} {idp} {live}; " +
        "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; " +
        "require-trusted-types-for 'script'; trusted-types 'none'"

    /** Schemes that go to the system: the browser, SideStore, an authenticator app. */
    private val SYSTEM_SCHEMES = setOf("https", "sidestore", "otpauth")

    enum class Navigation { IN_APP, SYSTEM, DROP }

    /** `scheme://host[:port]` of an http(s) address, in lower case; null for anything else. */
    fun origin(url: String?): String? {
        val uri = parse(url) ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        val port = uri.port
        val default = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return if (port == -1 || default) "$scheme://$host" else "$scheme://$host:$port"
    }

    fun idpOrigin(region: String) = "https://cognito-idp.$region.amazonaws.com"

    /**
     * The origin of the live API's address, `wss://<id>.execute-api.<region>.amazonaws.com`, if [url] is
     * exactly what the stack's LiveUrl output is in [region] ([CraniumConfig.isLiveUrl]); null otherwise.
     * It comes from the build's configuration only, never from what a server says.
     */
    fun liveOrigin(url: String?, region: String): String? {
        if (url == null || !CraniumConfig.isLiveUrl(url, region)) return null
        return url.substring(0, url.indexOf('/', "wss://".length))
    }

    /** The policy of a page of the bundle, by its route's policy ("console" or "customer"). */
    fun csp(policy: String, config: ShellConfig): String {
        val template = if (policy == "customer") CUSTOMER_TEMPLATE else CONSOLE_TEMPLATE
        val idp = listOfNotNull(idpOrigin(config.region), config.customerRegion?.let(::idpOrigin)).distinct()
        val filled = template
            .replace("{self}", ORIGIN)
            .replace("{console}", origin(config.consoleUrl).orEmpty())
            .replace("{customer}", origin(config.customerApiUrl).orEmpty())
            .replace("{idp}", idp.joinToString(" "))
            .replace("{live}", liveOrigin(config.liveUrl, config.region).orEmpty())
        // Each source once, and no space left where a value was left out.
        return filled.split(";").joinToString("; ") { directive -> directive.trim().split(Regex("\\s+")).distinct().joinToString(" ") }
    }

    /** Where a main-frame navigation to [url] goes: the web view, the system, or nowhere. */
    fun navigation(url: String?): Navigation {
        val uri = parse(url) ?: return Navigation.DROP
        val scheme = uri.scheme?.lowercase() ?: return Navigation.DROP
        if (isBundle(uri)) return Navigation.IN_APP
        if (scheme !in SYSTEM_SCHEMES) return Navigation.DROP
        if (scheme == "https" && (uri.host.isNullOrEmpty() || uri.rawUserInfo != null)) return Navigation.DROP
        return Navigation.SYSTEM
    }

    /** Whether [url] is of the bundle's origin: https, the bundle's host, the default port, nobody's user info. */
    fun isBundle(url: String?): Boolean = parse(url)?.let(::isBundle) == true

    private fun isBundle(uri: URI): Boolean =
        uri.scheme?.lowercase() == "https" && uri.host?.lowercase() == HOST && (uri.port == -1 || uri.port == 443) && uri.rawUserInfo == null

    /** app.open: an https:, sidestore: or otpauth: address, outside the app. Never the bundle's own. */
    fun openable(url: String?): Boolean = url != null && url.length <= 4096 && navigation(url) == Navigation.SYSTEM

    /** Where the web view starts: the customer site when the configuration has the customer pool, else the console. */
    fun startUrl(hasCustomer: Boolean): String = if (hasCustomer) "$ORIGIN/" else "$ORIGIN/admin"

    private fun parse(url: String?): URI? {
        if (url.isNullOrEmpty() || url.length > 8192) return null
        return runCatching { URI(url) }.getOrNull()?.takeIf { it.isAbsolute }
    }
}
