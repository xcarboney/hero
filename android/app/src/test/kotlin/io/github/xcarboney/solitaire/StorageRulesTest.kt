package io.github.xcarboney.solitaire

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Key validation, the value size cap, the key list and the on-disk record format. */
class StorageRulesTest {

    @get:Rule
    val temp = TemporaryFolder()

    // ------------------------------------------------------------------------------- keys

    @Test
    fun `the keys the page uses are valid`() {
        for (key in listOf("sol.save.v1", "sol.settings.v1", "sol.stats.v1", "a", "A-Z_0.9", "x".repeat(64))) {
            assertTrue(key, StorageRules.isValidKey(key))
        }
    }

    @Test
    fun `anything outside the alphabet or the length limit is not a key`() {
        val invalid = listOf(
            null, "", "x".repeat(65),
            "sol/save", "sol\\save", "../escape", "sol save", "sol:save", "sol*", "sol?", "sol|x",
            "s\u0000l", "sol\n", "\tsol", "s\u00e9l", "\u0441ol", // Cyrillic "с" looks like "c"
            "sol%2Fsave", "sol+save", "sol,save", "\"sol\"", "sol'", "<sol>", "sol;x", "sol=x", "~sol",
        )
        for (key in invalid) assertFalse("$key", StorageRules.isValidKey(key))
    }

    @Test
    fun `dots are allowed anywhere because a key is never a file name on its own`() {
        assertTrue(StorageRules.isValidKey("."))
        assertTrue(StorageRules.isValidKey(".."))
        assertTrue(StorageRules.isValidKey(".hidden"))
    }

    // ----------------------------------------------------------------------------- values

    @Test
    fun `a value is encoded as UTF-8`() {
        assertArrayEquals(byteArrayOf(), StorageRules.encodeValue(""))
        assertArrayEquals("{\"a\":1}".toByteArray(Charsets.UTF_8), StorageRules.encodeValue("{\"a\":1}"))
        // 1, 2, 3 and 4 byte characters: "a", "é", "€", and a spade emoji outside the BMP.
        assertEquals(1 + 2 + 3 + 4, StorageRules.encodeValue("a\u00e9\u20ac\uD83C\uDCA1")!!.size)
    }

    @Test
    fun `no value is not a value`() {
        assertNull(StorageRules.encodeValue(null))
    }

    @Test
    fun `the cap is 2 MB of UTF-8, inclusive`() {
        val max = StorageRules.MAX_VALUE_BYTES
        assertEquals(2 * 1024 * 1024, max)
        assertEquals(max, StorageRules.encodeValue("x".repeat(max))!!.size)
        assertNull(StorageRules.encodeValue("x".repeat(max + 1)))
    }

    @Test
    fun `the cap counts bytes, not characters`() {
        val max = StorageRules.MAX_VALUE_BYTES
        // Two bytes each: half as many characters fit.
        assertNotNull(StorageRules.encodeValue("\u00e9".repeat(max / 2)))
        assertNull(StorageRules.encodeValue("\u00e9".repeat(max / 2 + 1)))
        // Three bytes each: fewer characters than the cap, more bytes than the cap.
        assertNull(StorageRules.encodeValue("\u20ac".repeat(max / 3 + 1)))
    }

    // ------------------------------------------------------------------------------- JSON

    @Test
    fun `the key list is a sorted JSON array`() {
        assertEquals("[]", StorageRules.keysToJson(emptyList()))
        assertEquals("[\"sol.save.v1\"]", StorageRules.keysToJson(listOf("sol.save.v1")))
        assertEquals(
            "[\"sol.save.v1\",\"sol.settings.v1\",\"sol.stats.v1\"]",
            StorageRules.keysToJson(listOf("sol.stats.v1", "sol.save.v1", "sol.settings.v1")),
        )
    }

    @Test
    fun `the key list never contains anything that would need escaping`() {
        assertEquals("[\"ok\"]", StorageRules.keysToJson(listOf("ok", "a\"b", "a\\b", "")))
    }

    // ----------------------------------------------------------------------------- record

    private fun record(text: String): ByteArray {
        val payload = text.toByteArray(Charsets.UTF_8)
        return StorageRecord.header(payload) + payload
    }

    @Test
    fun `a record round-trips`() {
        for (text in listOf("", "x", "{\"deck\":[1,2,3]}", "\u00e9\u20ac\uD83C\uDCA1", "y".repeat(100_000))) {
            assertEquals(text, StorageRecord.decode(record(text)))
        }
    }

    @Test
    fun `a record starts with SOL1 and the CRC-32 of the payload`() {
        val bytes = record("123456789")
        assertEquals("SOL1", String(bytes, 0, 4, Charsets.US_ASCII))
        // 0xCBF43926 is the well-known CRC-32 check value of "123456789".
        assertArrayEquals(
            byteArrayOf(0xCB.toByte(), 0xF4.toByte(), 0x39, 0x26),
            bytes.copyOfRange(4, 8),
        )
        assertEquals(StorageRecord.HEADER_BYTES + 9, bytes.size)
    }

    @Test
    fun `a torn record is rejected at every length`() {
        val whole = record("{\"moves\":[1,2,3,4,5,6,7,8,9]}")
        for (length in 0 until whole.size) {
            assertNull("cut at $length", StorageRecord.decode(whole.copyOf(length)))
        }
    }

    @Test
    fun `a single flipped bit is detected anywhere in the record`() {
        val whole = record("{\"score\":120}")
        for (i in whole.indices) {
            val damaged = whole.copyOf().also { it[i] = (it[i].toInt() xor 0x04).toByte() }
            assertNull("bit flipped in byte $i", StorageRecord.decode(damaged))
        }
    }

    @Test
    fun `plain text that is not a record is rejected`() {
        assertNull(StorageRecord.decode("{\"score\":120}".toByteArray()))
        assertNull(StorageRecord.decode(ByteArray(0)))
        assertNull(StorageRecord.decode(ByteArray(64)))
    }

    @Test
    fun `reading a file gives the value, or null for a missing, damaged or oversized file`() {
        val dir = temp.newFolder()
        val good = File(dir, "good").apply { writeBytes(record("hello")) }
        assertEquals("hello", StorageRecord.read(good))

        assertNull(StorageRecord.read(File(dir, "missing")))
        assertNull(StorageRecord.read(File(dir, "empty").apply { writeBytes(ByteArray(0)) }))
        assertNull(StorageRecord.read(File(dir, "torn").apply { writeBytes(record("hello").copyOf(10)) }))
        assertNull(StorageRecord.read(dir)) // a directory is not a value

        // A valid record whose payload is over the cap is not even read into memory.
        val big = ByteArray(StorageRules.MAX_VALUE_BYTES + 1) { 'x'.code.toByte() }
        val tooBig = File(dir, "big").apply { writeBytes(StorageRecord.header(big) + big) }
        assertNull(StorageRecord.read(tooBig))
    }
}
