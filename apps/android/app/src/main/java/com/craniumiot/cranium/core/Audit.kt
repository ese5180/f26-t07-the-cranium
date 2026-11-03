package com.craniumiot.cranium.core

/** One fact of a log entry, in the console's words. */
data class AuditFact(
    val key: String,
    val label: String,
    val value: String,
    val code: Boolean,
    /** True when the label reads on into the value ("Size 1,264 bytes"); false for "Reason: …". */
    val phrase: Boolean,
    /** A refusal in words, where there are words for its code. */
    val words: String? = null,
)

/** Where a link of the log leads, inside the app. */
sealed class LogLink {
    data class ToDeployment(val id: String) : LogLink()
    data object ToFirmware : LogLink()
}

/** One line of the activity log: what was done, to what, and how it ended if not well. */
data class AuditWords(
    val glyph: Glyph,
    val verb: String,
    val label: String,
    val outcome: StateWords?,
    val link: LogLink?,
    val facts: List<AuditFact>,
    val scripted: Boolean,
)

/** The activity log in the console's words (core.js describeAudit and its tables). */
object AuditText {
    private data class Action(val done: String, val tried: String, val triedAlone: String, val glyph: Glyph)

    private val ACTIONS = mapOf(
        "firmware.upload" to Action("uploaded firmware", "tried to upload", "tried to upload a file", Glyph.UPLOAD),
        "firmware.revoke" to Action("revoked firmware", "tried to revoke firmware", "tried to revoke a release", Glyph.BAN),
        "deployment.create" to Action("started a deployment of", "tried to deploy", "tried to start a deployment", Glyph.SEND),
        "deployment.cancel" to Action(
            "cancelled the deployment of", "tried to cancel the deployment of", "tried to cancel a deployment", Glyph.STOP,
        ),
        "firmware.download" to Action(
            "downloaded firmware to a phone", "tried to download firmware", "tried to download firmware", Glyph.DOWNLOAD,
        ),
        "pairing.read" to Action(
            "read the Bluetooth passkey of", "tried to read the Bluetooth passkey of", "tried to read a Bluetooth passkey", Glyph.SHIELD,
        ),
        "firmware.bluetooth_send" to Action(
            "was cleared to send over Bluetooth", "tried to send over Bluetooth", "tried to send firmware over Bluetooth", Glyph.CHIP,
        ),
        "token.create" to Action("made API token", "tried to make API token", "tried to make an API token", Glyph.KEY),
        "token.revoke" to Action("revoked API token", "tried to revoke API token", "tried to revoke an API token", Glyph.KEY),
    )

    // What scripts/ota.sh without an API token, and the test bench, call their requests.
    private const val SCRIPTED_REQUEST = "bench-"

    const val SCRIPTED_TAG = "Script, no sign-in"
    const val SCRIPTED_NOTE = "Sent by a script (the test bench, or scripts/ota.sh without an API token) with AWS credentials, " +
        "directly to the API function. Nobody signed in. The name is the one the script gave, which has to be an active " +
        "release manager, so the entry does not show that this person did it."

    private val OUTCOMES = mapOf(
        "rejected" to StateWords(Tone.WARN, Glyph.BAN, "Refused"),
        "denied" to StateWords(Tone.BAD, Glyph.LOCK, "Not allowed"),
        "error" to StateWords(Tone.BAD, Glyph.ALERT, "Server error"),
    )

