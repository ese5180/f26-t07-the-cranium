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
     * stack had the customer pool: then [hasCustomer] is false and the app has the admin sign-in only.
     */
    val customerApiUrl: String = "",
    val customerClientId: String = "",
    val customerRegion: String = "",
    val customerUserPoolId: String = "",
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
        )
    }
}
