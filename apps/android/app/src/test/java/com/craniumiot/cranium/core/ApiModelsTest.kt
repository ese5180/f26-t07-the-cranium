package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Decoding of every answer the app reads, after the website's readers in core.js. */
class ApiModelsTest {
    private val thing = "cranium-0123456789abcdef"
    private val other = "cranium-00000000000000aa"
    private val deployment = "cranium-1-11-4-b0-20261102T110000Z-0a0a"
    private val at = "2026-11-02T11:59:40.000Z"

    // Boards.

    private val devices = """
        {"devices": [
          {"thing": "$thing", "name": "CRVIHAAN01", "online": true, "lastSeen": "$at",
           "fw": {"version": "1.11.4+0", "confirmed": true},
           "ota": {"state": "downloading", "job": "$deployment", "progress": 40, "last": "none", "error": ""},
           "rssi": -52, "uptime": 3600, "stuck": {"count": 0, "reason": "none"},
           "diag": {"mac": "f4:ce:36:12:34:56", "channel": 6, "heap": {"free": 21312, "least": 9840, "size": 44240},
                    "at": "2026-11-02T11:55:00.000Z"},
           "diary": {"boots": 42, "entries": [
              {"version": "1.11.4+0", "cause": "1", "causes": ["pin", "made_up"], "stage": 4},
              {"version": "not a version", "cause": "1", "causes": [], "stage": 1}]},
           "bt": {"from": "1.9.0+0", "to": "1.10.0+0", "result": "succeeded", "proof": "person", "count": 3}},
          {"thing": "$other", "name": "bad name!", "online": "yes", "fw": {"version": "1.8.0"}, "rssi": 12, "uptime": -1,
           "ota": {"state": "idle", "job": "not-a-job", "progress": 500},
           "diag": {"mac": "nope", "channel": 300, "heap": {"free": 5, "least": 1, "size": 2}},
           "bt": {"from": "1.0.0+0", "to": "1.1.0+0", "result": "exploded"},
           "stuck": {"count": 1, "reason": "Not A Word"}},
          {"thing": "cranium-00000000000000bb"},
          {"thing": ""}
        ], "generatedAt": "$at"}
    """.trimIndent()

    @Test
    fun `a board's name comes from the API, with its thing name kept for every call`() {
        val list = ApiJson.devices(devices)
        assertEquals(3, list.devices.size)
        assertEquals(at, list.generatedAt)
        val named = list.devices[0]
        assertEquals(thing, named.thing)
        assertEquals("CRVIHAAN01", named.name)
        assertNull("not 1 to 32 letters and digits", list.devices[1].name)
        assertNull("absent", list.devices[2].name)
        val long = ApiJson.devices("""{"devices": [{"thing": "$thing", "name": "${"A".repeat(33)}"}]}""").devices[0]
        assertNull(long.name)
        assertEquals("A".repeat(32), ApiJson.devices("""{"devices": [{"thing": "$thing", "name": "${"A".repeat(32)}"}]}""").devices[0].name)
    }

    @Test
    fun `what a board reports is read field by field`() {
        val board = ApiJson.devices(devices).devices[0]
        assertTrue(board.online)
        assertEquals(at, board.lastSeen)
        assertEquals(DeviceFirmware("1.11.4+0", true), board.fw)
        assertEquals(Ota("downloading", deployment, 40, "none", ""), board.ota)
        assertEquals(-52, board.rssi)
        assertEquals(3600L, board.uptime)
        assertEquals(Stuck(0, "none"), board.stuck)
        assertEquals(Diag("f4:ce:36:12:34:56", 6, Heap(21312, 9840, 44240), "2026-11-02T11:55:00.000Z"), board.diag)
        assertEquals(42L, board.diary!!.boots)
        assertEquals(listOf(DiaryEntry("1.11.4+0", "1", listOf("pin"), 4)), board.diary.entries)
        assertEquals(BtRecord("1.9.0+0", "1.10.0+0", "succeeded", "person", 3), board.bt)
    }

