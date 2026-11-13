package io.github.xcarboney.solitaire

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.CRC32
import kotlin.concurrent.withLock

/**
 * What the page may store through `SolitaireNative.storage*`: the limits and the wire formats.
 *
 * Pure JVM code (no Android classes) so that it is covered by the unit tests in src/test.
 */
internal object StorageRules {
    /** The page's keys look like "sol.save.v1". */
    const val MAX_KEY_LENGTH = 64

    /**
     * Largest accepted value, in UTF-8 bytes. The saved game carries its undo history and can
     * reach a few hundred KB; anything beyond 2 MB is a bug in the page, not a game.
     */
    const val MAX_VALUE_BYTES = 2 * 1024 * 1024

    /** The game uses three keys (settings, statistics, the game in progress). */
    const val MAX_KEYS = 32

    /**
     * Upper bound for all values together. Android's Auto Backup gives up on an app whose data
     * exceeds 25 MB; this keeps the store (and the localStorage copy of it) well below that.
     */
    const val MAX_TOTAL_BYTES = 8 * 1024 * 1024

    /**
     * Keys become file names, so only `[A-Za-z0-9._-]` is allowed: no separators, nothing a
     * file system could interpret. (A key is never used as a file name on its own, see
     * [KeyValueFileStore], so "." and ".." are harmless.)
     */
    fun isValidKey(key: String?): Boolean {
        if (key == null || key.isEmpty() || key.length > MAX_KEY_LENGTH) return false
        return key.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }
    }

    /**
     * The value as the UTF-8 bytes that go to disk, or null when it is missing or larger than
     * [MAX_VALUE_BYTES]. (An unpaired UTF-16 surrogate has no UTF-8 form and is stored as '?';
     * JSON.stringify, which produces every value the page stores, never emits one.)
     */
    fun encodeValue(value: String?): ByteArray? {
        // Every UTF-16 code unit takes at least one byte: skip encoding what cannot fit anyway.
        if (value == null || value.length > MAX_VALUE_BYTES) return null
        val bytes = value.toByteArray(Charsets.UTF_8)
        return if (bytes.size <= MAX_VALUE_BYTES) bytes else null
    }

    /** A JSON array of the given keys, sorted. Valid keys need no escaping. */
    fun keysToJson(keys: Collection<String>): String =
        keys.filter(::isValidKey).sorted().joinToString(separator = ",", prefix = "[", postfix = "]") { "\"$it\"" }
}

/**
 * The on-disk form of one value: `"SOL1"`, the CRC-32 of the payload (big endian), the payload
 * (UTF-8). The checksum tells a complete file from a torn or damaged one, so a damaged value is
 * reported as missing (the page then falls back to its localStorage copy) instead of being
 * handed to the game as if it were the save.
 */
internal object StorageRecord {
    const val HEADER_BYTES = 8
    private val MAGIC = byteArrayOf('S'.code.toByte(), 'O'.code.toByte(), 'L'.code.toByte(), '1'.code.toByte())

    fun header(payload: ByteArray): ByteArray {
        val crc = CRC32().apply { update(payload) }.value
        return byteArrayOf(
            MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3],
            (crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte(),
        )
    }

    /** The payload of a complete, undamaged record, or null. */
    fun decode(record: ByteArray): String? {
        if (record.size < HEADER_BYTES) return null
        for (i in MAGIC.indices) if (record[i] != MAGIC[i]) return null
        var stored = 0L
        for (i in 4 until HEADER_BYTES) stored = (stored shl 8) or (record[i].toLong() and 0xFF)
        val crc = CRC32().apply { update(record, HEADER_BYTES, record.size - HEADER_BYTES) }.value
        if (crc != stored) return null
        return String(record, HEADER_BYTES, record.size - HEADER_BYTES, Charsets.UTF_8)
    }

    /** Reads [file] as a record; null when it is missing, too large, torn or damaged. */
    fun read(file: File): String? {
        val length = file.length()
        if (length < HEADER_BYTES || length > StorageRules.MAX_VALUE_BYTES + HEADER_BYTES) return null
        return try {
            decode(file.readBytes())
        } catch (e: IOException) {
            null
        }
    }
}

/**
 * A [KeyValueFileStore] as one page may use it through `SolitaireNative.storage*`: every call
 * is refused, without touching the store, once the page's bridge has been released or while the
 * WebView shows something that is not the game ([NativeBridge.pageTrusted]).
 *
 * Both flags are written by the UI thread and read on the WebView's bridge thread.
 */
internal class GuardedStore(private val store: KeyValueFileStore) {
    @Volatile
    var released = false

    @Volatile
    var pageTrusted = true

    fun get(key: String?): String? = if (usable()) store.get(key) else null

    fun set(key: String?, value: String?): Boolean = usable() && store.set(key, value)

    fun remove(key: String?): Boolean = usable() && store.remove(key)

    /** The keys as the JSON array `storageKeys()` answers with; `[]` when the store is off limits. */
    fun keysJson(): String = StorageRules.keysToJson(if (usable()) store.keys() else emptyList())

