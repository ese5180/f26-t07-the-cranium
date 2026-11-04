package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** The activity log in the console's words, the server's image checks and the review of a chosen file. */
class AuditTextTest {
    private val deployment = "cranium-1-1-0-b7-20261010T115900Z-0a0a"
    private val thing = "cranium-0123456789abcdef"
    private val tokenId = "0123456789abcdef"
    private val digest = "ab".repeat(32)

    private fun entry(
        action: String,
        target: String,
        outcome: String = "ok",
        detail: List<Pair<String, String>> = emptyList(),
        requestId: String = "req-1",
        actor: Person? = Person("s-1", "rm@example.com"),
    ) = AuditEntry("2026-11-02T11:00:00.000Z", actor, action, target, outcome, detail, requestId)

    private fun describe(action: String, target: String, outcome: String = "ok", detail: List<Pair<String, String>> = emptyList()) =
        AuditText.describe(entry(action, target, outcome, detail))

    private fun said(words: AuditWords) =
        listOf(words.verb, words.label, words.tail, AuditText.boards(words)).filter { it.isNotEmpty() }.joinToString(" ")

    private fun facts(words: AuditWords) = words.facts.map { "${it.label}${if (it.phrase) "" else ":"} ${it.value}" }

    @Test
    fun `an entry reads as a sentence and links only to what exists`() {
        val upload = describe("firmware.upload", "1.1.0+7")
        assertEquals(Glyph.UPLOAD, upload.glyph)
        assertEquals("uploaded firmware", upload.verb)
        assertEquals("1.1.0+7", upload.label)
        assertNull(upload.outcome)
        assertEquals(LogLink.ToFirmware, upload.link)
        assertEquals(emptyList<AuditFact>(), upload.facts)
        assertFalse(upload.scripted)
        assertEquals("revoked firmware 1.1.0+7", said(describe("firmware.revoke", "1.1.0+7")))

        val refused = describe("firmware.upload", "zephyr.signed.bin", "rejected")
        assertNull(refused.link)
        assertEquals("tried to upload zephyr.signed.bin", said(refused))
        assertEquals(StateWords(Tone.WARN, Glyph.BAN, "Refused"), refused.outcome)
        assertEquals("Not allowed", describe("deployment.create", "1.1.0+7", "denied").outcome!!.label)
        assertEquals(Tone.BAD, describe("deployment.create", "1.1.0+7", "denied").outcome!!.tone)
        assertEquals("Server error", describe("deployment.create", "1.1.0+7", "error").outcome!!.label)
        val odd = describe("something.new", "javascript:alert(1)", "odd")
        assertNull(odd.link)
        assertEquals("something.new", odd.verb)
        assertEquals(StateWords(Tone.IDLE, Glyph.MINUS, "odd"), odd.outcome)
        assertEquals(Glyph.LIST, odd.glyph)
        assertEquals("did something", AuditText.describe(entry("", "")).verb)
    }

    @Test
    fun `a deployment is called by the version it installs, its id one of the details`() {
        val started = describe("deployment.create", deployment, detail = listOf("version" to "1.1.0+7", "things" to "2"))
        assertEquals("deployed 1.1.0+7 to 2 boards", said(started))
        assertEquals(LogLink.ToDeployment(deployment), started.link)
        assertEquals(listOf(Triple("Deployment", deployment, true)), started.facts.map { Triple(it.label, it.value, it.code) })
        assertEquals("cancelled the deployment of 1.1.0+7", said(describe("deployment.cancel", deployment)))
        assertEquals("tried to cancel the deployment of 1.1.0+7", said(describe("deployment.cancel", deployment, "rejected")))
        assertEquals("tried to deploy 1.1.0+7", said(describe("deployment.create", "1.1.0+7", "rejected")))
        assertEquals("tried to deploy 1.1.0+7", said(describe("deployment.create", deployment, "rejected")))
        val outOfRange = "cranium-999-0-0-b1-20261010T221500Z-ffff"
        assertEquals(outOfRange, describe("deployment.cancel", outOfRange).label)
        assertEquals(LogLink.ToDeployment(outOfRange), describe("deployment.cancel", outOfRange).link)
    }

