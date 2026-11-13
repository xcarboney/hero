package io.github.xcarboney.solitaire

import java.io.File
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The file store against a real (temporary) directory: latest value wins, values are replaced
 * atomically, an interrupted write is recovered, many threads may use it at once, flush waits.
 */
class KeyValueFileStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val opened = ArrayList<KeyValueFileStore>()
    private val reports: MutableList<String> = Collections.synchronizedList(ArrayList())

    private fun open(
        dir: File,
        rename: (File, File) -> Boolean = { from, to -> from.renameTo(to) },
    ): KeyValueFileStore =
        KeyValueFileStore(dir, { message, _ -> reports.add(message) }, rename).also { opened.add(it) }

    @After
    fun closeStores() {
        for (store in opened) store.close(2_000)
    }

    private fun valueFile(dir: File, key: String) = File(dir, key + KeyValueFileStore.VALUE_SUFFIX)
    private fun tempFile(dir: File, key: String) = File(dir, key + KeyValueFileStore.TEMP_SUFFIX)
    private fun names(dir: File): List<String> = dir.list().orEmpty().sorted()

    private fun record(text: String): ByteArray {
        val payload = text.toByteArray(Charsets.UTF_8)
        return StorageRecord.header(payload) + payload
    }

    /** A rename that can be made to wait (the writer thread then sits right before the rename). */
    private class Gate {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val armed = AtomicBoolean(false)
        val renames = AtomicInteger(0)

        val rename: (File, File) -> Boolean = { from, to ->
            if (armed.compareAndSet(true, false)) {
                entered.countDown()
                release.await(30, TimeUnit.SECONDS)
            }
            renames.incrementAndGet()
            from.renameTo(to)
        }
    }

    // ------------------------------------------------------------------------------ basics

    @Test
    fun `a value can be read back at once and from a new instance after a flush`() {
        val dir = temp.newFolder()
        val store = open(dir)
        assertNull(store.get("sol.save.v1"))
        assertTrue(store.set("sol.save.v1", "{\"moves\":1}"))
        assertEquals("{\"moves\":1}", store.get("sol.save.v1"))
        assertTrue(store.flush(5_000))
        assertEquals(listOf("sol.save.v1.val"), names(dir))
        store.close()

        val reopened = open(dir)
        assertEquals("{\"moves\":1}", reopened.get("sol.save.v1"))
        assertEquals(listOf("sol.save.v1"), reopened.keys())
        assertEquals(emptyList<String>(), reports)
    }

    @Test
    fun `the directory is created when it does not exist`() {
        val dir = File(temp.newFolder(), "files/store")
        val store = open(dir)
        assertEquals(emptyList<String>(), store.keys())
        assertTrue(store.set("a", "1"))
        assertTrue(store.flush(5_000))
        assertEquals("1", StorageRecord.read(valueFile(dir, "a")))
    }

    @Test
    fun `values keep every character through the disk`() {
        val dir = temp.newFolder()
        val text = "\u0000\t\n\"\\ é€🂡 " + "♠♥♣♦".repeat(1000)
        val store = open(dir)
        assertTrue(store.set("k", text))
        assertTrue(store.set("empty", ""))
        store.close()
        val reopened = open(dir)
        assertEquals(text, reopened.get("k"))
        assertEquals("", reopened.get("empty"))
    }

    @Test
    fun `remove deletes the value and its file`() {
        val dir = temp.newFolder()
        val store = open(dir)
        store.set("a", "1")
        store.set("b", "2")
        assertTrue(store.flush(5_000))
        assertTrue(store.remove("a"))
        assertNull(store.get("a"))
        assertEquals(listOf("b"), store.keys())
        assertTrue(store.flush(5_000))
        assertEquals(listOf("b.val"), names(dir))
        assertTrue("removing a missing key is fine", store.remove("never-set"))
        store.close()
        assertNull(open(dir).get("a"))
    }

    @Test
    fun `set after remove and remove after set keep their order on disk`() {
        val dir = temp.newFolder()
        val store = open(dir)
        store.set("a", "1")
        store.remove("a")
        store.set("a", "2")
        store.set("b", "1")
        store.remove("b")
        assertTrue(store.flush(5_000))
        assertEquals("2", store.get("a"))
        assertNull(store.get("b"))
        assertEquals(listOf("a.val"), names(dir))
        store.close()
        val reopened = open(dir)
        assertEquals("2", reopened.get("a"))
        assertNull(reopened.get("b"))
    }

    @Test
    fun `keys are sorted and only list what has a value`() {
        val store = open(temp.newFolder())
        store.set("sol.stats.v1", "{}")
        store.set("sol.save.v1", "\"x\"")
        store.set("sol.settings.v1", "{}")
        store.remove("sol.save.v1")
        assertEquals(listOf("sol.settings.v1", "sol.stats.v1"), store.keys())
    }

    // ------------------------------------------------------------------------- validation

    @Test
    fun `invalid keys are refused everywhere and never touch the file system`() {
        val root = temp.newFolder()
        val dir = File(root, "store")
        val store = open(dir)
        for (key in listOf(null, "", "../evil", "a/b", "a\\b", "x".repeat(65), "a b", "a\u0000")) {
            assertFalse("$key", store.set(key, "1"))
            assertNull("$key", store.get(key))
            assertFalse("$key", store.remove(key))
        }
        assertTrue(store.flush(5_000))
        assertEquals(emptyList<String>(), names(dir))
        assertEquals(listOf("store"), names(root))
    }

    @Test
    fun `keys made of dots stay inside the directory`() {
        val root = temp.newFolder()
        val dir = File(root, "store")
        val store = open(dir)
        assertTrue(store.set(".", "one"))
        assertTrue(store.set("..", "two"))
        assertTrue(store.flush(5_000))
        assertEquals(listOf("...val", "..val"), names(dir))
        assertEquals(listOf("store"), names(root))
        store.close()
        val reopened = open(dir)
        assertEquals("one", reopened.get("."))
        assertEquals("two", reopened.get(".."))
    }

    @Test
    fun `a key that looks like a temp or value file name cannot disturb another key`() {
        val dir = temp.newFolder()
        val store = open(dir)
        assertTrue(store.set("a", "plain"))
        assertTrue(store.set("a.tmp", "looks like a's temp file"))
        assertTrue(store.set("a.val", "looks like a's value file"))
        assertTrue(store.flush(5_000))
        store.set("a", "plain 2") // writes a.tmp, then renames it to a.val
        assertTrue(store.flush(5_000))
        store.close()
        val reopened = open(dir)
        assertEquals("plain 2", reopened.get("a"))
        assertEquals("looks like a's temp file", reopened.get("a.tmp"))
        assertEquals("looks like a's value file", reopened.get("a.val"))
    }

    @Test
    fun `a value over the cap is refused and the previous value stays`() {
        val dir = temp.newFolder()
        val store = open(dir)
        assertTrue(store.set("save", "small"))
        assertFalse(store.set("save", "x".repeat(StorageRules.MAX_VALUE_BYTES + 1)))
        assertFalse(store.set("save", null))
        assertEquals("small", store.get("save"))
        assertTrue("exactly at the cap is fine", store.set("save", "x".repeat(StorageRules.MAX_VALUE_BYTES)))
        assertTrue(store.flush(10_000))
        assertEquals(
            (StorageRules.MAX_VALUE_BYTES + StorageRecord.HEADER_BYTES).toLong(),
            valueFile(dir, "save").length(),
        )
        store.close()
        assertEquals(StorageRules.MAX_VALUE_BYTES, open(dir).get("save")!!.length)
    }

    @Test
    fun `the number of keys is bounded but existing keys can still change`() {
        val store = open(temp.newFolder())
        for (i in 0 until StorageRules.MAX_KEYS) assertTrue(store.set("k$i", "v"))
        assertFalse(store.set("one-too-many", "v"))
        assertTrue(store.set("k0", "changed"))
        assertTrue(store.remove("k1"))
        assertTrue("a freed slot can be used", store.set("one-too-many", "v"))
        assertEquals(StorageRules.MAX_KEYS, store.keys().size)
    }

    @Test
    fun `all values together are bounded`() {
        val store = open(temp.newFolder())
        val megabyte = "x".repeat(1024 * 1024)
        val count = StorageRules.MAX_TOTAL_BYTES / megabyte.length
        for (i in 0 until count) assertTrue(store.set("k$i", megabyte))
        assertFalse(store.set("k$count", "y"))
        assertFalse("growing a value past the total is refused too", store.set("k0", megabyte + "y"))
        assertEquals(megabyte, store.get("k0"))
        assertTrue("replacing a value by a smaller one is fine", store.set("k0", "y"))
        assertTrue(store.set("k$count", megabyte.dropLast(1)))
        assertTrue(store.flush(20_000))
    }

    // ------------------------------------------------------------------------ latest wins

    @Test
    fun `get returns the latest value while the disk is still behind`() {
        val dir = temp.newFolder()
        val gate = Gate()
        val store = open(dir, gate.rename)
        gate.armed.set(true)
        assertTrue(store.set("save", "move 1"))
        assertTrue("the writer reached the rename", gate.entered.await(10, TimeUnit.SECONDS))

        // The writer is stuck in the middle of writing "move 1". Nothing else waits for it.
        assertEquals("move 1", store.get("save"))
        assertTrue(store.set("save", "move 2"))
        assertTrue(store.set("save", "move 3"))
        assertTrue(store.set("other", "x"))
        assertEquals("move 3", store.get("save"))
        assertEquals(listOf("other", "save"), store.keys())
        assertFalse("nothing has been renamed into place yet", valueFile(dir, "save").exists())
        assertFalse("flush gives up after its timeout", store.flush(100))

        gate.release.countDown()
        assertTrue(store.flush(10_000))
        assertEquals("move 3", StorageRecord.read(valueFile(dir, "save")))
        // "move 1" (under way), then "move 3" and "other": "move 2" was replaced in the queue.
        assertEquals(3, gate.renames.get())
        assertEquals(listOf("other.val", "save.val"), names(dir))
    }

    @Test
    fun `storing the value that is already stored does not write again`() {
        val gate = Gate()
        val store = open(temp.newFolder(), gate.rename)
        store.set("save", "state")
        assertTrue(store.flush(5_000))
        repeat(5) { assertTrue(store.set("save", "state")) }
        assertTrue(store.flush(5_000))
        assertEquals(1, gate.renames.get())
        store.set("save", "state 2")
        assertTrue(store.flush(5_000))
        assertEquals(2, gate.renames.get())
    }

    // --------------------------------------------------------------------- atomic replace

    @Test
    fun `a reader of the file only ever sees a complete value`() {
        val dir = temp.newFolder()
        val store = open(dir)
        val file = valueFile(dir, "save")
        // Values of very different sizes, so a torn or mixed file could not go unnoticed.
        val values = (0 until 40).map { i -> "v$i:" + "abcdefghij".repeat(1 + (i % 7) * 3000) }.toSet()
        store.set("save", values.first())
        assertTrue(store.flush(5_000))

        val done = AtomicBoolean(false)
        val problem = AtomicReference<String>()
        val reads = AtomicInteger(0)
        val reader = thread(name = "reader") {
            while (!done.get() && problem.get() == null) {
                val seen = StorageRecord.read(file)
                reads.incrementAndGet()
                if (seen == null) problem.set("read a missing, torn or damaged file")
                else if (seen !in values) problem.set("read a value that was never written")
            }
        }
        repeat(6) {
            for (value in values) {
                store.set("save", value)
                assertTrue(store.flush(10_000))
            }
        }
        done.set(true)
        reader.join(10_000)
        assertNull(problem.get())
        assertTrue("the reader really ran alongside (${reads.get()} reads)", reads.get() > 50)
        assertEquals(listOf("save.val"), names(dir))
    }

    // --------------------------------------------------------------------- crash recovery

    /**
     * Stops the writer exactly between "temp file written and synced" and "renamed into place"
     * and copies the directory as it is at that instant: what a process killed there leaves.
     */
    private fun directoryOfAProcessKilledBeforeTheRename(oldValue: String?, newValue: String): File {
        val dir = temp.newFolder()
        val gate = Gate()
        val store = open(dir, gate.rename)
        if (oldValue != null) {
            store.set("save", oldValue)
            assertTrue(store.flush(5_000))
        }
        gate.armed.set(true)
        store.set("save", newValue)
        assertTrue(gate.entered.await(10, TimeUnit.SECONDS))

        val snapshot = temp.newFolder()
        for (file in dir.listFiles().orEmpty()) file.copyTo(File(snapshot, file.name))
        gate.release.countDown()
        return snapshot
    }

    @Test
    fun `a write that was complete but not yet renamed is finished on the next start`() {
        val dir = directoryOfAProcessKilledBeforeTheRename(oldValue = "move 41", newValue = "move 42")
        assertEquals(listOf("save.tmp", "save.val"), names(dir))
        assertEquals("move 41", StorageRecord.read(valueFile(dir, "save")))

        val store = open(dir)
        assertEquals("move 42", store.get("save"))
        assertEquals(listOf("save.val"), names(dir))
        assertEquals("move 42", StorageRecord.read(valueFile(dir, "save")))
        assertTrue(store.set("save", "move 43"))
        assertTrue(store.flush(5_000))
        assertEquals("move 43", StorageRecord.read(valueFile(dir, "save")))
    }

    @Test
    fun `the very first write of a key survives the same crash`() {
        val dir = directoryOfAProcessKilledBeforeTheRename(oldValue = null, newValue = "move 1")
        assertEquals(listOf("save.tmp"), names(dir))
        val store = open(dir)
        assertEquals("move 1", store.get("save"))
        assertEquals(listOf("save.val"), names(dir))
    }

    @Test
    fun `a torn temp file is discarded and the previous value survives`() {
        val dir = directoryOfAProcessKilledBeforeTheRename(oldValue = "move 41", newValue = "move 42 " + "x".repeat(5000))
        // The process died earlier, in the middle of writing the temp file.
        val whole = tempFile(dir, "save").readBytes()
        for (length in listOf(0, 3, StorageRecord.HEADER_BYTES, whole.size / 2, whole.size - 1)) {
            tempFile(dir, "save").writeBytes(whole.copyOf(length))
            val store = open(dir)
            assertEquals("cut at $length", "move 41", store.get("save"))
            assertEquals("cut at $length", listOf("save.val"), names(dir))
            store.close()
        }
    }

    @Test
    fun `a torn temp file without a previous value leaves the key unset`() {
        val dir = temp.newFolder()
        tempFile(dir, "save").writeBytes(record("move 1").copyOf(10))
        val store = open(dir)
        assertNull(store.get("save"))
        assertEquals(emptyList<String>(), store.keys())
        assertEquals(emptyList<String>(), names(dir))
        assertTrue(store.set("save", "move 1"))
        assertTrue(store.flush(5_000))
        assertEquals(listOf("save.val"), names(dir))
    }

    @Test
    fun `a damaged value file counts as missing, is reported, and can be replaced`() {
        val dir = temp.newFolder()
        valueFile(dir, "good").writeBytes(record("fine"))
        valueFile(dir, "save").writeBytes(record("{\"moves\":[1,2,3]}").also { it[it.size - 3] = '9'.code.toByte() })
        valueFile(dir, "cut").writeBytes(record("something longer").copyOf(12))
        valueFile(dir, "text").writeText("{\"not\":\"a record\"}")

        val store = open(dir)
        assertEquals("fine", store.get("good"))
        assertNull(store.get("save"))
        assertNull(store.get("cut"))
        assertNull(store.get("text"))
        assertEquals(listOf("good"), store.keys())
        assertEquals(3, reports.size)
        assertTrue(reports.all { it.startsWith("Ignoring damaged stored value") })

        assertTrue(store.set("save", "new game"))
        assertTrue(store.remove("cut"))
        assertTrue(store.flush(5_000))
        assertEquals("new game", StorageRecord.read(valueFile(dir, "save")))
        assertFalse("remove also clears the damaged file", valueFile(dir, "cut").exists())
    }

    @Test
    fun `files that are not the store's are left alone`() {
        val dir = temp.newFolder()
        File(dir, "notes.txt").writeText("hello")
        File(dir, "sub.val").mkdir()
        File(dir, "bad key!.val").writeBytes(record("x"))
        valueFile(dir, "a").writeBytes(record("1"))
        val store = open(dir)
        assertEquals(listOf("a"), store.keys())
        assertTrue(store.flush(5_000))
        assertEquals(listOf("a.val", "bad key!.val", "notes.txt", "sub.val"), names(dir))
        assertEquals("hello", File(dir, "notes.txt").readText())
    }

    // --------------------------------------------------------------------- failing writes

    @Test
    fun `a failed write keeps the value in memory and is retried by the next flush`() {
        val dir = temp.newFolder()
        val failing = AtomicBoolean(false)
        val store = open(dir) { from, to -> if (failing.get()) false else from.renameTo(to) }
        store.set("save", "move 1")
        assertTrue(store.flush(5_000))

        failing.set(true)
        assertTrue("accepted: the write happens later", store.set("save", "move 2"))
        assertFalse("the disk does not match the cache", store.flush(5_000))
        assertEquals("move 2", store.get("save"))
        assertEquals("move 1", StorageRecord.read(valueFile(dir, "save")))
        assertEquals("no half-written file is left behind", listOf("save.val"), names(dir))
        assertEquals(listOf("Could not write stored value 'save'"), reports.distinct())

        failing.set(false)
        assertTrue(store.flush(5_000))
        assertEquals("move 2", StorageRecord.read(valueFile(dir, "save")))
        assertTrue("and stays flushed", store.flush(5_000))
    }

    @Test
    fun `an exception while writing is contained`() {
        val dir = temp.newFolder()
        val failing = AtomicBoolean(true)
        val store = open(dir) { from, to -> if (failing.get()) throw IOException("disk full") else from.renameTo(to) }
        assertTrue(store.set("save", "move 1"))
        assertFalse(store.flush(5_000))
        assertEquals("move 1", store.get("save"))
        assertEquals(emptyList<String>(), names(dir))

        failing.set(false)
        assertTrue("a newer value does not wait for a flush to be tried", store.set("save", "move 2"))
        assertTrue(store.flush(5_000))
        assertEquals("move 2", StorageRecord.read(valueFile(dir, "save")))
    }

    // ------------------------------------------------------------------------- concurrency

    @Test
    fun `many threads can set, get, remove and list at once`() {
        val dir = temp.newFolder()
        val store = open(dir)
        val threads = 12
        val rounds = 400
        val keys = listOf("sol.save.v1", "sol.settings.v1", "sol.stats.v1", "shared")
        val start = CyclicBarrier(threads)
        val problem = AtomicReference<Throwable>()
        // What each thread wrote last to its own key: the store must end up with exactly that.
        val lastOwn = arrayOfNulls<String>(threads)

        val workers = (0 until threads).map { t ->
            thread(name = "worker-$t") {
                try {
                    start.await(10, TimeUnit.SECONDS)
                    val own = "own-$t"
                    for (i in 0 until rounds) {
                        val shared = keys[(t + i) % keys.size]
                        val value = "t$t-i$i-" + "p".repeat((t * 37 + i * 11) % 2000)
                        assertTrue(store.set(shared, value))
                        val seen = store.get(shared)
                        // Another thread may have written in between, but never a half value.
                        if (seen != null && !Regex("t\\d+-i\\d+-p*").matches(seen)) fail("mangled value: ${seen.take(40)}")

                        assertTrue(store.set(own, value))
                        assertEquals("a thread always reads its own latest write", value, store.get(own))
                        lastOwn[t] = value

                        if (i % 50 == 49) {
                            assertTrue(store.remove(own))
                            assertNull(store.get(own))
                            assertTrue(store.set(own, value))
                        }
                        if (i % 25 == 0) assertTrue(store.keys().containsAll(listOf(own)))
                        if (i % 100 == 0) store.flush(1_000)
                    }
                } catch (e: Throwable) {
                    problem.compareAndSet(null, e)
                }
            }
        }
        workers.forEach { it.join(60_000) }
        assertTrue("all workers finished", workers.none { it.isAlive })
        problem.get()?.let { throw AssertionError("a worker failed", it) }

        assertTrue(store.flush(30_000))
        val expectedKeys = (keys + (0 until threads).map { "own-$it" }).sorted()
        assertEquals(expectedKeys, store.keys())
        for (t in 0 until threads) assertEquals(lastOwn[t], store.get("own-$t"))
        assertEquals("no temp file is left", expectedKeys.map { "$it.val" }.sorted(), names(dir))

        // The disk holds exactly what the store answers from memory.
        val inMemory = expectedKeys.associateWith { store.get(it) }
        for ((key, value) in inMemory) assertEquals(key, value, StorageRecord.read(valueFile(dir, key)))
        store.close()
        val reopened = open(dir)
        assertEquals(inMemory, expectedKeys.associateWith { reopened.get(it) })
        assertEquals(emptyList<String>(), reports)
    }

    @Test
    fun `callers that arrive while the directory is still being read get the loaded values`() {
        val dir = temp.newFolder()
        for (i in 0 until 20) valueFile(dir, "k$i").writeBytes(record("v$i-" + "z".repeat(50_000)))
        val store = open(dir) // loading starts on the writer thread; do not wait for it
        val results = (0 until 8).map { t ->
            val seen = AtomicReference<String>()
            thread { seen.set(store.get("k$t")) } to seen
        }
        results.forEach { (worker, _) -> worker.join(10_000) }
        results.forEachIndexed { t, (_, seen) -> assertTrue(seen.get()!!.startsWith("v$t-")) }
        assertEquals(20, store.keys().size)
    }

    // ------------------------------------------------------------------------------- flush

    @Test
    fun `flush returns at once when there is nothing to do`() {
        val store = open(temp.newFolder())
        val started = System.nanoTime()
        assertTrue(store.flush(5_000))
        assertTrue(store.flush(0))
        assertTrue("took ${(System.nanoTime() - started) / 1_000_000} ms", System.nanoTime() - started < 2_000_000_000L)
    }

    @Test
    fun `flush waits no longer than its timeout`() {
        val gate = Gate()
        val store = open(temp.newFolder(), gate.rename)
        gate.armed.set(true)
        store.set("save", "move 1")
        assertTrue(gate.entered.await(10, TimeUnit.SECONDS))
        val started = System.nanoTime()
        assertFalse(store.flush(200))
        val waitedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("waited $waitedMs ms", waitedMs in 150..3_000)
        gate.release.countDown()
        assertTrue(store.flush(10_000))
    }

    @Test
    fun `an interrupted flush gives up and keeps the interrupt`() {
        val gate = Gate()
        val store = open(temp.newFolder(), gate.rename)
        gate.armed.set(true)
        store.set("save", "move 1")
        assertTrue(gate.entered.await(10, TimeUnit.SECONDS))
        val result = AtomicReference<Pair<Boolean, Boolean>>()
        val flusher = thread {
            val flushed = store.flush(30_000)
            result.set(flushed to Thread.currentThread().isInterrupted)
        }
        Thread.sleep(100)
        flusher.interrupt()
        flusher.join(10_000)
        assertEquals(false to true, result.get())
        gate.release.countDown()
    }

    @Test
    fun `close writes out what is queued and then refuses changes`() {
        val dir = temp.newFolder()
        val store = open(dir)
        for (i in 0 until 20) store.set("k$i", "value $i")
        assertTrue(store.close())
        assertEquals(20, names(dir).size)
        assertFalse(store.set("late", "x"))
        assertFalse(store.remove("k0"))
        assertEquals("reads still work", "value 0", store.get("k0"))
    }

    @Test
    fun `values already on disk beyond the limits are not loaded`() {
        val dir = temp.newFolder()
        for (i in 0 until StorageRules.MAX_KEYS + 5) valueFile(dir, "k%02d".format(i)).writeBytes(record("v"))
        val store = open(dir)
        assertEquals(StorageRules.MAX_KEYS, store.keys().size)
        assertEquals("k00", store.keys().first())
    }
}
