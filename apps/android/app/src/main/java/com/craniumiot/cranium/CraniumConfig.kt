package com.craniumiot.cranium

/**
 * The deployed stack's values, put into the build from apps/config/cranium.json (or the example
 * file, with [isExample] set). See docs/mobile-apps.md, "Configuration". Never logged.
 */
data class CraniumConfig(
    val consoleUrl: String,
    val loginDomain: String,
    val mobileClientId: String,
    val redirectUri: String,
    val isExample: Boolean,
) {
    companion object {
        fun fromBuild(): CraniumConfig = CraniumConfig(
            consoleUrl = BuildConfig.CONSOLE_URL,
            loginDomain = BuildConfig.LOGIN_DOMAIN,
            mobileClientId = BuildConfig.MOBILE_CLIENT_ID,
            redirectUri = BuildConfig.REDIRECT_URI,
            isExample = BuildConfig.EXAMPLE_CONFIG,
        )
    }
}