    @Test
    fun `an odd value becomes null or a harmless default, and the rest of the list stays`() {
        val odd = ApiJson.devices(devices).devices[1]
        assertEquals(other, odd.thing)
        assertFalse("only true is online", odd.online)
        assertNull("1.8.0 is not the API's form", odd.fw)
        assertNull(odd.rssi)
        assertNull(odd.uptime)
        assertEquals(Ota("idle", null, 0, "none", ""), odd.ota)
        assertEquals(Diag(null, null, null, null), odd.diag)
        assertNull(odd.bt)
        assertNull(odd.stuck)
        val bare = ApiJson.devices(devices).devices[2]
        assertEquals(Device(thing = "cranium-00000000000000bb"), bare)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a list of boards that is not a list is an error`() {
        ApiJson.devices("""{"devices": {}}""")
    }

    @Test
    fun `a board's text is cut to printable ASCII`() {
        val board = ApiJson.devices(
            """{"devices": [{"thing": "$thing", "ota": {"state": "idle", "job": null, "progress": 0, "last": "none", "error": "badé \u0007x"}}]}""",
        ).devices[0]
        assertEquals("bad? ?x", board.ota!!.error)
    }

    @Test
    fun `a board's page has its certificates and its history of updates`() {
        val detail = ApiJson.deviceDetail(
            """
            {"device": {"thing": "$thing", "online": false},
             "certificates": ["0123456789abcdef", 5],
             "executions": [
               {"deployment": "$deployment", "version": "1.11.4+0", "status": "SUCCEEDED",
                "queuedAt": "2026-11-02T11:00:00.000Z", "startedAt": null, "lastUpdatedAt": "2026-11-02T11:05:00.000Z"},
               {"deployment": "made-elsewhere", "version": "bad", "status": "FAILED", "queuedAt": "never"},
               "not an object"
             ],
             "olderExecutions": 3}
            """.trimIndent(),
        )
        assertEquals(thing, detail.device.thing)
        assertEquals(listOf("0123456789abcdef"), detail.certificates)
        assertEquals(2, detail.executions.size)
        assertEquals(
            ExecutionSummary(deployment, "1.11.4+0", "SUCCEEDED", "2026-11-02T11:00:00.000Z", null, "2026-11-02T11:05:00.000Z"),
            detail.executions[0],
        )
        assertNull(detail.executions[1].version)
        assertNull(detail.executions[1].queuedAt)
        assertEquals(3L, detail.olderExecutions)
        assertEquals(thing, ApiJson.device("""{"device": {"thing": "$thing"}}""").thing)
    }

    // Deployments.

    private val summary = """
        "id": "$deployment", "version": "1.11.4+0", "status": "IN_PROGRESS", "createdAt": "2026-11-02T11:00:00.000Z",
        "completedAt": null, "createdBy": {"sub": "s-1", "email": "rm@example.com"}, "note": "Field trial",
        "things": ["$thing", 7], "counts": {"queued": 1, "inProgress": "2", "succeeded": 3}
    """.trimIndent()

    @Test
    fun `the list of deployments is read, and one without an id is left out`() {
        val list = ApiJson.deployments("""{"deployments": [{$summary}, {"id": ""}]}""")
        assertEquals(1, list.size)
        val first = list[0]
        assertEquals(deployment, first.id)
        assertEquals("1.11.4+0", first.version)
        assertEquals("IN_PROGRESS", first.status)
        assertNull(first.completedAt)
        assertEquals(Person("s-1", "rm@example.com"), first.createdBy)
        assertEquals("Field trial", first.note)
        assertEquals(listOf(thing), first.things)
        assertEquals(Counts(queued = 1, inProgress = 0, succeeded = 3), first.counts)
    }

