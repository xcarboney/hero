package io.github.xcarboney.solitaire

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View

/** The haptic vocabulary of the page: `SOL.Haptics.play(kind)` in solitaire/js/core/platform.js. */
internal enum class HapticKind(private val jsName: String) {
    TICK("tick"),
    TAP("tap"),
    THUD("thud"),
    SUCCESS("success"),
    ERROR("error"),
    HEAVY("heavy"),
    WIN("win");

    companion object {
        /** The kind for a name sent by the page, or null for anything unknown (then: no-op). */
        fun fromJsName(name: String?): HapticKind? = entries.firstOrNull { it.jsName == name }
    }
}

/**
 * Plays haptics with [View.performHapticFeedback]: no VIBRATE permission, and the user's system
 * touch-feedback setting is respected.
 *
 * The platform only offers a fixed set of effects, so each kind maps to the closest constant(s)
 * for the running API level. Ordered by strength on stock Android:
 * CLOCK_TICK < CONTEXT_CLICK < VIRTUAL_KEY < LONG_PRESS, plus the semantic CONFIRM / REJECT
 * effects that exist from API 30.
 */
internal object Haptics {
    /** Gap between the pulses of a multi-pulse effect. */
    private const val PULSE_GAP_MS = 110L

    /** Must be called on the UI thread. Does nothing while [view] is detached. */
    fun play(view: View, kind: HapticKind) {
        val pulses = pulsesFor(kind)
        view.performHapticFeedback(pulses[0])
        for (i in 1 until pulses.size) {
            view.postDelayed({ view.performHapticFeedback(pulses[i]) }, i * PULSE_GAP_MS)
        }
    }

    /** HapticFeedbackConstants to perform, [PULSE_GAP_MS] apart. Never empty. */
    private fun pulsesFor(kind: HapticKind): IntArray = when (kind) {
        // The four plain strengths, lightest to strongest.
        HapticKind.TICK -> intArrayOf(HapticFeedbackConstants.CLOCK_TICK)
        HapticKind.TAP -> intArrayOf(HapticFeedbackConstants.CONTEXT_CLICK)
        HapticKind.THUD -> intArrayOf(HapticFeedbackConstants.VIRTUAL_KEY)
        HapticKind.HEAVY -> intArrayOf(HapticFeedbackConstants.LONG_PRESS)
        // "It worked": the platform's confirm effect where it exists, else light-then-firm.
        HapticKind.SUCCESS ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intArrayOf(HapticFeedbackConstants.CONFIRM)
            } else {
                intArrayOf(HapticFeedbackConstants.CONTEXT_CLICK, HapticFeedbackConstants.VIRTUAL_KEY)
            }
        // "Not allowed": the platform's reject effect (a double click) where it exists, else two
        // firm clicks.
        HapticKind.ERROR ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intArrayOf(HapticFeedbackConstants.REJECT)
            } else {
                intArrayOf(HapticFeedbackConstants.VIRTUAL_KEY, HapticFeedbackConstants.VIRTUAL_KEY)
            }
        // The win celebration: a double heavy thump, unlike any other kind.
        HapticKind.WIN -> intArrayOf(HapticFeedbackConstants.LONG_PRESS, HapticFeedbackConstants.LONG_PRESS)
    }
}