    @Test
    fun `no sentence ends in of, and none stops short`() {
        assertEquals("tried to cancel a deployment", said(describe("deployment.cancel", "", "rejected")))
        assertEquals("started a deployment", said(describe("deployment.create", "")))
        assertEquals("tried to start a deployment", said(describe("deployment.create", "", "rejected")))
        assertEquals("tried to upload a file", said(describe("firmware.upload", "", "rejected")))
        assertEquals("tried to revoke a release", said(describe("firmware.revoke", "", "denied")))
        assertEquals("tried to send firmware over Bluetooth", said(describe("firmware.bluetooth_send", "", "rejected")))
        assertEquals("tried to make an API token", said(describe("token.create", "", "rejected")))
    }

    @Test
    fun `the details are in the console's words, in an order that reads well`() {
        val upload = describe(
            "firmware.upload", "1.1.0+7", "rejected",
            listOf("sha256" to digest, "size" to "1264", "filename" to "zephyr.signed.bin", "code" to "wrong_key"),
        )
        assertEquals(listOf("Refused with wrong_key", "File zephyr.signed.bin", "Size 1,264 bytes", "SHA-256 $digest"), facts(upload))
        assertEquals(listOf(true, true, false, true), upload.facts.map { it.code })
        assertEquals("Signed with a different key than this project’s", upload.facts[0].words)
        assertNull(describe("firmware.upload", "1.1.0+7", "rejected", listOf("code" to "something_new")).facts[0].words)
        assertEquals(emptyList<AuditFact>(), describe("firmware.upload", "x.bin", "rejected", listOf("filename" to "x.bin")).facts)

        val reason = "Pads stop responding after a few minutes of use."
        val revoke = describe("firmware.revoke", "1.1.0+7", detail = listOf("reason" to reason, "cancelled" to "1"))
        assertEquals(listOf("Reason: $reason", "Deployments cancelled 1"), facts(revoke))
        assertFalse(revoke.facts[0].code)

        assertEquals(
            listOf("Asked to withdraw the offer and stop boards that had started"),
            facts(describe("deployment.cancel", "1.1.0+7", detail = listOf("force" to "true"))),
        )
        assertEquals(
            listOf("Failed with internal", "Asked to withdraw the offer", "Cancelled all the same"),
            facts(describe("deployment.cancel", "1.1.0+7", "error", listOf("force" to "false", "cancelled" to "true", "code" to "internal"))),
        )
        assertEquals(
            // The sentence says how many boards ("to 2 boards"), so the details do not again.
            listOf("Refused with device_busy"),
            facts(describe("deployment.create", "1.1.0+7", "rejected", listOf("version" to "1.1.0+7", "things" to "2", "code" to "device_busy"))),
        )
        assertEquals(listOf("Version 9.9.9+9"), facts(describe("deployment.create", "1.1.0+7", detail = listOf("version" to "9.9.9+9"))))
        assertEquals(
            listOf("Size unknown", "somethingNew: x", "constructor: y"),
            facts(describe("firmware.upload", "1.1.0+7", detail = listOf("somethingNew" to "x", "size" to "unknown", "constructor" to "y"))),
        )
    }

    @Test
    fun `a revocation that was not completed says which steps are left, and one that finished another says so`() {
        assertEquals(
            listOf(
                "Failed with revoke_incomplete",
                "Left undone: refusing the image, cancelling the deployments, recording that it is done",
                "Reason: A fault.",
                "Deployments cancelled 0",
            ),
            facts(
                describe(
                    "firmware.revoke", "1.1.0+7", "error",
                    listOf("reason" to "A fault.", "cancelled" to "0", "incomplete" to "tag cancel record", "code" to "revoke_incomplete"),
                ),
            ),
        )
        assertEquals(listOf("Left undone: a_new_step"), facts(describe("firmware.revoke", "1.1.0+7", "error", listOf("incomplete" to "a_new_step"))))
        val finished = describe("firmware.revoke", "1.1.0+7", detail = listOf("cancelled" to "1", "resumed" to "true"))
        assertEquals("finished revoking firmware", finished.verb)
        assertEquals(listOf("Deployments cancelled 1"), facts(finished))
        // Not on a refusal: then it did not finish anything.
        assertEquals("tried to revoke firmware", describe("firmware.revoke", "1.1.0+7", "rejected", listOf("resumed" to "true")).verb)
    }

