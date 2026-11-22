package io.github.xcarboney.solitaire

import android.content.Context
import android.util.Log
import java.io.File

/**
 * The app's one [KeyValueFileStore]: the saved game, the statistics and the settings, as the
 * page stores them through `SolitaireNative.storage*`.
 *
 * The files live in `files/store/` of the app's private data directory (one `<key>.val` per
 * key). That directory is listed in res/xml/backup_rules.xml and data_extraction_rules.xml, so
 * the values travel with Android's backup and device-to-device transfer.
 *
 * One instance per process, not per Activity: the store keeps the latest values in memory and
 * owns the only thread that writes the files, so a second instance on the same directory (the
 * Activity can be recreated while the process lives on) would work from a stale copy.
 */
internal object GameStorage {
    private const val TAG = "Solitaire"
    private const val DIRECTORY = "store"

    @Volatile
    private var instance: KeyValueFileStore? = null

    /** Safe from any thread. The first call starts loading the stored values in the background. */
    fun get(context: Context): KeyValueFileStore =
        instance ?: synchronized(this) {
            instance ?: KeyValueFileStore(
                dir = File(context.applicationContext.filesDir, DIRECTORY),
                report = { message, cause -> Log.w(TAG, message, cause) },
            ).also { instance = it }
        }
}