    /** Why the server refused a request or failed at it, in words, for a code. */
    val REFUSAL_WORDS = mapOf(
        "account_inactive" to "The account is not active",
        "already_cancelled" to "That deployment was already cancelled",
        "already_finished" to "That deployment had already finished",
        "already_revoked" to "That release was already revoked",
        "audit_failed" to "The change could not be written to this log",
        "bad_header" to "The image header cannot be read",
        "bad_signing_key" to "The server’s signing key cannot be read",
        "cancel_refused" to "AWS IoT would not cancel it",
        "forbidden" to "This account may not do that",
        "internal_error" to "Something went wrong on the server",
        "invalid_body" to "The request could not be read",
        "invalid_deployment" to "Not a valid deployment ID",
        "invalid_filename" to "The file name has characters the server does not accept, or is too long",
        "invalid_json" to "The request could not be read",
        "invalid_thing" to "Not a valid board name",
        "invalid_things" to "The list of boards is not valid",
        "invalid_version" to "Not a valid version number",
        "not_found" to "There is nothing at that address",
        "payload_too_large" to "The request was too large",
        "release_manager_required" to "Only a release manager can do this",
        "revoke_incomplete" to "The revocation did not finish",
        "throttled" to "AWS asked the server to slow down",
        "timeout" to "The server ran out of time",
        "unauthorized" to "The sign-in was not accepted",
        "unknown_deployment" to "There is no such deployment",
        "unknown_device" to "A board is not registered",
        "unknown_version" to "There is no such release",
        "image_unavailable" to "The image could not be read; it may have been revoked",
        "image_mismatch" to "The stored image is not the one that was verified",
        "invalid_name" to "Not the name of a board over Bluetooth",
        "invalid_board" to "Not the name of a board over Bluetooth",
        "invalid_sha256" to "Not a valid SHA-256",
        "sha256_mismatch" to "The phone’s image is not the release’s",
        "no_pairing" to "No board online was pairing under that name",
        "unsupported_flags" to "Uses image options this project does not",
        "upload_conflict" to "Another upload was under way at that moment",
        "wrong_key" to "Signed with a different key than this project’s",
        "bad_signature" to "The signature is not valid",
        "unsigned" to "Not signed",
        "hash_mismatch" to "The file is damaged",
        "bad_magic" to "Not an MCUboot image",
        "not_an_image" to "Not an MCUboot image",
        "too_small" to "Too small to be a firmware image",
        "too_large" to "Too large for the board’s slot",
        "truncated" to "Shorter than its header says",
        "wrong_target" to "Not built for this product’s flash layout",
        "trailing_data" to "Has data after the signature",
        "unexpected_tlv" to "Not signed the way this project requires",
        "malformed_tlv" to "The signature area cannot be read",
        "bad_signature_encoding" to "The signature cannot be read",
        "version_exists" to "That version is already registered",
        "version_not_newer" to "Not newer than the highest version registered",
        "version_zero" to "Version 0.0.0+0 is never accepted",
        "device_busy" to "A board had an unfinished update",
        "release_revoked" to "The release is revoked",
        "invalid_token" to "The API token was not valid, or had been revoked or had expired",
        "token_not_allowed" to "An API token cannot be used for that",
        "phone_not_allowed" to "The phone app’s sign-in cannot be used for that",
        "phone_sign_in_again" to "A change from the phone needs a sign-in in the last 15 minutes",
        "too_many_tokens" to "That person already had as many API tokens as one may have",
        "invalid_token_name" to "The token’s name was empty, too long or not one line",
        "invalid_days" to "The token’s lifetime was not a whole number of days from 1 to 90",
        "invalid_token_id" to "Not a valid token ID",
        "unknown_token" to "That person has no API token with that ID",
        "token_already_revoked" to "That API token was already revoked",
        "invalid_time" to "A time was not written the way the server reads times",
        "invalid_range" to "The time range was empty, backwards or longer than 31 days",
        "invalid_kinds" to "The list of kinds of event was not valid",
        "invalid_hours" to "The number of hours was not a whole number from 1 to 168",
    )

    private val REVOCATION_STEPS = mapOf(
        "tag" to "refusing the image",
        "cancel" to "cancelling the deployments",
        "record" to "recording that it is done",
    )

    private data class Detail(
        val label: String,
        val code: Boolean = false,
        val sentence: Boolean = false,
        val say: ((String) -> String)? = null,
    )

    // In the order in which a line reads best.
    private val DETAILS: LinkedHashMap<String, Detail> = linkedMapOf(
        "code" to Detail("Refused with", code = true),
        "incomplete" to Detail("Left undone", sentence = true, say = { value ->
            value.split(' ').filter { it.isNotEmpty() }.joinToString(", ") { REVOCATION_STEPS[it] ?: it }
        }),
        "filename" to Detail("File", code = true),
        "version" to Detail("Version", code = true),
        "things" to Detail("Boards"),
        "force" to Detail("Asked to", say = { value ->
            when (value) {
                "true" -> "withdraw the offer and stop boards that had started"
                "false" -> "withdraw the offer"
                else -> value
            }
        }),
        "reason" to Detail("Reason", sentence = true),
        "cancelled" to Detail("Cancelled", say = { value ->
            when (value) {
                "true" -> "all the same"
                "false" -> "no"
                else -> value
            }
        }),
        "size" to Detail("Size", say = { value -> value.toLongOrNull()?.let { Words.exactBytes(it) } ?: value }),
        "sha256" to Detail("SHA-256", code = true),
        "token" to Detail("With API token", code = true),
        "tokenState" to Detail("The token had", say = { value -> if (value == "revoked") "been revoked" else value }),
        "board" to Detail("To board", code = true),
        "thing" to Detail("Board", code = true),
        "name" to Detail("Named", sentence = true),
        "days" to Detail("Valid for", say = { value -> value.toLongOrNull()?.let { Words.plural(it, "day") } ?: value }),
        "withdrawn" to Detail("Withdrawn", say = { value -> if (value == "true") "at once, to stay within the limit" else value }),
    )