    @Test
    fun `what a script sent past the gateway is told apart`() {
        assertTrue(AuditText.describe(entry("firmware.revoke", "1.1.0+7", requestId = "bench-0123")).scripted)
        assertFalse(AuditText.describe(entry("firmware.revoke", "1.1.0+7", requestId = "LvC5hbench-=")).scripted)
        assertTrue(AuditText.SCRIPTED_NOTE.startsWith("Sent by a script"))
        assertEquals("Script, no sign-in", AuditText.SCRIPTED_TAG)
    }

    @Test
    fun `the phone's calls read as what they were, with their board and why they were refused`() {
        val cleared = describe("firmware.bluetooth_send", "1.1.0+7", detail = listOf("sha256" to digest, "board" to "Cranium-1A2B"))
        assertEquals(Glyph.CHIP, cleared.glyph)
        assertEquals("was cleared to send 1.1.0+7 over Bluetooth", said(cleared))
        assertEquals(LogLink.ToFirmware, cleared.link)
        assertEquals(listOf(Triple("SHA-256", digest, true), Triple("To board", "Cranium-1A2B", true)), cleared.facts.map { Triple(it.label, it.value, it.code) })
        assertEquals(
            "The release is revoked",
            describe("firmware.bluetooth_send", "1.1.0+7", "rejected", listOf("code" to "release_revoked", "sha256" to digest)).facts[0].words,
        )
        assertEquals(
            "The phone’s image is not the release’s",
            describe("firmware.bluetooth_send", "1.1.0+7", "rejected", listOf("code" to "sha256_mismatch")).facts[0].words,
        )
        assertEquals(
            "A change from the phone needs a sign-in in the last 15 minutes",
            describe("deployment.create", "1.1.0+7", "denied", listOf("code" to "phone_sign_in_again")).facts[0].words,
        )
        val read = describe("pairing.read", "Cranium-1A2B", detail = listOf("thing" to thing))
        assertEquals("read the Bluetooth passkey of Cranium-1A2B", said(read))
        assertEquals(listOf(listOf("thing", "Board", thing, "true")), read.facts.map { listOf(it.key, it.label, it.value, it.code.toString()) })
        assertEquals("downloaded 1.1.0+7 to a phone", said(describe("firmware.download", "1.1.0+7")))
    }

    @Test
    fun `the log says what was done with a token, and which token made a change`() {
        val made = describe("token.create", tokenId, detail = listOf("name" to "laptop", "days" to "30"))
        assertEquals(listOf(Glyph.KEY.name, "made API token", tokenId), listOf(made.glyph.name, made.verb, made.label))
        assertNull(made.link)
        assertEquals(listOf("Named" to "laptop", "Valid for" to "30 days"), made.facts.map { it.label to it.value })
        assertEquals("Valid for 1 day", describe("token.create", tokenId, detail = listOf("days" to "1")).facts.single().let { "${it.label} ${it.value}" })
        assertEquals("revoked API token", describe("token.revoke", tokenId, detail = listOf("name" to "laptop")).verb)
        assertEquals(
            "That person already had as many API tokens as one may have",
            describe("token.create", "", "rejected", listOf("code" to "too_many_tokens")).facts[0].words,
        )
        val scripted = describe("deployment.create", deployment, detail = listOf("token" to tokenId, "version" to "1.1.0+7"))
        val token = scripted.facts.first { it.key == "token" }
        assertEquals(Triple("With API token", tokenId, true), Triple(token.label, token.value, token.code))
        val late = describe("firmware.upload", "", "denied", listOf("token" to tokenId, "tokenState" to "revoked", "code" to "invalid_token"))
        assertEquals(
            listOf("Refused with" to "invalid_token", "With API token" to tokenId, "The token had" to "been revoked"),
            late.facts.map { it.label to it.value },
        )
        assertEquals(
            "Withdrawn at once, to stay within the limit",
            describe("token.create", tokenId, "rejected", listOf("withdrawn" to "true")).facts.single().let { "${it.label} ${it.value}" },
        )
    }