    private fun usable(): Boolean = !released && pageTrusted
}

/**
 * A small durable key/value store: one file per key in [dir].
 *
 * Why it exists: the game saves through the WebView's localStorage after every move, but
 * Chromium commits localStorage to disk lazily, so a move made just before the app is swiped
 * away can be lost. Here every accepted value is in the in-memory cache at once (so a read
 * always sees the latest value) and is written out by a single background thread right away.
 *
 * Guarantees
 *  - [get], [set], [remove] and [keys] may be called from any thread. They never do disk I/O
 *    for a write: [set] and [remove] only update the cache and queue the work. The only wait is
 *    for the initial load of the directory, which the writer thread starts in the constructor.
 *  - Latest wins: while a value for a key waits in the queue, a newer one replaces it, and the
 *    single writer keeps the writes of one key in order.
 *  - Atomic replace: a value is written to `<key>.tmp`, synced to the device, then renamed over
 *    `<key>.val`. A reader (and a crash) sees the old value or the new one, never a mix.
 *  - Crash recovery: a `<key>.tmp` left behind by a process that died is completed when it is a
 *    whole record (it was synced, only the rename was missing) and discarded otherwise.
 *  - [flush] waits, bounded, until everything queued is on disk.
 *
 * There must be only one instance per directory in a process (see [GameStorage]).
 *
 * @param report called (on the writer thread) for problems worth logging; never for user data.
 * @param rename the atomic replace. A parameter only so tests can stop the writer just before it.
 */