    private fun fact(entry: AuditEntry, key: String, value: String): AuditFact {
        val known = DETAILS[key] ?: return AuditFact(key, key, value, code = false, phrase = false)
        var label = known.label
        if (key == "cancelled" && entry.action == "firmware.revoke") label = "Deployments cancelled"
        if (key == "code" && entry.outcome == "error") label = "Failed with"
        return AuditFact(
            key = key,
            label = label,
            value = known.say?.invoke(value) ?: value,
            code = known.code,
            phrase = !known.sentence,
            words = if (key == "code") REFUSAL_WORDS[value] else null,
        )
    }

    /** One line of the activity log. A deployment is called by its version; its id goes to the facts. */
    fun describe(entry: AuditEntry): AuditWords {
        val action = ACTIONS[entry.action]
        val ok = entry.outcome == "ok"
        val deployment = entry.target.takeIf { ApiJson.isDeploymentId(it) }
        val label = if (deployment != null) Updates.versionOfDeployment(deployment) ?: deployment else entry.target
        val details = entry.detail.toMap()
        val resumed = entry.action == "firmware.revoke" && ok && details["resumed"] == "true"
        var words = entry.action.ifEmpty { "did something" }
        when {
            resumed -> words = "finished revoking firmware"
            action != null && ok -> words = action.done
            action != null -> words = if (label.isNotEmpty()) action.tried else action.triedAlone
        }
        val order = LinkedHashSet<String>().apply {
            addAll(DETAILS.keys)
            addAll(entry.detail.map { it.first })
        }
        val facts = mutableListOf<AuditFact>()
        for (key in order) {
            val value = details[key] ?: continue
            if (key == "version" && value == label) continue
            if (key == "resumed" && resumed) continue
            if (key == "filename" && value == label) continue
            facts += fact(entry, key, value)
        }
        if (deployment != null) facts += AuditFact("target", "Deployment", deployment, code = true, phrase = true)
        val link = when {
            deployment != null -> LogLink.ToDeployment(deployment)
            FirmwareVersion.parseStrict(entry.target) != null -> LogLink.ToFirmware
            else -> null
        }
        return AuditWords(
            glyph = action?.glyph ?: Glyph.LIST,
            verb = if (label.isNotEmpty()) words else words.removeSuffix(" of"),
            label = label,
            outcome = if (ok) null else OUTCOMES[entry.outcome] ?: StateWords(Tone.IDLE, Glyph.MINUS, entry.outcome.ifEmpty { "Unknown" }),
            link = link,
            facts = facts,
            scripted = entry.requestId.startsWith(SCRIPTED_REQUEST),
        )
    }

    /** The whole line as one sentence, for a lane of the timeline or a screen reader. */
    fun sentence(entry: AuditEntry): String {
        val words = describe(entry)
        val what = listOf(Words.nameOf(entry.actor), words.verb, words.label).filter { it.isNotEmpty() }.joinToString(" ")
        return if (words.outcome != null) "$what (${words.outcome.label.lowercase()})" else what
    }
}

/** What the server checks before it stores an image, in the order it does so (core.js IMAGE_CHECKS). */
object ImageChecks {
    data class Check(val name: String, val passed: String, val passedFirst: String? = null, val codes: List<String>)

    val ALL = listOf(
        Check(
            "Image format", "It is an MCUboot image, and it fits the board’s update slot.",
            codes = listOf("not_an_image", "too_small", "too_large", "bad_magic", "bad_header", "truncated"),
        ),
        Check("Flash layout", "It was built for this product’s flash layout.", codes = listOf("unsupported_flags", "wrong_target")),
        Check(
            "Signature area", "Its signature area is well formed, with nothing after it.",
            codes = listOf("malformed_tlv", "unexpected_tlv", "trailing_data", "unsigned"),
        ),
        Check("Image hash", "The image matches its own SHA-256 hash, so the file is not damaged.", codes = listOf("hash_mismatch")),
        Check("Signing key", "It is signed with this project’s key.", codes = listOf("wrong_key")),
        Check("Signature", "Its ECDSA P-256 signature is valid.", codes = listOf("bad_signature", "bad_signature_encoding")),
        Check(
            "Version", "Its version is newer than every release before it.",
            passedFirst = "Its version has a number, and no release came before it.",
            codes = listOf("version_zero", "version_exists", "version_not_newer"),
        ),
    )