    @Test
    fun `every refusal has words, not a code, and no full stop`() {
        assertEquals("Only a release manager can do this", AuditText.REFUSAL_WORDS["release_manager_required"])
        assertEquals("The file name has characters the server does not accept, or is too long", AuditText.REFUSAL_WORDS["invalid_filename"])
        assertTrue(AuditText.REFUSAL_WORDS.size > 60)
        for ((code, words) in AuditText.REFUSAL_WORDS) {
            assertFalse(code, Regex("[a-z]_[a-z]").containsMatchIn(words))
            assertFalse(code, words.endsWith("."))
        }
    }

    @Test
    fun `the whole line as one sentence`() {
        assertEquals("rm@example.com deployed 1.1.0+7", AuditText.sentence(entry("deployment.create", deployment)))
        // The sentence is the website's auditSentence; the Console lane adds how it ended.
        assertEquals("rm@example.com tried to deploy 1.1.0+7", AuditText.sentence(entry("deployment.create", "1.1.0+7", "rejected")))
        assertEquals("rm@example.com tried to deploy 1.1.0+7 (refused)", AuditText.spoken(entry("deployment.create", "1.1.0+7", "rejected")))
        assertEquals("an unknown account tried to upload a file (not allowed)", AuditText.spoken(entry("firmware.upload", "", "denied", actor = null)))
    }

    // The server's checks of an image.

    @Test
    fun `the check an image failed is named from the code of the refusal`() {
        assertEquals("Image format", ImageChecks.failedCheck("bad_magic"))
        assertEquals("Flash layout", ImageChecks.failedCheck("wrong_target"))
        assertEquals("Signature area", ImageChecks.failedCheck("trailing_data"))
        assertEquals("Image hash", ImageChecks.failedCheck("hash_mismatch"))
        assertEquals("Signing key", ImageChecks.failedCheck("wrong_key"))
        assertEquals("Signature", ImageChecks.failedCheck("bad_signature"))
        assertEquals("Version", ImageChecks.failedCheck("version_exists"))
        assertNull(ImageChecks.failedCheck("device_busy"))
        assertNull(ImageChecks.failedCheck(null))
        assertEquals(7, ImageChecks.ALL.size)
        assertEquals("Its version has a number, and no release came before it.", ImageChecks.ALL.last().passedFirst)
    }

    @Test
    fun `the server's words, unless they are jargon`() {
        assertTrue(ImageChecks.plainMessage(ApiError(422, "unexpected_tlv", "raw")).startsWith("This image is not signed the way this project requires"))
        assertEquals(
            "The signature area of this image cannot be read. Build and sign it again.",
            ImageChecks.plainMessage(ApiError(422, "malformed_tlv", "raw")),
        )
        assertEquals("Version 1.1.0+7 is not newer.", ImageChecks.plainMessage(ApiError(422, "version_not_newer", "Version 1.1.0+7 is not newer.")))
    }

    @Test
    fun `what a failed request means for what happens next`() {
        assertTrue(Outcomes.isRefusal(404))
        assertFalse(Outcomes.isRefusal(500))
        assertFalse(Outcomes.isRefusal(0))
        assertFalse("a refusal changed nothing", Outcomes.staleAfter(ApiError(404, "unknown_version", "m")))
        assertTrue("a conflict says the page is out of date", Outcomes.staleAfter(ApiError(409, "device_busy", "m")))
        assertTrue("it may have gone through", Outcomes.staleAfter(ApiError(500, "internal_error", "m")))
        assertTrue(Outcomes.staleAfter(IOException("offline")))
        assertFalse(Outcomes.canRetryUpload(ApiError(422, "wrong_key", "m")))
        assertTrue(Outcomes.canRetryUpload(ApiError(429, "throttled", "m")))
        assertTrue(Outcomes.canRetryUpload(ApiError(409, "upload_conflict", "m")))
        assertFalse(Outcomes.canRetryUpload(ApiError(409, "version_exists", "m")))
        assertTrue(Outcomes.canRetryUpload(ApiError(500, "internal_error", "m")))
        assertTrue(Outcomes.canRetryUpload(IOException("offline")))
    }

