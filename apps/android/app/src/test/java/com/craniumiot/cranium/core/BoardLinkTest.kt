package com.craniumiot.cranium.core

import com.craniumiot.cranium.core.BoardLink.Refusal
import com.craniumiot.cranium.core.BoardLink.Result
import org.junit.Assert.assertEquals
import org.junit.Test

/** Scan board's check of a board's QR code (BoardLink): only a board's page on this console is opened. */
class BoardLinkTest {
    private val console = "https://console.example.test"
    private val thing = "cranium-fe5b26c0c5b1dcd7"

    @Test
    fun `a board's link on this console gives its thing name`() {
        for (text in listOf(
            "https://console.example.test/#/devices/$thing",
            "https://console.example.test#/devices/$thing",
            "HTTPS://Console.Example.Test/#/devices/$thing",
            "https://console.example.test:443/#/devices/$thing",
        )) {
            assertEquals(text, Result.Board(thing), BoardLink.thing(text, console))
        }
        assertEquals(Result.Board("b1"), BoardLink.thing("https://console.example.test/#/devices/b1", "https://console.example.test/"))
        assertEquals(Result.Board("b1"), BoardLink.thing("http://127.0.0.1:8080/#/devices/b1", "http://127.0.0.1:8080"))
        val longest = "x".repeat(128)
        assertEquals(Result.Board(longest), BoardLink.thing("https://console.example.test/#/devices/$longest", console))
    }

    @Test
    fun `another origin is refused`() {
        for (text in listOf(
            "https://evil.example.test/#/devices/$thing",
            "https://console.example.test.evil.test/#/devices/$thing",
            "https://console.example.test:8443/#/devices/$thing",
            "http://console.example.test/#/devices/$thing",
            "https://user:pw@console.example.test/#/devices/$thing",
            "https://user@console.example.test/#/devices/$thing",
            "https://appassets.androidplatform.net/admin#/devices/$thing",
        )) {
            assertEquals(text, Result.Refused(Refusal.OTHER_CONSOLE), BoardLink.thing(text, console))
        }
    }

    @Test
    fun `a path, query or fragment that is not a board's page is refused`() {
        for (text in listOf(
            "https://console.example.test/admin#/devices/$thing",
            "https://console.example.test/?next=x#/devices/$thing",
            "https://console.example.test/#/devices/$thing/more",
            "https://console.example.test/#/devices/",
            "https://console.example.test/#/deployments/$thing",
            "https://console.example.test/#/devices/a%2Fb",
            "https://console.example.test/#/devices/${"x".repeat(129)}",
            "https://console.example.test/",
        )) {
            assertEquals(text, Result.Refused(Refusal.NOT_A_BOARD), BoardLink.thing(text, console))
        }
    }

    @Test
    fun `what is not a link is refused, and so is every code for a console a label never has`() {
        for (text in listOf(
            "",
            "cranium-fe5b26c0c5b1dcd7",
            "WIFI:S:lab;T:WPA;P:secret;;",
            "mailto:a@b.test",
            "https://console.example.test/#/devices/${"x".repeat(3000)}",
        )) {
            assertEquals(text, Result.Refused(Refusal.NOT_A_LINK), BoardLink.thing(text, console))
        }
        for (other in listOf("http://console.example.test", "https://console.example.test/admin", "https://u@console.example.test")) {
            assertEquals(other, Result.Refused(Refusal.NOT_A_LINK), BoardLink.thing("$other/#/devices/b1", other))
        }
        assertEquals("That code is for another console, so the app did not open it.", Refusal.OTHER_CONSOLE.message)
    }
}