    /** The name of the check an image failed, from the code of the server's refusal. */
    fun failedCheck(code: String?): String? = ALL.firstOrNull { code in it.codes }?.name

    private const val SIGNED_WRONGLY = "This image is not signed the way this project requires: an ECDSA P-256 signature, " +
        "with a hash of the public key. Sign it with the project’s imgtool settings."

    private val PLAIN_WORDS = mapOf(
        "unexpected_tlv" to SIGNED_WRONGLY,
        "malformed_tlv" to "The signature area of this image cannot be read. Build and sign it again.",
        "bad_signature_encoding" to "The signature in this image cannot be read. Build and sign it again.",
    )

    /** What to say about a failed request: the server's wording, unless it is written in jargon. */
    fun plainMessage(error: ApiError): String = PLAIN_WORDS[error.code] ?: (error.message ?: "")
}

/** What a failed request means for what happens next (core.js). */
object Outcomes {
    /** A refusal: the server understood the request and said no, so nothing was changed. */
    fun isRefusal(status: Int): Boolean = status in 400..499

    /** Whether the page has to be read again after a change failed. */
    fun staleAfter(error: Throwable): Boolean {
        val status = (error as? ApiError)?.status ?: return true
        return !isRefusal(status) || status == 409
    }

    /** Whether sending the same file once more could end differently. */
    fun canRetryUpload(error: Throwable): Boolean {
        val api = error as? ApiError ?: return true
        return !isRefusal(api.status) || api.status == 429 || api.code == "upload_conflict"
    }
}

/** What can be said about a chosen file before it is uploaded (core.js reviewImage). */
object UploadReview {
    enum class NoteTone { GOOD, WARN, BAD, WAIT }

    data class Note(val tone: NoteTone, val text: String)

    data class Review(val blocked: Boolean, val doomed: Boolean, val notes: List<Note>)

    /** The header of a chosen file, as far as the phone reads it: a preview, so that a wrong file shows early. */
    data class Header(val ok: Boolean, val message: String = "", val headerSize: Int = 0, val payloadSize: Long = 0, val version: String = "")

    fun readHeader(data: ByteArray): Header {
        if (data.size < McubootHeader.LENGTH) return Header(false, "The file is too small to be a firmware image.")
        val header = McubootHeader.parse(data)
            ?: return Header(false, "This is not an MCUboot image. Choose the *.signed.bin file from the build.")
        return Header(true, headerSize = header.headerSize, payloadSize = header.imageSize, version = header.version.toString())
    }

    const val SIGNATURE_UNCHECKED = "Signature: not checked yet. The server checks it against the project key when you upload."

    fun review(header: Header, size: Long, digest: String, firmware: ReleaseList?): Review {
        val notes = mutableListOf<Note>()
        if (!header.ok) return Review(blocked = true, doomed = false, notes = listOf(Note(NoteTone.BAD, header.message)))
        val slot = firmware?.slotSize
        var blocked = false
        if (slot != null && size > slot) {
            blocked = true
            notes += Note(NoteTone.BAD, "Too large: the board’s slot holds ${Words.exactBytes(slot)}.")
        } else if (slot != null) {
            notes += Note(NoteTone.GOOD, "Fits the board’s ${Words.fileSize(slot)} slot.")
        }
        if (header.version == "0.0.0+0") {
            notes += Note(NoteTone.WARN, "Version 0.0.0+0 is never accepted. Give the build a version first.")
            return Review(blocked, true, notes)
        }
        if (firmware == null) return Review(blocked, false, notes)
        val version = FirmwareVersion.parseStrict(header.version)
        val same = firmware.releases.firstOrNull { it.sha256 == digest }
        val taken = firmware.releases.firstOrNull { it.version == header.version }
        val highest = firmware.releases.mapNotNull { FirmwareVersion.parseStrict(it.version) }.maxOrNull()
        val notNewer = highest != null && version != null && version <= highest
        val doomed = same != null || taken != null || notNewer
        when {
            same != null -> notes += Note(NoteTone.WARN, "This exact file is already registered as ${same.version}.")
            taken != null -> notes += Note(
                NoteTone.WARN, "${taken.version} is already registered with different contents. A version can be used once.",
            )
            notNewer -> notes += Note(
                NoteTone.WARN, "Not newer than $highest, the highest version registered so far. The server will refuse it.",
            )
            highest != null -> notes += Note(NoteTone.GOOD, "Newer than every registered release (highest so far: $highest).")
            else -> notes += Note(NoteTone.GOOD, "This will be the first release.")
        }
        return Review(blocked, doomed, notes)
    }
}
