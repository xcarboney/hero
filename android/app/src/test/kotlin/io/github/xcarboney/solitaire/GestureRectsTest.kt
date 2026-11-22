package io.github.xcarboney.solitaire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The argument of SolitaireNative.setGestureExclusion: parsing, validation, CSS px -> px. */
class GestureRectsTest {

    // ------------------------------------------------------------------------------ parse

    @Test
    fun `an empty array clears the exclusion`() {
        assertEquals(emptyList<CssRect>(), GestureRects.parse("[]"))
        assertEquals(emptyList<CssRect>(), GestureRects.parse("  [ \n ]\t"))
    }

    @Test
    fun `the two strips the page sends`() {
        val json = "[{\"x\":0,\"y\":96,\"w\":40,\"h\":612},{\"x\":350,\"y\":96,\"w\":40,\"h\":612}]"
        assertEquals(
            listOf(CssRect(0.0, 96.0, 40.0, 612.0), CssRect(350.0, 96.0, 40.0, 612.0)),
            GestureRects.parse(json),
        )
    }

    @Test
    fun `members may come in any order, with whitespace and any JSON number form`() {
        val json = """ [ { "h" : 1.5e2 , "w":4E1, "y" : -0.25 ,"x":-12 } ,
            {"x":0.0,"y":0,"w":0,"h":1e-3} ] """
        assertEquals(
            listOf(CssRect(-12.0, -0.25, 40.0, 150.0), CssRect(0.0, 0.0, 0.0, 0.001)),
            GestureRects.parse(json),
        )
    }

    @Test
    fun `what JSON stringify produces for fractional layout values is accepted`() {
        val rects = GestureRects.parse("[{\"x\":371.4285583496094,\"y\":64.5,\"w\":40,\"h\":200}]")
        assertEquals(listOf(CssRect(371.4285583496094, 64.5, 40.0, 200.0)), rects)
    }

