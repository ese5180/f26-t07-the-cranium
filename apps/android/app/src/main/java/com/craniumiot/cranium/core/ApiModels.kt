package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Who did something: the account id (the token's sub) and the address it showed at the time. `name`
 * is the server's short name for the person where the answer gives one (an update's `who`), else "".
 */
data class Person(val sub: String = "", val email: String = "", val name: String = "")

/** How a release was revoked. `enforcedAt` is when the steps after the mark were done, or null. */
data class Revocation(
    val by: Person? = null,
    val at: String? = null,
    val reason: String = "",
    val enforcedAt: String? = null,
    /** False for a server that does not record the end of a revocation at all. */
    val recordsEnforcement: Boolean = true,
)

/** One firmware release, from `GET /api/firmware`. */
data class Release(
    val version: String,
    val size: Long,
    val sha256: String,
    val status: String,
    val uploadedAt: String = "",
    val notes: String = "",
    val imageHash: String = "",
    val keyHash: String = "",
    val payloadSize: Long? = null,
    val headerSize: Long? = null,
    val loadAddress: Long? = null,
    val filename: String = "",
    val uploadedBy: Person? = null,
    val revoked: Revocation? = null,
) {
    val isActive: Boolean get() = status == "active"
}

/** `GET /api/firmware`: the releases, newest first, the size of an image slot, and the signing key. */
data class ReleaseList(val releases: List<Release>, val slotSize: Long?, val fingerprint: String = "")

/** `GET /api/me`. `canWrite` is true for a release manager. */
data class Me(
    val email: String = "",
    val groups: List<String> = emptyList(),
    val canWrite: Boolean = false,
    val sub: String = "",
    /** When the session's token ends, in epoch seconds. */
    val expiresAt: Long? = null,
)

/** `GET /api/pairing/{name}`: the passkey a board shows while a phone pairs with it. */
data class Pairing(val thing: String, val name: String, val passkey: String, val reportedAt: String = "")

data class DeviceFirmware(val version: String = "", val confirmed: Boolean = false)

/** What a board says about updates: its step, the deployment it works on, and how the last one ended. */
data class Ota(val state: String, val job: String?, val progress: Int, val last: String, val error: String)

data class Stuck(val count: Long, val reason: String)

data class Heap(val free: Long, val least: Long, val size: Long)

/** The diagnostics report, from firmware 1.10.0: MAC, Wi-Fi channel and the heap. */
data class Diag(val mac: String?, val channel: Int?, val heap: Heap?, val at: String?)

data class DiaryEntry(val version: String, val cause: String, val causes: List<String>, val stage: Int)

/** The boot diary, newest boot first. */
data class Diary(val boots: Long, val entries: List<DiaryEntry>)

/** The board's record of its last update over Bluetooth, from firmware 1.9.0. */
data class BtRecord(val from: String, val to: String, val result: String, val proof: String, val count: Long)

/**
 * A board, as `GET /api/devices` describes it. `thing` (cranium-…) is its identity in AWS IoT and
 * in every request; `name` is the device ID a person gave it, from firmware 1.11.4, shown first.
 */
data class Device(
    val thing: String = "",
    val online: Boolean = false,
    val fw: DeviceFirmware? = null,
    val name: String? = null,
    val lastSeen: String? = null,
    val ota: Ota? = null,
    val rssi: Int? = null,
    val uptime: Long? = null,
    val stuck: Stuck? = null,
    val diag: Diag? = null,
    val diary: Diary? = null,
    val bt: BtRecord? = null,
)

data class DeviceList(val devices: List<Device>, val generatedAt: String?)

/** One entry of a board's history of updates. */
data class ExecutionSummary(
    val deployment: String,
    val version: String?,
    val status: String,
    val queuedAt: String?,
    val startedAt: String?,
    val lastUpdatedAt: String?,
)

/**
 * One update of a board, from `GET /api/updates` (console 2.1.1): a deployment's execution on it, or an
 * update the board reported itself, over Bluetooth or by USB or another tool. `how` and `outcome` are the
 * console's words as it sent them ("" when missing); the words for them (Updates.howWords and
 * Updates.outcomeWords) take a value they do not know for "usb_or_other" and "pending".
 */
