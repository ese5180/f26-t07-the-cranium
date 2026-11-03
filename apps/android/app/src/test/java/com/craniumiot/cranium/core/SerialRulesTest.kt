package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The serial console's rules: the firmware's limits in its own words, masking, and reading lines. */
class SerialRulesTest {
    private val mask = SerialRules.MASK

    // The fields, in the firmware's words.

    @Test
    fun `an id is 1 to 32 letters or digits`() {
        val wrong = "id must be 1-32 letters or digits"
        assertNull(SerialRules.check(SerialRules.Rule.ID, "CRVIHAAN01"))
        assertNull(SerialRules.check(SerialRules.Rule.ID, "A".repeat(32)))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.ID, ""))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.ID, "A".repeat(33)))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.ID, "bad-id"))
    }

    @Test
    fun `a network name is 1 to 32 bytes, without a bar or a control character`() {
        assertNull(SerialRules.check(SerialRules.Rule.SSID, "home network"))
        assertNull(SerialRules.check(SerialRules.Rule.SSID, "tab\there"))
        assertEquals("ssid must be 1-32 bytes", SerialRules.check(SerialRules.Rule.SSID, ""))
        assertEquals("ssid must be 1-32 bytes", SerialRules.check(SerialRules.Rule.SSID, "x".repeat(33)))
        // Counted in bytes, as the firmware counts them: 17 two-byte characters are 34 bytes.
        assertEquals("ssid must be 1-32 bytes", SerialRules.check(SerialRules.Rule.SSID, "é".repeat(17)))
        assertEquals("ssid cannot contain |", SerialRules.check(SerialRules.Rule.SSID, "home|net"))
        assertEquals("ssid cannot contain a control character", SerialRules.check(SerialRules.Rule.SSID, "home\u0001"))
    }

    @Test
    fun `a password is 8 to 63 characters, and an open network is refused`() {
        assertNull(SerialRules.check(SerialRules.Rule.PASSWORD, "correct horse"))
        assertNull(SerialRules.check(SerialRules.Rule.PASSWORD, "x".repeat(63)))
        assertEquals("open networks are not allowed", SerialRules.check(SerialRules.Rule.PASSWORD, ""))
        assertEquals("password must be 8-63 characters", SerialRules.check(SerialRules.Rule.PASSWORD, "1234567"))
        assertEquals("password must be 8-63 characters", SerialRules.check(SerialRules.Rule.PASSWORD, "x".repeat(64)))
        assertEquals("password cannot contain a control character", SerialRules.check(SerialRules.Rule.PASSWORD, "12345678\u0001"))
    }

    @Test
    fun `a server is a host name and nothing else`() {
        val wrong = "endpoint must be a host name of at most 127 letters, digits, dots and hyphens"
        assertNull(SerialRules.check(SerialRules.Rule.HOST, "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "https://a1b2-ats.iot.us-east-1.amazonaws.com"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "a1b2-ats.iot.us-east-1.amazonaws.com:8883"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "localhost"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, ".example.com"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "-example.com"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "example.com/path"))
        assertEquals(wrong, SerialRules.check(SerialRules.Rule.HOST, "a".repeat(124) + ".com"))
    }

    // Masking.

    @Test
    fun `a wifi password is masked, and the network name kept`() {
        assertEquals("WIFI|home|$mask", SerialRules.shownCommand("WIFI|home|correct horse"))
        assertEquals("wifi|home|$mask", SerialRules.shownCommand("wifi|home|correct horse"))
        assertEquals("WIFI_SEC|home|WPA3_SAE|$mask", SerialRules.shownCommand("WIFI_SEC|home|WPA3_SAE|correct horse"))
        assertEquals("WIFI_SEC|home|wpa2_psk|$mask", SerialRules.shownCommand("WIFI_SEC|home|wpa2_psk|pass|word"))
    }

    @Test
    fun `fields that may not be what they should be are masked as well`() {
        // A password can hold a bar: with no valid security mode, where it starts cannot be told.
        assertEquals("WIFI_SEC|$mask", SerialRules.shownCommand("WIFI_SEC|home|pass|word|more"))
        assertEquals("WIFI|$mask", SerialRules.shownCommand("WIFI|onlyonefield"))
        assertEquals("WIFI_SEC|$mask", SerialRules.shownCommand("WIFI_SEC|home"))
    }

    @Test
    fun `a command without a bar is shown as it is, and other commands too`() {
        assertEquals("WIFI", SerialRules.shownCommand("WIFI"))
        assertEquals("GET_ID", SerialRules.shownCommand("  GET_ID  "))
        assertEquals("SET_ID|CR2", SerialRules.shownCommand("SET_ID|CR2"))
        assertEquals("MQTT_HOST|a.example.com", SerialRules.shownCommand("MQTT_HOST|a.example.com"))
    }

    @Test
    fun `of a name that is not a command only the name is shown, cut to 32`() {
        assertEquals("WIFFI|$mask", SerialRules.shownCommand("WIFFI|home|correct horse"))
        assertEquals("X".repeat(32), SerialRules.shownCommand("X".repeat(40)))
        assertEquals("${"Y".repeat(32)}|$mask", SerialRules.shownCommand("Y".repeat(40) + "|secret"))
    }

    @Test
    fun `a line holds a secret once a wifi command has a bar`() {
        assertTrue(SerialRules.holdsSecret("WIFI|"))
        assertTrue(SerialRules.holdsSecret("wifi_sec|home"))
        assertTrue(SerialRules.holdsSecret(" WIFI |home|pw"))
        assertFalse(SerialRules.holdsSecret("WIFI"))
        assertFalse(SerialRules.holdsSecret("SET_ID|CR2"))
        assertFalse(SerialRules.holdsSecret("WIFIX|a"))
    }

    // The forms.

    private fun command(name: String) = SerialRules.command(name)!!

    @Test
    fun `a section left out is left off the line`() {
        val status = command("STATUS")
        assertEquals(SerialRules.Checked(emptyMap(), "STATUS"), SerialRules.checkCommand(status, mapOf("section" to "")))
        assertEquals("STATUS|wifi", SerialRules.checkCommand(status, mapOf("section" to "wifi")).line)
        assertEquals(
            mapOf("section" to "Section must be one of the choices"),
            SerialRules.checkCommand(status, mapOf("section" to "bogus")).errors,
        )
    }

    @Test
    fun `what erases the board needs its name typed`() {
        val init = command("INIT")
        assertEquals(mapOf("confirm" to "Type INIT to confirm"), SerialRules.checkCommand(init, mapOf("id" to "CR1")).errors)
        assertEquals(SerialRules.Checked(emptyMap(), "INIT|CR1"), SerialRules.checkCommand(init, mapOf("id" to "CR1", "confirm" to "INIT")))
        assertEquals(
            mapOf("confirm" to "Type FACTORY_RESET to confirm"),
            SerialRules.checkCommand(command("FACTORY_RESET"), mapOf("confirm" to "factory_reset")).errors,
        )
        assertEquals("FACTORY_RESET", SerialRules.checkCommand(command("FACTORY_RESET"), mapOf("confirm" to "FACTORY_RESET")).line)
    }

    @Test
    fun `each field is checked in the firmware's words`() {
        val wifi = command("WIFI")
        val checked = SerialRules.checkCommand(wifi, mapOf("ssid" to "home|x", "password" to "short"))
        assertEquals(
            mapOf("ssid" to "ssid cannot contain |", "password" to "password must be 8-63 characters"),
            checked.errors,
        )
        val sec = SerialRules.checkCommand(command("WIFI_SEC"), mapOf("ssid" to "home", "security" to "WEP", "password" to "correct horse"))
        assertEquals(mapOf("security" to "Security must be one of the choices"), sec.errors)
        assertEquals(
            "WIFI_SEC|home|WPA2_PSK|correct horse",
            SerialRules.checkCommand(command("WIFI_SEC"), mapOf("ssid" to "home", "security" to "WPA2_PSK", "password" to "correct horse")).line,
        )
        assertEquals("GET_ID", SerialRules.checkCommand(command("GET_ID"), emptyMap()).line)
    }

    @Test
    fun `a line longer than the firmware reads is refused on the first field`() {
        val long = SerialRules.Command("LONG", null, false, 1, 1, listOf(SerialRules.Field("text", "Text")))
        val checked = SerialRules.checkCommand(long, mapOf("text" to "x".repeat(400)))
        assertEquals(mapOf("text" to "line too long, the limit is 384 bytes"), checked.errors)
    }

    // The free command line.

    @Test
    fun `an empty line is nothing to send`() {
        assertEquals(SerialRules.Typed.Empty, SerialRules.checkTyped(""))
        assertEquals(SerialRules.Typed.Empty, SerialRules.checkTyped("   "))
    }

    @Test
    fun `a line too long or with a control character is refused`() {
        assertEquals(SerialRules.Typed.Refused("line too long, the limit is 384 bytes"), SerialRules.checkTyped("STATS|" + "x".repeat(380)))
        assertEquals(SerialRules.Typed.Refused("a line cannot hold a control character"), SerialRules.checkTyped("STATS\u0001"))
    }

    @Test
    fun `what erases the board goes through its form`() {
        assertEquals(
            SerialRules.Typed.Refused("INIT erases the board, so it asks for a typed confirmation: use its form on this page."),
            SerialRules.checkTyped("INIT|CR1"),
        )
        assertEquals(
            SerialRules.Typed.Refused("FACTORY_RESET erases the board, so it asks for a typed confirmation: use its form on this page."),
            SerialRules.checkTyped("factory_reset"),
        )
    }

    @Test
    fun `echo stays off`() {
        val refused = SerialRules.Typed.Refused(
            "Echo stays off on this page, so that the board does not send back what is typed. A plain serial monitor can turn it on.",
        )
        assertEquals(refused, SerialRules.checkTyped("ECHO|ON"))
        assertEquals(refused, SerialRules.checkTyped("echo| on "))
        assertEquals(SerialRules.Typed.Send("ECHO|OFF", keep = true), SerialRules.checkTyped("ECHO|OFF"))
    }

    @Test
    fun `only known commands without a password are kept for recall`() {
        assertEquals(SerialRules.Typed.Send("WIFI|home|correct horse", keep = false), SerialRules.checkTyped("WIFI|home|correct horse"))
        assertEquals(SerialRules.Typed.Send("STATS", keep = true), SerialRules.checkTyped("  STATS"))
        assertEquals(SerialRules.Typed.Send("?", keep = true), SerialRules.checkTyped("?"))
        assertEquals(SerialRules.Typed.Send("NOPE|x", keep = false), SerialRules.checkTyped("NOPE|x"))
    }

    // Reading what the board says.

    @Test
    fun `a tag line, with or without a level`() {
        assertEquals(SerialRules.Received.Tag("BT", "WRN", "passkey timed out"), SerialRules.classifyLine("[BT] WRN: passkey timed out"))
        assertEquals(SerialRules.Received.Tag("NET", "ERR", "no route"), SerialRules.classifyLine("[NET] ERR: no route"))
        assertEquals(SerialRules.Received.Tag("BOOT", null, "Cranium 1.11.4+0"), SerialRules.classifyLine("[BOOT] Cranium 1.11.4+0"))
        assertEquals(SerialRules.Received.Tag("TAG", null, "text"), SerialRules.classifyLine("[TAG]text"))
    }

    @Test
    fun `a final line, with or without its text`() {
        assertEquals(SerialRules.Received.Final(true, ""), SerialRules.classifyLine("OK"))
        assertEquals(SerialRules.Received.Final(true, "CRVIHAAN01|1.11.4+0"), SerialRules.classifyLine("OK CRVIHAAN01|1.11.4+0"))
        assertEquals(SerialRules.Received.Final(false, "unknown command"), SerialRules.classifyLine("ERR unknown command"))
        assertEquals(SerialRules.Received.Output("OKAY"), SerialRules.classifyLine("OKAY"))
    }

    @Test
    fun `escapes and unprintable characters are taken out, and a blank line is nothing`() {
        assertEquals(SerialRules.Received.Final(true, ""), SerialRules.classifyLine("\u001b[32mOK\u001b[0m"))
        assertEquals(SerialRules.Received.Output("state ok"), SerialRules.classifyLine("state\u0007 ok"))
        assertNull(SerialRules.classifyLine(""))
        assertNull(SerialRules.classifyLine("   "))
        assertNull(SerialRules.classifyLine("\u001b[2K"))
        assertEquals(SerialRules.Received.Output("[not a tag"), SerialRules.classifyLine("[not a tag"))
    }

    @Test
    fun `the answer to MQTT becomes facts, a repeated key one fact`() {
        val facts = SerialRules.mqttFacts(
            listOf(
                "state          connected",
                "endpoint       a1b2-ats.iot.us-east-1.amazonaws.com",
                "client id      cranium-0123456789abcdef",
                "subscribed     \$aws/things/x/jobs/notify-next",
                "subscribed     \$aws/things/x/shadow/update/delta",
                "rx bytes       1234",
                "a line that is not a key and a value",
            ),
        )
        assertEquals(listOf("state", "endpoint", "client id", "subscribed", "rx bytes"), facts.map { it.key })
        assertEquals(listOf("State", "Server", "Client ID", "Subscribed to", "rx bytes"), facts.map { it.label })
        assertEquals(
            listOf("\$aws/things/x/jobs/notify-next", "\$aws/things/x/shadow/update/delta"),
            facts.first { it.key == "subscribed" }.values,
        )
        assertEquals(listOf("cranium-0123456789abcdef"), facts.first { it.key == "client id" }.values)
    }

    @Test
    fun `a wifi command coming back is masked like one going out`() {
        assertEquals("wifi|home|$mask", SerialRules.shownOutput("wifi|home|correct horse"))
        assertEquals("WIFI_SEC|home|WPA2_PSK|$mask", SerialRules.shownOutput("> WIFI_SEC|home|WPA2_PSK|correct horse"))
        assertEquals("WIFI|$mask", SerialRules.shownOutput(">WIFI|x"))
        assertEquals("state          connected", SerialRules.shownOutput("state          connected"))
    }

    // Lines out of reads of any size.

    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

    @Test
    fun `a CRLF split over two reads ends one line`() {
        val reader = LineReader()
        assertEquals(listOf("OK"), reader.feed(bytes("OK\r")))
        assertEquals(listOf("next"), reader.feed(bytes("\nnext\r\n")))
    }

    @Test
    fun `a character split over two reads is put back together`() {
        val reader = LineReader()
        val text = bytes("café\n")
        assertEquals(emptyList<String>(), reader.feed(text.copyOfRange(0, 4)))
        assertEquals(listOf("café"), reader.feed(text.copyOfRange(4, text.size)))
    }

    @Test
    fun `CR alone and LF alone each end a line`() {
        assertEquals(listOf("a", "b"), LineReader().feed(bytes("a\rb\r")))
        assertEquals(listOf("a", "b", ""), LineReader().feed(bytes("a\nb\n\n")))
    }

    @Test
    fun `what is left at the end is a line of its own, once`() {
        val reader = LineReader()
        assertEquals(emptyList<String>(), reader.feed(bytes("partial")))
        assertEquals("partial", reader.flush())
        assertNull(reader.flush())
    }

    @Test
    fun `a line that never ends is cut at the limit`() {
        val reader = LineReader()
        val lines = reader.feed(bytes("x".repeat(SerialRules.PARTIAL_MAX + 10) + "\n"))
        assertEquals(2, lines.size)
        assertEquals(SerialRules.PARTIAL_MAX, lines[0].length)
        assertEquals("x".repeat(10), lines[1])
    }
}
