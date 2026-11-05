package com.craniumiot.cranium.update

import com.craniumiot.cranium.core.Person
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AppReleasesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val sha6 = "6".repeat(64)
    private val sha5 = "5a".repeat(32)

    // The shape cloud/api/src/handlers/apps.mjs answers with, the iPhone app and the console included.
    private val list = """
        {
          "android": {
            "latest": "0.6.0",
            "releases": [
              {
                "version": "0.6.0", "versionCode": 6, "size": 12345678, "sha256": "$sha6",
                "notes": "New versions reach every phone.", "filename": "cranium-android-0.6.0.apk",
                "publishedBy": {"sub": "abc", "email": "rm@example.com"}, "publishedAt": "2026-11-05T12:00:00.000Z",
                "somethingNew": [1, 2, 3]
              },
              {
                "version": "0.5.0", "versionCode": 5, "size": 12000000, "sha256": "$sha5",
                "notes": "", "filename": "cranium-android-0.5.0.apk",
                "publishedBy": {"sub": "", "email": ""}, "publishedAt": null
              }
            ]
          },
          "ios": {"version": "0.5.0", "notes": "The board log."},
          "console": {"version": "1.14.0", "commit": "baff264"}
        }
    """.trimIndent()

    private fun release(version: String, code: Int, size: Long = 100, sha256: String = sha6, notes: String = "") =
        AppRelease(version, code, size, sha256, notes)

    private fun download(
        url: String = "https://bucket.s3.eu-west-2.amazonaws.com/apps/android/cranium-android-0.6.0.apk?X-Amz-Signature=ab",
        version: String = "0.6.0",
        size: Long = 12345678,
        sha256: String = sha6,
    ) = """{"download": {"url": "$url", "expiresAt": "2026-11-05T12:15:00.000Z", "version": "$version",
        "filename": "cranium-android-$version.apk", "size": $size, "sha256": "$sha256"}}"""

    private fun refused(text: String) {
        try {
            AppReleaseJson.download(text)
            fail("taken: $text")
        } catch (e: IllegalArgumentException) {
            // As it should be.
        }
    }

    // The list.

    @Test
    fun `decodes the list of the Android app's releases`() {
        val releases = AppReleaseJson.releases(list)
        assertEquals(listOf("0.6.0", "0.5.0"), releases.map { it.version })
        val first = releases[0]
        assertEquals(6, first.versionCode)
        assertEquals(12_345_678L, first.size)
        assertEquals(sha6, first.sha256)
        assertEquals("New versions reach every phone.", first.notes)
        assertEquals("cranium-android-0.6.0.apk", first.filename)
        assertEquals(Person("abc", "rm@example.com"), first.publishedBy)
        assertEquals("2026-11-05T12:00:00.000Z", first.publishedAt)
        assertEquals("cranium-android-0.6.0.apk", first.localName)
        assertNull(releases[1].publishedAt)
        assertEquals("", releases[1].notes)
    }

    @Test
    fun `no release yet is an empty list`() {
        assertEquals(emptyList<AppRelease>(), AppReleaseJson.releases("""{"android": {"latest": null, "releases": []}, "ios": {}}"""))
    }

    @Test
    fun `a release it cannot read is left out, not the list`() {
        val good = """{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "$sha6"}"""
        val bad = listOf(
            "\"not an object\"",
            "null",
            // The version: three numbers with dots, as the server writes them.
            """{"version": "v0.6.0", "versionCode": 6, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6", "versionCode": 6, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.06.0", "versionCode": 6, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0/../x", "versionCode": 6, "size": 10, "sha256": "$sha6"}""",
            """{"versionCode": 6, "size": 10, "sha256": "$sha6"}""",
            // The versionCode: a whole number above zero.
            """{"version": "0.6.0", "versionCode": 0, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": -6, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": "6", "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 6.5, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 9999999999, "size": 10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "size": 10, "sha256": "$sha6"}""",
            // The size: above zero, and not absurd.
            """{"version": "0.6.0", "versionCode": 6, "size": 0, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": -10, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": "10", "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": 999999999999, "sha256": "$sha6"}""",
            """{"version": "0.6.0", "versionCode": 6, "sha256": "$sha6"}""",
            // The SHA-256: 64 lower-case hex digits.
            """{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "${"A".repeat(64)}"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "${"a".repeat(63)}"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "${"g".repeat(64)}"}""",
            """{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": null}""",
            """{"version": "0.6.0", "versionCode": 6, "size": 10}""",
        )
        for (item in bad) {
            val releases = AppReleaseJson.releases("""{"android": {"releases": [$item, $good]}}""")
            assertEquals(item, listOf("0.6.0"), releases.map { it.version })
        }
    }

    @Test
    fun `odd extras are harmless`() {
        val releases = AppReleaseJson.releases(
            """{"android": {"releases": [{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "$sha6",
                "notes": null, "publishedBy": "someone", "publishedAt": "yesterday", "filename": 7}]}}""",
        )
        val only = releases.single()
        assertEquals("", only.notes)
        assertNull(only.publishedBy)
        assertNull(only.publishedAt)
        assertEquals("", only.filename)
        // Its name on the phone comes from the version alone.
        assertEquals("cranium-android-0.6.0.apk", only.localName)
    }

    @Test
    fun `a note on several lines is shown on one`() {
        val releases = AppReleaseJson.releases(
            """{"android": {"releases": [{"version": "0.6.0", "versionCode": 6, "size": 10, "sha256": "$sha6", "notes": "One\nTwo\u0007"}]}}""",
        )
        assertEquals("One Two", releases.single().notes)
    }

    @Test
    fun `an answer without the Android list is an error`() {
        for (text in listOf("", "not json", "[]", "{}", """{"android": null}""", """{"android": {"releases": {}}}""", """{"android": {}}""")) {
            try {
                AppReleaseJson.releases(text)
                fail("taken: $text")
            } catch (e: IllegalArgumentException) {
                // As it should be.
            }
        }
    }

    // The download answer.

    @Test
    fun `decodes the download link`() {
        val link = AppReleaseJson.download(download())
        assertEquals("0.6.0", link.version)
        assertEquals(12_345_678L, link.size)
        assertEquals(sha6, link.sha256)
        assertEquals("cranium-android-0.6.0.apk", link.filename)
        assertEquals("2026-11-05T12:15:00.000Z", link.expiresAt)
        assertTrue(link.url.startsWith("https://"))
        // The link lets whoever holds it download the APK: it is never printed.
        assertFalse(link.toString().contains("X-Amz-Signature"))
        assertFalse(link.toString().contains("https"))
    }

    @Test
    fun `a download answer missing what is needed is refused`() {
        refused("{}")
        refused("""{"download": null}""")
        refused("""{"download": {"version": "0.6.0", "size": 10, "sha256": "$sha6"}}""")
        refused(download(url = "http://bucket.example.com/a.apk"))
        refused(download(url = "file:///sdcard/a.apk"))
        refused(download(url = "https://user:pw@bucket.example.com/a.apk"))
        refused(download(url = "https:///a.apk"))
        refused(download(url = "not a url"))
        refused(download(version = "0.6"))
        refused(download(size = -1))
        refused(download(size = 0))
        refused(download(sha256 = "bad"))
        refused(download(sha256 = sha5.uppercase()))
        refused(download(sha256 = sha6 + "6"))
        refused("""{"download": {"url": "https://b.example.com/a", "version": "0.6.0", "size": "10", "sha256": "$sha6"}}""")
        refused("""{"download": {"url": "https://b.example.com/a", "version": "0.6.0", "size": 10}}""")
    }

    @Test
    fun `the download answer must describe the APK the list did`() {
        val listed = AppReleaseJson.releases(list).first()
        assertNull(AppUpdates.disagreement(listed, AppReleaseJson.download(download())))
        assertNotNull(AppUpdates.disagreement(listed, AppReleaseJson.download(download(version = "0.5.0"))))
        assertNotNull(AppUpdates.disagreement(listed, AppReleaseJson.download(download(size = 12345679))))
        val otherSha = AppUpdates.disagreement(listed, AppReleaseJson.download(download(sha256 = "7".repeat(64))))
        assertNotNull(otherSha)
        assertTrue(otherSha!!, otherSha.contains("SHA-256") && otherSha.contains("nothing was downloaded"))
    }

    // Which release, and whether it is an update.

    @Test
    fun `the newest is the highest versionCode, wherever it is in the list`() {
        val a = release("0.5.0", 5)
        val b = release("0.6.0", 6)
        val c = release("0.5.1", 7)
        assertEquals(c, AppUpdates.newest(listOf(a, b, c)))
        assertEquals(c, AppUpdates.newest(listOf(c, a, b)))
        assertEquals(b, AppUpdates.newest(listOf(b)))
        assertNull(AppUpdates.newest(emptyList()))
        // Two with one versionCode cannot both be on the console; if they were, the first listed.
        val twin = release("0.6.1", 6)
        assertEquals(b, AppUpdates.newest(listOf(b, twin)))
    }

    @Test
    fun `an update is offered only above this build's versionCode`() {
        val releases = listOf(release("0.6.0", 6), release("0.5.0", 5))
        assertEquals("0.6.0", AppUpdates.available(releases, installedCode = 5)?.version)
        assertEquals("0.6.0", AppUpdates.available(releases, installedCode = 1)?.version)
        // The same version: nothing to do.
        assertNull(AppUpdates.available(releases, installedCode = 6))
        // A build newer than anything published, as on a developer's phone.
        assertNull(AppUpdates.available(releases, installedCode = 7))
        assertNull(AppUpdates.available(emptyList(), installedCode = 5))
    }

    @Test
    fun `a list with only malformed releases offers nothing`() {
        val releases = AppReleaseJson.releases(
            """{"android": {"releases": [{"version": "9.9.9", "versionCode": "99", "size": 10, "sha256": "$sha6"},
                {"version": "9.9.8", "versionCode": 98, "size": -1, "sha256": "$sha6"}]}}""",
        )
        assertNull(AppUpdates.available(releases, installedCode = 5))
    }

    @Test
    fun `a version is notified once`() {
        val six = release("0.6.0", 6)
        assertTrue(AppUpdates.shouldNotify(six, lastNotifiedCode = 0))
        assertTrue(AppUpdates.shouldNotify(six, lastNotifiedCode = 5))
        assertFalse(AppUpdates.shouldNotify(six, lastNotifiedCode = 6))
        assertFalse(AppUpdates.shouldNotify(six, lastNotifiedCode = 7))
    }

    @Test
    fun `what the banner says`() {
        assertEquals("Update available: 0.6.0 — New versions reach every phone.", AppUpdates.headline(release("0.6.0", 6, notes = "New versions reach every phone.")))
        assertEquals("Update available: 0.6.0", AppUpdates.headline(release("0.6.0", 6)))
    }

    // The file.

    @Test
    fun `SHA-256 in lower-case hex, by the known vectors`() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Sha256.of("abc".toByteArray()))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256.of(ByteArray(0)))
        assertEquals("000fff807f", Sha256.hex(byteArrayOf(0x00, 0x0f, 0xff.toByte(), 0x80.toByte(), 0x7f)))
        val file = folder.newFile("abc.apk").apply { writeText("abc") }
        assertEquals(Arrived(3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), Sha256.of(file))
    }

    @Test
    fun `the file must be the size and the SHA-256 the console gave`() {
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        val apk = folder.newFile("cranium-android-0.6.0.apk").apply { writeBytes(bytes) }
        val good = release("0.6.0", 6, size = bytes.size.toLong(), sha256 = Sha256.of(bytes))
        assertNull(ApkFiles.verify(apk, good))
        // The console writes it in lower case; the same digest in upper case is the same.
        assertNull(ApkFiles.verify(apk, good.copy(sha256 = good.sha256.uppercase())))

        val size = ApkFiles.verify(apk, good.copy(size = good.size + 1))
        assertNotNull(size)
        assertTrue(size!!, size.contains("deleted") && size.contains("nothing was installed"))
        val sha = ApkFiles.verify(apk, good.copy(sha256 = "0".repeat(64)))
        assertNotNull(sha)
        assertTrue(sha!!, sha.contains("SHA-256"))

        // One byte more than described, as the download reads at most: refused by its size.
        assertNotNull(AppUpdates.fileProblem(good, Arrived(good.size + 1, good.sha256)))
        assertNotNull(ApkFiles.verify(folder.root.resolve("gone.apk"), good))
    }

    @Test
    fun `old downloads are cleaned up, the one in use is kept`() {
        val dir = folder.newFolder("updates")
        dir.resolve("cranium-android-0.5.0.apk").writeText("old")
        dir.resolve("cranium-android-0.6.0.apk.part").writeText("cut short")
        dir.resolve("cranium-android-0.6.0.apk").writeText("current")
        ApkFiles.clean(dir, keep = "cranium-android-0.6.0.apk")
        assertEquals(listOf("cranium-android-0.6.0.apk"), dir.list()!!.toList())
        ApkFiles.clean(dir)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
        // No folder yet: nothing to do.
        ApkFiles.clean(folder.root.resolve("none"))
    }
}