data class Update(
    val id: String,
    val thing: String,
    /** What the board ran before; null when not known. */
    val from: String? = null,
    /** What the update installs; null for a job some other tool made. */
    val to: String? = null,
    val how: String = "",
    /** The job id, for a deployment. */
    val deployment: String? = null,
    /** Bluetooth: whose phone made the check before the send; a deployment: who started it. */
    val who: Person? = null,
    val outcome: String = "",
    val startedAt: String? = null,
    /** Null while the update is pending. */
    val endedAt: String? = null,
    /** The AWS IoT execution status, for a deployment only. */
    val status: String? = null,
)

/** `GET /api/updates`: newest first, and the cursor of the next page (null: no more). */
data class UpdatesPage(val updates: List<Update>, val cursor: String?, val generatedAt: String?)

/** `GET /api/devices/{thing}`. `lastUpdate` is the board's newest update, from console 2.1.1. */
data class DeviceDetail(
    val device: Device,
    val certificates: List<String>,
    val executions: List<ExecutionSummary>,
    val olderExecutions: Long,
    val lastUpdate: Update? = null,
)

/** How many boards of a deployment are in each state. */
data class Counts(
    val queued: Int = 0,
    val inProgress: Int = 0,
    val succeeded: Int = 0,
    val failed: Int = 0,
    val rejected: Int = 0,
    val canceled: Int = 0,
    val timedOut: Int = 0,
    val removed: Int = 0,
) {
    operator fun get(name: String): Int = when (name) {
        "queued" -> queued
        "inProgress" -> inProgress
        "succeeded" -> succeeded
        "failed" -> failed
        "rejected" -> rejected
        "canceled" -> canceled
        "timedOut" -> timedOut
        "removed" -> removed
        else -> 0
    }

    val total: Int get() = queued + inProgress + succeeded + failed + rejected + canceled + timedOut + removed

    operator fun plus(other: Counts) = Counts(
        queued + other.queued, inProgress + other.inProgress, succeeded + other.succeeded, failed + other.failed,
        rejected + other.rejected, canceled + other.canceled, timedOut + other.timedOut, removed + other.removed,
    )

    companion object {
        val NAMES = listOf("queued", "inProgress", "succeeded", "failed", "rejected", "canceled", "timedOut", "removed")

        /** The counts of a list of execution statuses, as the API counts them. */
        fun of(statuses: List<String>): Counts = Counts(
            queued = statuses.count { it == "QUEUED" },
            inProgress = statuses.count { it == "IN_PROGRESS" },
            succeeded = statuses.count { it == "SUCCEEDED" },
            failed = statuses.count { it == "FAILED" },
            rejected = statuses.count { it == "REJECTED" },
            canceled = statuses.count { it == "CANCELED" },
            timedOut = statuses.count { it == "TIMED_OUT" },
            removed = statuses.count { it == "REMOVED" },
        )
    }
}

/** A deployment as `GET /api/deployments` lists it. */
data class DeploymentSummary(
    val id: String,
    val version: String?,
    val status: String,
    val createdAt: String?,
    val completedAt: String?,
    val createdBy: Person?,
    val note: String,
    val things: List<String>,
    val counts: Counts,
)

/** One board's part in a deployment. */
data class Execution(
    val thing: String,
    val status: String,
    val phase: String,
    val progress: Int?,
    val reason: String?,
    val detail: String?,
    /** What the job recorded when the board finished the update: history. */
    val ranAtEnd: String?,
    /** For an update the board did not finish: what is known of the board now. */
    val reported: String?,
    val online: Boolean,
    val queuedAt: String?,
    val startedAt: String?,
    val lastUpdatedAt: String?,
    val secondsLeft: Long?,
)

/** `GET /api/deployments/{id}`: the summary and each board's part. */
data class Deployment(val summary: DeploymentSummary, val executions: List<Execution>) {
    val id: String get() = summary.id
    val version: String? get() = summary.version
    val status: String get() = summary.status
}

