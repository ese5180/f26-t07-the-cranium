package com.craniumiot.cranium.shell

import com.craniumiot.cranium.shell.ShellPolicy.Navigation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The console's pages in this app (apps/shared/pages.json): each one in the bundle, in the sections, in the web view,
 * with its API calls taken from the app's sign-in. A page the console gains fails here until pages.json has it.
 */
class PagesParityTest {
    private val pages = Shared.json("pages.json")
    private val repo: File = Shared.file("pages.json").absoluteFile.parentFile.parentFile.parentFile
    private val assets = File(repo, "cloud/web/src/site/assets")

    private fun text(path: String) = File(repo, path).readText()

    private fun list(name: String): List<JsonObject> = pages.getValue(name).jsonArray.map { it.jsonObject }

    private fun JsonObject.string(key: String): String? =
        get(key)?.takeUnless { it is JsonNull }?.jsonPrimitive?.content

    private fun JsonObject.api(): List<String> = (get("api") as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()

    /** The names in a `const SECTIONS = [ ... ];` of a script, without its comments. */
    private fun sections(source: String, pattern: String): List<String> {
        val body = source.substringAfter("const SECTIONS = [").substringBefore("];")
            .lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")
        return Regex(pattern).findAll(body).map { it.groupValues[1] }.toList()
    }

    // A section's name is a word, or two joined by a hyphen (release-notes).
    private val route = Regex("""^#/([a-z]+(?:-[a-z]+)?)(?:/([A-Za-z0-9-]+))?$""")

    @Test
    fun `every section of the console is a page, and every page one of the console's`() {
        val core = text("cloud/web/src/site/assets/core.js")
        val known = sections(core, """'([a-z]+(?:-[a-z]+)?)'""")
        assertTrue(known.contains("memfault"))
        val listed = list("console").map { route.find(it.string("route")!!)!!.groupValues[1] }.toSet()
        for (section in known) assertTrue("#/$section in pages.json", section in listed)
        for (page in list("console")) {
            val path = page.string("route")!!
            val match = route.find(path)
            assertTrue(path, match != null)
            val (section, item) = match!!.destructured
            assertTrue("$path in core.js", section in known)
            if (item.isNotEmpty()) assertTrue("$path's item in core.js", core.contains("section === '$section' &&"))
        }
    }

    @Test
    fun `each page is in the sections, and its script is in the bundle and loaded by the console`() {
        val nav = sections(text("cloud/web/src/site/assets/views.js"), """\['([a-z]+)', '""")
        val app = text("cloud/web/src/site/assets/app.js")
        for (page in list("console")) {
            val path = page.string("route")!!
            page.string("nav")?.let { assertTrue("$path under $it", it in nav) }
            val script = page.string("script") ?: continue
            assertTrue(script, Regex("""^[a-z0-9][a-z0-9._-]{0,63}\.js$""").matches(script))
            assertTrue("$script in site/assets/", File(assets, script).isFile)
            assertTrue("$script loaded by app.js", app.contains("import('./$script')"))
        }
    }

    @Test
    fun `each board card is drawn by its script and called on the board's page`() {
        val views = text("cloud/web/src/site/assets/views.js")
        for (card in list("cards")) {
            val source = File(assets, card.string("script")!!).readText()
            val draw = card.string("draw")!!
            assertTrue(draw, source.contains("export function $draw("))
            assertTrue(card.string("title"), source.contains("title: '${card.string("title")}'"))
            assertTrue(draw, views.contains(".$draw("))
        }
    }

    @Test
    fun `each page's API routes take the apps' sign-in`() {
        val api = text("cloud/api/src/app.mjs")
        val routes = (list("console") + list("cards")).flatMap { it.api() }
        assertTrue(routes.contains("GET /api/devices/{thing}/memfault"))
        for (name in routes) {
            val (method, path) = name.split(" ")
            // No options: `phone` and `token` keep their defaults, so the phone apps' client is taken.
            val pattern = Regex("""route\('$method', '${Regex.escape(path)}', [A-Za-z_.]+\),""")
            assertTrue("$name in app.mjs", pattern.containsMatchIn(api))
        }
    }

    /** A page an app leaves out names the app and why; this one leaves none out (its serial port is the bridge's usb.*). */
    @Test
    fun `exclusions have a reason, and this app has every page`() {
        for (page in list("console")) {
            val excluded = page["excluded"] as? JsonObject ?: continue
            val path = page.string("route")!!
            for ((platform, reason) in excluded) {
                assertTrue("$path excluded on $platform", platform in setOf("ios", "android"))
                assertTrue("$path excluded on $platform has a reason", reason.jsonPrimitive.content.length >= 20)
            }
            assertTrue("$path is in the Android app", "android" !in excluded)
        }
        assertTrue("usb" in BridgeSpec.FEATURES && "usb.open" in BridgeSpec.METHODS)
    }

    @Test
    fun `the web view keeps every page, reaches the console, and sends Memfault links outside`() {
        for (page in list("console")) {
            val path = page.string("route")!!
            assertEquals(path, Navigation.IN_APP, ShellPolicy.navigation("${ShellPolicy.ORIGIN}/admin$path"))
        }
        val config = ShellConfig(
            consoleUrl = "https://console.example.com",
            region = "us-east-1",
            userPoolId = "us-east-1_EXAMPLE00",
            mobileClientId = "exampleclientid0000000000",
            customerApiUrl = null,
            customerRegion = null,
            customerUserPoolId = null,
            customerClientId = null,
            example = true,
        )
        assertTrue(ShellPolicy.csp("console", config).contains("connect-src 'self' https://appassets.androidplatform.net https://console.example.com"))
        for (address in pages.getValue("outside").jsonArray.map { it.jsonPrimitive.content }) {
            assertEquals(address, Navigation.SYSTEM, ShellPolicy.navigation(address))
        }
    }
}