internal class KeyValueFileStore(
    private val dir: File,
    private val report: (message: String, cause: Throwable?) -> Unit = { _, _ -> },
    private val rename: (from: File, to: File) -> Boolean = { from, to -> from.renameTo(to) },
) {
    private class Entry(val value: String, val bytes: Int)

    private val lock = ReentrantLock()

    /** Signalled when the load finishes, when work is queued and when a write finishes. */
    private val stateChanged = lock.newCondition()

    // Everything below is guarded by [lock].
    private val cache = HashMap<String, Entry>()
    private var totalBytes = 0L

    /** Key -> bytes to write, or null to delete the file. Insertion order is write order. */
    private val pending = LinkedHashMap<String, ByteArray?>()

    /** Keys whose last write failed and that nothing newer is queued for; [flush] retries them. */
    private val failed = HashSet<String>()
    private var inFlight: String? = null
    private var loaded = false
    private var closed = false

    private val writer = Thread({ run() }, "solitaire-storage").apply { isDaemon = true }

    init {
        writer.start() // last: the thread reads the fields above
    }

    /** The latest value for [key], or null when there is none (or the key is not valid). */
    fun get(key: String?): String? {
        if (key == null || !StorageRules.isValidKey(key)) return null
        lock.withLock {
            awaitLoaded()
            return cache[key]?.value
        }
    }

    /**
     * Stores [value] under [key]. False (and nothing changes) when the key is not valid, the
     * value is missing or larger than [StorageRules.MAX_VALUE_BYTES], or the store is full.
     */
    fun set(key: String?, value: String?): Boolean {
        if (key == null || value == null || !StorageRules.isValidKey(key)) return false
        val bytes = StorageRules.encodeValue(value) ?: return false
        lock.withLock {
            awaitLoaded()
            if (closed) return false
            val old = cache[key]
            if (old == null && cache.size >= StorageRules.MAX_KEYS) return false
            val newTotal = totalBytes - (old?.bytes ?: 0) + bytes.size
            if (newTotal > StorageRules.MAX_TOTAL_BYTES) return false
            // The page saves again when it is hidden, usually the very state it saved after the
            // last move: what is already stored (or queued) needs no second trip to the disk.
            if (old != null && old.value == value && key !in failed) return true
            cache[key] = Entry(value, bytes.size)
            totalBytes = newTotal
            pending[key] = bytes
            failed.remove(key)
            stateChanged.signalAll()
            return true
        }
    }

    /** Forgets [key]. False only when the key is not valid (removing a missing key is fine). */
    fun remove(key: String?): Boolean {
        if (key == null || !StorageRules.isValidKey(key)) return false
        lock.withLock {
            awaitLoaded()
            if (closed) return false
            val old = cache.remove(key)
            if (old != null) totalBytes -= old.bytes
            // Queued even when the key was unknown: a damaged file may still be lying around.
            pending[key] = null
            failed.remove(key)
            stateChanged.signalAll()
            return true
        }
    }

    /** All keys that currently have a value, sorted. */
    fun keys(): List<String> = lock.withLock {
        awaitLoaded()
        cache.keys.sorted()
    }

    /**
     * Waits until every accepted change is on disk, at most [timeoutMs]. Writes that failed
     * earlier (a full disk) get one more attempt. True when the disk now matches the cache.
     */
    fun flush(timeoutMs: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.coerceAtLeast(0))
        lock.withLock {
            try {
                while (!loaded) {
                    val remaining = deadline - System.nanoTime()
                    if (remaining <= 0) return false
                    stateChanged.awaitNanos(remaining)
                }
                for (key in failed) {
                    if (key !in pending) pending[key] = cache[key]?.value?.toByteArray(Charsets.UTF_8)
                }
                failed.clear()
                stateChanged.signalAll()
                while (pending.isNotEmpty() || inFlight != null) {
                    val remaining = deadline - System.nanoTime()
                    if (remaining <= 0) return false
                    stateChanged.awaitNanos(remaining)
                }
                return failed.isEmpty()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
        }
    }

    /**
     * Stops accepting changes, writes out what is queued and ends the writer thread. The app
     * never needs this (the store lives as long as the process); tests do.
     */
    fun close(timeoutMs: Long = 10_000): Boolean {
        lock.withLock {
            closed = true
            stateChanged.signalAll()
        }
        writer.join(timeoutMs)
        return !writer.isAlive
    }

    // ----------------------------------------------------------------------- writer thread

    private fun awaitLoaded() {
        while (!loaded) stateChanged.awaitUninterruptibly()
    }

    private fun run() {
        load()
        while (true) {
            val key: String
            val bytes: ByteArray?
            lock.withLock {
                while (pending.isEmpty() && !closed) stateChanged.awaitUninterruptibly()
                if (pending.isEmpty()) return // closed and drained
                val next = pending.entries.iterator().next()
                key = next.key
                bytes = next.value
                pending.remove(key)
                inFlight = key
            }
            val ok = try {
                if (bytes == null) delete(key) else write(key, bytes)
                true
            } catch (e: Exception) {
                report("Could not ${if (bytes == null) "delete" else "write"} stored value '$key'", e)
                false
            }
            lock.withLock {
                inFlight = null
                // A newer change for the key is already queued: that one decides, not this failure.
                if (!ok && key !in pending) failed.add(key)
                stateChanged.signalAll()
            }
        }
    }

    /** Reads the whole directory into the cache. Always ends with [loaded] set. */
    private fun load() {
        val found = sortedMapOf<String, Entry>()
        try {
            if (!dir.isDirectory) dir.mkdirs()
            for (file in dir.listFiles().orEmpty()) {
                if (file.name.endsWith(TEMP_SUFFIX)) recoverInterruptedWrite(file)
            }
            for (file in dir.listFiles().orEmpty()) {
                if (!file.name.endsWith(VALUE_SUFFIX) || !file.isFile) continue
                val key = file.name.removeSuffix(VALUE_SUFFIX)
                if (!StorageRules.isValidKey(key)) continue
                val value = StorageRecord.read(file)
                if (value == null) {
                    report("Ignoring damaged stored value '$key'", null)
                    continue
                }
                found[key] = Entry(value, (file.length() - StorageRecord.HEADER_BYTES).toInt())
            }
        } catch (e: Exception) {
            report("Could not read the stored values in $dir", e)
        } finally {
            lock.withLock {
                for ((key, entry) in found) {
                    if (cache.size >= StorageRules.MAX_KEYS) break
                    if (totalBytes + entry.bytes > StorageRules.MAX_TOTAL_BYTES) continue
                    cache[key] = entry
                    totalBytes += entry.bytes
                }
                loaded = true
                stateChanged.signalAll()
            }
        }
    }

    /**
     * A temp file can only be left behind by a process that died (or a disk error) in the middle
     * of [write]. If it is a complete record, the value had reached the device and only the
     * rename was missing: finish the job, it is the newest value of that key. Otherwise drop it;
     * the previous value is still in place.
     */
    private fun recoverInterruptedWrite(temp: File) {
        val key = temp.name.removeSuffix(TEMP_SUFFIX)
        val complete = StorageRules.isValidKey(key) && StorageRecord.read(temp) != null
        if (complete && rename(temp, valueFile(key))) return
        temp.delete()
    }

    private fun write(key: String, payload: ByteArray) {
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("Cannot create $dir")
        val temp = File(dir, key + TEMP_SUFFIX)
        try {
            FileOutputStream(temp).use { out ->
                out.write(StorageRecord.header(payload))
                out.write(payload)
                out.flush()
                // The data must be on the device before the rename makes it the value: a rename
                // can survive a power cut that the data blocks of an unsynced file do not.
                out.fd.sync()
            }
            if (!rename(temp, valueFile(key))) throw IOException("Cannot replace ${valueFile(key).name}")
        } catch (e: Exception) {
            temp.delete()
            throw e
        }
    }

    private fun delete(key: String) {
        File(dir, key + TEMP_SUFFIX).delete()
        val file = valueFile(key)
        if (!file.delete() && file.exists()) throw IOException("Cannot delete ${file.name}")
    }

    private fun valueFile(key: String) = File(dir, key + VALUE_SUFFIX)

    internal companion object {
        /**
         * Different suffixes for values and temp files, both appended to the key: no key can
         * name another key's temp file, and no key can be "." or "..".
         */
        const val VALUE_SUFFIX = ".val"
        const val TEMP_SUFFIX = ".tmp"
    }
}