/** One entry of the activity log. `detail` keeps the order the API sent. */
data class AuditEntry(
    val at: String?,
    val actor: Person?,
    val action: String,
    val target: String,
    val outcome: String,
    val detail: List<Pair<String, String>>,
    val requestId: String,
)

data class AuditPage(val entries: List<AuditEntry>, val next: String?)

/**
 * One event of a board, from `GET /api/events`, or an entry of the activity log on the Console lane
 * (`thing` null). `job` names a deployment of this console; `href` is where a console event leads.
 */
data class BoardEvent(
    val thing: String?,
    val at: String,
    val id: String,
    val kind: String,
    val what: String,
    val level: String,
    val text: String,
    val job: String? = null,
    val href: String? = null,
) {
    val atMs: Long get() = Times.parse(at) ?: 0L
}

data class EventPage(val events: List<BoardEvent>, val cursor: String?, val from: String?, val to: String?)

data class Sample(val at: String, val rssi: Int?, val uptime: Long?, val heapFree: Long?, val heapLeast: Long?)

/** `GET /api/devices/{thing}/samples`, oldest first. */
data class Samples(val samples: List<Sample>, val hours: Int, val bucketSeconds: Long, val from: String?, val to: String?)

/** A person's own API token, as the list shows it: never the token itself. */
data class ApiToken(
    val id: String,
    val name: String,
    val createdAt: String?,
    val expiresAt: String?,
    val revokedAt: String?,
    val status: String,
)

data class TokenList(val tokens: List<ApiToken>, val limit: Int, val maxDays: Int)

/** The answer to making a token: the token itself, shown once. */
data class NewToken(val token: String, val id: String, val name: String, val createdAt: String?, val expiresAt: String?)

/** The answer to a revocation: the release as it is now, and the deployments it cancelled. */
data class Revoked(val release: Release, val cancelled: List<String>)

/** A board the server named when it refused a deployment because it is busy. */
data class BusyBoard(val thing: String, val deployment: String?)

/** An error the console answered with: `{"error": {"code", "message", "requestId", "details"}}` and an HTTP status. */
class ApiError(
    val status: Int,
    val code: String,
    message: String,
    val requestId: String? = null,
    val details: List<BusyBoard> = emptyList(),
) : Exception(message)

/** Decoding of the console's answers (docs/mobile-apps.md, "The API"; the website's core.js readers). */
object ApiJson {
    private val json = Json { ignoreUnknownKeys = true }

    private val THING = Regex("^cranium-[0-9a-f]{16}$")
    private val DEPLOYMENT = Regex("^cranium-(\\d{1,3})-(\\d{1,3})-(\\d{1,5})-b(\\d{1,10})-\\d{8}T\\d{6}Z-[0-9a-f]{4}$")
    private val CURSOR = Regex("^[A-Za-z0-9_-]{1,512}$")
    private val MAC = Regex("^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$")
    private val HEX = Regex("^[0-9a-f]{1,8}$")
    private val WORD = Regex("^[a-z][a-z_]{0,31}$")
    private val STATUS = Regex("^[A-Z][A-Z_]{0,23}$")
    private val TOKEN = Regex("^crn_[A-Za-z0-9_-]{43}$")
    private val TOKEN_ID = Regex("^[0-9a-f]{16}$")
    private val EVENT_ID = Regex("^[0-9a-f]{6}$")
    private val RESET_NAMES = setOf(
        "pin", "software", "brownout", "power_on", "watchdog", "debugger", "security", "wake", "lockup",
        "parity", "pll", "clock", "hardware", "user", "temperature", "unknown",
    )
    val BT_RESULTS = listOf("pending", "succeeded", "rolled_back", "not_installed", "trial_lost", "superseded", "flash_error")
    val EVENT_KINDS = listOf("connection", "firmware", "update", "restart", "bluetooth", "health")

    private fun root(text: String): JsonObject =
        runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: throw IllegalArgumentException("The console's answer is not a JSON object")

    private fun list(value: JsonElement?, what: String): JsonArray =
        value as? JsonArray ?: throw IllegalArgumentException("The answer has no $what")