    // Reviewing a chosen file before it is uploaded.

    @Test
    fun `the header of a chosen file is read before anything is sent`() {
        assertEquals(
            UploadReview.Header(false, "The file is too small to be a firmware image."),
            UploadReview.readHeader(ByteArray(10)),
        )
        assertEquals(
            "This is not an MCUboot image. Choose the *.signed.bin file from the build.",
            UploadReview.readHeader(TestImages.header(magic = listOf(0, 0, 0, 0))).message,
        )
        val header = UploadReview.readHeader(TestImages.image(FirmwareVersion(1, 9, 0, 2)))
        assertTrue(header.ok)
        assertEquals("1.9.0+2", header.version)
        assertEquals(0x200, header.headerSize)
        assertEquals(4096L, header.payloadSize)
    }

    private val slot = 794_624L

    private fun firmware(vararg releases: Release) = ReleaseList(releases.toList(), slot)

    private fun header(version: String): UploadReview.Header {
        val parsed = FirmwareVersion.parseStrict(version)!!
        return UploadReview.readHeader(TestImages.image(parsed))
    }

    private fun notes(review: UploadReview.Review) = review.notes.map { "${it.tone} ${it.text}" }

    @Test
    fun `a file that cannot be firmware is blocked, and one the server must refuse is doomed`() {
        val unusable = UploadReview.review(UploadReview.Header(false, "The file is too small to be a firmware image."), 10, "", null)
        assertTrue(unusable.blocked)
        assertEquals(listOf("BAD The file is too small to be a firmware image."), notes(unusable))

        val large = UploadReview.review(header("1.9.0+0"), slot + 1, digest, firmware())
        assertTrue(large.blocked)
        assertEquals("BAD Too large: the board’s slot holds 794,624 bytes.", notes(large).first())

        val zero = UploadReview.review(header("0.0.0+0"), 4608, digest, firmware())
        assertTrue(zero.doomed)
        assertEquals(
            listOf("GOOD Fits the board’s 776 KiB slot.", "WARN Version 0.0.0+0 is never accepted. Give the build a version first."),
            notes(zero),
        )
    }

    @Test
    fun `nothing is said about other releases until their list has arrived`() {
        val early = UploadReview.review(header("1.9.0+0"), 4608, digest, null)
        assertFalse(early.blocked)
        assertFalse(early.doomed)
        assertEquals(emptyList<String>(), notes(early))
    }

    @Test
    fun `the review says how the file stands against what is registered`() {
        val registered = Release("1.8.0+0", 10, digest, "active")
        val same = UploadReview.review(header("1.9.0+0"), 4608, digest, firmware(registered))
        assertTrue(same.doomed)
        assertEquals("WARN This exact file is already registered as 1.8.0+0.", notes(same).last())

        val taken = UploadReview.review(header("1.8.0+0"), 4608, "cd".repeat(32), firmware(registered))
        assertTrue(taken.doomed)
        assertEquals("WARN 1.8.0+0 is already registered with different contents. A version can be used once.", notes(taken).last())

        val revokedHigher = Release("1.9.0+0", 10, "ef".repeat(32), "revoked")
        val older = UploadReview.review(header("1.8.5+0"), 4608, "cd".repeat(32), firmware(registered, revokedHigher))
        assertTrue(older.doomed)
        assertEquals("WARN Not newer than 1.9.0+0, the highest version registered so far. The server will refuse it.", notes(older).last())

        val newer = UploadReview.review(header("1.9.0+0"), 4608, "cd".repeat(32), firmware(registered))
        assertFalse(newer.doomed)
        assertFalse(newer.blocked)
        assertEquals("GOOD Newer than every registered release (highest so far: 1.8.0+0).", notes(newer).last())

        val first = UploadReview.review(header("1.0.0+0"), 4608, digest, firmware())
        assertEquals(listOf("GOOD Fits the board’s 776 KiB slot.", "GOOD This will be the first release."), notes(first))
        assertTrue(UploadReview.SIGNATURE_UNCHECKED.startsWith("Signature: not checked yet."))
    }
}
