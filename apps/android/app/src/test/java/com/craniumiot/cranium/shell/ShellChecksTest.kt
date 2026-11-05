package com.craniumiot.cranium.shell

import com.craniumiot.cranium.core.BoardStatus
import com.craniumiot.cranium.core.ImageSlot
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

/** The handlers' own checks: the image before an upload, the status after a restart, the tokens to keep. */
class ShellChecksTest {
    private fun image(size: Int = 1024): ByteArray = ByteArray(size).also {
        it[0] = 0x3d
        it[1] = 0xb8.toByte()
        it[2] = 0xf3.toByte()
        it[3] = 0x96.toByte()
        it[100] = 7
    }

    private fun refused(base64: String, sha256: String) {
        try {
            ShellChecks.uploadImage(base64, sha256)
            fail("taken")
        } catch (e: BridgeError) {
            assertEquals("bad_request", e.code)
        }
    }

    @Test
    fun `an image is sent only with its SHA-256 and MCUboot's magic`() {
        val bytes = image()
        val sha = BundleManifest.sha256Hex(bytes)
        assertArrayEquals(bytes, ShellChecks.uploadImage(Base64.getEncoder().encodeToString(bytes), sha))
        refused(Base64.getEncoder().encodeToString(bytes), "0".repeat(64))
        val plain = ByteArray(1024)
        refused(Base64.getEncoder().encodeToString(plain), BundleManifest.sha256Hex(plain))
        refused("not base64!", sha)
        refused("", BundleManifest.sha256Hex(ByteArray(0)))
        val huge = image(ShellChecks.MAX_IMAGE_BYTES + 1)
        refused(Base64.getEncoder().encodeToString(huge), BundleManifest.sha256Hex(huge))
    }

    private val sample =
        "010302010300384e0d00010e0100000000000000010e00000000000007010100010e000000000000010d020007000000deadbeef010203040300040302010000"

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `after the restart only the status of this send is followed`() {
        // The firmware's sample: last update over Bluetooth to 1.14.0+0, image hash deadbeef01020304.
        val status = BoardStatus.parse(bytes(sample))!!
        assertTrue(ShellChecks.aboutThisSend(status, "1.14.0+0", "deadbeef01020304"))
        assertTrue(ShellChecks.aboutThisSend(status, "1.14.0+0", null))
        assertFalse(ShellChecks.aboutThisSend(status, "1.14.0+0", "0000000000000001"))
        assertFalse(ShellChecks.aboutThisSend(status, "1.14.1+0", "deadbeef01020304"))
        // Over Wi-Fi: not a send over Bluetooth.
        val wifi = bytes(sample).also { it[29] = 2 }
        assertFalse(ShellChecks.aboutThisSend(BoardStatus.parse(wifi)!!, "1.14.0+0", null))
    }

    private fun jwt(claims: String): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        return "${encoder.encodeToString("{\"alg\":\"none\"}".toByteArray())}.${encoder.encodeToString(claims.toByteArray())}.c2ln"
    }

    @Test
    fun `a token is kept only for the pool's phone client`() {
        val token = jwt("""{"sub":"abc","client_id":"phone","iss":"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool"}""")
        assertEquals("abc", ShellChecks.claim(token, "sub"))
        assertTrue(ShellChecks.tokenFits(token, "phone", "us-east-1_Pool"))
        assertFalse(ShellChecks.tokenFits(token, "website", "us-east-1_Pool"))
        assertFalse(ShellChecks.tokenFits(token, "phone", "us-east-1_Other"))
        assertFalse(ShellChecks.tokenFits("not.a.jwt", "phone", "us-east-1_Pool"))
        assertFalse(ShellChecks.tokenFits(jwt("""{"sub":"abc"}"""), "phone", "us-east-1_Pool"))
        assertNull(ShellChecks.claim("only-one-part", "sub"))
    }

    private val config = ShellConfig(
        "https://console.example.com", "us-east-1", "us-east-1_A", "phone", null, null, null, null, example = false,
    )

    @Test
    fun `hello and config have the contract's shape`() {
        val bundle = bundleOf(pages("x"))
        val launched = LaunchedBundle(bundle.manifest, BundleSource.BUILT_IN, bundle.objects)
        val hello = ShellChecks.helloJson("0.8.0", 12, launched, listOf("auth", "ble"), needsNewerApp = false)
        assertEquals("android", hello["platform"]!!.jsonPrimitive.content)
        assertEquals("12", hello["shell"]!!.jsonObject["build"]!!.jsonPrimitive.content)
        assertEquals("built-in", hello["bundle"]!!.jsonObject["source"]!!.jsonPrimitive.content)
        assertEquals("2.1.1", hello["bundle"]!!.jsonObject["console"]!!.jsonPrimitive.content)
        assertEquals(bundle.manifest.id, hello["bundle"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals(2, (hello["features"] as JsonArray).size)

        val shown = ShellChecks.configJson(config)
        assertEquals(
            setOf("consoleUrl", "region", "userPoolId", "mobileClientId", "customerApiUrl", "customerRegion", "customerUserPoolId", "customerClientId", "example"),
            shown.keys,
        )
        assertEquals(JsonNull, shown["customerApiUrl"])
    }

    @Test
    fun `the image list is image 0's`() {
        val slots = listOf(
            ImageSlot(0, 0, "1.14.0", active = true, confirmed = true, pending = false),
            ImageSlot(0, 1, "1.14.1", active = false, confirmed = false, pending = true, permanent = true),
            ImageSlot(1, 0, "2.0.0", active = true, confirmed = true, pending = false),
        )
        val images = ShellChecks.imagesJson(slots)["images"] as JsonArray
        assertEquals(2, images.size)
        assertEquals("1.14.1", images[1].jsonObject["version"]!!.jsonPrimitive.content)
        assertEquals("true", images[1].jsonObject["permanent"]!!.jsonPrimitive.content)
    }
}