    private fun record(value: JsonElement?, what: String): JsonObject =
        value as? JsonObject ?: throw IllegalArgumentException("The answer has no $what")

    fun isThing(text: String?): Boolean = text != null && THING.matches(text)

    fun isDeploymentId(text: String?): Boolean = text != null && DEPLOYMENT.matches(text)

    private fun versionOrNull(value: JsonElement?): String? =
        J.str(value)?.takeIf { FirmwareVersion.parseStrict(it) != null }

    // Releases.

    /** One release, or null if it cannot be read: no version, size or SHA-256. */
    fun release(value: JsonElement?): Release? {
        val item = J.obj(value) ?: return null
        val version = J.str(item["version"]) ?: return null
        val size = J.long(item["size"]) ?: return null
        val sha256 = J.str(item["sha256"]) ?: return null
        val active = J.str(item["status"]) == "active"
        val revoked = J.obj(item["revoked"])?.let { mark ->
            Revocation(
                by = J.person(mark["by"]),
                at = J.instant(mark["at"]),
                reason = J.text(mark["reason"], 200),
                enforcedAt = J.instant(mark["enforcedAt"]),
                recordsEnforcement = mark.containsKey("enforcedAt"),
            )
        }
        return Release(
            version = version.take(32),
            size = size,
            sha256 = sha256.take(64),
            status = if (active) "active" else "revoked",
            uploadedAt = J.instant(item["uploadedAt"]) ?: "",
            notes = J.text(item["notes"], 500),
            imageHash = J.text(item["imageHash"], 64),
            keyHash = J.text(item["keyHash"], 64),
            payloadSize = J.whole(item["payloadSize"], 0, 1L shl 32),
            headerSize = J.whole(item["headerSize"], 0, 0xffff),
            loadAddress = J.whole(item["loadAddress"], 0, 1L shl 32),
            filename = J.text(item["filename"], 64),
            uploadedBy = J.person(item["uploadedBy"]),
            revoked = if (active) null else revoked,
        )
    }

    /**
     * The release list. A release that cannot be read is left out rather than failing the
     * whole list; the filters further on leave out what is not active or has no version.
     */
    fun releases(text: String): ReleaseList {
        val root = root(text)
        val items = root["releases"] as? JsonArray ?: throw IllegalArgumentException("The answer has no release list")
        return ReleaseList(
            releases = items.mapNotNull(::release),
            slotSize = J.whole(root["slotSize"], 1, 1L shl 32),
            fingerprint = J.text(J.obj(root["signingKey"])?.get("fingerprint"), 64),
        )
    }

    /** The answer to an upload: `{"release": {...}}`. */
    fun uploaded(text: String): Release = release(root(text)["release"]) ?: throw IllegalArgumentException("The answer has no release")

    fun revoked(text: String): Revoked {
        val root = root(text)
        val release = release(root["release"]) ?: throw IllegalArgumentException("The answer has no release")
        val cancelled = J.arr(root["cancelled"])?.mapNotNull { J.str(it)?.takeIf(::isDeploymentId) }.orEmpty()
        return Revoked(release, cancelled)
    }

    // Who is signed in.

    fun me(text: String): Me {
        val root = root(text)
        return Me(
            email = J.text(root["email"], 254),
            groups = J.texts(root["groups"]),
            canWrite = J.bool(root["canWrite"]),
            sub = J.text(root["sub"], 64),
            expiresAt = J.whole(root["expiresAt"], 0, 99_999_999_999),
        )
    }

    fun pairing(text: String): Pairing {
        val root = root(text)
        return Pairing(
            thing = J.str(root["thing"]) ?: throw IllegalArgumentException("The answer names no board"),
            name = J.text(root["name"], 32),
            passkey = J.str(root["passkey"]) ?: throw IllegalArgumentException("The answer has no passkey"),
            reportedAt = J.text(root["reportedAt"], 40),
        )
    }

    // Boards.

    private fun readStuck(value: JsonElement?): Stuck? {
        val item = J.obj(value) ?: return null
        val count = J.whole(item["count"], 0, 1L shl 32) ?: return null
        val reason = J.str(item["reason"])?.takeIf { WORD.matches(it) } ?: return null
        return Stuck(count, reason)
    }