    @Test
    fun `a deployment has each board's part, as the board said it`() {
        val read = ApiJson.deployment(
            """
            {"deployment": {$summary, "executions": [
              {"thing": "$thing", "status": "IN_PROGRESS", "phase": "downloading", "progress": 40, "reason": "xéy",
               "detail": "", "ranAtEnd": null, "reported": "1.10.0+0", "online": true, "queuedAt": "2026-11-02T11:00:00.000Z",
               "startedAt": "2026-11-02T11:01:00.000Z", "lastUpdatedAt": "2026-11-02T11:02:00.000Z", "secondsLeft": 120},
              {"thing": ""}
            ]}}
            """.trimIndent(),
        )
        assertEquals(deployment, read.id)
        assertEquals("1.11.4+0", read.version)
        assertEquals("IN_PROGRESS", read.status)
        assertEquals(1, read.executions.size)
        val execution = read.executions[0]
        assertEquals("downloading", execution.phase)
        assertEquals(40, execution.progress)
        assertEquals("x?y", execution.reason)
        assertNull("empty is none", execution.detail)
        assertNull(execution.ranAtEnd)
        assertEquals("1.10.0+0", execution.reported)
        assertTrue(execution.online)
        assertEquals(120L, execution.secondsLeft)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a deployment without its boards is an error`() {
        ApiJson.deployment("""{"deployment": {$summary}}""")
    }

    @Test
    fun `counts add up and are read by name`() {
        val counts = Counts(queued = 1, inProgress = 2) + Counts(succeeded = 3, removed = 1)
        assertEquals(7, counts.total)
        assertEquals(2, counts["inProgress"])
        assertEquals(0, counts["nothing"])
        assertEquals(Counts(queued = 2, failed = 1, canceled = 1), Counts.of(listOf("QUEUED", "QUEUED", "FAILED", "CANCELED", "ODD")))
    }

    // The activity log.

    @Test
    fun `an entry of the activity log keeps its details in order, numbers as text`() {
        val page = ApiJson.audit(
            """
            {"entries": [{"at": "2026-11-02T11:00:00.000Z", "actor": {"sub": "s-1", "email": "rm@example.com"},
              "action": "firmware.upload", "target": "zephyr.signed.bin", "outcome": "rejected",
              "detail": {"code": "wrong_key", "size": 1264, "flag": true, "nested": {}, "empty": null, "share": 12.5},
              "requestId": "req-1"}],
             "next": "abc_-123"}
            """.trimIndent(),
        )
        val entry = page.entries.single()
        assertEquals("2026-11-02T11:00:00.000Z", entry.at)
        assertEquals(Person("s-1", "rm@example.com"), entry.actor)
        assertEquals(listOf("code" to "wrong_key", "size" to "1264", "share" to "12.5"), entry.detail)
        assertEquals("req-1", entry.requestId)
        assertEquals("abc_-123", page.next)
        assertNull(ApiJson.audit("""{"entries": [], "next": "not a cursor!"}""").next)
        assertNull(ApiJson.audit("""{"entries": []}""").next)
    }

    // Events and readings.

    @Test
    fun `an event that names no board of this project, no time or no kind is left out`() {
        val page = ApiJson.events(
            """
            {"events": [
              {"thing": "$thing", "at": "2026-11-02T11:00:00.000Z", "id": "00000a", "kind": "update", "what": "step",
               "level": "warn", "text": "Downloading 1.11.4+0", "job": "$deployment"},
              {"thing": "not-a-board", "at": "2026-11-02T11:00:00.000Z", "kind": "update"},
              {"thing": "$thing", "at": "2026-11-02T11:00:00.000Z", "kind": "made_up"},
              {"thing": "$thing", "at": "not a time", "kind": "update"},
              {"thing": "$thing", "at": "2026-11-02T10:00:00.000Z", "id": "zz", "kind": "connection", "what": "connected",
               "level": "info", "text": "Connected to AWS IoT", "job": "nope"}
            ], "cursor": "abc", "from": "2026-11-01T12:00:00.000Z", "to": "2026-11-02T12:00:00.000Z"}
            """.trimIndent(),
        )
        assertEquals(2, page.events.size)
        val first = page.events[0]
        assertEquals("warn", first.level)
        assertEquals(deployment, first.job)
        assertEquals("00000a", first.id)
        assertEquals(Times.parse("2026-11-02T11:00:00.000Z"), first.atMs)
        val second = page.events[1]
        assertEquals("000000", second.id)
        assertEquals("info", second.level)
        assertNull("only a deployment of this console", second.job)
        assertEquals("abc", page.cursor)
        assertEquals("2026-11-01T12:00:00.000Z", page.from)
    }

    @Test
    fun `a board's readings are read, a reading without a time left out`() {
        val samples = ApiJson.samples(
            """
            {"thing": "$thing", "hours": 24, "from": "2026-11-01T12:00:00.000Z", "to": "2026-11-02T12:00:00.000Z",
             "samples": [{"at": "2026-11-02T11:00:00.000Z", "rssi": -60, "uptime": 10, "heapFree": 100, "heapLeast": 90},
                         {"at": "2026-11-02T11:00:30.000Z", "rssi": 5, "uptime": null},
                         {"rssi": -50}],
             "bucketSeconds": 144}
            """.trimIndent(),
        )
        assertEquals(2, samples.samples.size)
        assertEquals(Sample("2026-11-02T11:00:00.000Z", -60, 10, 100, 90), samples.samples[0])
        assertEquals(Sample("2026-11-02T11:00:30.000Z", null, null, null, null), samples.samples[1])
        assertEquals(24, samples.hours)
        assertEquals(144L, samples.bucketSeconds)
        assertEquals(24, ApiJson.samples("""{"samples": [], "hours": 900}""").hours)
    }

