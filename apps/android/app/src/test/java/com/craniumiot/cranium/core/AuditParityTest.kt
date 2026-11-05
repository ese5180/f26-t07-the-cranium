package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The activity log in the website's words: the examples of cloud/web/test/core.test.mjs for
 * describeAudit, auditBoards and auditSentence, one for one. A test there is named in each comment.
 */
class AuditParityTest {
    private val thingOfTest = "cranium-fe5b26c0c5b1dcd7"
    private val deployment = "cranium-1-1-0-b7-20261010T221500Z-9f3a"
    private val tokenId = "0123456789abcdef"

    private fun entry(
        action: String,
        target: String,
        outcome: String = "ok",
        detail: List<Pair<String, String>> = emptyList(),
        actor: Person? = null,
        requestId: String = "",
    ) = AuditEntry("2026-10-10T12:00:00Z", actor, action, target, outcome, detail, requestId)

    private fun describe(action: String, target: String, outcome: String = "ok", detail: List<Pair<String, String>> = emptyList()) =
        AuditText.describe(entry(action, target, outcome, detail))

    /** core.test.mjs `said`: verb, label, tail and boards. */
    private fun said(line: AuditWords) =
        listOf(line.verb, line.label, line.tail, AuditText.boards(line)).filter { it.isNotEmpty() }.joinToString(" ")

    private fun facts(list: List<AuditFact>) = list.map { "${it.label}${if (it.phrase) "" else ":"} ${it.value}" }

    // "an entry of the activity log reads as a sentence and links only to what exists"
    @Test
    fun `an entry reads as a sentence and links only to what exists`() {
        val upload = describe("firmware.upload", "1.1.0+7")
        assertEquals(
            listOf("uploaded firmware", "1.1.0+7", "", "null", "[]", "false", "[]", "0", "false"),
            listOf(upload.verb, upload.label, upload.tail, upload.outcome.toString(), upload.facts.toString(), upload.scripted.toString(),
                upload.boards.toString(), upload.boardCount.toString(), upload.byName.toString()),
        )
        assertEquals(LogLink.ToFirmware, upload.link)
        assertTrue(AuditText.describe(entry("firmware.revoke", "1.1.0+7", requestId = "bench-0123")).scripted)
        assertFalse(AuditText.describe(entry("firmware.revoke", "1.1.0+7", requestId = "LvC5hbench-=")).scripted)
        assertEquals("revoked firmware 1.1.0+7", said(describe("firmware.revoke", "1.1.0+7")))

        val started = describe("deployment.create", deployment, detail = listOf("version" to "1.1.0+7", "things" to "2"))
        assertEquals("deployed 1.1.0+7 to 2 boards", said(started))
        assertEquals(LogLink.ToDeployment(deployment), started.link)
        assertEquals(listOf(Triple("Deployment", deployment, true)), started.facts.map { Triple(it.label, it.value, it.code) })
        assertEquals("cancelled the deployment of 1.1.0+7", said(describe("deployment.cancel", deployment)))
        assertEquals("tried to cancel the deployment of 1.1.0+7", said(describe("deployment.cancel", deployment, "rejected")))
        assertEquals("tried to deploy 1.1.0+7", said(describe("deployment.create", "1.1.0+7", "rejected")))
        assertEquals("tried to deploy 1.1.0+7", said(describe("deployment.create", deployment, "rejected")))
        assertEquals("deployed 1.1.0+7", said(describe("deployment.create", deployment)))
        val odd = "cranium-999-0-0-b1-20261010T221500Z-ffff"
        assertEquals(odd, describe("deployment.cancel", odd).label)
        assertEquals("tried to cancel a deployment", said(describe("deployment.cancel", "", "rejected")))
        assertEquals("started a deployment", said(describe("deployment.create", "")))
        assertEquals("tried to start a deployment", said(describe("deployment.create", "", "rejected")))
        assertEquals("tried to upload a file", said(describe("firmware.upload", "", "rejected")))
        assertEquals("tried to revoke a release", said(describe("firmware.revoke", "", "denied")))

        val refused = describe("firmware.upload", "zephyr.signed.bin", "rejected")
        assertNull(refused.link)
        assertEquals("tried to upload zephyr.signed.bin", said(refused))
        assertEquals("Refused", refused.outcome?.label)
        assertEquals("Not allowed", describe("deployment.create", "1.1.0+7", "denied").outcome?.label)
        assertEquals("Server error", describe("deployment.create", "1.1.0+7", "error").outcome?.label)
        assertNull(describe("something.new", "javascript:alert(1)", "odd").link)
        assertEquals("something.new", describe("something.new", "x", "odd").verb)
        assertEquals(StateWords(Tone.IDLE, Glyph.MINUS, "odd"), describe("odd", "odd", "odd").outcome)
    }