    private fun readDiag(value: JsonElement?): Diag? {
        val item = J.obj(value) ?: return null
        val heap = J.obj(item["heap"])?.let { raw ->
            val free = J.whole(raw["free"], 0, 1L shl 31)
            val least = J.whole(raw["least"], 0, 1L shl 31)
            val size = J.whole(raw["size"], 1, 1L shl 31)
            if (free != null && least != null && size != null && free <= size && least <= size) Heap(free, least, size) else null
        }
        return Diag(
            mac = J.str(item["mac"])?.takeIf { MAC.matches(it) },
            channel = J.int(item["channel"], 0, 233),
            heap = heap,
            at = J.instant(item["at"]),
        )
    }

    private fun readDiary(value: JsonElement?): Diary? {
        val item = J.obj(value) ?: return null
        val entries = J.arr(item["entries"]) ?: return null
        val boots = J.whole(item["boots"], 0, 1L shl 32) ?: return null
        return Diary(
            boots = boots,
            entries = entries.take(16).mapNotNull { raw ->
                val entry = J.obj(raw) ?: return@mapNotNull null
                val version = versionOrNull(entry["version"]) ?: return@mapNotNull null
                val cause = J.str(entry["cause"])?.takeIf { HEX.matches(it) } ?: return@mapNotNull null
                val stage = J.int(entry["stage"], 0, 255) ?: return@mapNotNull null
                DiaryEntry(version, cause, J.texts(entry["causes"], 16).filter { it in RESET_NAMES }, stage)
            },
        )
    }

    private fun readBt(value: JsonElement?): BtRecord? {
        val item = J.obj(value) ?: return null
        val from = versionOrNull(item["from"]) ?: return null
        val to = versionOrNull(item["to"]) ?: return null
        val result = J.str(item["result"])?.takeIf { it in BT_RESULTS } ?: return null
        val proof = J.str(item["proof"])?.takeIf { it == "cloud" || it == "person" } ?: "none"
        return BtRecord(from, to, result, proof, J.whole(item["count"], 0, 1L shl 32) ?: 0)
    }

    fun readDevice(value: JsonElement?): Device {
        val item = record(value, "board")
        val fw = J.obj(item["fw"])?.let { raw ->
            versionOrNull(raw["version"])?.let { DeviceFirmware(it, J.bool(raw["confirmed"])) }
        }
        val ota = J.obj(item["ota"])?.let { raw ->
            Ota(
                state = J.boardText(raw["state"], 24).ifEmpty { "idle" },
                job = J.str(raw["job"])?.takeIf(::isDeploymentId),
                progress = J.int(raw["progress"], 0, 100) ?: 0,
                last = J.boardText(raw["last"], 24).ifEmpty { "none" },
                error = J.boardText(raw["error"], 64),
            )
        }
        return Device(
            thing = J.text(item["thing"], 64),
            online = J.bool(item["online"]),
            fw = fw,
            name = J.str(item["name"])?.takeIf { Boards.isBoardName(it) },
            lastSeen = J.instant(item["lastSeen"]),
            ota = ota,
            rssi = J.int(item["rssi"], -127, 0),
            uptime = J.whole(item["uptime"], 0, 1L shl 32),
            stuck = readStuck(item["stuck"]),
            diag = readDiag(item["diag"]),
            diary = readDiary(item["diary"]),
            bt = readBt(item["bt"]),
        )
    }

    fun devices(text: String): DeviceList {
        val root = root(text)
        return DeviceList(
            devices = list(root["devices"], "list of boards").map(::readDevice).filter { it.thing.isNotEmpty() },
            generatedAt = J.instant(root["generatedAt"]),
        )
    }

    /** The board in `GET /api/devices/{thing}`. */
    fun device(text: String): Device = readDevice(root(text)["device"])

