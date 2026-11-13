package io.github.xcarboney.solitaire

import kotlin.math.ceil
import kotlin.math.floor

/** A rectangle as the page sends it: CSS px, relative to the top left of the viewport. */
internal data class CssRect(val x: Double, val y: Double, val w: Double, val h: Double)

/** A rectangle in physical px, relative to the top left of the WebView. */
internal data class PxRect(val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * The argument of `SolitaireNative.setGestureExclusion(json)`: parsing, validation and the
 * conversion to physical pixels.
 *
 * Pure JVM code (no org.json, no android.graphics.Rect) so that it is covered by the unit tests
 * in src/test. The parser accepts exactly one shape, a JSON array of flat objects with the four
 * numeric members x, y, w and h, and nothing else: the string comes from page script.
 */
internal object GestureRects {
    /** The page sends two strips; a few more leave room without letting the list grow. */
    const val MAX_RECTS = 8

    /** Eight rectangles with generous numbers fit several times over. */
    const val MAX_JSON_LENGTH = 1024

    /** No viewport is anywhere near this many CSS px; keeps the px arithmetic far from overflow. */
    const val MAX_COORDINATE = 100_000.0

    /**
     * The rectangles in [json], or null when it is not valid. An empty array is valid (it clears
     * the exclusion). Width and height must not be negative; x and y may be (a rectangle that
     * starts off screen is clipped by [toDevicePx]).
     */
    fun parse(json: String?): List<CssRect>? {
        if (json == null || json.length > MAX_JSON_LENGTH) return null
        return try {
            Parser(json).parseDocument()
        } catch (e: Invalid) {
            null
        }
    }

    /**
     * Converts to physical px for a view of [viewWidth] x [viewHeight] px, rounding outwards (a
     * strip must not end a fraction of a pixel short of the screen edge) and clipping to the
     * view. Rectangles that end up empty are dropped.
     *
     * [density] is physical px per CSS px: the page's viewport is `width=device-width` at scale
     * 1 and zooming is disabled, so that is the display density.
     */
    fun toDevicePx(rects: List<CssRect>, density: Float, viewWidth: Int, viewHeight: Int): List<PxRect> {
        if (density.isNaN() || density.isInfinite() || density <= 0f || viewWidth <= 0 || viewHeight <= 0) {
            return emptyList()
        }
        val scale = density.toDouble()
        val out = ArrayList<PxRect>(rects.size)
        for (rect in rects.take(MAX_RECTS)) {
            val left = floor(rect.x * scale).coerceIn(0.0, viewWidth.toDouble()).toInt()
            val top = floor(rect.y * scale).coerceIn(0.0, viewHeight.toDouble()).toInt()
            val right = ceil((rect.x + rect.w) * scale).coerceIn(0.0, viewWidth.toDouble()).toInt()
            val bottom = ceil((rect.y + rect.h) * scale).coerceIn(0.0, viewHeight.toDouble()).toInt()
            if (right > left && bottom > top) out.add(PxRect(left, top, right, bottom))
        }
        return out
    }

    private class Invalid : Exception() {
        // Control flow only: no stack trace needed for input that is simply rejected.
        override fun fillInStackTrace(): Throwable = this
    }

    private class Parser(private val text: String) {
        private var pos = 0

        fun parseDocument(): List<CssRect> {
            val rects = ArrayList<CssRect>()
            skipWhitespace()
            expect('[')
            skipWhitespace()
            if (peek() == ']') {
                pos++
            } else {
                while (true) {
                    if (rects.size >= MAX_RECTS) throw Invalid()
                    rects.add(parseRect())
                    skipWhitespace()
                    if (peek() == ',') {
                        pos++
                        skipWhitespace()
                    } else {
                        expect(']')
                        break
                    }
                }
            }
            skipWhitespace()
            if (pos != text.length) throw Invalid()
            return rects
        }

        private fun parseRect(): CssRect {
            // x, y, w, h in the order they are found; each exactly once.
            val values = arrayOfNulls<Double>(4)
            expect('{')
            skipWhitespace()
            if (peek() != '}') {
                while (true) {
                    val index = "xywh".indexOf(parseName())
                    if (index < 0 || values[index] != null) throw Invalid()
                    skipWhitespace()
                    expect(':')
                    skipWhitespace()
                    values[index] = parseNumber()
                    skipWhitespace()
                    if (peek() == ',') {
                        pos++
                        skipWhitespace()
                    } else {
                        break
                    }
                }
            }
            expect('}')
            val x = values[0] ?: throw Invalid()
            val y = values[1] ?: throw Invalid()
            val w = values[2] ?: throw Invalid()
            val h = values[3] ?: throw Invalid()
            if (w < 0 || h < 0) throw Invalid()
            return CssRect(x, y, w, h)
        }

        /** A member name: one of the single letters, in quotes. Returns the letter. */
        private fun parseName(): Char {
            expect('"')
            val name = peek() ?: throw Invalid()
            pos++
            expect('"')
            return name
        }

        /** A number in JSON's grammar, finite and within [MAX_COORDINATE]. */
        private fun parseNumber(): Double {
            val start = pos
            if (peek() == '-') pos++
            when (peek()) {
                '0' -> pos++
                in '1'..'9' -> skipDigits()
                else -> throw Invalid()
            }
            if (peek() == '.') {
                pos++
                if (skipDigits() == 0) throw Invalid()
            }
            if (peek() == 'e' || peek() == 'E') {
                pos++
                if (peek() == '+' || peek() == '-') pos++
                if (skipDigits() == 0) throw Invalid()
            }
            val value = text.substring(start, pos).toDoubleOrNull() ?: throw Invalid()
            if (value.isNaN() || value < -MAX_COORDINATE || value > MAX_COORDINATE) throw Invalid()
            return value
        }

        private fun skipDigits(): Int {
            val start = pos
            while (pos < text.length && text[pos] in '0'..'9') pos++
            return pos - start
        }

        private fun skipWhitespace() {
            while (pos < text.length && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) pos++
        }

        private fun peek(): Char? = if (pos < text.length) text[pos] else null

        private fun expect(c: Char) {
            if (peek() != c) throw Invalid()
            pos++
        }
    }
}
