# Hologram card art

The files in `solitaire/art/holo/` are the artwork of the hologram card style. This folder holds
what is needed to make more of it in the same style, or to rebuild the files.

## What the files are

All card images are 5:7, like a card, in two sizes: `-l` (720×1008, for the 3D preview and the
gallery) and `-s` (300×420, for cards on the table).

| Files | What |
| --- | --- |
| `court-<suit>-<rank>-{l,s}.webp` | A holographic figure with a transparent background: rank 11 jack, 12 queen, 13 king; suit `spades`, `hearts`, `clubs`, `diamonds`. The figure fills the image from top to bottom and dissolves into a beam of light at the bottom. |
| `ace-<suit>-{l,s}.webp` | A crystal gem in the shape of the suit, transparent background, same framing. |
| `back-a-{l,s}.webp`, `back-b-{l,s}.webp` | Two card backs, opaque and full bleed: midnight with rainbow foil ("Prism") and a pearl lattice ("Pearl"). |
| `foil-ice.webp`, `foil-sparkle.webp` | Seamless 512×512 tiles for the foil effect: greyscale "cracked ice" shards and pastel sparkles on black. |

## How the figures, aces and backs were made

They were generated with Higgsfield (model `gpt_image_2_6`, aspect ratio 3:4, resolution 2k,
quality high; `background: transparent` for figures and aces, `opaque` for backs), following
the style contract of Higgsfield's game asset workflow: one style formula, inserted unchanged
into every prompt. The King of Spades was generated first and then passed as the reference
image for every other figure and ace.

Style formula (keep it byte for byte when generating more):

> premium holographic foil playing-card illustration, semi-realistic digital painting with crisp engraved linework and glassy translucent volumes, elegant regal silhouettes with fine gold filigree outlines and faceted gem-like planes, figures in pearl, silver and deep jewel tones lit by spectral rainbow rim light, spades and clubs accented in sapphire and onyx, hearts and diamonds accented in ruby and rose-gold, luminous majestic mood as if projected from pure light, high contrast, clean readable silhouette, flat frontal view

Prompt for a figure, in this order:

1. `in exactly the same art style, scale, framing and lighting as the reference image, game sprite of a holographic projection of the <Rank> of <Suit>, single character, centered,`
2. the figure: who it is, shown waist-up facing the viewer, what it wears (decorated only with its own suit's emblems, in that suit's colours) and holds, then `below the waist the body dissolves downward into a narrow beam of glowing prismatic light particles and crystal shards,`
3. the style formula,
4. `, tall portrait composition with the head in the upper third and empty space left and right of the figure, top-left and bottom-right corners kept empty, isolated on a fully transparent background, no background scenery, no card border, no frame, no text, no letters, no numbers, no other card suit symbols, nothing cropped at the edges`

An ace replaces part 2 with one large faceted crystal gemstone cut in the exact shape of the
suit symbol, set in a fine gold rim, above the same beam of light. A back describes a flat,
full-bleed ornamental pattern that looks the same when rotated by 180 degrees, followed by the
style formula.

## Rebuilding the files

Needs Python with `numpy` and `pillow`.

```sh
# figures, aces and backs: from a folder of generated PNGs named like the outputs
# (court-spades-13.png, ace-hearts.png, back-a.png)
python3 tools/holo-art/process.py path/to/generated

# the two foil tiles (procedural, always the same result)
python3 tools/holo-art/foil.py
```

`process.py` crops each 3:4 image to 5:7, removes the faintest haze from the transparent edge and
writes both sizes as WebP. The generated PNGs are about 6 MB each and are not kept in the
repository.