    fun deviceDetail(text: String): DeviceDetail {
        val root = root(text)
        return DeviceDetail(
            device = readDevice(root["device"]),
            certificates = J.texts(root["certificates"]).map { id ->
                id.map { if (it in ' '..'~') it else '?' }.joinToString("").take(96)
            },
            executions = (J.arr(root["executions"])?.mapNotNull { raw ->
                val item = J.obj(raw) ?: return@mapNotNull null
                ExecutionSummary(
                    deployment = J.text(item["deployment"], 64),
                    version = versionOrNull(item["version"]),
                    status = J.text(item["status"], 24),
                    queuedAt = J.instant(item["queuedAt"]),
                    startedAt = J.instant(item["startedAt"]),
                    lastUpdatedAt = J.instant(item["lastUpdatedAt"]),
                )
            }).orEmpty(),
            olderExecutions = J.whole(root["olderExecutions"], 0, 1L shl 32) ?: 0,
            lastUpdate = readUpdate(root["lastUpdate"]),
        )
    }

    // Updates, of every kind.

    /**
     * One update, or null if it cannot be shown: no id, or no board. A value the app does not know
     * (`how`, `outcome`) is kept as the console's word; one that is not a word becomes "".
     */
    fun readUpdate(value: JsonElement?): Update? {
        val item = J.obj(value) ?: return null
        val id = J.boardText(item["id"], 160).takeIf { it.isNotEmpty() } ?: return null
        val thing = J.str(item["thing"])?.takeIf(::isThing) ?: return null
        val who = J.obj(item["who"])?.let { raw ->
            J.person(raw)?.copy(name = Words.singleLine(J.text(raw["name"], 64)).trim())
        }
        return Update(
            id = id,
            thing = thing,
            from = versionOrNull(item["from"]),
            to = versionOrNull(item["to"]),
            how = J.str(item["how"])?.takeIf { WORD.matches(it) } ?: "",
            deployment = J.boardText(item["deployment"], 64).ifEmpty { null },
            who = who,
            outcome = J.str(item["outcome"])?.takeIf { WORD.matches(it) } ?: "",
            startedAt = J.instant(item["startedAt"]),
            endedAt = J.instant(item["endedAt"]),
            status = J.str(item["status"])?.takeIf { STATUS.matches(it) },
        )
    }

    /** `GET /api/updates`: an update that cannot be shown is left out, and so is a second one with the same id. */
    fun updates(text: String): UpdatesPage {
        val root = root(text)
        return UpdatesPage(
            updates = list(root["updates"], "list of updates").mapNotNull(::readUpdate).distinctBy { it.id },
            cursor = J.str(root["cursor"])?.takeIf { it.length in 1..1024 && it.all { c -> c in '!'..'~' } },
            generatedAt = J.instant(root["generatedAt"]),
        )
    }

    // Deployments.

    private fun readCounts(value: JsonElement?): Counts {
        val item = J.obj(value)
        fun count(name: String) = J.int(item?.get(name), 0, 1000) ?: 0
        return Counts(
            count("queued"), count("inProgress"), count("succeeded"), count("failed"),
            count("rejected"), count("canceled"), count("timedOut"), count("removed"),
        )
    }

    fun readSummary(value: JsonElement?): DeploymentSummary {
        val item = record(value, "deployment")
        return DeploymentSummary(
            id = J.text(item["id"], 64),
            version = versionOrNull(item["version"]),
            status = J.text(item["status"], 32),
            createdAt = J.instant(item["createdAt"]),
            completedAt = J.instant(item["completedAt"]),
            createdBy = J.person(item["createdBy"]),
            note = J.text(item["note"], 200),
            things = J.texts(item["things"]),
            counts = readCounts(item["counts"]),
        )
    }

    private fun readExecution(value: JsonElement?): Execution {
        val item = record(value, "board of the deployment")
        return Execution(
            thing = J.text(item["thing"], 64),
            status = J.text(item["status"], 24),
            phase = J.text(item["phase"], 32),
            progress = J.int(item["progress"], 0, 100),
            reason = J.boardText(item["reason"], 48).ifEmpty { null },
            detail = J.boardText(item["detail"], 96).ifEmpty { null },
            ranAtEnd = versionOrNull(item["ranAtEnd"]),
            reported = versionOrNull(item["reported"]),
            online = J.bool(item["online"]),
            queuedAt = J.instant(item["queuedAt"]),
            startedAt = J.instant(item["startedAt"]),
            lastUpdatedAt = J.instant(item["lastUpdatedAt"]),
            secondsLeft = J.whole(item["secondsLeft"], 0, 10_000_000),
        )
    }

