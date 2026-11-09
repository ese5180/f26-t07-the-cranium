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
    /** The user pool and its Region, for the app's own sign-in screen (SRP). */
    val region: String,
    val userPoolId: String,
    val isExample: Boolean,
    /**
     * The customer side (docs/mobile-apps.md, "Customers"): the customer API's address, the customer
     * pool's phone client, its Region and the pool. All empty for a configuration written before the
     * stack had the customer pool: then [hasCustomer] is false and the one sign-in takes team accounts only.
     */
    val customerApiUrl: String = "",
    val customerClientId: String = "",
    val customerRegion: String = "",
    val customerUserPoolId: String = "",
    /**
     * The live API's WebSocket (docs/live.md), `wss://<id>.execute-api.<region>.amazonaws.com/<stage>`.
     * Empty for a configuration written before console 2.4.0 had it: then the pages poll.
     */
    val liveUrl: String = "",
) {
    /** All four customer values are there: customers can sign in. The build takes all four or none. */
    val hasCustomer: Boolean
        get() = customerApiUrl.isNotEmpty() && customerClientId.isNotEmpty() && customerRegion.isNotEmpty() &&
            customerUserPoolId.isNotEmpty()

    /** Never the values: the configuration is not to be printed. */
    override fun toString(): String = "CraniumConfig(isExample=$isExample, hasCustomer=$hasCustomer)"

    companion object {
        fun fromBuild(): CraniumConfig = CraniumConfig(
            consoleUrl = BuildConfig.CONSOLE_URL,
            loginDomain = BuildConfig.LOGIN_DOMAIN,
            mobileClientId = BuildConfig.MOBILE_CLIENT_ID,
            redirectUri = BuildConfig.REDIRECT_URI,
            region = BuildConfig.REGION,
            userPoolId = BuildConfig.USER_POOL_ID,
            isExample = BuildConfig.EXAMPLE_CONFIG,
            customerApiUrl = BuildConfig.CUSTOMER_API_URL,
            customerClientId = BuildConfig.CUSTOMER_CLIENT_ID,
            customerRegion = BuildConfig.CUSTOMER_REGION,
            customerUserPoolId = BuildConfig.CUSTOMER_USER_POOL_ID,
            liveUrl = BuildConfig.LIVE_URL,
        )

        private val REGION = Regex("^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$")
        private val STAGE = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val API_ID = Regex("^[a-z0-9]{10}$")

        /**
         * Whether [url] is the live API's address in [region], as the stack's LiveUrl output is: `wss://`,
         * the API's ID (ten lower-case letters and digits), `.execute-api.<region>.amazonaws.com`, `/` and
         * a stage. The build checks the same; this keeps anything else out of the pages' policy all the same.
         */
        fun isLiveUrl(url: String, region: String): Boolean {
            if (!REGION.matches(region) || url.length > 300 || !url.startsWith("wss://")) return false
            val rest = url.removePrefix("wss://")
            val slash = rest.indexOf('/')
            if (slash < 0) return false
            val host = rest.substring(0, slash)
            val suffix = ".execute-api.$region.amazonaws.com"
            return host.endsWith(suffix) && API_ID.matches(host.removeSuffix(suffix)) && STAGE.matches(rest.substring(slash + 1))
        }
    }
}
