package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HelpTest {

    private val sample = """
        {
          "version": 1,
          "sections": [
            {"title": "Getting started", "topics": ["updates", "leds"]},
            {"title": "When something goes wrong", "topics": ["trouble"]}
          ],
          "topics": [
            {
              "id": "updates", "title": "How an update works", "summary": "From a release to a board.",
              "keywords": ["ota", "deploy"], "sources": ["docs/mobile-apps.md"],
              "blocks": [
                {"heading": "The steps"},
                {"text": "A release manager deploys a release."},
                {"steps": ["Upload", "Deploy", "Wait"]},
                {"list": ["Over the internet", "Over Bluetooth"]},
                {"rows": [["LED1", "Flashes while offered"], ["LED2", "Lit on trial"]]},
                {"note": "Nothing installs by itself."},
                {"see": ["leds", "trouble"]},
                {"links": [["The repository", "https://github.com/ese5180/f26-t07-the-cranium"]]}
              ]
            },
            {"id": "leds", "title": "What the LEDs say", "summary": "LED1 and LED2.", "blocks": [{"text": "LED1 flashes four times."}]},
            {"id": "trouble", "title": "Troubleshooting", "summary": "When a board does not update.", "blocks": []}
          ]
        }
    """.trimIndent()

    private fun book(text: String = sample): HelpBook {
        val load = HelpReader.parse(text)
        assertTrue(load.toString(), load is HelpLoad.Ok)
        return (load as HelpLoad.Ok).book
    }

    private fun broken(text: String): String {
        val load = HelpReader.parse(text)
        assertTrue(load.toString(), load is HelpLoad.Broken)
        return (load as HelpLoad.Broken).why
    }

    @Test
    fun `a book reads with its sections, topics and every kind of block`() {
        val help = book()
        assertEquals(1, help.version)
        assertEquals(listOf("Getting started", "When something goes wrong"), help.sections.map { it.title })
        val topic = help.topic("updates")!!
        assertEquals("How an update works", topic.title)
        assertEquals(listOf("ota", "deploy"), topic.keywords)
        assertEquals(listOf("docs/mobile-apps.md"), topic.sources)
        assertEquals(
            listOf(
                HelpBlock.Heading("The steps"),
                HelpBlock.Text("A release manager deploys a release."),
                HelpBlock.Steps(listOf("Upload", "Deploy", "Wait")),
                HelpBlock.Items(listOf("Over the internet", "Over Bluetooth")),
                HelpBlock.Rows(listOf("LED1" to "Flashes while offered", "LED2" to "Lit on trial")),
                HelpBlock.Note("Nothing installs by itself."),
                HelpBlock.See(listOf("leds", "trouble")),
                HelpBlock.Links(listOf("The repository" to "https://github.com/ese5180/f26-t07-the-cranium")),
            ),
            topic.blocks,
        )
        // Keywords and sources may be left out.
        assertEquals(emptyList<String>(), help.topic("leds")!!.keywords)
        assertEquals(emptyList<String>(), help.topic("leds")!!.sources)
        assertNull(help.topic("nothing"))
    }

    @Test
    fun `the plain text of a topic is its words, without the links to other topics`() {
        val text = book().topic("updates")!!.plainText
        for (words in listOf("The steps", "Upload Deploy Wait", "LED1 Flashes while offered", "Nothing installs", "The repository")) {
            assertTrue(words, text.contains(words))
        }
        assertTrue(!text.contains("trouble"))
    }

    @Test
    fun `a link that is not https is refused`() {
        assertTrue(broken(sample.replace("https://github.com", "http://github.com")).contains("https"))
    }

    @Test
    fun `two topics with one id are refused`() {
        assertEquals("Two topics have the id leds", broken(sample.replace("\"id\": \"trouble\"", "\"id\": \"leds\"")))
    }

    @Test
    fun `a link to a topic that does not exist is refused`() {
        assertTrue(broken(sample.replace("\"see\": [\"leds\", \"trouble\"]", "\"see\": [\"leds\", \"gone\"]")).endsWith("gone"))
    }

    @Test
    fun `a section that names a missing topic, and a topic in no section, are refused`() {
        assertTrue(broken(sample.replace("\"topics\": [\"trouble\"]", "\"topics\": [\"trouble\", \"gone\"]")).endsWith("gone"))
        assertEquals("A topic is in no section: trouble", broken(sample.replace("\"topics\": [\"trouble\"]", "\"topics\": []")))
    }

    @Test
    fun `a block with two kinds, a row of three and an unknown kind are refused`() {
        broken(sample.replace("{\"heading\": \"The steps\"}", "{\"heading\": \"The steps\", \"text\": \"two\"}"))
        broken(sample.replace("[\"LED2\", \"Lit on trial\"]", "[\"LED2\", \"Lit\", \"on trial\"]"))
        broken(sample.replace("{\"heading\": \"The steps\"}", "{\"video\": \"The steps\"}"))
    }

    @Test
    fun `a file that is not a book is refused`() {
        broken("not json")
        broken("[]")
        broken("{\"sections\": [], \"topics\": []}")
        broken(sample.replace("\"title\": \"What the LEDs say\"", "\"title\": 7"))
        broken(sample.replace("\"blocks\": []", "\"blocks\": {}"))
    }

    @Test
    fun `help topics become search items`() {
        val items = Search.help(book())
        assertEquals(listOf("updates", "leds", "trouble"), items.map { it.key })
        assertEquals(SearchKind.HELP, items[0].kind)
        assertEquals("From a release to a board.", items[0].subtitle)
        assertEquals("updates", Search.rank("installs", items).single().item.key)
        assertEquals("updates", Search.rank("ota", items).single().item.key)
    }
}