    // "the details of an entry are put in the words of the console, not in the API's field names"
    @Test
    fun `the details are in the words of the console`() {
        fun list(action: String, outcome: String, detail: List<Pair<String, String>>) = describe(action, "1.1.0+7", outcome, detail).facts
        val digest = "ab".repeat(32)
        val upload = list("firmware.upload", "rejected", listOf("sha256" to digest, "size" to "1264", "filename" to "zephyr.signed.bin", "code" to "wrong_key"))
        assertEquals(listOf("Refused with wrong_key", "File zephyr.signed.bin", "Size 1,264 bytes", "SHA-256 $digest"), facts(upload))
        assertEquals(listOf(true, true, false, true), upload.map { it.code })
        assertEquals("Signed with a different key than this project’s", upload[0].words)
        assertNull(list("firmware.upload", "rejected", listOf("code" to "something_new"))[0].words)
        assertEquals(emptyList<AuditFact>(), AuditText.describe(entry("firmware.upload", "x.bin", "rejected", listOf("filename" to "x.bin"))).facts)

        val reason = "Pads stop responding after a few minutes of use."
        val revoke = list("firmware.revoke", "ok", listOf("reason" to reason, "cancelled" to "1"))
        assertEquals(listOf("Reason: $reason", "Deployments cancelled 1"), facts(revoke))
        assertFalse(revoke[0].code)
        assertEquals(listOf("Asked to withdraw the offer and stop boards that had started"), facts(list("deployment.cancel", "ok", listOf("force" to "true"))))
        assertEquals(
            listOf("Failed with internal", "Asked to withdraw the offer", "Cancelled all the same"),
            facts(list("deployment.cancel", "error", listOf("force" to "false", "cancelled" to "true", "code" to "internal"))),
        )
        assertEquals(
            listOf("Refused with device_busy"),
            facts(list("deployment.create", "rejected", listOf("version" to "1.1.0+7", "things" to "2", "code" to "device_busy"))),
        )
        assertEquals(listOf("Version 9.9.9+9"), facts(list("deployment.create", "ok", listOf("version" to "9.9.9+9"))))
        assertEquals(
            listOf(
                "Failed with revoke_incomplete",
                "Left undone: refusing the image, cancelling the deployments, recording that it is done",
                "Reason: A fault.", "Deployments cancelled 0",
            ),
            facts(
                list(
                    "firmware.revoke", "error",
                    listOf("reason" to "A fault.", "cancelled" to "0", "incomplete" to "tag cancel record", "code" to "revoke_incomplete"),
                ),
            ),
        )
        assertEquals(listOf("Left undone: a_new_step"), facts(list("firmware.revoke", "error", listOf("incomplete" to "a_new_step"))))
        val finished = describe("firmware.revoke", "1.1.0+7", detail = listOf("cancelled" to "1", "resumed" to "true"))
        assertEquals("finished revoking firmware", finished.verb)
        assertEquals(listOf("Deployments cancelled 1"), facts(finished.facts))
        assertEquals(
            listOf("Size unknown", "somethingNew: x", "constructor: y"),
            facts(list("firmware.upload", "ok", listOf("somethingNew" to "x", "size" to "unknown", "constructor" to "y"))),
        )
    }

