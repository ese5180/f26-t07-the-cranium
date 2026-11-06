package com.craniumiot.cranium.shell

import com.craniumiot.cranium.shell.ShellPolicy.Navigation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pages' policies, and where an address may go. */
class ShellPolicyTest {
    private val withCustomer = ShellConfig(
        consoleUrl = "https://console.example.com",
        region = "us-east-1",
        userPoolId = "us-east-1_EXAMPLE00",
        mobileClientId = "exampleclientid0000000000",
        customerApiUrl = "https://example.com",
        customerRegion = "us-east-1",
        customerUserPoolId = "us-east-1_EXAMPLE01",
        customerClientId = "examplecustomerclient0000",
        example = true,
    )
    private val adminOnly = withCustomer.copy(customerApiUrl = null, customerRegion = null, customerUserPoolId = null, customerClientId = null)

    @Test
    fun `the console's policy names the bundle, the two APIs and Cognito, once each`() {
        assertEquals(
            "default-src 'none'; script-src 'self' https://appassets.androidplatform.net; " +
                "style-src 'self' https://appassets.androidplatform.net; " +
                "img-src 'self' https://appassets.androidplatform.net data: https://tile.openstreetmap.org; " +
                "connect-src 'self' https://appassets.androidplatform.net https://console.example.com https://example.com " +
                "https://cognito-idp.us-east-1.amazonaws.com; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'",
            ShellPolicy.csp("console", withCustomer),
        )
    }

    @Test
    fun `the customer site's requires Trusted Types and shows no map`() {
        val policy = ShellPolicy.csp("customer", withCustomer)
        assertTrue(policy.endsWith("frame-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'"))
        assertTrue("img-src 'self' https://appassets.androidplatform.net data:;" in policy)
        assertFalse("openstreetmap" in policy)
    }

    @Test
    fun `no customer API, and a customer pool in another Region`() {
        assertTrue(
            "connect-src 'self' https://appassets.androidplatform.net https://console.example.com https://cognito-idp.us-east-1.amazonaws.com;" in
                ShellPolicy.csp("console", adminOnly),
        )
        val elsewhere = withCustomer.copy(customerRegion = "eu-west-1", customerApiUrl = "https://console.example.com/")
        assertTrue(
            "connect-src 'self' https://appassets.androidplatform.net https://console.example.com " +
                "https://cognito-idp.us-east-1.amazonaws.com https://cognito-idp.eu-west-1.amazonaws.com;" in
                ShellPolicy.csp("console", elsewhere),
        )
    }

    @Test
    fun `the live API is in both policies, its origin only, and only as the build's configuration has it`() {
        val live = withCustomer.copy(liveUrl = "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live")
        for (policy in listOf("console", "customer")) {
            val csp = ShellPolicy.csp(policy, live)
            assertTrue("https://cognito-idp.us-east-1.amazonaws.com wss://abc123def4.execute-api.us-east-1.amazonaws.com;" in csp)
            assertFalse("/live" in csp)
            val without = ShellPolicy.csp(policy, withCustomer)
            assertFalse("wss:" in without || "{live}" in without || "  " in without)
        }
        for (wrong in listOf(
            "wss://example.com/live",
            "ws://abc123def4.execute-api.us-east-1.amazonaws.com/live",
            "wss://abc123def4.execute-api.eu-west-1.amazonaws.com/live",
            "wss://ABC123DEF4.execute-api.us-east-1.amazonaws.com/live",
            "wss://abc123def4.execute-api.us-east-1.amazonaws.com",
            "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live/more",
            "wss://abc123def4.execute-api.us-east-1.amazonaws.com.example.com/live",
            "wss://user@abc123def4.execute-api.us-east-1.amazonaws.com/live",
        )) {
            assertNull(wrong, ShellPolicy.liveOrigin(wrong, "us-east-1"))
            assertFalse(wrong, "wss:" in ShellPolicy.csp("console", withCustomer.copy(liveUrl = wrong)))
        }
    }

    @Test
    fun `only the bundle's origin stays in the web view`() {
        assertEquals(Navigation.IN_APP, ShellPolicy.navigation("https://appassets.androidplatform.net/"))
        assertEquals(Navigation.IN_APP, ShellPolicy.navigation("https://appassets.androidplatform.net/admin#/devices"))
        assertEquals(Navigation.IN_APP, ShellPolicy.navigation("https://APPASSETS.androidplatform.net:443/admin"))
        // Not the bundle: another port, http, user info, a look-alike host.
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("https://appassets.androidplatform.net:8443/"))
        assertEquals(Navigation.DROP, ShellPolicy.navigation("http://appassets.androidplatform.net/"))
        assertEquals(Navigation.DROP, ShellPolicy.navigation("https://me@appassets.androidplatform.net/"))
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("https://appassets.androidplatform.net.example.com/"))
        // The console's own website goes to the browser, as does everything else of https.
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("https://console.example.com/"))
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("https://github.com/ese5180/f26-t07-the-cranium"))
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("sidestore://source?url=https://console.example.com/x"))
        assertEquals(Navigation.SYSTEM, ShellPolicy.navigation("otpauth://totp/Cranium:me@example.com?secret=ABCD&issuer=Cranium"))
        for (url in listOf("javascript:alert(1)", "data:text/html,hi", "file:///sdcard/x", "content://x/y", "intent://x#Intent;end",
            "mailto:a@example.com", "about:blank", "http://example.com/", "", "not a url", "https:///nohost")) {
            assertEquals(url, Navigation.DROP, ShellPolicy.navigation(url))
        }
    }

    @Test
    fun `app open takes an address for outside the app, never the bundle's`() {
        assertTrue(ShellPolicy.openable("https://example.com/a?b=c"))
        assertTrue(ShellPolicy.openable("sidestore://source?url=https%3A%2F%2Fconsole.example.com"))
        assertFalse(ShellPolicy.openable("https://appassets.androidplatform.net/admin"))
        assertFalse(ShellPolicy.openable("javascript:alert(1)"))
        assertFalse(ShellPolicy.openable("https://example.com/" + "a".repeat(4096)))
        assertFalse(ShellPolicy.openable(null))
    }

    @Test
    fun `origins, and where the web view starts`() {
        assertEquals("https://console.example.com", ShellPolicy.origin("https://console.example.com/path?x"))
        assertEquals("https://console.example.com:8443", ShellPolicy.origin("https://Console.Example.com:8443/"))
        assertEquals("https://console.example.com", ShellPolicy.origin("https://console.example.com:443"))
        assertNull(ShellPolicy.origin("sidestore://x"))
        assertNull(ShellPolicy.origin(null))
        assertEquals("https://appassets.androidplatform.net/", ShellPolicy.startUrl(hasCustomer = true))
        assertEquals("https://appassets.androidplatform.net/admin", ShellPolicy.startUrl(hasCustomer = false))
    }
}