    // Releases.

    @Test
    fun `a revoked release says whether the server recorded the end of its revocation`() {
        val list = ApiJson.releases(
            """
            {"releases": [
              {"version": "1.9.0+0", "size": 10, "sha256": "aa", "status": "revoked",
               "revoked": {"by": {"sub": "s", "email": "e"}, "at": "2026-11-01T00:00:00.000Z", "reason": "bad", "enforcedAt": null}},
              {"version": "1.8.0+0", "size": 10, "sha256": "bb", "status": "revoked",
               "revoked": {"at": "2026-11-01T00:00:00.000Z", "reason": "old server"}},
              {"version": "1.7.0+0", "size": 10, "sha256": "cc", "status": "active", "revoked": {"reason": "ignored"},
               "uploadedBy": {"sub": "u", "email": "up@example.com"}, "payloadSize": 9, "headerSize": 512, "loadAddress": 65536}
            ], "signingKey": {"fingerprint": "abcd"}, "slotSize": 794624}
            """.trimIndent(),
        )
        assertEquals("abcd", list.fingerprint)
        val incomplete = list.releases[0].revoked!!
        assertTrue(incomplete.recordsEnforcement)
        assertNull(incomplete.enforcedAt)
        assertEquals(Person("s", "e"), incomplete.by)
        assertFalse(list.releases[1].revoked!!.recordsEnforcement)
        val active = list.releases[2]
        assertNull("an active release has no revocation", active.revoked)
        assertEquals(Person("u", "up@example.com"), active.uploadedBy)
        assertEquals(512L, active.headerSize)
        assertEquals(65536L, active.loadAddress)
    }