    @Test
    fun `anything that is not an array of x y w h objects is rejected`() {
        val invalid = listOf(
            null, "", " ", "null", "true", "0", "\"[]\"", "{}", "[", "]", "[[]]", "[1]", "[null]", "[{}]",
            "{\"x\":0,\"y\":0,\"w\":1,\"h\":1}", // an object, not an array
            "[{\"x\":0,\"y\":0,\"w\":1}]", // h missing
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1,\"z\":2}]", // unknown member
            "[{\"x\":0,\"x\":1,\"y\":0,\"w\":1,\"h\":1}]", // duplicate member
            "[{\"xx\":0,\"y\":0,\"w\":1,\"h\":1}]",
            "[{\"\":0,\"y\":0,\"w\":1,\"h\":1}]",
            "[{x:0,y:0,w:1,h:1}]", // not JSON
            "[{'x':0,'y':0,'w':1,'h':1}]",
            "[{\"x\":\"0\",\"y\":0,\"w\":1,\"h\":1}]", // string instead of number
            "[{\"x\":null,\"y\":0,\"w\":1,\"h\":1}]",
            "[{\"x\":[0],\"y\":0,\"w\":1,\"h\":1}]",
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1},]", // trailing comma
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1,}]",
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1}]x", // trailing garbage
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1}][]",
            "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1} {\"x\":0,\"y\":0,\"w\":1,\"h\":1}]", // comma missing
            "[{\"x\":0 \"y\":0,\"w\":1,\"h\":1}]",
            "[{\"x\" 0,\"y\":0,\"w\":1,\"h\":1}]",
        )
        for (json in invalid) assertNull("$json", GestureRects.parse(json))
    }

    @Test
    fun `numbers must be JSON numbers`() {
        fun withX(x: String) = "[{\"x\":$x,\"y\":0,\"w\":1,\"h\":1}]"
        for (ok in listOf("0", "-0", "7", "-7", "0.5", "12.25", "1e2", "1E+2", "25e-1")) {
            assertNotNull(ok, GestureRects.parse(withX(ok)))
        }
        for (bad in listOf("NaN", "Infinity", "-Infinity", "+1", ".5", "1.", "01", "0x10", "1e", "1e+", "--1", "1f", "1_0", "")) {
            assertNull(bad, GestureRects.parse(withX(bad)))
        }
    }

    @Test
    fun `numbers must be finite and within the coordinate bound`() {
        fun withX(x: String) = "[{\"x\":$x,\"y\":0,\"w\":1,\"h\":1}]"
        assertNotNull(GestureRects.parse(withX("100000")))
        assertNotNull(GestureRects.parse(withX("-100000")))
        assertNull(GestureRects.parse(withX("100000.5")))
        assertNull(GestureRects.parse(withX("-100001")))
        assertNull(GestureRects.parse(withX("1e999"))) // would be Infinity
        assertNull(GestureRects.parse(withX("1e15")))
    }

    @Test
    fun `width and height must not be negative`() {
        assertNotNull(GestureRects.parse("[{\"x\":0,\"y\":0,\"w\":0,\"h\":0}]"))
        assertNull(GestureRects.parse("[{\"x\":0,\"y\":0,\"w\":-1,\"h\":1}]"))
        assertNull(GestureRects.parse("[{\"x\":0,\"y\":0,\"w\":1,\"h\":-0.5}]"))
    }

    @Test
    fun `the number of rectangles is bounded`() {
        fun list(n: Int) = (0 until n).joinToString(",", "[", "]") { "{\"x\":$it,\"y\":0,\"w\":1,\"h\":1}" }
        assertEquals(GestureRects.MAX_RECTS, GestureRects.parse(list(GestureRects.MAX_RECTS))!!.size)
        assertNull(GestureRects.parse(list(GestureRects.MAX_RECTS + 1)))
    }

    @Test
    fun `the length of the JSON is bounded`() {
        val padding = " ".repeat(GestureRects.MAX_JSON_LENGTH)
        assertNotNull(GestureRects.parse("[]" + padding.dropLast(2)))
        assertNull(GestureRects.parse("[]" + padding))
    }

    @Test
    fun `hostile input neither throws nor hangs`() {
        val hostile = listOf(
            "[".repeat(1000), "{".repeat(1000), "[{\"x\":" + "9".repeat(900) + "}]",
            "[{\"x\":1e" + "9".repeat(900) + "}]", "\u0000", "[{\"x\":0,\"y\":0,\"w\":1,\"h\":1}\u0000]",
            "[{\"\\u0078\":0,\"y\":0,\"w\":1,\"h\":1}]", // an escaped "x": escapes are not accepted
        )
        for (json in hostile) assertNull(GestureRects.parse(json))
    }

    // ------------------------------------------------------------------------- conversion

    private val strips = listOf(CssRect(0.0, 96.0, 40.0, 612.0), CssRect(350.0, 96.0, 40.0, 612.0))

    @Test
    fun `CSS px are multiplied by the density`() {
        assertEquals(
            listOf(PxRect(0, 288, 120, 2124), PxRect(1050, 288, 1170, 2124)),
            GestureRects.toDevicePx(strips, 3f, 1170, 2532),
        )
        assertEquals(
            listOf(PxRect(0, 96, 40, 708), PxRect(350, 96, 390, 708)),
            GestureRects.toDevicePx(strips, 1f, 390, 844),
        )
    }

    @Test
    fun `fractions round outwards so a strip never stops short of the edge`() {
        // density 2.625 (a common 420 dpi phone): 411.43 CSS px wide, 1080 px.
        val rects = listOf(CssRect(0.3, 10.2, 39.9, 100.1), CssRect(371.4285583496094, 10.2, 40.0, 100.1))
        assertEquals(
            listOf(PxRect(0, 26, 106, 290), PxRect(974, 26, 1080, 290)),
            GestureRects.toDevicePx(rects, 2.625f, 1080, 2400),
        )
    }

    @Test
    fun `rectangles are clipped to the view`() {
        val rects = listOf(
            CssRect(-20.0, -50.0, 60.0, 100.0), // sticks out top left
            CssRect(380.0, 800.0, 100.0, 100.0), // sticks out bottom right
            CssRect(-1000.0, -1000.0, 100_000.0, 100_000.0), // covers everything
        )
        assertEquals(
            listOf(PxRect(0, 0, 80, 100), PxRect(760, 1600, 780, 1688), PxRect(0, 0, 780, 1688)),
            GestureRects.toDevicePx(rects, 2f, 780, 1688),
        )
    }

    @Test
    fun `empty and off-screen rectangles are dropped`() {
        val rects = listOf(
            CssRect(0.0, 0.0, 0.0, 100.0), // no width
            CssRect(0.0, 0.0, 40.0, 0.0), // no height
            CssRect(500.0, 0.0, 40.0, 100.0), // right of the view
            CssRect(0.0, 900.0, 40.0, 100.0), // below the view
            CssRect(-100.0, 0.0, 40.0, 100.0), // left of the view
            CssRect(10.0, 10.0, 20.0, 20.0), // the only one that stays
        )
        assertEquals(listOf(PxRect(20, 20, 60, 60)), GestureRects.toDevicePx(rects, 2f, 780, 1688))
    }

    @Test
    fun `no view size or no usable density gives no rectangles`() {
        assertTrue(GestureRects.toDevicePx(strips, 3f, 0, 2532).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, 3f, 1170, 0).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, 3f, -1, -1).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, 0f, 1170, 2532).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, -2f, 1170, 2532).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, Float.NaN, 1170, 2532).isEmpty())
        assertTrue(GestureRects.toDevicePx(strips, Float.POSITIVE_INFINITY, 1170, 2532).isEmpty())
        assertTrue(GestureRects.toDevicePx(emptyList(), 3f, 1170, 2532).isEmpty())
    }

    @Test
    fun `the extremes the parser lets through cannot overflow`() {
        val extreme = GestureRects.parse(
            "[{\"x\":-100000,\"y\":-100000,\"w\":100000,\"h\":100000},{\"x\":100000,\"y\":100000,\"w\":100000,\"h\":100000}," +
                "{\"x\":-100000,\"y\":0,\"w\":100000,\"h\":100000}]",
        )!!
        // A very dense, very large display: nothing but the part inside the view comes out.
        assertEquals(emptyList<PxRect>(), GestureRects.toDevicePx(extreme.take(2), 8f, 8000, 8000))
        assertEquals(emptyList<PxRect>(), GestureRects.toDevicePx(extreme.drop(2), 8f, 8000, 8000))
    }
}