    private fun readDeployment(value: JsonElement?): Deployment {
        val item = record(value, "deployment")
        return Deployment(
            summary = readSummary(item),
            executions = list(item["executions"], "boards of the deployment").map(::readExecution).filter { it.thing.isNotEmpty() },
        )
    }

    fun deployments(text: String): List<DeploymentSummary> =
        list(root(text)["deployments"], "list of deployments").map(::readSummary).filter { it.id.isNotEmpty() }

    /** `{"deployment": {...}}`, the answer to reading, creating and cancelling one. */
    fun deployment(text: String): Deployment = readDeployment(root(text)["deployment"])

    // The activity log.

    private fun readAuditEntry(value: JsonElement?): AuditEntry {
        val item = record(value, "entry")
        val detail = J.obj(item["detail"])?.entries?.take(8)?.mapNotNull { (key, raw) ->
            val primitive = raw as? JsonPrimitive ?: return@mapNotNull null
            if (primitive.isString || J.long(primitive) != null || primitive.content.toDoubleOrNull() != null) {
                key.take(24) to primitive.content.take(200)
            } else {
                null
            }
        }.orEmpty()
        return AuditEntry(
            at = J.instant(item["at"]),
            actor = J.person(item["actor"]),
            action = J.text(item["action"], 48),
            target = J.text(item["target"], 96),
            outcome = J.text(item["outcome"], 24),
            detail = detail,
            requestId = J.text(item["requestId"], 64),
        )
    }

    fun audit(text: String): AuditPage {
        val root = root(text)
        return AuditPage(
            entries = list(root["entries"], "activity log").map(::readAuditEntry),
            next = J.str(root["next"])?.takeIf { CURSOR.matches(it) },
        )
    }

    // The boards' events and readings.

    private fun readEvent(value: JsonElement?): BoardEvent? {
        val item = J.obj(value) ?: return null
        val thing = J.str(item["thing"])?.takeIf(::isThing) ?: return null
        val at = J.instant(item["at"]) ?: return null
        val kind = J.str(item["kind"])?.takeIf { it in EVENT_KINDS } ?: return null
        return BoardEvent(
            thing = thing,
            at = at,
            id = J.str(item["id"])?.takeIf { EVENT_ID.matches(it) } ?: "000000",
            kind = kind,
            what = J.boardText(item["what"], 24),
            level = if (J.str(item["level"]) == "warn") "warn" else "info",
            text = J.boardText(item["text"], 200),
            job = J.str(item["job"])?.takeIf(::isDeploymentId),
        )
    }

    fun events(text: String): EventPage {
        val root = root(text)
        return EventPage(
            events = list(root["events"], "list of events").mapNotNull(::readEvent),
            cursor = J.str(root["cursor"])?.takeIf { CURSOR.matches(it) },
            from = J.instant(root["from"]),
            to = J.instant(root["to"]),
        )
    }

    /** `GET /api/events/log`: the boards' own lines; one that cannot be shown is left out. */
    fun lines(text: String): LinePage {
        val root = root(text)
        return LinePage(
            lines = list(root["lines"], "list of lines").mapNotNull(BoardLog::read),
            cursor = J.str(root["cursor"])?.takeIf { CURSOR.matches(it) },
            from = J.instant(root["from"]),
            to = J.instant(root["to"]),
        )
    }

    /** `PUT /api/firmware/{version}/notes`: the release as it is now. */
    fun noted(text: String): Release = release(root(text)["release"]) ?: throw IllegalArgumentException("The answer has no release")

    /** `POST /api/serial/commands`: what was put on record. */
    fun recorded(text: String): SerialRecord? {
        val item = J.obj(root(text)["recorded"]) ?: return null
        val command = J.str(item["command"])?.takeIf { it in SerialRules.RECORDED } ?: return null
        return SerialRecord(
            command = command,
            device = J.str(item["device"])?.takeIf { Boards.isBoardName(it) },
            version = J.str(item["version"])?.takeIf { FirmwareVersion.parseStrict(it) != null },
        )
    }