    // "the check before a Bluetooth send reads as what it was, with its board and why it was refused"
    @Test
    fun `the check before a Bluetooth send`() {
        fun line(words: AuditWords) = listOf(words.verb, words.label, words.tail).filter { it.isNotEmpty() }.joinToString(" ")
        val sha = "ab".repeat(32)
        val cleared = describe("firmware.bluetooth_send", "1.1.0+7", detail = listOf("sha256" to sha, "board" to "Cranium-1A2B"))
        assertEquals(listOf("CHIP", "was cleared to send 1.1.0+7 over Bluetooth"), listOf(cleared.glyph.name, line(cleared)))
        assertEquals(LogLink.ToFirmware, cleared.link)
        assertEquals(listOf(Triple("SHA-256", sha, true), Triple("To board", "Cranium-1A2B", true)), cleared.facts.map { Triple(it.label, it.value, it.code) })
        val refused = describe("firmware.bluetooth_send", "1.1.0+7", "rejected", listOf("code" to "release_revoked", "sha256" to sha))
        assertEquals("tried to send 1.1.0+7 over Bluetooth", line(refused))
        assertEquals("The release is revoked", refused.facts[0].words)
        assertEquals("tried to send firmware over Bluetooth", line(describe("firmware.bluetooth_send", "", "rejected", listOf("code" to "invalid_version"))))
        assertEquals(
            "The phone’s image is not the release’s",
            describe("firmware.bluetooth_send", "1.1.0+7", "rejected", listOf("code" to "sha256_mismatch")).facts[0].words,
        )
        assertEquals(
            "The phone app’s sign-in cannot be used for that",
            describe("deployment.create", "1.1.0+7", "denied", listOf("code" to "phone_not_allowed")).facts[0].words,
        )
    }

    // "a deployment says which boards it went to, by the name each has now, and a download reads as one"
    @Test
    fun `a deployment says which boards it went to, by the name each has now`() {
        val a = "cranium-0123456789abcdef"
        val b = "cranium-fedcba9876543210"
        val c = "cranium-00000000000000aa"
        val devices = listOf(Device(thing = a, name = "CRVIHAAN01"), Device(thing = b, name = null))
        val vihaan = Person("s", "vihaan@example.invalid")
        fun deployed(boards: List<String>, things: String = boards.size.toString()) = entry(
            "deployment.create", deployment, "ok",
            listOf("version" to "1.1.0+7", "things" to things) + (if (boards.isNotEmpty()) listOf("boards" to boards.joinToString(" ")) else emptyList()),
            actor = vihaan,
        )
        assertEquals("vihaan@example.invalid deployed 1.1.0+7 to CRVIHAAN01", AuditText.sentence(deployed(listOf(a)), devices))
        assertEquals("vihaan@example.invalid deployed 1.1.0+7 to CRVIHAAN01 and $b", AuditText.sentence(deployed(listOf(a, b)), devices))
        val three = AuditText.describe(deployed(listOf(a, b, c)))
        assertEquals("vihaan@example.invalid deployed 1.1.0+7 to 3 boards", AuditText.sentence(deployed(listOf(a, b, c)), devices))
        assertEquals(listOf("boards" to "$a $b $c", "target" to deployment), three.facts.map { it.key to it.value })
        assertEquals("vihaan@example.invalid deployed 1.1.0+7 to 12 boards", AuditText.sentence(deployed(emptyList(), "12"), devices))
        assertEquals("", AuditText.boards(AuditText.describe(deployed(emptyList(), "x"))))
        assertEquals(emptyList<String>(), AuditText.describe(deployed(listOf("CRVIHAAN01"))).boards)

        val download = entry("firmware.download", "1.1.0+7", actor = Person("", "a@b"))
        assertEquals("a@b downloaded 1.1.0+7 to a phone", AuditText.sentence(download))
        assertEquals("a@b downloaded firmware to a phone", AuditText.sentence(download.copy(target = "")))
        assertEquals("a@b tried to download 1.1.0+7", AuditText.sentence(download.copy(outcome = "denied")))
        val fromPhone = AuditText.describe(deployed(listOf(a)).copy(detail = listOf("things" to "1", "boards" to a, "from" to "phone")))
        assertEquals(listOf("From" to "the phone app", "Deployment" to deployment), fromPhone.facts.map { it.label to it.value })
    }

