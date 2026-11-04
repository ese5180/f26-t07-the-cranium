package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchTest {

    private fun item(title: String, subtitle: String = "", keywords: List<String> = emptyList(), kind: SearchKind = SearchKind.SCREEN, key: String = title) =
        SearchItem(kind, key, title, subtitle, keywords, SearchTarget.Screen(key))

    private fun shown(text: String, range: IntRange) = text.substring(range.first, range.last + 1)

    // Folding.

    @Test
    fun `folding drops case and accents`() {
        assertEquals("passwordreset", Search.fold("PässwördReset"))
        assertEquals("cafe", Search.fold("CAFÉ"))
        assertEquals("strasse", Search.fold("Straße"))
        // A decomposed accent folds like a precomposed one.
        assertEquals(Search.fold("é"), Search.fold("é"))
    }

    @Test
    fun `full-width letters fold to plain ones`() {
        assertEquals("abc1", Search.fold("ＡＢＣ１"))
    }

    @Test
    fun `tokens split on white space and keep punctuation inside a word`() {
        assertEquals(listOf("1.11", "board"), Search.tokens("  1.11   Board "))
        assertEquals(emptyList<String>(), Search.tokens("   "))
        assertEquals(listOf("cranium-0123"), Search.tokens("Cranium-0123"))
    }

    // Matching.

    @Test
    fun `an accented title is found without its accents, and its accents are highlighted`() {
        val hits = Search.rank("passwo", listOf(item("Pässwörd reset")))
        assertEquals(1, hits.size)
        assertEquals("Pässwö", shown("Pässwörd reset", hits[0].titleRanges.single()))
        // And the other way round: an accented query finds plain text.
        assertEquals(1, Search.rank("PÄSS", listOf(item("password"))).size)
    }

    @Test
    fun `a decomposed accent in the title is highlighted with its letter`() {
        val title = "Café board"
        val hit = Search.rank("cafe", listOf(item(title))).single()
        assertEquals("Café", shown(title, hit.titleRanges.single()))
    }

    @Test
    fun `the start of a word beats the inside of one`() {
        val hits = Search.rank("dash", listOf(item("Splashdash"), item("The dash board")))
        assertEquals(listOf("The dash board", "Splashdash"), hits.map { it.item.title })
        assertTrue(hits[0].score > hits[1].score)
    }

    @Test
    fun `the start of the title beats a later word`() {
        val hits = Search.rank("board", listOf(item("New board"), item("Boards")))
        assertEquals("Boards", hits[0].item.title)
    }

    @Test
    fun `every word must match`() {
        val items = listOf(item("Deploy a release"), item("Upload firmware"))
        assertEquals(listOf("Deploy a release"), Search.rank("deploy release", items).map { it.item.title })
        assertEquals(emptyList<SearchHit>(), Search.rank("deploy firmware", items))
        assertEquals(emptyList<SearchHit>(), Search.rank("   ", items))
    }

    @Test
    fun `a version prefix finds the version`() {
        val hits = Search.rank("1.11", listOf(item("1.11.4+0", kind = SearchKind.RELEASE), item("1.10.0+0", kind = SearchKind.RELEASE)))
        assertEquals(listOf("1.11.4+0"), hits.map { it.item.title })
        assertEquals("1.11", shown("1.11.4+0", hits[0].titleRanges.single()))
    }

    @Test
    fun `the whole title scores highest, then a title that starts with the query`() {
        val hits = Search.rank("api tokens", listOf(item("Using API tokens"), item("API tokens list"), item("API tokens")))
        assertEquals(listOf("API tokens", "API tokens list", "Using API tokens"), hits.map { it.item.title })
    }

    @Test
    fun `subtitle and keywords match, and rank below the title`() {
        val items = listOf(
            item("Account", subtitle = "Who is signed in"),
            item("Sign out", keywords = listOf("logout")),
            item("Signed boards"),
        )
        val hits = Search.rank("sign", items)
        // Both titles start with the word; the shorter one is the closer match.
        assertEquals(listOf("Sign out", "Signed boards", "Account"), hits.map { it.item.title })
        assertEquals(setOf("Account", "Sign out", "Signed boards"), hits.map { it.item.title }.toSet())
        val account = hits.first { it.item.title == "Account" }
        assertEquals("sign", shown("Who is signed in", account.subtitleRanges.single()).lowercase())
        assertEquals(emptyList<IntRange>(), account.titleRanges)
        // A keyword alone: found, but nothing shown is highlighted.
        val logout = Search.rank("logout", items).single()
        assertEquals("Sign out", logout.item.title)
        assertTrue(logout.titleRanges.isEmpty() && logout.subtitleRanges.isEmpty())
    }

    @Test
    fun `highlights of two words next to each other merge`() {
        val hit = Search.rank("new dep", listOf(item("new deployment"))).single()
        assertEquals(listOf(0..2, 4..6), hit.titleRanges)
        assertEquals(listOf(0..6), Search.merged(listOf(4..6, 0..3)))
        assertEquals(listOf(0..3, 5..6), Search.merged(listOf(5..6, 0..3)))
    }

    @Test
    fun `results are grouped by kind, the best group first, at most the limit each`() {
        val items = (1..10).map { item("Board $it", kind = SearchKind.BOARD, key = "b$it") } +
            item("Board", kind = SearchKind.HELP, key = "help") +
            item("Old board", kind = SearchKind.RELEASE, key = "r")
        val groups = Search.grouped(Search.rank("board", items), limit = 3)
        assertEquals(listOf(SearchKind.HELP, SearchKind.BOARD, SearchKind.RELEASE), groups.map { it.first })
        assertEquals(3, groups[1].second.size)
        assertEquals("Boards", SearchKind.BOARD.heading)
        assertEquals("Screens and actions", SearchKind.SCREEN.heading)
    }

    // What can be found.

    @Test
    fun `boards are found by name, thing, firmware and state`() {
        val named = Device(thing = "cranium-0123456789abcdef", online = true, fw = DeviceFirmware("1.11.4+0", false), name = "CRVIHAAN01", lastSeen = "2026-11-02T03:04:05.000Z")
        val plain = Device(thing = "cranium-fedcba9876543210", online = false)
        val items = Search.boards(listOf(named, plain))
        assertEquals("CRVIHAAN01", items[0].title)
        assertEquals("cranium-0123456789abcdef · Online · 1.11.4+0 on trial", items[0].subtitle)
        assertEquals(SearchTarget.Board("cranium-0123456789abcdef"), items[0].target)
        assertEquals("cranium-fedcba9876543210", items[1].title)
        assertEquals("Never connected · Firmware not reported", items[1].subtitle)
        assertEquals("cranium-0123456789abcdef", Search.rank("0123456789", items).single().item.key)
        assertEquals(SearchKind.BOARD, Search.rank("crvihaan", items).single().item.kind)
        assertEquals(1, Search.rank("1.11.4", items).size)
    }

    @Test
    fun `releases say whether they are revoked, and are found by the reason`() {
        val active = Release("1.11.4+0", 10, "aa", "active", notes = "LEDs take turns")
        val revoked = Release("1.11.3+0", 10, "bb", "revoked", revoked = Revocation(reason = "Bricks the Wi-Fi"))
        val items = Search.releases(listOf(active, revoked))
        assertEquals("Active · LEDs take turns", items[0].subtitle)
        assertEquals("Revoked", items[1].subtitle)
        assertEquals(SearchTarget.Release("1.11.3+0"), Search.rank("bricks", items).single().item.target)
    }

    @Test
    fun `deployments are named by their version and their boards`() {
        val board = Device(thing = "cranium-0123456789abcdef", name = "CRVIHAAN01")
        val deployment = DeploymentSummary(
            id = "cranium-1-11-4-b0-20261102T030405Z-abcd", version = "1.11.4+0", status = "COMPLETED",
            createdAt = "2026-11-02T03:04:05.000Z", completedAt = null, createdBy = Person("sub", "rm@example.invalid"),
            note = "Night update", things = listOf(board.thing), counts = Counts(succeeded = 1),
        )
        val item = Search.deployments(listOf(deployment), listOf(board)).single()
        assertEquals("Deployment of 1.11.4+0", item.title)
        assertTrue(item.subtitle, item.subtitle.endsWith(" · CRVIHAAN01"))
        assertEquals(SearchTarget.Deployment(deployment.id), item.target)
        assertEquals(1, Search.rank("night", listOf(item)).size)
        assertEquals(1, Search.rank("rm@example", listOf(item)).size)
        val unknown = Search.deployments(listOf(deployment.copy(version = null)), emptyList()).single()
        assertEquals("Deployment of unknown version", unknown.title)
    }

    @Test
    fun `events of boards are found, the console's are left to the activity`() {
        val board = BoardEvent("cranium-0123456789abcdef", "2026-11-02T03:04:05.000Z", "a1b2c3", "restart", "restarted", "warn", "Restarted after 3 h up")
        val console = BoardEvent(null, "2026-11-02T03:04:06.000Z", "req", "console", "deployment.create", "info", "someone started a deployment")
        val items = Search.events(listOf(board, console), emptyList())
        val item = items.single()
        assertEquals("Restarted after 3 h up", item.title)
        assertTrue(item.subtitle, item.subtitle.startsWith("cranium-0123456789abcdef · Restart · "))
        assertEquals(SearchTarget.Event("cranium-0123456789abcdef", Telemetry.eventKey(board)), item.target)
    }

    @Test
    fun `activity leads to what it is about`() {
        val entry = AuditEntry(
            at = "2026-11-02T03:04:05.000Z", actor = Person("sub-1", "rm@example.invalid"), action = "deployment.create",
            target = "cranium-1-11-4-b0-20261102T030405Z-abcd", outcome = "ok", detail = listOf("things" to "1"), requestId = "req-1",
        )
        val item = Search.activity(listOf(entry)).single()
        assertEquals("rm@example.invalid deployed 1.11.4+0 to 1 board", item.title)
        assertEquals(SearchTarget.Activity(LogLink.ToDeployment("cranium-1-11-4-b0-20261102T030405Z-abcd")), item.target)
        assertEquals(SearchKind.ACTIVITY, Search.rank("deployed 1.11", listOf(item)).single().item.kind)
    }

    @Test
    fun `the catalog leaves out what changes things for a viewer`() {
        val viewer = SearchCatalog.items(canWrite = false).map { it.key }
        val manager = SearchCatalog.items(canWrite = true).map { it.key }
        for (id in listOf("deploy", "upload", "serial", "bluetooth")) {
            assertFalse(id, id in viewer)
            assertTrue(id, id in manager)
        }
        assertTrue("signout" in viewer && "tokens" in viewer && "help" in viewer)
        assertEquals(SearchCatalog.SCREENS.size, manager.size)
        assertEquals(SearchTarget.Screen("signout"), Search.rank("log out", SearchCatalog.items(false)).first().item.target)
        assertEquals("serial", Search.rank("usb", SearchCatalog.items(true)).first().item.key)
    }

    // Recent searches.

    @Test
    fun `recent searches are newest first, kept once whatever the case or spacing, and at most ten`() {
        var list = emptyList<String>()
        list = RecentSearches.add(list, "board")
        list = RecentSearches.add(list, "1.11")
        list = RecentSearches.add(list, "  BOARD ")
        assertEquals(listOf("BOARD", "1.11"), list)
        assertEquals(list, RecentSearches.add(list, "   "))
        list = RecentSearches.add(list, "api   tokens")
        list = RecentSearches.add(list, "API tokens")
        assertEquals(listOf("API tokens", "BOARD", "1.11"), list)
        for (n in 1..12) list = RecentSearches.add(list, "query $n")
        assertEquals(RecentSearches.LIMIT, list.size)
        assertEquals("query 12", list.first())
        assertEquals(listOf("query 11"), RecentSearches.remove(listOf("query 12", "query 11"), "query 12"))
    }

    @Test
    fun `help topics are found by their words`() {
        val book = HelpBook(
            version = 1,
            sections = listOf(HelpSection("Start", listOf("leds"))),
            topics = listOf(HelpTopic("leds", "What the LEDs say", "LED1 and LED2", listOf("blink"), emptyList(), listOf(HelpBlock.Text("LED1 flashes four times when Bluetooth opens.")))),
        )
        val items = Search.help(book)
        assertEquals(SearchTarget.Help("leds"), items.single().target)
        assertNotNull(Search.rank("flashes", items).singleOrNull())
        assertNotNull(Search.rank("blink", items).singleOrNull())
    }
}