    @Test
    fun `the answers to an upload and a revocation`() {
        val release = """{"version": "1.9.0+0", "size": 10, "sha256": "aa", "status": "active"}"""
        assertEquals("1.9.0+0", ApiJson.uploaded("""{"release": $release}""").version)
        val revoked = ApiJson.revoked("""{"release": $release, "cancelled": ["$deployment", "nope", 5]}""")
        assertEquals(listOf(deployment), revoked.cancelled)
        assertEquals(emptyList<String>(), ApiJson.revoked("""{"release": $release}""").cancelled)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an upload answer without a release is an error`() {
        ApiJson.uploaded("""{"ok": true}""")
    }

    // API tokens.

    private val token = "crn_" + "A".repeat(43)

    @Test
    fun `the list of tokens is read, a token without an id left out, an unknown state taken for expired`() {
        val list = ApiJson.tokens(
            """
            {"tokens": [
              {"id": "0123456789abcdef", "name": "laptop", "createdAt": "2026-11-01T00:00:00.000Z",
               "expiresAt": "2026-12-01T00:00:00.000Z", "revokedAt": null, "status": "active"},
              {"id": "bad", "name": "x", "status": "active"},
              {"id": "fedcba9876543210", "name": "old", "status": "weird"}
            ], "limit": 10, "maxDays": 90}
            """.trimIndent(),
        )
        assertEquals(2, list.tokens.size)
        assertEquals(ApiToken("0123456789abcdef", "laptop", "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", null, "active"), list.tokens[0])
        assertEquals("expired", list.tokens[1].status)
        assertEquals(10, list.limit)
        assertEquals(90, list.maxDays)
        assertEquals(10, ApiJson.tokens("""{"tokens": []}""").limit)
    }

    @Test
    fun `a new token is taken only in its own form`() {
        val made = ApiJson.newToken("""{"token": "$token", "id": "0123456789abcdef", "name": "laptop", "expiresAt": "2026-12-01T00:00:00.000Z"}""")
        assertEquals(token, made.token)
        assertEquals("0123456789abcdef", made.id)
        assertEquals("2026-12-01T00:00:00.000Z", made.expiresAt)
        for (bad in listOf("crn_short", "abc_" + "A".repeat(43), token + "A")) {
            val refused = runCatching { ApiJson.newToken("""{"token": "$bad", "id": "0123456789abcdef"}""") }
            assertTrue(bad, refused.exceptionOrNull() is IllegalArgumentException)
        }
        assertTrue(runCatching { ApiJson.newToken("""{"token": "$token", "id": "nope"}""") }.isFailure)
        val revoked = ApiJson.revokedToken("""{"token": {"id": "0123456789abcdef", "name": "laptop", "status": "revoked", "revokedAt": "2026-11-02T00:00:00.000Z"}}""")
        assertEquals("revoked", revoked.status)
        assertEquals("2026-11-02T00:00:00.000Z", revoked.revokedAt)
    }

    // Errors.

    @Test
    fun `a busy board is named in the details of the refusal, with the request id`() {
        val error = ApiJson.error(
            409,
            """
            {"error": {"code": "device_busy", "message": "$thing still has an update that is not finished.",
             "requestId": "r-1", "details": [
               {"thing": "$thing", "deployment": "$deployment"}, {"thing": "bad"}, {"thing": "$other", "deployment": "nope"}, 5]}}
            """.trimIndent(),
        )
        assertEquals(409, error.status)
        assertEquals("device_busy", error.code)
        assertEquals("r-1", error.requestId)
        assertEquals(listOf(BusyBoard(thing, deployment), BusyBoard(other, null)), error.details)
        assertEquals("$thing still has an update that is not finished.", error.message)
    }

    @Test
    fun `the gateway's own answer, and a refusal that is not about the role`() {
        val gateway = ApiJson.error(429, """{"message": "Too Many Requests"}""")
        assertEquals("Too Many Requests (HTTP 429).", gateway.message)
        assertEquals("", gateway.code)
        assertNull(gateway.requestId)
        assertEquals(emptyList<BusyBoard>(), gateway.details)

        val fresh = ApiJson.error(403, """{"error": {"code": "phone_sign_in_again", "message": "Sign in again first."}}""")
        assertEquals("Sign in again first.", fresh.message)
        val role = ApiJson.error(403, """{"error": {"code": "release_manager_required", "message": "Only release managers can do this."}}""")
        assertTrue(role.message!!.endsWith("Only a release manager can do this: ask an administrator for the role."))
        val bare = ApiJson.error(403, "")
        assertEquals("The console answered with HTTP 403. Only a release manager can do this: ask an administrator for the role.", bare.message)
    }

    @Test
    fun `me says who is signed in, what they may do, and when the session ends`() {
        val me = ApiJson.me("""{"sub": "s-1", "email": "rm@example.com", "groups": ["release-managers", 7], "canWrite": true, "expiresAt": 1798000000}""")
        assertEquals(Me("rm@example.com", listOf("release-managers"), true, "s-1", 1798000000), me)
        assertNull(ApiJson.me("""{"expiresAt": "soon"}""").expiresAt)
        assertFalse(ApiJson.me("""{"canWrite": "true"}""").canWrite)
    }

    @Test
    fun `thing names and deployment ids are told apart from anything else`() {
        assertTrue(ApiJson.isThing(thing))
        assertFalse(ApiJson.isThing("cranium-0123456789ABCDEF"))
        assertFalse(ApiJson.isThing(null))
        assertTrue(ApiJson.isDeploymentId(deployment))
        assertFalse(ApiJson.isDeploymentId("cranium-1-11-4-b0-20261102T110000Z-0A0A"))
        assertFalse(ApiJson.isDeploymentId("made-elsewhere"))
    }
}