    // "a sign-in says where it was made, and nothing more"
    @Test
    fun `a sign-in says where it was made, and nothing more`() {
        fun signIn(client: String) = entry(
            "account.sign_in", "", "ok", listOf("client" to client), Person("s", "vihaan@example.invalid"), "signin.s.$client.1793700000",
        )
        assertEquals("vihaan@example.invalid signed in on the website", AuditText.sentence(signIn("web")))
        assertEquals("vihaan@example.invalid signed in on the phone app", AuditText.sentence(signIn("phone")))
        assertEquals("vihaan@example.invalid signed in", AuditText.sentence(signIn("tv")))
        val line = AuditText.describe(signIn("web"))
        assertEquals(listOf("USER", "", "[]", "null", "false"), listOf(line.glyph.name, line.label, line.facts.toString(), line.link.toString(), line.scripted.toString()))
    }

    // "a command at a board's serial console reads as what it did, to which board, never with a value"
    @Test
    fun `a command at a board's serial console reads as what it did, to which board`() {
        fun command(name: String, device: String = "CRVIHAAN01", outcome: String = "ok", extra: List<Pair<String, String>> = emptyList()) =
            entry("serial.command", device, outcome, listOf("command" to name, "version" to "1.12.0+0") + extra, Person("", "a@b"))
        assertEquals("a@b set the Wi-Fi network of CRVIHAAN01 over USB", AuditText.sentence(command("WIFI")))
        assertEquals("a@b changed the device ID of CRVIHAAN01 over USB", AuditText.sentence(command("SET_ID")))
        assertEquals("a@b set up a board from factory mode over USB", AuditText.sentence(command("INIT", "")))
        assertEquals("a@b restarted CRVIHAAN01 into its bootloader over USB", AuditText.sentence(command("ENTER_BOOTLOADER")))
        assertEquals("a@b ran a command on CRVIHAAN01 over USB", AuditText.sentence(command("NEWER_ONE")))
        assertEquals(
            "a@b tried to put on record a command on CRVIHAAN01 over USB",
            AuditText.sentence(command("WIFI", "CRVIHAAN01", "rejected", listOf("code" to "unexpected_field"))),
        )
        assertEquals("a@b tried to put on record a command run over USB", AuditText.sentence(command("WIFI", "", "denied")))
        for (name in SerialRules.RECORDED) assertTrue(name, AuditText.SERIAL_WORDS.getValue(name).contains("{}"))
        val line = AuditText.describe(command("WIFI", "CRVIHAAN01", "ok", listOf("from" to "phone")))
        assertTrue(line.byName)
        assertEquals(
            listOf(Triple("Running", "1.12.0+0", true), Triple("Command", "WIFI", true), Triple("From", "the phone app", false)),
            line.facts.map { Triple(it.label, it.value, it.code) },
        )
        assertFalse(AuditText.describe(command("WIFI", "")).byName)
    }

    // "a passkey that was read names its board by its thing name, for the page to call it by its own"
    @Test
    fun `a passkey that was read names its board by its thing name`() {
        val read = describe("pairing.read", "Cranium-1A2B", detail = listOf("thing" to thingOfTest))
        assertEquals("read the Bluetooth passkey of Cranium-1A2B", "${read.verb} ${read.label}")
        assertEquals(listOf(listOf("thing", "Board", thingOfTest, "true")), read.facts.map { listOf(it.key, it.label, it.value, it.code.toString()) })
    }

    // "the log says what was done with a token, and which token made a change"
    @Test
    fun `the log says what was done with a token, and which token made a change`() {
        val made = describe("token.create", tokenId, detail = listOf("name" to "laptop", "days" to "30"))
        assertEquals(listOf("KEY", "made API token", tokenId, "null"), listOf(made.glyph.name, made.verb, made.label, made.link.toString()))
        assertEquals(listOf("Named" to "laptop", "Valid for" to "30 days"), made.facts.map { it.label to it.value })
        assertEquals("revoked API token", describe("token.revoke", tokenId, detail = listOf("name" to "laptop")).verb)
        val refused = describe("token.create", "", "rejected", listOf("code" to "too_many_tokens"))
        assertEquals("tried to make an API token", refused.verb)
        assertEquals("That person already had as many API tokens as one may have", refused.facts[0].words)
        val scripted = describe("deployment.create", deployment, detail = listOf("token" to tokenId, "version" to "1.1.0+7"))
        val token = scripted.facts.first { it.key == "token" }
        assertEquals(Triple("With API token", tokenId, true), Triple(token.label, token.value, token.code))
        val late = describe("firmware.upload", "", "denied", listOf("token" to tokenId, "tokenState" to "revoked", "code" to "invalid_token"))
        assertEquals(
            listOf("Refused with" to "invalid_token", "With API token" to tokenId, "The token had" to "been revoked"),
            late.facts.map { it.label to it.value },
        )
    }