    fun samples(text: String): Samples {
        val root = root(text)
        return Samples(
            samples = list(root["samples"], "list of readings").mapNotNull { raw ->
                val item = J.obj(raw) ?: return@mapNotNull null
                val at = J.instant(item["at"]) ?: return@mapNotNull null
                Sample(
                    at = at,
                    rssi = J.int(item["rssi"], -127, 0),
                    uptime = J.whole(item["uptime"], 0, 1L shl 32),
                    heapFree = J.whole(item["heapFree"], 0, 1L shl 31),
                    heapLeast = J.whole(item["heapLeast"], 0, 1L shl 31),
                )
            },
            hours = J.int(root["hours"], 1, 168) ?: 24,
            bucketSeconds = J.whole(root["bucketSeconds"], 0, 86_400) ?: 0,
            from = J.instant(root["from"]),
            to = J.instant(root["to"]),
        )
    }

    // API tokens.

    private fun readToken(value: JsonElement?): ApiToken {
        val item = record(value, "token")
        return ApiToken(
            id = J.str(item["id"])?.takeIf { TOKEN_ID.matches(it) } ?: "",
            name = J.text(item["name"], 40),
            createdAt = J.instant(item["createdAt"]),
            expiresAt = J.instant(item["expiresAt"]),
            revokedAt = J.instant(item["revokedAt"]),
            // The server's word, for its own clock. Anything else is taken for the end of it.
            status = J.str(item["status"])?.takeIf { it in setOf("active", "expired", "revoked") } ?: "expired",
        )
    }

    fun tokens(text: String): TokenList {
        val root = root(text)
        return TokenList(
            tokens = list(root["tokens"], "list of tokens").map(::readToken).filter { it.id.isNotEmpty() },
            limit = J.int(root["limit"], 1, 1000) ?: 10,
            maxDays = J.int(root["maxDays"], 1, 3650) ?: 90,
        )
    }

    fun newToken(text: String): NewToken {
        val root = root(text)
        val token = J.str(root["token"])?.takeIf { TOKEN.matches(it) } ?: throw IllegalArgumentException("The answer has no token")
        val id = J.str(root["id"])?.takeIf { TOKEN_ID.matches(it) } ?: throw IllegalArgumentException("The answer has no token id")
        return NewToken(token, id, J.text(root["name"], 40), J.instant(root["createdAt"]), J.instant(root["expiresAt"]))
    }

    /** The answer to revoking a token: `{"token": {...}}`. */
    fun revokedToken(text: String): ApiToken = readToken(root(text)["token"])

    // Errors.

    /**
     * The error for an answer with [status] and [body]. Shows the console's own message, and for
     * a refusal of the role also what to do about it.
     */
    fun error(status: Int, body: String): ApiError {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
        val detail = J.obj(root?.get("error"))
        val code = J.text(detail?.get("code"), 64)
        val given = J.text(detail?.get("message"), 400).trim()
        // API Gateway answers some requests itself, as { "message": "..." }.
        val gateway = J.text(root?.get("message"), 200).trim()
        val message = when {
            given.isNotEmpty() -> given
            gateway.isNotEmpty() -> "$gateway (HTTP $status)."
            else -> "The console answered with HTTP $status."
        }
        val roleRefused = status == 403 && (code.isEmpty() || code == "forbidden" || code == "release_manager_required")
        val text = if (roleRefused) "$message Only a release manager can do this: ask an administrator for the role." else message
        val busy = J.arr(detail?.get("details"))?.take(25)?.mapNotNull { raw ->
            val item = J.obj(raw) ?: return@mapNotNull null
            val thing = J.str(item["thing"])?.takeIf(::isThing) ?: return@mapNotNull null
            BusyBoard(thing, J.str(item["deployment"])?.takeIf(::isDeploymentId))
        }.orEmpty()
        return ApiError(status, code, text, J.optionalText(detail?.get("requestId"), 64), busy)
    }
}