    // "every code the API can record has words" (the part that needs no API source)
    @Test
    fun `refusals are said in words, and the page ends the sentence`() {
        for (words in AuditText.REFUSAL_WORDS.values) {
            assertFalse(words, Regex("[a-z]_[a-z]").containsMatchIn(words))
            assertFalse(words, words.endsWith("."))
        }
        fun word(code: String) = describe("firmware.upload", "", "rejected", listOf("code" to code)).facts[0].words
        assertEquals("Only a release manager can do this", word("release_manager_required"))
        assertEquals("The file name has characters the server does not accept, or is too long", word("invalid_filename"))
        assertEquals("More serial console commands in a minute than are recorded for one person", word("rate_limited"))
    }

    @Test
    fun `what the console's schedule did is the console's own, and the fleet's entries have words`() {
        assertEquals("The console went on with the staged rollout r-1", AuditText.sentence(entry("rollout.advance", "r-1")))
        assertEquals("a@b went on with the staged rollout r-1", AuditText.sentence(entry("rollout.advance", "r-1", actor = Person("s", "a@b"))))
        assertEquals("a@b asked CRVIHAAN01 to blink its lights", AuditText.sentence(entry("board.command", "CRVIHAAN01", detail = listOf("cmd" to "identify"), actor = Person("s", "a@b"))))
        assertEquals("a@b changed the note of 1.1.0+7", AuditText.sentence(entry("firmware.notes", "1.1.0+7", actor = Person("s", "a@b"))))
        assertEquals(
            listOf("New note: Fixes the stuck timer.", "Old note none"),
            facts(describe("firmware.notes", "1.1.0+7", detail = listOf("notes" to "Fixes the stuck timer.", "oldLength" to "0")).facts),
        )
        assertEquals(listOf("Board type nRF7002 DK"), facts(describe("group.create", "lab", detail = listOf("type" to "nrf7002dk")).facts))
    }

    // cloud/web/test/customer.test.mjs "the Customers page's entries read as sentences"
    @Test
    fun `the Customers page's entries read as sentences, a customer by address and a board then whose it is`() {
        val sub = "7ec17d2e-9ee4-4734-8901-33c8fec73372"
        val email = "email" to "ada@example.invalid"
        val a = Person("s", "a@b")
        fun sentence(action: String, target: String, outcome: String, detail: List<Pair<String, String>>) =
            AuditText.sentence(entry(action, target, outcome, detail, actor = a))
        assertEquals("a@b invited the customer ada@example.invalid", sentence("customer.create", sub, "ok", listOf(email)))
        assertEquals(emptyList<String>(), facts(describe("customer.create", sub, "ok", listOf(email)).facts))
        assertEquals("a@b tried to invite the customer ada@example.invalid",
            sentence("customer.create", "", "rejected", listOf(email, "code" to "customer_exists")))
        val given = listOf("customer" to sub, email, "label" to "Deck")
        assertEquals("a@b gave $thingOfTest to ada@example.invalid", sentence("customer.assign", thingOfTest, "ok", given))
        assertEquals(listOf("Customer $sub", "Called: Deck"), facts(describe("customer.assign", thingOfTest, "ok", given).facts))
        assertEquals("a@b took $thingOfTest back from a customer",
            sentence("customer.unassign", thingOfTest, "ok", listOf("customer" to sub)))
        assertEquals("a@b tried to give a board to a customer",
            sentence("customer.assign", "", "denied", listOf("code" to "release_manager_required")))
        assertEquals("a@b sent an invitation again", sentence("customer.resend", "", "ok", emptyList()))
        assertEquals("a@b switched off the customer account of ada@example.invalid",
            sentence("customer.disable", sub, "ok", listOf(email)))
        assertEquals("a@b tried to switch on a customer account", sentence("customer.enable", "", "denied", emptyList()))
        assertEquals("That board belongs to another customer",
            describe("customer.assign", thingOfTest, "rejected", listOf("code" to "board_taken")).facts[0].words)
    }
}
