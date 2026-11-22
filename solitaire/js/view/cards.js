/*
 * SOL.Cards — builds the 3D playing-card elements (fronts, backs, thickness) and their shared art.
 *
 * Public API
 * ----------
 *   Cards.BACKS            -> [{ id, name }]  ('royal', 'aurora', 'ember', 'lattice', 'petal', 'mono', 'prism', 'pearl'
 *                             — in this order; the last two are pictures from art/holo/)
 *   Cards.DEFAULT_BACK     -> 'prism'
 *   Cards.STYLES           -> ['holo', 'classic']     Cards.DEFAULT_STYLE -> 'holo'
 *   Cards.SUITS            -> ['spades', 'hearts', 'clubs', 'diamonds']
 *   Cards.COMPACT_BELOW    -> 60   card widths (CSS px) below this show the compact front layout (see "Art notes")
 *   Cards.HOLO             -> layout numbers of the hologram style (see "Hologram style")
 *   Cards.create(cardId, { back, thick, style } = {})    -> HTMLElement  full card, face-up (--flip unset = 0deg)
 *   Cards.createBackOnly(backId, { thick, style } = {})  -> HTMLElement  the same back on both sides (gallery previews)
 *   Cards.setBack(el, backId)                       -> el           unknown ids fall back to DEFAULT_BACK
 *   Cards.setStyle(el, style)                       -> el           'holo' | 'classic': rebuilds the inside of the front;
 *                                                                   setStyle(el) hands the card back to the setting
 *   Cards.styleOf(el)                               -> 'holo' | 'classic'   the style a card has now
 *   Cards.currentStyle()                            -> 'holo' | 'classic'   the 'cardStyle' setting ('holo' without SOL.Settings)
 *   Cards.foil(el, x, y, o, edge?)                  -> el           live foil of a hologram card: light at x, y (0..1 across
 *                                                                   the visible face), o 0..1 how alive, edge 0..1 how far a
 *                                                                   thick card is turned away. foil(el, null) = back to rest
 *   Cards.preload({ large, cards, backs } = {})     -> Promise      fetches and decodes the art files (never rejects);
 *                                                                   with cards / backs: the pictures of those alone
 *   Cards.preloaded()                               -> boolean      the table-size pictures of the style in use have
 *                                                                   arrived: what the promise of preload() tells, asked
 *                                                                   without waiting (see preloaded() for why both exist)
 *   Cards.setFaceUp(el, bool)                       -> el           instant: --flip 0deg / 180deg + .is-face-down
 *   Cards.isFaceUp(el)                              -> boolean      (reads the .is-face-down class)
 *   Cards.suitSvg(suit, { size, className } = {})   -> string       standalone <svg> markup, fill: currentColor;
 *                                                                   suit is 0..3 or 'spades' | 'hearts' | 'clubs' | 'diamonds'
 *   Cards.label(cardId)                             -> 'Queen of Hearts' | '7 of Clubs'
 *   Cards.info(cardId)                              -> { id, suit, rank, suitName, color: 'red' | 'black', label }
 *   Cards.backUrl(backId)                           -> string       CSS `url("…")` of a back design, for swatches that are
 *                                                                   not card elements: a data: URI for the six drawn backs,
 *                                                                   the table-size picture for 'prism' and 'pearl'
 *   Cards.ensureAssets()                            -> void         injects the back styles and the art <svg>s of the
 *                                                                   style in use (idempotent; create() calls it, and
 *                                                                   brings what a card of the other style needs, so
 *                                                                   calling it is optional)
 *
 * Hologram style (the default; HOLO.md is the design)
 * ---------------------------------------------------
 * Every card has a style, written on it as data-style="holo" | "classic". create() and createBackOnly() take it
 * from { style } or, without one, from the 'cardStyle' setting — and a card made without one keeps following
 * the setting: on 'settings:change' this module switches every such card itself, in the document or not, so no
 * owner has to. A Classic card is built and painted exactly as before the hologram style existed (same DOM,
 * no image is requested for its face).
 *
 * A hologram front (data-face="court" | "ace" | "pips" on .card) has these boxes inside .card__front:
 *   window cards (courts, aces):  .card__win (window floor)  .card__fig > .card__figim (the figure or gem, a
 *                                 picture from art/holo/)  svg.card__art (pearl paper with the window cut out,
 *                                 gold rim)  svg.card__ink (indices, fan mark, tight mark)
 *   number cards:                 .card__foil > svg.card__art (pearl paper, foil-ink pips)  svg.card__ink (the
 *                                 paper around the panel, the foil line, indices, fan mark, tight mark)
 * The back of a hologram card is the same box as a classic one's. The classes .card__classic / .card__compact
 * / .card__fan / .card__tight, data-layout, .is-fanned and .is-tight work as on a classic card. A hologram card
 * is 16 DOM nodes (number card) or 18 (window card), 49 / 51 with { thick: true }.
 *
 * At rest all of it is static paint: a resting hologram card has no more compositor layers than a classic one.
 *
 * Live foil: the owner of a card calls Cards.foil(el, x, y, o) whenever the light on the card changes, and
 * Cards.foil(el, null) when the card comes to rest (see foil() for the details). foil() keeps small "sheets"
 * (<i class="card__sheet">) in the card — in .card__win and .card__foil, and in three boxes it adds for them:
 * .card__spark (in front of the figure), .card__figfx (on the figure, thick cards) and .card__bfoil (on a
 * picture back) — and writes their transform and opacity; the card has the class .is-holo while they exist
 * (3 to 14 nodes more). On a table-size card the sheets are painted into the card's own layer; on a thick
 * card, or one laid out wider than 130px, each is a compositor layer — and such a large card shows the foil
 * as it is seen from close by: facets that stay where they are on the card (two sheets that never move, and
 * are not displayed on a smaller card) with the sliding rainbow blended into them, so every facet answers the
 * light in its own colour (cards.css: "live foil of a large card"). Nothing happens for a Classic card or
 * with <html data-effects="low">. Custom properties on .card do NOT drive the foil.
 * No filter runs on anything that moves (HOLO.md 5) — with one exception that is meant: the two gleam copies
 * of the figure on a thick card (.card__sheet--glow / --glow-b, the <b> inside each) are brightened with a CSS
 * filter. It is on an inner box without a layer of its own, so it is baked into the sheet's texture when the
 * sheet is rastered and costs nothing per frame (measured; the reasoning and the numbers are at that rule in
 * cards.css, "The figure's own light"). Do not take it for an oversight, and do not add another.
 *
 * The two picture backs carry a fine rim of pale gold just inside the edge (cards.css), in either style, so
 * face-down cards that lie on each other keep their outlines.
 *
 * Depth: on a thick window card the boxes are real planes — the window floor is a recess, the indices stand
 * proud, the figure floats in front of the card and sparkles in front of the figure (Cards.HOLO.depth, as
 * fractions of the card's width). The fifth argument of foil(), edge, lets the floating planes sink back as the
 * card turns away (fully floating up to HOLO.edgeFadeFrom, sunk from HOLO.edgeFadeTo); with edge 1 a thick card
 * looks exactly like the flat card. foil() moves the planes with inline transforms on the three boxes, not
 * with a custom property (see applyDepth() for why). A thick number card is flat.
 *
 * What must not be done to a hologram card: no opacity < 1, filter, overflow, clip-path, mask or mix-blend-mode
 * on .card, .card__tilt, .card__flip or (thick cards) .card__front — each flattens the planes; no transform
 * with a negative scale on a thick card's ancestors (the planes are culled from behind); no innerHTML / child
 * surgery inside .card__front or .card__back (setStyle() and foil() own those); never rotate a FLAT card past
 * edge-on (as for classic cards).
 *
 * Cards.HOLO -> { panel: { x0, y0, x1, y1, notchW, notchH }, panelCompact: { x0, y0, x1, y1 },
 *                 depth: { ink, figure, sparkle }, edgeFadeFrom, edgeFadeTo }
 *   panel         the window of a court / ace (the foil panel of a number card) in the classic layout, as
 *                 fractions of the card (x of its width, y of its height, from the top-left corner): a rounded
 *                 rectangle x0..x1, y0..y1 with the top-left and the bottom-right corner stepped in by notchW x
 *                 notchH, where the two indices stand on pearl paper
 *   panelCompact  the same in the compact layout: the rectangle under rank and suit
 *
 * Images: Cards.preload() fetches and decodes what the table paints with (16 figures and gems, the two picture
 * backs, the two foil tiles; only the backs while the style is Classic); it runs by itself when this file
 * loads. The 720 px files are loaded on demand, picture by picture: Cards.preload({ large: true, cards: [ids],
 * backs: [ids] }) fetches and decodes the large pictures of those cards and backs (and decodes them again when
 * asked again), and a card that is big enough paints with the large file of a picture from the moment it is
 * in — until then with the small one, never with nothing. A thick card asks for its own when it is made;
 * SOL.Inspector asks for the neighbours of the card in view and for the cards on its carousel a step ahead.
 * Cards.preload({ large: true }) without a list loads all 18, two at a time (SOL.Inspector does that when it
 * closes, where the table's own cards are big enough to use them). Nothing in here listens for the
 * inspector's events.
 * All files are in art/holo/, addressed relative to this script, so nothing depends on where the page lives.
 *
 * Card model (contract section 4): id 0..51, suit = floor(id / 13) (0 spades, 1 hearts, 2 clubs, 3 diamonds),
 * rank = id % 13 + 1 (1 ace … 13 king), red when suit is odd. Derived here on purpose: no dependency on SOL.Engine.
 *
 * DOM (css/cards.css documents the custom properties each part reads, and why they are routed the way they are)
 * ---------------------------------------------------------------------------------------------------------------
 *   <div class="card [card--thick] [card--back-only] [is-face-down] [is-holo]" data-id data-suit data-rank data-color
 *        data-back data-style [data-face] [data-style-fixed] role="img" aria-label="Queen of Hearts">
 *     <div class="card__shadow"></div>                         (two cross-faded lift shadows; rotates with the faces)
 *     <div class="card__tilt">
 *       <div class="card__flip">
 *         <div class="card__face card__front"><svg class="card__art">…four <use> into the faces…</svg></div>
 *                                                              (a classic front; a hologram front: "Hologram style")
 *         <div class="card__face card__back"></div>            (the design is a CSS background chosen by data-back)
 *         <div class="card__edges">…</div>                     (only with { thick: true }: 4 walls + 7 strips per rounded
 *                                                                corner, each an <i class="card__edge">, lit from the top-left)
 *         <div class="card__glare"></div>
 *       </div>
 *     </div>
 *   </div>
 *
 * The owner of a card writes `transform` on .card and sets, on the .card element, --flip, --tilt-x, --tilt-y
 * (angles, with unit), --lift (0..1), --glare-x, --glare-y (percentages), --glare-o (0..1) and the optional
 * --sheen-o / --shadow-o (0..1). Nothing in here listens for resize: every measure derives from --card-w in CSS,
 * and the art is SVG.
 *
 * Art notes: all shapes live once in injected <svg> elements at the top of <body> and each front is four <use>
 * elements — a classic layout (corner indices, pips, ornamental ace, double-ended courts), a compact one for
 * cards narrower than 60px (big rank + suit, one large suit or a single bust), the fan mark and the tight mark
 * (both below); a container query in cards.css shows one of the two layouts. The <svg>s are of two kinds (see
 * "sprite" in the code): sprites, rendered at zero size, for what must be rendered to work — #sol-card-sprite
 * (suit and numeral symbols, clip paths, the diaper pattern of the classic courts; always there) and
 * #sol-card-sprite-holo (the gradients of the hologram style) — and faces, display:none, with one <g> per card
 * and layout: #sol-card-faces (classic) and #sol-card-faces-holo. A style's part is injected with the first
 * card of that style (when this file loads: the part of the style in use), so a page that only shows one
 * style never builds the other's, and the faces cost neither style nor layout. The six drawn backs are
 * procedurally generated SVG documents handed to CSS as data: URIs, so a face-down card costs no extra DOM.
 * Suits, numerals, the classic court figures and the six drawn backs are drawn from scratch below; the
 * hologram figures, gems, the two picture backs and the foil tiles are generated pictures in art/holo/
 * (tools/holo-art/README.md). A classic card is 12 DOM nodes (45 with { thick: true }).
 *
 * Optional attribute: data-layout="compact" | "classic" on the .card element pins the front layout whatever the
 * card's size (unset = automatic). Nothing in here sets it.
 *
 * Optional class: .is-fanned on the .card element — "only the left edge of this card can be seen" (a covered
 * card of a sideways fan). In the compact layout it shows the fan mark, a small suit under the rank (on a paper
 * chip for the courts), which is hidden otherwise; the classic layout ignores it (its corner index has the suit
 * under the rank anyway). The owner sets it (SOL.Board does, for the draw-3 waste); nothing in here does.
 *
 * Optional class: .is-tight on the .card element — "only a strip along the top edge of this card can be seen,
 * too low for the classic corner index" (a covered card of a squeezed column: the suit under the rank is cut
 * off). In the classic layout it shows the tight mark, the suit once more in the top-right corner, level with
 * the rank (that corner is empty on every classic face), which is hidden otherwise; the compact layout ignores
 * it (its suit sits there anyway). The owner sets it (SOL.Board does, for squeezed tableau columns); nothing
 * in here does.
 *
 * Layout numbers other modules may lean on (fractions of the card height, measured from the top edge): the
 * corner index ends at 0.26 in the classic layout (rank alone: 0.17; the tight mark ends at 0.15, so a classic
 * card marked .is-tight shows rank and suit down to a step of 0.17) and at 0.27 in the compact one, so a
 * tableau fan step of 0.27-0.28 keeps rank and suit of every covered card readable at any size. Sideways
 * (fractions of the card width from the left edge): the classic index needs 0.22; the compact rank needs 0.24
 * (0.33 for the 10) and the compact suit sits top-RIGHT, so a sideways fan of compact cards shows rank and
 * colour only — unless its covered cards are marked .is-fanned: the fan mark needs 0.27 (0.30 under the 10,
 * 0.28 on a court) and ends at 0.44 of the card height.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  // ------------------------------------------------------------------ card model
  const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
  const SUIT_LABELS = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
  const RANK_LABELS = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];

  const BACKS = [
    { id: 'royal', name: 'Royal' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'ember', name: 'Ember' },
    { id: 'lattice', name: 'Lattice' },
    { id: 'petal', name: 'Petal' },
    { id: 'mono', name: 'Mono' },
    { id: 'prism', name: 'Prism' },
    { id: 'pearl', name: 'Pearl' },
  ];
  const DEFAULT_BACK = 'prism';
  const STYLES = ['holo', 'classic'];
  const DEFAULT_STYLE = 'holo';
  const COMPACT_BELOW = 60; // must match the container query in cards.css (max-width: 59.9px)

  function checkId(cardId) {
    if (!Number.isInteger(cardId) || cardId < 0 || cardId > 51) {
      throw new RangeError('SOL.Cards: card id must be an integer 0..51, got ' + cardId);
    }
    return cardId;
  }

  function suitIndex(suit) {
    const i = typeof suit === 'string' ? SUITS.indexOf(suit) : suit;
    if (!Number.isInteger(i) || i < 0 || i > 3) throw new RangeError('SOL.Cards: unknown suit ' + suit);
    return i;
  }

  function backId(id) {
    return BACKS.some((b) => b.id === id) ? id : DEFAULT_BACK;
  }

  function backName(id) {
    return BACKS.find((b) => b.id === id).name;
  }

  /** { id, suit, rank, suitName, color, label } for a card id. */
  function info(cardId) {
    checkId(cardId);
    const suit = Math.floor(cardId / 13);
    const rank = (cardId % 13) + 1;
    return {
      id: cardId,
      suit: suit,
      rank: rank,
      suitName: SUITS[suit],
      color: suit % 2 === 1 ? 'red' : 'black',
      label: RANK_LABELS[rank - 1] + ' of ' + SUIT_LABELS[suit],
    };
  }

  function label(cardId) {
    return info(cardId).label;
  }

  // ------------------------------------------------------------------ small helpers
  /** Round to 2 decimals and drop trailing zeros: keeps the generated markup short. */
  function n(v) {
    return String(Math.round(v * 100) / 100);
  }

  /** Deterministic PRNG (mulberry32) so procedural backs are identical on every load. */
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function polar(cx, cy, r, deg) {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  // ------------------------------------------------------------------ suits (100 x 100 box, one path each)
  const SUIT_PATHS = [
    // spade
    'M50 4C44 20 9 42 9 64C9 77 19 86 30.5 86C38.5 86 45 82 48 75.5C47.5 84 44 91 35 96L65 96C56 91 52.5 84 52 75.5' +
      'C55 82 61.5 86 69.5 86C81 86 91 77 91 64C91 42 56 20 50 4Z',
    // heart
    'M50 92C47 88 8 62 8 34C8 18.5 19.5 8 31 8C40 8 47 13.5 50 21C53 13.5 60 8 69 8C80.5 8 92 18.5 92 34' +
      'C92 62 53 88 50 92Z',
    // club: the outline of three lobes and a stem as ONE closed path (no overlapping subpaths), so it can be
    // stroked and clipped like the other suits (the ace inline needs that)
    'M32.37 37.47A20.5 20.5 0 1 1 67.63 37.47A20.5 20.5 0 1 1 52.85 64.7C52.9 81 56.5 90.5 65 96L35 96' +
      'C43.5 90.5 47.1 81 47.15 64.7A20.5 20.5 0 1 1 32.37 37.47Z',
    // diamond
    'M50 3C58 20 73 38 87 50C73 62 58 80 50 97C42 80 27 62 13 50C27 38 42 20 50 3Z',
  ];

  /**
   * Standalone suit icon markup (does not depend on the sprite). `fill` is currentColor, so colour it with CSS;
   * data-suit / data-color are set for convenience.
   */
  function suitSvg(suit, opts) {
    const i = suitIndex(suit);
    const o = opts || {};
    const size = o.size === undefined || o.size === null ? '1em' : typeof o.size === 'number' ? o.size + 'px' : o.size;
    const cls = 'sol-suit sol-suit--' + SUITS[i] + (o.className ? ' ' + o.className : '');
    return (
      '<svg class="' + cls + '" data-suit="' + SUITS[i] + '" data-color="' + (i % 2 ? 'red' : 'black') +
      '" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="' + SUIT_PATHS[i] + '"/></svg>'
    );
  }

  // ------------------------------------------------------------------ numerals (original monoline glyphs)
  /*
   * Each glyph is a centre-line path stroked 14 wide in a W x 100 box. Strokes deliberately overshoot the box:
   * the <symbol> viewport clips them, which gives every diagonal a flat, type-like terminal.
   */
  const GLYPHS = {
    1: { w: 64, d: 'M4.5 110L32 -2L59.5 110M14 68H50' },
    2: { w: 60, d: 'M10.3 38.4A21.5 21.5 0 1 1 52 31C52 46 32 60 8 92.5H58' },
    3: { w: 60, d: 'M11 19.6A21 21 0 1 1 30 49.5H23M23 49.5H30A21.5 21.5 0 1 1 10.5 80.1' },
    4: { w: 60, d: 'M62 69.5H9L44 -4M44 -6V106' },
    5: { w: 60, d: 'M54 7.5H13.5V43.5H28A24.5 24.5 0 1 1 6.8 80.3' },
    6: { w: 60, d: 'M48 9.5C26 6 7.5 30 7.5 69A22.5 22.5 0 1 0 52.5 69A22.5 22.5 0 1 0 7.5 69' },
    7: { w: 60, d: 'M3 7.5H55L23 106' },
    8: { w: 60, d: 'M30 7.5A20 20 0 1 1 30 47.5A20 20 0 1 1 30 7.5ZM30 48.5A22 22 0 1 1 30 92.5A22 22 0 1 1 30 48.5Z' },
    9: { w: 60, d: 'M48 9.5C26 6 7.5 30 7.5 69A22.5 22.5 0 1 0 52.5 69A22.5 22.5 0 1 0 7.5 69', t: 'rotate(180 30 50)' },
    10: { w: 84, d: 'M7 27L20.5 8V106M58.5 7.5A18.5 42.5 0 1 1 58.5 92.5A18.5 42.5 0 1 1 58.5 7.5Z' },
    11: { w: 52, d: 'M44.5 -5V72.5A20 20 0 0 1 4.5 72.5' },
    12: { w: 68, d: 'M34 7.5A26.5 42.5 0 1 1 34 92.5A26.5 42.5 0 1 1 34 7.5ZM40 70L64 104' },
    13: { w: 62, d: 'M7.5 -5V105M60 -8L9 62M26 41L64 108' },
  };

  function use(id, x, y, w, h, extra) {
    return '<use href="#' + id + '" x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"' +
      (extra || '') + '/>';
  }

  /** A suit pip centred on (cx, cy); `flip` turns it upside down (lower half of the card). */
  function pip(suit, cx, cy, size, flip, extra) {
    return use('sol-suit-' + suit, cx - size / 2, cy - size / 2, size, size,
      (flip ? ' transform="rotate(180 ' + n(cx) + ' ' + n(cy) + ')"' : '') + (extra || ''));
  }

  // ------------------------------------------------------------------ fronts: classic layout (250 x 350)
  const PAPER = '#fdfbf5';
  const GOLD = '#dba63f';
  const GOLD_D = '#b17d1e';
  const GOLD_L = '#f3d27f';
  const SKIN = '#f6dcc0';
  const SKIN_D = '#e3bb95';
  const STEEL = '#eef1f6';

  /** Corner index: rank over suit, top-left. The caller rotates a copy for the opposite corner. */
  function indexMarkup(rank, suit) {
    return use('sol-rank-' + rank, 8, 13, 44, 46) + use('sol-suit-' + suit, 16.5, 63.5, 27, 27);
  }

  // Pip columns sit a little inside the traditional 30% / 70% so the big corner indices get clear air around them.
  const PIP_X = [84, 125, 166];
  const PIP_TOP = 70;
  const PIP_BOTTOM = 280;
  const PIP_MID = 175;

  /** Standard pip positions for 2..10 as [column, y, upsideDown]. */
  function pipLayout(rank) {
    const T = PIP_TOP;
    const B = PIP_BOTTOM;
    const M = PIP_MID;
    const sides = (y, flip) => [[0, y, flip], [2, y, flip]];
    switch (rank) {
      case 2: return [[1, T, 0], [1, B, 1]];
      case 3: return [[1, T, 0], [1, M, 0], [1, B, 1]];
      case 4: return sides(T, 0).concat(sides(B, 1));
      case 5: return sides(T, 0).concat(sides(B, 1), [[1, M, 0]]);
      case 6: return sides(T, 0).concat(sides(M, 0), sides(B, 1));
      case 7: return sides(T, 0).concat(sides(M, 0), sides(B, 1), [[1, (T + M) / 2, 0]]);
      case 8: return sides(T, 0).concat(sides(M, 0), sides(B, 1), [[1, (T + M) / 2, 0], [1, (M + B) / 2, 1]]);
      case 9: {
        const s = (B - T) / 3;
        return sides(T, 0).concat(sides(T + s, 0), sides(B - s, 1), sides(B, 1), [[1, M, 0]]);
      }
      case 10: {
        const s = (B - T) / 3;
        return sides(T, 0).concat(sides(T + s, 0), sides(B - s, 1), sides(B, 1),
          [[1, T + s / 2, 0], [1, B - s / 2, 1]]);
      }
      default: return [];
    }
  }

  function pipsMarkup(rank, suit) {
    const size = rank <= 3 ? 50 : rank <= 8 ? 44 : 39;
    return pipLayout(rank).map((p) => pip(suit, PIP_X[p[0]], p[1], size, p[2])).join('');
  }

  /**
   * A suit centred on (cx, cy) with an engraved inline: `rim` of ink, then `band` of paper, then solid ink
   * (both in suit units, 1/100 of `size`). The inline is a true inset — two strokes clipped to the suit's own
   * outline — so its width is the same all the way round and the outer tips stay sharp; a scaled copy of the
   * shape would pinch at the tips and gape at the lobes.
   */
  function inlineSuit(suit, cx, cy, size, rim, band) {
    const d = SUIT_PATHS[suit];
    return (
      '<g transform="translate(' + n(cx - size / 2) + ' ' + n(cy - size / 2) + ') scale(' + n(size / 100) +
      ')" clip-path="url(#sol-suit-clip-' + suit + ')">' +
      '<path d="' + d + '"/>' +
      '<path d="' + d + '" fill="none" stroke="' + PAPER + '" stroke-width="' + n(2 * (rim + band)) + '" stroke-linejoin="round"/>' +
      '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="' + n(2 * rim) + '" stroke-linejoin="round"/>' +
      '</g>'
    );
  }

  /** The ornamental ace: a large inlined suit inside a fine sunburst with four small jewels. */
  function aceMarkup(suit) {
    const cx = 125;
    const cy = 175;
    let rays = '';
    let dots = '';
    for (let i = 0; i < 48; i++) {
      const long = i % 2 === 0;
      const a = polar(cx, cy, 78, i * 7.5);
      const b = polar(cx, cy, long ? 97 : 87, i * 7.5);
      rays += 'M' + n(a[0]) + ' ' + n(a[1]) + 'L' + n(b[0]) + ' ' + n(b[1]);
      if (!long) {
        const d = polar(cx, cy, 93.5, i * 7.5);
        dots += '<circle cx="' + n(d[0]) + '" cy="' + n(d[1]) + '" r="1.6"/>';
      }
    }
    // four small jewels where the ring meets the card's axes
    let gems = '';
    for (let i = 0; i < 4; i++) {
      const g = polar(cx, cy, 70.5, i * 90);
      gems += '<path d="M' + n(g[0]) + ' ' + n(g[1] - 5.2) + 'l3.6 5.2l-3.6 5.2l-3.6-5.2z" fill="' + GOLD + '" stroke="' +
        PAPER + '" stroke-width="2.2" paint-order="stroke"/>';
    }
    const size = [118, 110, 112, 118][suit];
    const dy = [-2.5, 1.5, -2, 0][suit]; // optical centring: stems pull spades and clubs down, the heart's cleft pulls it up
    return (
      '<path d="' + rays + '" fill="none" stroke="' + GOLD + '" stroke-width="1.7" stroke-linecap="round"/>' +
      '<g fill="' + GOLD + '">' + dots + '</g>' +
      '<circle cx="125" cy="175" r="72.5" fill="none" stroke="' + GOLD + '" stroke-width="1.5"/>' +
      '<circle cx="125" cy="175" r="68.5" fill="none" stroke="currentColor" stroke-width=".9" opacity=".45"/>' +
      gems +
      inlineSuit(suit, cx, cy + dy, size, 3.2, 2.6)
    );
  }

  // ------------------------------------------------------------------ court cards (original figures)
  /*
   * One bust per rank and suit, drawn in card coordinates inside the panel x 60..190, y 30..175 (the lower half of
   * the card is the same bust rotated 180 degrees about the centre). Flat geometric shapes only; ink = currentColor.
   * Per suit: a tint and a pale panel colour; clubs and diamonds are mirrored so the four suits do not look alike.
   */
  const COURT_PAL = [
    { tint: '#6f86ba', pale: '#e7ecf6', hair: '#2a3048', hair2: '#5a6485' }, // spades — steel blue
    { tint: '#ee959b', pale: '#fdebe8', hair: '#47212d', hair2: '#805260' }, // hearts — rose
    { tint: '#5fa08d', pale: '#e4f2ed', hair: '#2a3048', hair2: '#5a6485' }, // clubs — sage
    { tint: '#f3aa5f', pale: '#fdf1e0', hair: '#47212d', hair2: '#805260' }, // diamonds — amber
  ];

  function P(d, fill, extra) {
    return '<path d="' + d + '" fill="' + fill + '"' + (extra || '') + '/>';
  }
  function C(cx, cy, r, fill, extra) {
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"' + (extra || '') + '/>';
  }
  function R(x, y, w, h, rx, fill, extra) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"' + (rx ? ' rx="' + rx + '"' : '') +
      ' fill="' + fill + '"' + (extra || '') + '/>';
  }
  function L(d, stroke, width, extra) {
    return '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="' + width + '"' + (extra || '') + '/>';
  }

  function kingBust(suit, pal) {
    const INK = 'currentColor';
    let s = '';
    // robe + ermine collar
    s += P('M58 176V151Q58 140 70 136L104 124H146L180 136Q192 140 192 151V176Z', INK);
    s += C(66, 149, 2.2, GOLD) + C(184, 149, 2.2, GOLD) + C(73, 159, 2.2, GOLD) + C(177, 159, 2.2, GOLD);
    s += C(64, 160.5, 1.5, GOLD) + C(186, 160.5, 1.5, GOLD);
    s += P('M77 133L104 121Q125 150 146 121L173 133Q165 156 125 160Q85 156 77 133Z', PAPER);
    s += L('M77 133Q85 156 125 160Q165 156 173 133', GOLD, 1.8);
    [[89, 138.5], [100, 146], [112, 150.5], [125, 152], [138, 150.5], [150, 146], [161, 138.5]].forEach((p) => {
      s += P('M' + p[0] + ' ' + (p[1] - 3.4) + 'l2 3.4l-2 3.4l-2-3.4z', INK);
    });
    // head
    s += P('M99 62H151V100Q151 110 143 110H107Q99 110 99 100Z', pal.hair);
    s += R(118, 100, 14, 24, 0, SKIN_D);
    s += P('M107 64H143V98Q143 114 125 116Q107 114 107 98Z', SKIN);
    s += P('M125 64H143V98Q143 114 125 116Z', SKIN_D, ' opacity=".35"');
    s += R(113.5, 80, 5.5, 3.4, 1.7, pal.hair) + R(131, 80, 5.5, 3.4, 1.7, pal.hair);
    s += L('M111.5 75.5L120 74.5M130 74.5L138.5 75.5', pal.hair, 1.8, ' stroke-linecap="round"');
    s += L('M125 80V89.5H128.5', SKIN_D, 1.8, ' stroke-linecap="round" stroke-linejoin="round"');
    // beard + moustache
    s += P('M105 90Q115 96 125 93Q135 96 145 90V106Q145 126 125 137Q105 126 105 106Z', pal.hair);
    s += P('M125 95Q117 91 110 96Q117 102 125 99Q133 102 140 96Q133 91 125 95Z', pal.hair2);
    s += R(120.5, 104, 9, 3, 1.5, SKIN_D);
    // crown
    s += P('M100 56L97 36L108 48L113 34L119 48L125 29L131 48L137 34L142 48L153 36L150 56Z', GOLD);
    s += R(99, 55, 52, 10, 1.5, GOLD);
    s += R(99, 55, 52, 2.6, 0, GOLD_D);
    s += C(97, 35.5, 2.7, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(113, 33.5, 2.7, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(125, 28.5, 3.1, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(137, 33.5, 2.7, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(153, 35.5, 2.7, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(111, 61.5, 2.2, INK) + C(139, 61.5, 2.2, INK) + P('M125 57.5l3.6 4l-3.6 4l-3.6-4z', pal.tint);
    // sword (black suits) or sceptre (red suits), held upright beside the head
    if (suit % 2 === 0) {
      s += P('M176 38L181 49V139H171V49Z', STEEL);
      s += P('M176 38L181 49V139H176Z', pal.tint, ' opacity=".4"');
      s += L('M176 38L181 49V139H171V49Z', pal.hair2, 1, ' stroke-linejoin="round"');
      s += R(163.5, 138, 25, 5.5, 2.5, GOLD);
      s += R(173, 143, 6, 17, 0, pal.hair) + C(176, 162, 3.6, GOLD);
    } else {
      s += R(174.4, 50, 3.2, 114, 1.2, GOLD_D);
      s += C(176, 47, 7.5, GOLD) + C(176, 47, 3.4, pal.tint);
      s += P('M176 31l3 5.5l-3 4.5l-3-4.5z', GOLD);
      s += R(170.5, 56, 11, 3, 1.5, GOLD);
    }
    s += R(168, 143.5, 16, 12.5, 5.5, SKIN) + L('M172 147.6H180M172 151.6H180', SKIN_D, 1.1);
    // suit mark in the opposite corner
    s += pip(suit, 78, 52, 23, 0, ' fill="' + INK + '"');
    return s;
  }

  function queenBust(suit, pal) {
    const INK = 'currentColor';
    let s = '';
    // long hair behind everything
    s += P('M95 76Q95 48 125 48Q155 48 155 76V122Q155 136 146 140H104Q95 136 95 122Z', pal.hair);
    s += C(98.5, 133, 8.5, pal.hair) + C(151.5, 133, 8.5, pal.hair);
    // gown, neckline, necklace
    s += P('M58 176V159Q58 148 70 144L108 129H142L180 144Q192 148 192 159V176Z', INK);
    s += P('M104 131Q125 126 146 131L125 163Z', pal.tint);
    s += P('M110 130Q125 127 140 130Q134 150 125 152Q116 150 110 130Z', SKIN);
    s += L('M111.5 133Q125 151 138.5 133', GOLD, 2.2, ' stroke-linecap="round"');
    s += P('M125 143.5l3.4 4.2l-3.4 4.2l-3.4-4.2z', GOLD) + C(125, 147.7, 1.2, PAPER);
    s += L('M66 164Q74 152 86 148M184 164Q176 152 164 148', GOLD, 1.6, ' stroke-linecap="round"');
    // head
    s += R(119, 102, 12, 28, 0, SKIN_D);
    s += P('M109 68H141V94Q141 112 125 116Q109 112 109 94Z', SKIN);
    s += P('M125 68H141V94Q141 112 125 116Z', SKIN_D, ' opacity=".3"');
    s += P('M106 88Q107 63 125 61Q143 63 144 88Q139 73 125 71Q111 73 106 88Z', pal.hair);
    s += L('M113.2 86.5q3.6 3.4 7.2 0M129.6 86.5q3.6 3.4 7.2 0', pal.hair, 1.7, ' stroke-linecap="round"');
    s += L('M125 88V95.5', SKIN_D, 1.6, ' stroke-linecap="round"');
    s += P('M120.6 101.5q4.4-2.4 8.8 0q-4.4 4.4-8.8 0z', INK);
    s += C(113.5, 96.5, 3.2, '#ee8f8f', ' opacity=".5"') + C(136.5, 96.5, 3.2, '#ee8f8f', ' opacity=".5"');
    s += C(107.3, 101, 2.3, GOLD) + C(142.7, 101, 2.3, GOLD);
    // crown: three pearled points
    s += P('M109 52L106.5 38L116 46L125 31L134 46L143.5 38L141 52Z', GOLD);
    s += R(108, 50.5, 34, 7, 1.5, GOLD) + R(108, 50.5, 34, 2.2, 0, GOLD_D);
    s += C(106.5, 37.5, 2.6, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(125, 30.5, 3, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += C(143.5, 37.5, 2.6, PAPER, ' stroke="' + GOLD_D + '" stroke-width=".9"');
    s += P('M125 51.2l2.8 3l-2.8 3l-2.8-3z', INK);
    // the flower she holds blooms into her own suit
    s += L('M176 152V74', GOLD_D, 2.4, ' stroke-linecap="round"');
    s += P('M176 118Q166 116 163 105Q174 107 176 118Z', pal.tint) + P('M176 132Q186 130 189 119Q178 121 176 132Z', pal.tint);
    s += pip(suit, 176, 59, 26, 0, ' fill="' + INK + '"');
    s += R(168.5, 146, 15, 12, 5.5, SKIN) + L('M172.2 150H179.8M172.2 153.8H179.8', SKIN_D, 1.1);
    s += pip(suit, 77, 52, 21, 0, ' fill="' + INK + '" opacity=".9"');
    return s;
  }

  function jackBust(suit, pal) {
    const INK = 'currentColor';
    let s = '';
    // two-tone tunic with a broad collar
    s += P('M64 176V158Q64 148 76 144L108 130H125V176Z', INK);
    s += P('M125 130H142L174 144Q186 148 186 158V176H125Z', pal.tint);
    s += R(122.2, 130, 5.6, 46, 0, GOLD);
    s += C(125, 152, 1.9, INK) + C(125, 163, 1.9, INK);
    s += P('M106 127L125 134L114 152L94 139Z', PAPER) + P('M144 127L125 134L136 152L156 139Z', PAPER);
    s += L('M106 127L125 134L144 127', GOLD_D, 1.1);
    // head: bobbed hair that flicks out at the jaw, straight fringe
    s += P('M98 72Q98 56 114 56H136Q152 56 152 72V103Q152 111 157 113.5Q151 120.5 143 117V72H107V117Q99 120.5 93 113.5Q98 111 98 103Z',
      pal.hair);
    s += R(119, 104, 12, 26, 0, SKIN_D);
    s += P('M108 66H142V98Q142 114 125 118Q108 114 108 98Z', SKIN);
    s += P('M125 66H142V98Q142 114 125 118Z', SKIN_D, ' opacity=".3"');
    s += P('M107 66H143V79Q125 72 107 79Z', pal.hair);
    s += C(116.8, 89, 2.2, pal.hair) + C(133.2, 89, 2.2, pal.hair);
    s += L('M125 90V97H127.8', SKIN_D, 1.6, ' stroke-linecap="round" stroke-linejoin="round"');
    s += L('M120 103.5q5 3.6 10 0', pal.hair, 1.7, ' stroke-linecap="round"');
    // soft cap, band and feather
    s += P('M96 62Q93 39 121 37Q152 35 154 57V62Z', INK);
    s += R(95.5, 58, 59, 6, 2, GOLD) + R(95.5, 58, 59, 2, 0, GOLD_D);
    s += P('M103 59Q88 47 91 26Q107 37 112 57Z', pal.tint);
    s += L('M105 57Q95 45 93 31', PAPER, 1, ' opacity=".8"');
    s += C(107.5, 61, 2.6, GOLD_L);
    // pike with a pennant
    s += R(174.5, 52, 3, 124, 0, GOLD_D);
    s += P('M176 31L181.5 45L176 56L170.5 45Z', STEEL);
    s += P('M176 31L181.5 45L176 56Z', pal.tint, ' opacity=".4"');
    s += L('M176 31L181.5 45L176 56L170.5 45Z', pal.hair2, 1, ' stroke-linejoin="round"');
    s += P('M174.5 61L158 67.5L174.5 74Z', GOLD);
    s += R(168.5, 144, 15, 12, 5.5, SKIN) + L('M172.2 148H179.8M172.2 151.8H179.8', SKIN_D, 1.1);
    s += pip(suit, 76, 54, 22, 0, ' fill="' + INK + '"');
    return s;
  }

  function bustMarkup(rank, suit) {
    const pal = COURT_PAL[suit];
    const art = rank === 13 ? kingBust(suit, pal) : rank === 12 ? queenBust(suit, pal) : jackBust(suit, pal);
    // nudged down so crowns and feathers clear the frame; clubs and diamonds face the other way
    return '<g transform="' + (suit >= 2 ? 'translate(250 4) scale(-1 1)' : 'translate(0 4)') + '">' + art + '</g>';
  }

  /** Double-ended court panel: frame, the bust twice (point-symmetric) and a jewelled band across the middle. */
  function courtMarkup(rank, suit) {
    const pal = COURT_PAL[suit];
    const id = 'sol-bust-' + suit + '-' + rank;
    let band = R(58, 168, 134, 14, 0, GOLD) + R(58, 168, 134, 1.6, 0, GOLD_D) + R(58, 180.4, 134, 1.6, 0, GOLD_D);
    for (let x = 70; x <= 180; x += 11) {
      if (Math.abs(x - 125) < 14) continue;
      band += P('M' + x + ' 171.2l3.4 3.8l-3.4 3.8l-3.4-3.8z', PAPER, ' opacity=".9"');
    }
    band += C(125, 175, 11, GOLD_D) + C(125, 175, 8.6, 'currentColor') + P('M125 169.6l4.4 5.4l-4.4 5.4l-4.4-5.4z', GOLD_L);
    return (
      R(58, 20, 134, 310, 5, pal.pale) +
      '<rect x="58" y="20" width="134" height="310" rx="5" fill="url(#sol-diaper-' + suit + ')"/>' +
      '<use href="#' + id + '"/><use href="#' + id + '" transform="rotate(180 125 175)"/>' +
      band +
      '<rect x="58" y="20" width="134" height="310" rx="5" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<rect x="61.6" y="23.6" width="126.8" height="302.8" rx="2.5" fill="none" stroke="' + GOLD + '" stroke-width="1"/>'
    );
  }

  function faceMarkup(cardId) {
    const c = info(cardId);
    const body = c.rank === 1 ? aceMarkup(c.suit) : c.rank <= 10 ? pipsMarkup(c.rank, c.suit) : courtMarkup(c.rank, c.suit);
    const idx = indexMarkup(c.rank, c.suit);
    return body + idx + '<g transform="rotate(180 125 175)">' + idx + '</g>';
  }

  // ------------------------------------------------------------------ fronts: compact layout (cards < 60px wide)
  /*
   * At phone sizes pips are noise, so the compact face is: a large rank top-left, its suit top-right and one big
   * suit (inlined on the ace; an enlarged single bust for J/Q/K) below. CSS swaps the two layouts with a
   * container query.
   */
  function compactMarkup(cardId) {
    const c = info(cardId);
    const g = GLYPHS[c.rank];
    const h = 80;
    let s = use('sol-rank-' + c.rank, 14, 14, (g.w * h) / 100, h) + use('sol-suit-' + c.suit, 168, 19, 68, 68);
    if (c.rank === 1) {
      s += inlineSuit(c.suit, 125, 224, 166, 3.6, 3); // the ace keeps its engraved suit at every size
    } else if (c.rank <= 10) {
      s += pip(c.suit, 125, 224, 160, 0);
    } else {
      const pal = COURT_PAL[c.suit];
      s += R(31, 110, 188, 216, 9, pal.pale);
      s += '<use href="#sol-bust-' + c.suit + '-' + c.rank + '" transform="translate(-50 75) scale(1.4)"/>';
      s += '<rect x="31" y="110" width="188" height="216" rx="9" fill="none" stroke="currentColor" stroke-width="4"/>';
    }
    return s;
  }

  /*
   * The fan mark: a small suit directly under the compact rank, like a classic corner index. A sideways fan of
   * compact cards (the draw-3 waste on a phone) shows only the left 43% of each covered card — the rank, but
   * not the suit top-right. The owner marks those cards .is-fanned and cards.css then shows this mark (it is
   * hidden everywhere else). On a court it sits on a paper chip over the corner of the bust frame.
   */
  function fanMarkup(cardId) {
    const c = info(cardId);
    const court = c.rank > 10;
    const size = court ? 46 : 54;
    const cx = 14 + GLYPHS[c.rank].w * 0.4; // centre of the rank glyph (80 high, so 0.8 of its box width wide)
    const y = 99;
    let s = '';
    if (court) {
      s += R(n(cx - size / 2 - 5), y - 3, size + 10, size + 8, 9, PAPER) +
        '<rect x="' + n(cx - size / 2 - 5) + '" y="' + (y - 3) + '" width="' + (size + 10) + '" height="' + (size + 8) +
        '" rx="9" fill="none" stroke="currentColor" stroke-width="2.5" opacity=".35"/>';
    }
    return s + use('sol-suit-' + c.suit, cx - size / 2, y, size, size);
  }

  /*
   * The tight mark: the suit once more, in the top-right corner of the CLASSIC layout, level with the rank. A
   * column squeezed below the height of the corner index (rank over suit, 0.26 of the card) cuts the suit off
   * its covered cards; the owner marks those cards .is-tight and cards.css then shows this mark (it is hidden
   * everywhere else). The corner is free on every classic face: pips end at x = 188, the court frame at 193, and
   * the ace's sunburst starts lower. Needs no group of its own in the faces: it instances the suit symbol directly.
   */
  function tightMarkup(suit) {
    return use('sol-suit-' + suit, 201, 13, 38, 38, ' class="card__tight"');
  }

  // ------------------------------------------------------------------ sprite
  /*
   * The art every front instances with <use> is kept in <svg> elements at the top of <body>, in two kinds
   * (injectSvg() below adds them; ensureAssets() says which exist when):
   *
   *   SPRITES — what must be RENDERED to work: <symbol>, <clipPath>, <pattern> and gradients (a paint server
   *   inside display:none paints nothing). #sol-card-sprite has the suits, the numerals and the diaper of the
   *   classic courts, #sol-card-sprite-holo the gradients of the hologram style. Both are a few dozen elements,
   *   shown at zero size.
   *
   *   FACES — the shapes: one <g> per card and layout (and the classic busts). #sol-card-faces has the classic
   *   ones, #sol-card-faces-holo the hologram ones, and each is only made when the first card of its style is.
   *   These are display:none. A <use> clones what it references wherever that lies, so nothing changes for
   *   the cards; but what is not rendered is neither styled nor laid out, and that is the point: the faces of
   *   the two styles are 3,000 elements, 7,000 with the instances of the <use>s inside them — three quarters
   *   of everything in the document — and as rendered <defs> they were all styled and given layout objects in
   *   the first frame of every start (measured at 4x CPU throttle: 110 of the 360 ms until the scripts had
   *   loaded with the classic faces alone, 210 of 585 ms with the faces of both styles in the page).
   */
  function spriteMarkup() {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += '<symbol id="sol-suit-' + i + '" viewBox="0 0 100 100"><path d="' + SUIT_PATHS[i] + '"/></symbol>' +
        '<clipPath id="sol-suit-clip-' + i + '"><path d="' + SUIT_PATHS[i] + '"/></clipPath>';
    }
    for (let r = 1; r <= 13; r++) {
      const g = GLYPHS[r];
      s += '<symbol id="sol-rank-' + r + '" viewBox="0 0 ' + g.w + ' 100"><path d="' + g.d + '"' +
        (g.t ? ' transform="' + g.t + '"' : '') +
        ' fill="none" stroke="currentColor" stroke-width="14" stroke-miterlimit="12"/></symbol>';
    }
    for (let suit = 0; suit < 4; suit++) {
      // (125, 175) sits on a lattice node, so the diaper is point-symmetric like the rest of the panel
      s += '<pattern id="sol-diaper-' + suit + '" x="5" y="5" width="12" height="17" patternUnits="userSpaceOnUse">' +
        '<path d="M6 5.3L8.1 8.5L6 11.7L3.9 8.5Z" fill="' + COURT_PAL[suit].tint + '" opacity=".3"/>' +
        '<path d="M0 -3.2L2.1 0L0 3.2L-2.1 0ZM12 -3.2L14.1 0L12 3.2L9.9 0ZM0 13.8L2.1 17L0 20.2L-2.1 17Z' +
        'M12 13.8L14.1 17L12 20.2L9.9 17Z" fill="' + COURT_PAL[suit].tint + '" opacity=".3"/></pattern>';
    }
    return s;
  }

  /** The faces of the classic style: the busts, and per card its classic layout, its compact one and its fan mark. */
  function classicFacesMarkup() {
    let s = '';
    for (let suit = 0; suit < 4; suit++) {
      for (let r = 11; r <= 13; r++) s += '<g id="sol-bust-' + suit + '-' + r + '">' + bustMarkup(r, suit) + '</g>';
    }
    for (let id = 0; id < 52; id++) {
      s += '<g id="sol-face-' + id + '">' + faceMarkup(id) + '</g>';
      s += '<g id="sol-mini-' + id + '">' + compactMarkup(id) + '</g>';
      s += '<g id="sol-fan-' + id + '">' + fanMarkup(id) + '</g>';
    }
    return s;
  }

  const svgQueued = {};

  /**
   * Adds one of the art <svg> elements to the top of <body>, once: a rendered sprite (zero size) or, with
   * `hidden`, faces that are only ever cloned by <use>. `markup` is called when the element is really made.
   * Safe before <body> exists (it is then added on DOM ready).
   */
  function injectSvg(id, hidden, markup) {
    if (doc.getElementById(id)) return;
    const add = function () {
      svgQueued[id] = false;
      if (doc.getElementById(id)) return;
      const holder = doc.createElement('div');
      // A sprite is not display:none: its gradients, patterns and clip paths would stop working.
      holder.innerHTML =
        '<svg id="' + id + '" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" style="' +
        (hidden ? 'display:none' : 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none') + '"><defs>' +
        markup() + '</defs></svg>';
      doc.body.insertBefore(holder.firstChild, doc.body.firstChild);
    };
    if (doc.body) add();
    else if (!svgQueued[id]) {
      svgQueued[id] = true;
      doc.addEventListener('DOMContentLoaded', add, { once: true });
    }
  }

  // ------------------------------------------------------------------ backs (procedural SVG documents)
  const BACK_W = 250;
  const BACK_H = 350;

  function backDoc(defs, body) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + BACK_W + ' ' + BACK_H + '" preserveAspectRatio="none">' +
      '<defs><clipPath id="panel"><rect x="11" y="11" width="228" height="328" rx="9"/></clipPath>' + defs + '</defs>' +
      body + '</svg>'
    );
  }

  /** Closed polar curve r(theta) around the card centre, sampled every `step` degrees. */
  function polarPath(fn, step, cx, cy) {
    let d = '';
    for (let a = 0; a < 360; a += step) {
      const p = polar(cx === undefined ? 125 : cx, cy === undefined ? 175 : cy, fn((a * Math.PI) / 180), a);
      d += (a === 0 ? 'M' : 'L') + n(p[0]) + ' ' + n(p[1]);
    }
    return d + 'Z';
  }

  function backRoyal() {
    const gold = '#ecc978';
    const defs =
      '<radialGradient id="a" cx=".5" cy=".5" r=".8"><stop offset="0" stop-color="#3559cc"/>' +
      '<stop offset=".55" stop-color="#1f3b98"/><stop offset="1" stop-color="#101d58"/></radialGradient>' +
      // phased so the 200 x 300 field holds whole diamonds on every side (10 x 15 of them)
      '<pattern id="p" x="5" y="5" width="20" height="20" patternUnits="userSpaceOnUse">' +
      '<path d="M10 0L20 10L10 20L0 10Z" fill="none" stroke="' + gold + '" stroke-width=".9" opacity=".5"/>' +
      '<circle cx="10" cy="10" r="1.6" fill="' + gold + '" opacity=".85"/>' +
      '<path d="M0 -2.2L2.2 0L0 2.2L-2.2 0ZM20 -2.2L22.2 0L20 2.2L17.8 0ZM0 17.8L2.2 20L0 22.2L-2.2 20Z' +
      'M20 17.8L22.2 20L20 22.2L17.8 20Z" fill="' + gold + '" opacity=".45"/></pattern>';
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>' +
      '<rect x="25" y="25" width="200" height="300" fill="url(#p)"/>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="' + gold + '" stroke-width="2.4"/>';
    s += '<rect x="22.5" y="22.5" width="205" height="305" rx="3" fill="none" stroke="' + gold + '" stroke-width=".9" opacity=".85"/>';
    // medallion: woven guilloche rosettes
    s += '<circle cx="125" cy="175" r="63" fill="#13225f" stroke="' + gold + '" stroke-width="2.4"/>';
    s += '<circle cx="125" cy="175" r="57.5" fill="none" stroke="' + gold + '" stroke-width=".9" opacity=".8"/>';
    for (let k = 0; k < 4; k++) {
      const ph = (k * Math.PI) / 2;
      s += '<path d="' + polarPath((t) => 36 + 16 * Math.cos(8 * t + ph), 1.5) + '" fill="none" stroke="' + gold +
        '" stroke-width="' + (k % 2 ? 0.8 : 1.1) + '" opacity="' + (k % 2 ? 0.6 : 0.95) + '"/>';
    }
    s += '<path d="' + polarPath((t) => 13 + 5 * Math.cos(8 * t), 3) + '" fill="' + gold + '"/>';
    s += '<circle cx="125" cy="175" r="5" fill="#13225f"/><circle cx="125" cy="175" r="2.2" fill="' + gold + '"/>';
    // crests above and below the medallion (point-symmetric pair)
    const crest =
      '<path d="M125 62L135 78L125 94L115 78Z" fill="#13225f" stroke="' + gold + '" stroke-width="1.6"/>' +
      '<path d="M125 70L130 78L125 86L120 78Z" fill="' + gold + '"/>' +
      '<path d="M96 78H110M140 78H154" stroke="' + gold + '" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="90" cy="78" r="2.2" fill="' + gold + '"/><circle cx="160" cy="78" r="2.2" fill="' + gold + '"/>';
    s += crest + '<g transform="rotate(180 125 175)">' + crest + '</g>';
    // corner fans
    const fan =
      '<path d="M23 23H55A32 32 0 0 1 23 55Z" fill="#162869"/>' +
      '<path d="M23 55A32 32 0 0 0 55 23M23 45A22 22 0 0 0 45 23M23 35A12 12 0 0 0 35 23" fill="none" stroke="' + gold +
      '" stroke-width="1.3"/><circle cx="28.5" cy="28.5" r="2" fill="' + gold + '"/>';
    s += fan + '<g transform="translate(250 0) scale(-1 1)">' + fan + '</g>' +
      '<g transform="rotate(180 125 175)">' + fan + '<g transform="translate(250 0) scale(-1 1)">' + fan + '</g></g>';
    return backDoc(defs, s);
  }

  function backAurora() {
    const rnd = prng(7719);
    const defs =
      '<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c0f55"/>' +
      '<stop offset=".5" stop-color="#0a4d6e"/><stop offset="1" stop-color="#1c0f55"/></linearGradient>' +
      '<linearGradient id="r1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4ff0d0"/>' +
      '<stop offset=".5" stop-color="#8ef7a0"/><stop offset="1" stop-color="#b48bff"/></linearGradient>' +
      '<linearGradient id="r2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b48bff"/>' +
      '<stop offset=".5" stop-color="#ff7ac2"/><stop offset="1" stop-color="#5fd8ff"/></linearGradient>';
    let half = '';
    // ribbons: each is one smooth wave drawn three times (wide + faint -> narrow + bright) to fake a glow
    const waves = [
      { y: 62, amp: 20, len: 210, ph: 0.4, g: 'r1' },
      { y: 98, amp: 26, len: 250, ph: 2.1, g: 'r2' },
      { y: 136, amp: 18, len: 190, ph: 3.6, g: 'r1' },
      { y: 164, amp: 24, len: 230, ph: 5.0, g: 'r2' },
    ];
    waves.forEach((w) => {
      let d = '';
      for (let x = -10; x <= 260; x += 6) {
        const y = w.y + w.amp * Math.sin((x / w.len) * Math.PI * 2 + w.ph) + 0.12 * (x - 125);
        d += (x === -10 ? 'M' : 'L') + x + ' ' + n(y);
      }
      half += '<path d="' + d + '" fill="none" stroke="url(#' + w.g + ')" stroke-width="30" opacity=".13"/>' +
        '<path d="' + d + '" fill="none" stroke="url(#' + w.g + ')" stroke-width="15" opacity=".25"/>' +
        '<path d="' + d + '" fill="none" stroke="url(#' + w.g + ')" stroke-width="4" opacity=".8" stroke-linecap="round"/>';
    });
    let stars = '';
    for (let i = 0; i < 34; i++) {
      const x = 16 + rnd() * 218;
      const y = 16 + rnd() * 156;
      const r = 0.5 + rnd() * 1.1;
      stars += '<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' + n(r) + '" opacity="' + n(0.45 + rnd() * 0.5) + '"/>';
    }
    half += '<g fill="#fff">' + stars + '</g>';
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>';
    s += '<g clip-path="url(#panel)">' + half + '<g transform="rotate(180 125 175)">' + half + '</g></g>';
    // a four-point star at the centre ties the two halves together
    s += '<path d="M125 147Q128 172 153 175Q128 178 125 203Q122 178 97 175Q122 172 125 147Z" fill="#fff" opacity=".92"/>';
    s += '<circle cx="125" cy="175" r="30" fill="none" stroke="#fff" stroke-width=".8" opacity=".5"/>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/>';
    return backDoc(defs, s);
  }

  function backEmber() {
    const rnd = prng(4242);
    const defs =
      '<radialGradient id="a" gradientUnits="userSpaceOnUse" cx="125" cy="175" r="225"><stop offset="0" stop-color="#ffd27a"/>' +
      '<stop offset=".2" stop-color="#ff9438"/><stop offset=".48" stop-color="#df4426"/>' +
      '<stop offset=".8" stop-color="#7b1620"/><stop offset="1" stop-color="#3a0a12"/></radialGradient>';
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>';
    let rays = '';
    for (let i = 0; i < 20; i++) {
      const a = polar(125, 175, 300, i * 18 - 4.5);
      const b = polar(125, 175, 300, i * 18 + 4.5);
      rays += 'M125 175L' + n(a[0]) + ' ' + n(a[1]) + 'L' + n(b[0]) + ' ' + n(b[1]) + 'Z';
    }
    let sparks = '';
    for (let i = 0; i < 26; i++) {
      const x = 18 + rnd() * 214;
      const y = 18 + rnd() * 150;
      const r = 0.8 + rnd() * 1.6;
      const o = n(0.4 + rnd() * 0.5);
      sparks += '<circle cx="' + n(x) + '" cy="' + n(y) + '" r="' + n(r) + '" opacity="' + o + '"/>' +
        '<circle cx="' + n(250 - x) + '" cy="' + n(350 - y) + '" r="' + n(r) + '" opacity="' + o + '"/>';
    }
    s += '<g clip-path="url(#panel)"><path d="' + rays + '" fill="#ffe7a8" opacity=".13"/>' +
      '<g fill="#ffe0a0">' + sparks + '</g></g>';
    // the sun: flame-tipped star, rings, a dark core with a pinwheel of four flames
    s += '<circle cx="125" cy="175" r="72" fill="none" stroke="#ffe2a0" stroke-width=".9" opacity=".7"/>';
    s += '<circle cx="125" cy="175" r="66" fill="none" stroke="#ffe2a0" stroke-width="2" opacity=".85"/>';
    let star = '';
    for (let i = 0; i < 32; i++) {
      const p = polar(125, 175, i % 2 ? 37 : i % 4 === 0 ? 60 : 50, i * 11.25 - 90);
      star += (i ? 'L' : 'M') + n(p[0]) + ' ' + n(p[1]);
    }
    s += '<path d="' + star + 'Z" fill="#fff0c2"/>';
    s += '<circle cx="125" cy="175" r="29" fill="#8f1d1f"/><circle cx="125" cy="175" r="29" fill="none" stroke="#ffd27a" stroke-width="1.6"/>';
    const flame = 'M125 175C123.5 163 130 155.5 142 153C141.5 163.5 136.5 172 125 175Z';
    for (let i = 0; i < 4; i++) {
      s += '<path d="' + flame + '" fill="#ffd27a" transform="rotate(' + i * 90 + ' 125 175)"/>';
    }
    s += '<circle cx="125" cy="175" r="4.6" fill="#8f1d1f"/><circle cx="125" cy="175" r="2" fill="#ffd27a"/>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="#ffd98a" stroke-width="2.2"/>';
    s += '<rect x="22.5" y="22.5" width="205" height="305" rx="3" fill="none" stroke="#ffd98a" stroke-width=".8" opacity=".75"/>';
    return backDoc(defs, s);
  }

  function backLattice() {
    const cream = '#f4e9c8';
    const defs =
      '<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b7256"/>' +
      '<stop offset=".5" stop-color="#11523d"/><stop offset="1" stop-color="#1b7256"/></linearGradient>' +
      '<pattern id="p" x="5" y="15" width="24" height="32" patternUnits="userSpaceOnUse">' +
      '<path d="M12 0L24 16L12 32L0 16Z" fill="#0c3f2f" opacity=".55"/>' +
      '<path d="M0 0L24 32M24 0L0 32" stroke="' + cream + '" stroke-width="1.1" opacity=".75"/>' +
      '<path d="M12 11.6L15.3 16L12 20.4L8.7 16Z" fill="' + cream + '"/>' +
      '<circle cx="0" cy="0" r="1.9" fill="' + cream + '"/><circle cx="24" cy="0" r="1.9" fill="' + cream + '"/>' +
      '<circle cx="0" cy="32" r="1.9" fill="' + cream + '"/><circle cx="24" cy="32" r="1.9" fill="' + cream + '"/>' +
      '</pattern>';
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>';
    // the lattice is cut exactly along rows / columns of crossings, so its edge is a clean zigzag
    s += '<rect x="29" y="31" width="192" height="288" fill="url(#p)"/>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="' + cream + '" stroke-width="2.2"/>';
    s += '<rect x="25.5" y="27.5" width="199" height="295" rx="1.5" fill="none" stroke="' + cream + '" stroke-width="1"/>';
    // cartouche: a lozenge with an eight-point knot
    s += '<path d="M125 107L173 175L125 243L77 175Z" fill="#0f4a37" stroke="' + cream + '" stroke-width="2.4"/>';
    s += '<path d="M125 117L166 175L125 233L84 175Z" fill="none" stroke="' + cream + '" stroke-width=".9" opacity=".8"/>';
    s += '<path d="M125 150L150 175L125 200L100 175Z" fill="none" stroke="' + cream + '" stroke-width="2"/>';
    s += '<rect x="107.5" y="157.5" width="35" height="35" fill="none" stroke="' + cream + '" stroke-width="2"/>';
    s += '<circle cx="125" cy="175" r="6" fill="' + cream + '"/><circle cx="125" cy="175" r="2.4" fill="#0f4a37"/>';
    s += '<circle cx="125" cy="129" r="2.4" fill="' + cream + '"/><circle cx="125" cy="221" r="2.4" fill="' + cream + '"/>';
    return backDoc(defs, s);
  }

  function backPetal() {
    const defs =
      '<radialGradient id="a" gradientUnits="userSpaceOnUse" cx="125" cy="175" r="215"><stop offset="0" stop-color="#b5477f"/>' +
      '<stop offset=".5" stop-color="#7c2a66"/><stop offset="1" stop-color="#3f1440"/></radialGradient>';
    /** One ring of `count` leaf-shaped petals from radius r0 to r1 with half-width w. */
    function ring(count, r0, r1, w, fill, stroke, offset, cx, cy) {
      const x = cx === undefined ? 125 : cx;
      const y = cy === undefined ? 175 : cy;
      const d = 'M' + x + ' ' + (y - r0) + 'C' + (x + w) + ' ' + n(y - r0 - (r1 - r0) * 0.3) + ' ' + (x + w * 0.9) + ' ' +
        n(y - r0 - (r1 - r0) * 0.72) + ' ' + x + ' ' + (y - r1) + 'C' + (x - w * 0.9) + ' ' + n(y - r0 - (r1 - r0) * 0.72) + ' ' +
        (x - w) + ' ' + n(y - r0 - (r1 - r0) * 0.3) + ' ' + x + ' ' + (y - r0) + 'Z';
      let out = '';
      for (let i = 0; i < count; i++) {
        out += '<path d="' + d + '" transform="rotate(' + n((360 / count) * i + (offset || 0)) + ' ' + x + ' ' + y + ')"/>';
      }
      return '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width=".9">' + out + '</g>';
    }
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>';
    s += '<g clip-path="url(#panel)">';
    s += ring(16, 18, 94, 14, '#e889b0', '#ffd3e3', 11.25);
    s += ring(16, 14, 77, 13, '#f3a6c4', '#ffe1ec', 0);
    s += ring(12, 10, 56, 12.5, '#fbc7da', '#fff0f5', 15);
    s += ring(8, 6, 34, 10, '#ffe6ee', '#fff', 0);
    // buds above and below
    [56, 294].forEach((y) => {
      s += ring(8, 3, 22, 6.5, '#f3a6c4', '#ffe1ec', 22.5, 125, y) + ring(8, 2, 13, 4.5, '#ffe6ee', '#fff', 0, 125, y) +
        '<circle cx="125" cy="' + y + '" r="3" fill="#f3c969"/>';
    });
    s += '</g>';
    s += '<circle cx="125" cy="175" r="8.5" fill="#f3c969" stroke="#fff3cf" stroke-width="1.2"/>';
    s += '<circle cx="125" cy="175" r="3.4" fill="#b5477f"/>';
    // pearl border
    let pearls = '';
    for (let x = 26; x <= 224; x += 9) pearls += '<circle cx="' + x + '" cy="24" r="1.5"/><circle cx="' + x + '" cy="326" r="1.5"/>';
    for (let y = 33; y <= 317; y += 9.46) pearls += '<circle cx="24" cy="' + n(y) + '" r="1.5"/><circle cx="226" cy="' + n(y) + '" r="1.5"/>';
    s += '<g fill="#ffd9e6">' + pearls + '</g>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="#ffd9e6" stroke-width="1.6"/>';
    return backDoc(defs, s);
  }

  function backMono() {
    const ivory = '#f4f1ea';
    const defs =
      '<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#262b3a"/>' +
      '<stop offset=".5" stop-color="#151924"/><stop offset="1" stop-color="#262b3a"/></linearGradient>' +
      '<pattern id="p" x="5" y="7" width="12" height="12" patternUnits="userSpaceOnUse">' +
      '<path d="M6 4.6V7.4M4.6 6H7.4" stroke="' + ivory + '" stroke-width=".8" opacity=".38"/></pattern>';
    let s = '<rect x="11" y="11" width="228" height="328" rx="9" fill="url(#a)"/>';
    s += '<rect x="26" y="26" width="198" height="298" fill="url(#p)"/>';
    s += '<rect x="17.5" y="17.5" width="215" height="315" rx="5.5" fill="none" stroke="' + ivory + '" stroke-width="2.2"/>';
    s += '<rect x="23" y="23" width="204" height="304" rx="2.5" fill="none" stroke="' + ivory + '" stroke-width=".7" opacity=".7"/>';
    // nested lozenges
    s += '<path d="M125 97L181 175L125 253L69 175Z" fill="#151924" stroke="' + ivory + '" stroke-width="2.2"/>';
    [[44, 62, 1], [32, 45, 0.8], [20, 28, 1.6]].forEach((q) => {
      s += '<path d="M125 ' + (175 - q[1]) + 'L' + (125 + q[0]) + ' 175L125 ' + (175 + q[1]) + 'L' + (125 - q[0]) +
        ' 175Z" fill="none" stroke="' + ivory + '" stroke-width="' + q[2] + '"/>';
    });
    s += '<path d="M125 163L133.6 175L125 187L116.4 175Z" fill="' + ivory + '"/>';
    const mark = '<path d="M125 52L131.5 61L125 70L118.5 61Z" fill="' + ivory + '"/>' +
      '<path d="M101 61H113M137 61H149" stroke="' + ivory + '" stroke-width="1.4" stroke-linecap="round"/>';
    s += mark + '<g transform="rotate(180 125 175)">' + mark + '</g>';
    return backDoc(defs, s);
  }

  const BACK_BUILDERS = {
    royal: backRoyal,
    aurora: backAurora,
    ember: backEmber,
    lattice: backLattice,
    petal: backPetal,
    mono: backMono,
  };
  const backUrlCache = {};

  /**
   * CSS url() of a back design. The six drawn backs are data: URIs, so no request is ever made for them; the
   * two image backs ('prism', 'pearl') are the table-size files in art/holo/, as an absolute URL.
   */
  function backUrl(id) {
    const key = backId(id);
    if (!backUrlCache[key]) {
      backUrlCache[key] = IMAGE_BACKS[key]
        ? 'url("' + artUrl(IMAGE_BACKS[key], false) + '")'
        : 'url("data:image/svg+xml,' + encodeURIComponent(BACK_BUILDERS[key]()) + '")';
    }
    return backUrlCache[key];
  }

  // ------------------------------------------------------------------ hologram style: art files
  /*
   * The generated art lives in art/holo/ next to index.html (tools/holo-art/README.md says how it was made).
   * Every URL handed to CSS is absolute and derived from the address of this script, so the same card works
   * from index.html, from a page in dev/, from file:// and inside the Android app.
   */
  const ART_BASE = (function () {
    if (!doc) return 'art/holo/';
    try {
      let src = doc.currentScript && doc.currentScript.src;
      if (!src) {
        const tag = doc.querySelector('script[src*="js/view/cards.js"]');
        src = tag && tag.src;
      }
      if (src) return new root.URL('../../art/holo/', src).href;
      return new root.URL('art/holo/', doc.baseURI).href;
    } catch (err) {
      return 'art/holo/';
    }
  })();

  /** Which cards carry a hologram window: aces and courts. */
  function hasWindow(rank) {
    return rank === 1 || rank > 10;
  }

  /** File name (without size suffix and extension) of the figure or gem of a window card. */
  function figureFile(c) {
    return c.rank === 1 ? 'ace-' + c.suitName : 'court-' + c.suitName + '-' + c.rank;
  }

  /*
   * Two figures hold their weapon over the top-left corner, where the index sits: the King of Diamonds (axe)
   * and the Jack of Spades (halberd). They are shown mirrored, which moves the weapon to the free corner.
   */
  const MIRRORED = { 51: true, 10: true };

  const IMAGE_BACKS = { prism: 'back-a', pearl: 'back-b' };

  function artUrl(name, large) {
    return ART_BASE + name + (large ? '-l' : '-s') + '.webp';
  }

  // ------------------------------------------------------------------ hologram style: fronts (250 x 350)
  /*
   * A hologram front is built from the same suits and numerals as the classic one, in a few boxes inside
   * .card__front (frontMarkup() writes them; cards.css says what each does and how they are stacked in depth
   * on a thick card):
   *   .card__win    the floor of the hologram window (courts and aces)
   *   .card__fig    the figure or gem (courts and aces)
   *   .card__art    paper-level art: the pearl paper around the window and its gold rim (courts and aces), or
   *                 the foil-ink pips of a number card, inside its .card__foil
   *   .card__foil   pearl paper and foil of a number card
   *   .card__ink    the indices and the fan / tight marks: always above the foil, so it never tints them; on a
   *                 number card also the paper around the panel and the foil line
   * (Three more boxes only exist while the foil of a card is live; foil() makes them: see SHEETS.)
   *
   * The panel is the shape everything is built around. Classic layout: a rounded rectangle 16..234 x 16..334
   * with the two index corners stepped out of it (41 wide, 80 high), so the indices keep their classic size and
   * place on pearl paper. Compact layout: the area under rank and suit, 13..237 x 104..337. On a court or an ace
   * the panel is the window; on a number card it is traced by the foil line and holds the foil.
   */
  const PANEL = { x0: 16, y0: 16, x1: 234, y1: 334, nx: 41, ny: 80, r: 10, rn: 8 };
  const PANEL_COMPACT = { x0: 13, y0: 104, x1: 237, y1: 337, r: 11 };
  const CARD_R = 18.75; // 0.075 of the width, like --card-radius
  const PEARL = '#fbfaff';

  /*
   * The same numbers for other modules (Cards.HOLO), as fractions of the card: x of its width, y of its height,
   * both from the top-left corner; depths are fractions of the card's WIDTH, positive towards the viewer, and
   * must match the "depth" rules in cards.css.
   */
  const HOLO_LAYOUT = {
    panel: { x0: PANEL.x0 / 250, y0: PANEL.y0 / 350, x1: PANEL.x1 / 250, y1: PANEL.y1 / 350, notchW: PANEL.nx / 250, notchH: PANEL.ny / 350 },
    panelCompact: { x0: PANEL_COMPACT.x0 / 250, y0: PANEL_COMPACT.y0 / 350, x1: PANEL_COMPACT.x1 / 250, y1: PANEL_COMPACT.y1 / 350 },
    depth: { ink: 0.01, figure: 0.06, sparkle: 0.075 },
    edgeFadeFrom: 0.2,
    edgeFadeTo: 0.8,
  };

  /** Closed path through axis-aligned corners [x, y, radius] given clockwise; every corner is rounded. */
  function roundedPoly(pts) {
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[(i + 1) % pts.length];
      const ux = Math.sign(a[0] - p[0]);
      const uy = Math.sign(a[1] - p[1]);
      const vx = Math.sign(b[0] - p[0]);
      const vy = Math.sign(b[1] - p[1]);
      const clockwise = -ux * vy + uy * vx > 0;
      d += (i ? 'L' : 'M') + n(p[0] + ux * p[2]) + ' ' + n(p[1] + uy * p[2]) + 'A' + p[2] + ' ' + p[2] + ' 0 0 ' +
        (clockwise ? 1 : 0) + ' ' + n(p[0] + vx * p[2]) + ' ' + n(p[1] + vy * p[2]);
    }
    return d + 'Z';
  }

  function panelPath(compact) {
    if (compact) {
      const q = PANEL_COMPACT;
      return roundedPoly([[q.x0, q.y0, q.r], [q.x1, q.y0, q.r], [q.x1, q.y1, q.r], [q.x0, q.y1, q.r]]);
    }
    const p = PANEL;
    return roundedPoly([
      [p.x0 + p.nx, p.y0, p.rn], [p.x1, p.y0, p.r], [p.x1, p.y1 - p.ny, p.rn], [p.x1 - p.nx, p.y1 - p.ny, p.rn],
      [p.x1 - p.nx, p.y1, p.rn], [p.x0, p.y1, p.r], [p.x0, p.y0 + p.ny, p.rn], [p.x0 + p.nx, p.y0 + p.ny, p.rn],
    ]);
  }

  const CARD_PATH = roundedPoly([[0, 0, CARD_R], [250, 0, CARD_R], [250, 350, CARD_R], [0, 350, CARD_R]]);

  /**
   * Paper-level art of a hologram front. A window card: the pearl paper with the panel cut out of it (the
   * window floor lies under the hole) and the gold rim of the window. A number card: the pips in foil ink (the
   * paper under them is the background of .card__foil). The hairline round the card is CSS (an outline).
   */
  function holoArtMarkup(cardId, compact) {
    const c = info(cardId);
    const panel = panelPath(compact);
    if (hasWindow(c.rank)) {
      return (
        '<path d="' + CARD_PATH + panel + '" fill-rule="evenodd" fill="url(#sol-holo-paper)"/>' +
        '<path d="' + panel + '" fill="none" stroke="#2a1c08" stroke-opacity=".5" stroke-width="' + (compact ? 6 : 3.6) + '"/>' +
        '<path d="' + panel + '" fill="none" stroke="url(#sol-holo-rim)" stroke-width="' + (compact ? 4 : 2.2) + '"/>'
      );
    }
    const ink = ' fill="url(#sol-holo-ink-' + (c.color === 'red' ? 'r' : 'b') + ')"';
    return '<g' + ink + '>' + (compact ? pip(c.suit, 125, 224, 160, 0) : pipsMarkup(c.rank, c.suit)) + '</g>';
  }

  /**
   * The top SVG of a hologram front: the indices in plain ink, above every foil. On a number card it also
   * carries the pearl paper AROUND the panel and the foil line along it: the live foil of a number card covers
   * its whole face, and this frame is what keeps it inside the panel and away from the indices.
   */
  function holoInkMarkup(cardId, compact) {
    const c = info(cardId);
    let s = '';
    if (!hasWindow(c.rank)) {
      const panel = panelPath(compact);
      s += '<path d="' + CARD_PATH + panel + '" fill-rule="evenodd" fill="url(#sol-holo-paper)"/>' +
        '<path d="' + panel + '" fill="none" stroke="url(#sol-holo-line)" stroke-width="' + (compact ? 3 : 1.5) + '"/>';
    }
    if (compact) {
      const g = GLYPHS[c.rank];
      return s + use('sol-rank-' + c.rank, 14, 14, (g.w * 80) / 100, 80) + use('sol-suit-' + c.suit, 168, 19, 68, 68);
    }
    const idx = indexMarkup(c.rank, c.suit);
    return s + idx + '<g transform="rotate(180 125 175)">' + idx + '</g>';
  }

  /** The fan mark of a hologram front: as fanMarkup(), on a pearl chip wherever it lies over a window. */
  function holoFanMarkup(cardId) {
    const c = info(cardId);
    const chip = hasWindow(c.rank);
    const size = chip ? 46 : 54;
    const cx = 14 + GLYPHS[c.rank].w * 0.4;
    const y = 99;
    let s = '';
    if (chip) {
      s += '<rect x="' + n(cx - size / 2 - 5) + '" y="' + (y - 3) + '" width="' + (size + 10) + '" height="' + (size + 8) +
        '" rx="9" fill="' + PEARL + '" stroke="#2a1c08" stroke-opacity=".45" stroke-width="2.5"/>';
    }
    return s + use('sol-suit-' + c.suit, cx - size / 2, y, size, size);
  }

  /**
   * The tight mark of a hologram front: as tightMarkup(); over the corner of a window the suit stands on a
   * pearl chip (one group per suit in the faces, #sol-htight-<suit>).
   */
  function holoTightMarkup(c) {
    if (!hasWindow(c.rank)) return tightMarkup(c.suit);
    return '<use class="card__tight" href="#sol-htight-' + c.suit + '"/>';
  }

  /** The sprite of the hologram style: its gradients (see "sprite" above for the two kinds of art <svg>). */
  function holoSpriteMarkup() {
    const stops = function (list) {
      return list.map((q) => '<stop offset="' + q[0] + '" stop-color="' + q[1] + '"' +
        (q[2] === undefined ? '' : ' stop-opacity="' + q[2] + '"') + '/>').join('');
    };
    return (
      // the same pearl as the CSS background of a number card (cards.css, 152deg): one paper for all 52
      '<linearGradient id="sol-holo-paper" gradientUnits="userSpaceOnUse" x1="24.9" y1="-13.2" x2="225.1" y2="363.2">' +
      stops([[0, '#ffffff'], [0.26, '#fcfbff'], [0.52, '#f6f3fc'], [0.76, '#f1f7f8'], [1, '#faf4ef']]) + '</linearGradient>' +
      // foil ink: one gradient per pip, inside the black and inside the red family
      '<linearGradient id="sol-holo-ink-b" x1=".12" y1="0" x2=".88" y2="1">' +
      stops([[0, '#3a3f8c'], [0.34, '#1d2230'], [0.7, '#0c0e18'], [1, '#272a5e']]) + '</linearGradient>' +
      '<linearGradient id="sol-holo-ink-r" x1=".12" y1="0" x2=".88" y2="1">' +
      stops([[0, '#f2506e'], [0.36, '#c8283c'], [0.72, '#9a0f2c'], [1, '#d5305e']]) + '</linearGradient>' +
      '<linearGradient id="sol-holo-rim" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="250" y2="350">' +
      stops([[0, '#fff3c4'], [0.2, '#e2b24c'], [0.42, '#fbe7a6'], [0.6, '#c78d2c'], [0.8, '#f6dc94'], [1, '#d9a441']]) +
      '</linearGradient>' +
      '<linearGradient id="sol-holo-line" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="250" y2="350">' +
      stops([[0, '#e6bf62'], [0.25, '#ef9fc3'], [0.5, '#8fcdee'], [0.75, '#9fe0bf'], [1, '#e6bf62']]) + '</linearGradient>'
    );
  }

  /** The faces of the hologram style: per card its art and its ink in both layouts and its fan mark; the tight chips. */
  function holoFacesMarkup() {
    let s = '';
    for (let suit = 0; suit < 4; suit++) {
      s += '<g id="sol-htight-' + suit + '"><rect x="195" y="7" width="50" height="50" rx="10" fill="' + PEARL +
        '" stroke="#2a1c08" stroke-opacity=".45" stroke-width="1.6"/>' + use('sol-suit-' + suit, 201, 13, 38, 38) + '</g>';
    }
    for (let id = 0; id < 52; id++) {
      s += '<g id="sol-hface-' + id + '">' + holoArtMarkup(id, false) + '</g>';
      s += '<g id="sol-hmini-' + id + '">' + holoArtMarkup(id, true) + '</g>';
      s += '<g id="sol-hidx-' + id + '">' + holoInkMarkup(id, false) + '</g>';
      s += '<g id="sol-hmidx-' + id + '">' + holoInkMarkup(id, true) + '</g>';
      s += '<g id="sol-hfan-' + id + '">' + holoFanMarkup(id) + '</g>';
    }
    return s;
  }

  /**
   * A seamless tile of small four-point stars and dots with real transparency, as a CSS url(): the sparkles
   * that float in front of a window card. (foil-sparkle.webp has a black ground: it serves the layers that are
   * blended, this one serves the layer that is not.)
   */
  function sparkleUrl(seed) {
    const rnd = prng(seed);
    const size = 240;
    const tints = ['#ffffff', '#fff6d8', '#e4f4ff', '#ffe6f4', '#e9ffef'];
    let s = '';
    for (let i = 0; i < 26; i++) {
      const x = rnd() * size;
      const y = rnd() * size;
      const r = 1.4 + rnd() * rnd() * 5.6;
      const tint = tints[Math.floor(rnd() * tints.length)];
      const o = n(0.55 + rnd() * 0.45);
      // drawn again across the tile edges, so a star that crosses an edge is whole when the tile repeats
      [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]].forEach((sh) => {
        const cx = x + sh[0];
        const cy = y + sh[1];
        if (cx < -r || cx > size + r || cy < -r || cy > size + r) return;
        if (r < 3.2) {
          s += '<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r * 0.42) + '" fill="' + tint + '" opacity="' + o + '"/>';
          return;
        }
        const k = r * 0.14;
        s += '<path d="M' + n(cx) + ' ' + n(cy - r) + 'Q' + n(cx + k) + ' ' + n(cy - k) + ' ' + n(cx + r) + ' ' + n(cy) +
          'Q' + n(cx + k) + ' ' + n(cy + k) + ' ' + n(cx) + ' ' + n(cy + r) + 'Q' + n(cx - k) + ' ' + n(cy + k) + ' ' +
          n(cx - r) + ' ' + n(cy) + 'Q' + n(cx - k) + ' ' + n(cy - k) + ' ' + n(cx) + ' ' + n(cy - r) + 'Z" fill="' + tint +
          '" opacity="' + o + '"/>' +
          '<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r * 0.55) + '" fill="' + tint + '" opacity=".28"/>';
      });
    }
    return 'url("data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      s + '</svg>') + '")';
  }

  /** The rules that give every window card its figure, as text for a <style>: table size or large. */
  function figureRules(large, only) {
    let css = '';
    for (let id = 0; id < 52; id++) {
      const c = info(id);
      if (!hasWindow(c.rank) || (only && !only[figureFile(c)])) continue;
      css += '.card[data-id="' + id + '"] .card__fig{--fig:url("' + artUrl(figureFile(c), large) + '")}';
    }
    return css;
  }

  /** The same for the two picture backs. `only` (both functions): just the files named in that { name: true }. */
  function imageBackRules(large, only) {
    return Object.keys(IMAGE_BACKS).filter((id) => !only || only[IMAGE_BACKS[id]]).map((id) =>
      '.card[data-back="' + id + '"] .card__back,.card--back-only[data-back="' + id + '"] .card__front{background-image:url("' +
      artUrl(IMAGE_BACKS[id], large) + '")}').join('');
  }

  // style -> true once this page has asked for that style's part of the art: ensureAssets() looks after it from then on
  const artInUse = {};

  /**
   * Injects, once, what only hologram cards need: their sprite and their faces (#sol-card-sprite-holo,
   * #sol-card-faces-holo: see "sprite") and a <style> (#sol-card-holo) with the figure of every window card
   * and the sparkle tiles. A page that only ever shows Classic cards never gets any of them, and never
   * requests a figure.
   */
  function ensureHoloAssets() {
    if (!doc) return;
    artInUse.holo = true;
    if (!doc.getElementById('sol-card-holo')) {
      const style = doc.createElement('style');
      style.id = 'sol-card-holo';
      style.textContent = figureRules(false) +
        '\n.card__sheet--glint{background-image:' + sparkleUrl(90210) + '}' +
        '\n.card__sheet--glint-b{background-image:' + sparkleUrl(31337) + '}';
      (doc.head || doc.documentElement).appendChild(style);
    }
    injectSvg('sol-card-sprite-holo', false, holoSpriteMarkup);
    injectSvg('sol-card-faces-holo', true, holoFacesMarkup);
  }

  /**
   * Injects, once, what only Classic cards need: their faces (#sol-card-faces: see "sprite"). A page that only
   * ever shows hologram cards never gets them.
   */
  function ensureClassicAssets() {
    if (!doc) return;
    artInUse.classic = true;
    injectSvg('sol-card-faces', true, classicFacesMarkup);
  }

  // ------------------------------------------------------------------ hologram style: loading the images
  // small / large: the two sets as a whole ({ key, done }); jobs: url -> the promise of loadImage(); done: url ->
  // true once it is decoded; byUrl: url -> its Image; ready: file name -> true once big cards use its large file
  const loaded = { small: null, large: null, keep: [], byUrl: {}, jobs: {}, done: {}, ready: {} };

  /** Fetches and decodes one picture; asked for the same one again, it returns the same work. */
  function loadImage(url) {
    if (loaded.jobs[url]) return loaded.jobs[url];
    const job = new Promise(function (resolve) {
      let img;
      try {
        img = new root.Image();
      } catch (err) {
        resolve(false);
        return;
      }
      loaded.keep.push(img); // held on purpose: the browser keeps what a live Image points at
      loaded.byUrl[url] = img;
      img.decoding = 'async';
      img.src = url;
      const ok = function () {
        loaded.done[url] = true;
        resolve(true);
      };
      const fail = function () { resolve(false); };
      if (typeof img.decode === 'function') img.decode().then(ok, fail);
      else {
        img.onload = ok;
        img.onerror = fail;
      }
    });
    loaded.jobs[url] = job;
    return job;
  }

  /**
   * Loads pictures a few at a time, in the order given: for the large set as a whole. Its 18 decodes started
   * at once keep every core busy for as long as they take (measured at 4x CPU throttle while a card flew up
   * into the 3D preview: 18 frames in the first 0.8 s instead of 27, one of them over 200 ms); two at a time
   * leave room for whatever is animating just then.
   */
  function loadInTurn(urls, atOnce) {
    let next = 0;
    const lane = function () {
      return next < urls.length ? loadImage(urls[next++]).then(lane) : Promise.resolve();
    };
    const lanes = [];
    for (let i = 0; i < atOnce; i++) lanes.push(lane());
    return Promise.all(lanes);
  }

  /**
   * From now on, cards that are big enough paint with the large file of each picture named here (file names
   * without size and extension): any card laid out at 200 CSS px or wider, at 160 px or wider on a screen with
   * 1.5 or more device pixels per px, at 125 px or wider with 2.5 or more — more device pixels across than the
   * table-size files have (300), which is more than a phone's or a tablet's table ever gives a card (a large
   * tablet's or a desktop's may). sol-card is the front of a card, sol-card-box the box around both faces of a
   * thick or back-only card. A picture is only ever named here once it is decoded: a rule that named a file
   * still on its way would leave the window empty until it arrived; until then the card shows the small one.
   */
  function showLarge(names) {
    let fresh = false;
    for (let i = 0; i < names.length; i++) {
      if (!loaded.ready[names[i]]) loaded.ready[names[i]] = fresh = true;
    }
    if (!fresh) return;
    let style = doc.getElementById('sol-card-holo-large');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'sol-card-holo-large';
      (doc.head || doc.documentElement).appendChild(style);
    }
    const sized = function (container, rules) {
      return '@container ' + container + ' (min-width: 200px){' + rules + '}' +
        '\n@media (min-resolution: 1.5dppx){@container ' + container + ' (min-width: 160px){' + rules + '}}' +
        '\n@media (min-resolution: 2.5dppx){@container ' + container + ' (min-width: 125px){' + rules + '}}';
    };
    style.textContent = sized('sol-card', figureRules(true, loaded.ready)) + '\n' + sized('sol-card-box', imageBackRules(true, loaded.ready));
  }

  /**
   * Fetches and decodes the images the cards paint with, so the first deal does not show empty windows or a
   * blank back: the table-size figures and gems, the two image backs and the two foil tiles. With
   * { large: true } also all the large figures and backs, two at a time; cards that are big enough then paint
   * with them (see showLarge()). Classic cards need none of the figures: while the style is Classic only the
   * backs are fetched. { style } overrides the setting for one call. Returns a promise that never rejects;
   * calling it again returns the same work.
   *
   * With { cards: [card ids] } and / or { backs: [back ids] } the call is about those pictures alone, in the
   * size { large } says (cards and backs without a picture are skipped, and so are the figures while the style
   * is Classic): it fetches the ones that are not here yet and has all of them decoded now. This is how the
   * large pictures are meant to be asked for — on demand, the few a card needs: a thick card asks for its own
   * when it is made, and the 3D preview for the neighbours of the card in view and the cards coming onto its
   * carousel, a moment before they show. (A browser may also drop a decoded picture it has not painted for a
   * while; asking again brings it back, at next to no cost while it is still there.) A large picture asked
   * for like this is used by big cards as soon as it is in. Resolves when they are decoded.
   */
  function preload(opts) {
    const o = opts || {};
    if (!doc || typeof root.Image !== 'function') return Promise.resolve();
    const holo = (STYLES.indexOf(o.style) !== -1 ? o.style : currentStyle()) === 'holo';
    if (Array.isArray(o.cards) || Array.isArray(o.backs)) {
      const wanted = [];
      (holo && o.cards ? o.cards : []).forEach(function (id) {
        if (Number.isInteger(id) && id >= 0 && id <= 51 && hasWindow(info(id).rank)) wanted.push(figureFile(info(id)));
      });
      (o.backs || []).forEach(function (id) {
        if (Object.prototype.hasOwnProperty.call(IMAGE_BACKS, id)) wanted.push(IMAGE_BACKS[id]);
      });
      return Promise.all(wanted.map(function (name) {
        const url = artUrl(name, !!o.large);
        const img = loaded.byUrl[url];
        if (!loaded.done[url] || typeof img.decode !== 'function') return loadImage(url); // (not here yet, or on its way)
        return img.decode().then(function () { return true; }, function () { return false; });
      })).then(function (ok) {
        if (o.large) showLarge(wanted.filter((name, i) => ok[i]));
      });
    }
    const names = function (withFaces) {
      const list = Object.keys(IMAGE_BACKS).map((id) => IMAGE_BACKS[id]);
      if (withFaces) for (let id = 0; id < 52; id++) if (hasWindow(info(id).rank)) list.push(figureFile(info(id)));
      return list;
    };
    const key = holo ? 'holo' : 'classic';
    if (!loaded.small || (holo && loaded.small.key !== 'holo')) {
      const urls = names(holo).map((name) => artUrl(name, false));
      if (holo) urls.push(ART_BASE + 'foil-ice.webp', ART_BASE + 'foil-sparkle.webp');
      loaded.small = { key: key, urls: urls, done: Promise.all(urls.map(loadImage)) };
    }
    if (!o.large) return loaded.small.done.then(function () {});
    if (!loaded.large || (holo && loaded.large.key !== 'holo')) {
      const all = names(holo);
      const work = loadInTurn(all.map((name) => artUrl(name, true)), 2).then(function () {
        showLarge(all.filter((name) => loaded.done[artUrl(name, true)]));
      });
      loaded.large = { key: key, done: work };
    }
    return Promise.all([loaded.small.done, loaded.large.done]).then(function () {});
  }

  /**
   * Are the pictures of preload() in — the table-size set of the card style in use? The same question the
   * promise of preload() answers, asked without waiting: true once every file of the set has arrived (or
   * failed for good). An owner that holds its cards back until the pictures are there asks this as well as
   * waiting for the promise, because the promise can be late by a whole frame: it resolves in a task of its
   * own, and after a busy start-up the browser renders a frame before it gets round to that task — although
   * the files were in all along (measured over reloads at 4x CPU throttle: the cards 60 to 220 ms late in six
   * starts out of sixteen). A file that has arrived is painted with the frame it is first used in: Chromium —
   * the WebView of the Android app, Chrome — decodes a picture of this size for the frame that needs it if
   * preload()'s own decode has not finished (checked frame by frame, with the files delayed; other engines
   * were not checked and may fill a picture in a frame late).
   * Like preload() it speaks of the set that was asked for last: after preload({ style: 'holo' }) that is the
   * hologram set, whatever the setting. False before preload() was ever called for the style in use.
   */
  function preloaded() {
    if (!doc || typeof root.Image !== 'function') return true;
    const set = loaded.small;
    if (!set || (set.key !== 'holo' && currentStyle() === 'holo')) return false;
    for (let i = 0; i < set.urls.length; i++) {
      const img = loaded.byUrl[set.urls[i]];
      if (img && !loaded.done[set.urls[i]] && !img.complete) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ style
  /** The card style new cards get: the 'cardStyle' setting where SOL.Settings has one, else 'holo'. */
  function currentStyle() {
    try {
      const s = SOL.Settings && SOL.Settings.get && SOL.Settings.get('cardStyle');
      if (STYLES.indexOf(s) !== -1) return s;
    } catch (err) {
      /* a Settings without the key (an older store.js): fall through */
    }
    return DEFAULT_STYLE;
  }

  // ------------------------------------------------------------------ asset injection
  /**
   * Injects, once: a <style> with one rule per back design (data-back on .card selects the background image of
   * .card__back), the sprite both styles draw from (#sol-card-sprite: suits, numerals) and everything else
   * the card style in use needs — ensureHoloAssets() or ensureClassicAssets(). The other style's part is not
   * built here: it comes with the first card of that style (markStyle()), so a start-up pays for one style.
   * Safe to call before <body> exists (the <svg> elements are added on DOM ready) and self-healing: if
   * something wiped the document, the next call puts the assets back — those of the style in use and those
   * of the other style if this page has used it (artInUse), so cards of both styles get their faces back.
   */
  function ensureAssets() {
    if (!doc) return;

    if (!doc.getElementById('sol-card-backs')) {
      const style = doc.createElement('style');
      style.id = 'sol-card-backs';
      style.textContent = BACKS.map((b) =>
        '.card[data-back="' + b.id + '"] .card__back,.card--back-only[data-back="' + b.id + '"] .card__front{background-image:' +
        backUrl(b.id) + '}').join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    }
    injectSvg('sol-card-sprite', false, spriteMarkup);
    const holo = currentStyle() === 'holo';
    if (holo || artInUse.holo) ensureHoloAssets();
    if (!holo || artInUse.classic) ensureClassicAssets();
  }

  // ------------------------------------------------------------------ thickness (edge walls)
  const RADIUS = 0.075; // must match --card-radius in cards.css (fraction of the card width)
  const RATIO = 1.4; // card height / width
  const CORNER_SEGMENTS = 7;
  let edgesCache = null;

  function f4(v) {
    return String(Math.round(v * 10000) / 10000);
  }

  function mix(a, b, t) {
    const out = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
    return 'rgb(' + out.join(',') + ')';
  }

  /**
   * Markup for the side walls of a thick card: four straight strips and CORNER_SEGMENTS short strips per rounded
   * corner, each standing perpendicular to the faces. They are shaded for a light coming from the top-left; a
   * corner strip carries a gradient from the shade of its first edge to the shade of its last, so the lighting
   * runs smoothly round the corner instead of stepping from facet to facet. Positions are fractions of --card-w.
   */
  function edgesMarkup() {
    if (edgesCache) return edgesCache;
    const strips = [];
    const r = RADIUS;
    // straight walls: [centre x, centre y, length, outward normal angle, half the angle the strip spans];
    // a hair longer than the straight run so no backdrop shows through where they meet the corner strips
    const lap = 0;
    strips.push([1, RATIO / 2, RATIO - 2 * r + lap, 0, 0]);
    strips.push([0.5, RATIO, 1 - 2 * r + lap, 90, 0]);
    strips.push([0, RATIO / 2, RATIO - 2 * r + lap, 180, 0]);
    strips.push([0.5, 0, 1 - 2 * r + lap, 270, 0]);
    // corners: inscribed polygon, so the walls never poke outside the rounded faces
    const corners = [[1 - r, RATIO - r, 0], [r, RATIO - r, 90], [r, r, 180], [1 - r, r, 270]];
    const halfDeg = 90 / (2 * CORNER_SEGMENTS);
    const half = (halfDeg * Math.PI) / 180;
    corners.forEach((c) => {
      for (let k = 0; k < CORNER_SEGMENTS; k++) {
        const deg = c[2] + (2 * k + 1) * halfDeg;
        const a = (deg * Math.PI) / 180;
        const rm = r * Math.cos(half);
        strips.push([c[0] + rm * Math.cos(a), c[1] + rm * Math.sin(a), 2 * r * Math.sin(half) * 1.12, deg, halfDeg]);
      }
    });
    const dark = [134, 125, 108];
    const light = [253, 250, 240];
    // light direction (-0.45, -0.89): top walls are brightest, bottom walls darkest
    const shade = function (deg) {
      const a = (deg * Math.PI) / 180;
      const lit = 0.5 + 0.5 * (Math.cos(a) * -0.45 + Math.sin(a) * -0.89);
      return mix(dark, light, 0.22 + 0.78 * lit);
    };
    let html = '';
    strips.forEach((sp) => {
      // the strip's own top edge is its lower-angle end (see the rotateZ in cards.css)
      html += '<i class="card__edge' + (sp[4] ? ' card__edge--corner' : '') + '" style="--x:' + f4(sp[0]) + ';--y:' +
        f4(sp[1]) + ';--l:' + f4(sp[2]) + ';--a:' +
        n(sp[3]) + 'deg;--c0:' + shade(sp[3] - sp[4]) + ';--c1:' + shade(sp[3] + sp[4]) + '"></i>';
    });
    edgesCache = '<div class="card__edges">' + html + '</div>';
    return edgesCache;
  }

  // ------------------------------------------------------------------ element builders
  const SVG_OPEN = ' viewBox="0 0 250 350" aria-hidden="true" focusable="false">';

  /** What goes inside .card__front: the classic art, or the boxes of a hologram front (see holoArtMarkup). */
  function frontMarkup(c, style) {
    if (style !== 'holo') {
      return (
        '<svg class="card__art"' + SVG_OPEN +
        '<use class="card__classic" href="#sol-face-' + c.id + '"/>' +
        '<use class="card__compact" href="#sol-mini-' + c.id + '"/>' +
        '<use class="card__fan" href="#sol-fan-' + c.id + '"/>' +
        tightMarkup(c.suit) + '</svg>'
      );
    }
    const win = hasWindow(c.rank);
    const art =
      '<svg class="card__art"' + SVG_OPEN +
      '<use class="card__classic" href="#sol-hface-' + c.id + '"/>' +
      '<use class="card__compact" href="#sol-hmini-' + c.id + '"/></svg>';
    return (
      (win
        ? '<div class="card__win"></div>' +
          '<div class="card__fig"' + (MIRRORED[c.id] ? ' data-mirror' : '') + '><i class="card__figim"></i></div>' + art
        : '<div class="card__foil">' + art + '</div>') +
      '<svg class="card__ink"' + SVG_OPEN +
      '<use class="card__classic" href="#sol-hidx-' + c.id + '"/>' +
      '<use class="card__compact" href="#sol-hmidx-' + c.id + '"/>' +
      '<use class="card__fan" href="#sol-hfan-' + c.id + '"/>' +
      holoTightMarkup(c) + '</svg>'
    );
  }

  function shell(front, thick) {
    return (
      '<div class="card__shadow"></div>' +
      '<div class="card__tilt"><div class="card__flip">' +
      '<div class="card__face card__front">' + front + '</div>' +
      '<div class="card__face card__back"></div>' +
      (thick ? edgesMarkup() : '') +
      '<div class="card__glare"></div>' +
      '</div></div>'
    );
  }

  function resolveStyle(value) {
    return STYLES.indexOf(value) !== -1 ? value : currentStyle();
  }

  /** Writes the attributes a style needs on .card and makes sure its assets are in the document. */
  function markStyle(el, style, fixed, c) {
    el.setAttribute('data-style', style);
    if (fixed) el.setAttribute('data-style-fixed', '');
    else el.removeAttribute('data-style-fixed');
    if (c && style === 'holo') el.setAttribute('data-face', c.rank === 1 ? 'ace' : c.rank > 10 ? 'court' : 'pips');
    else el.removeAttribute('data-face');
    if (style === 'holo') {
      ensureHoloAssets();
      preload({ style: 'holo' });
      // a thick card is shown large: it asks for its own large pictures (and for no others)
      if (el.classList.contains('card--thick')) {
        preload({ style: 'holo', large: true, cards: c ? [c.id] : [], backs: [el.getAttribute('data-back')] });
      }
    } else if (c) ensureClassicAssets(); // (a back-only card has no art)
  }

  /**
   * Full card, face-up. `back` is one of Cards.BACKS ids (default DEFAULT_BACK); `thick: true` adds visible
   * thickness for big 3D presentations (about 33 extra elements — use it for a few cards, not the whole table);
   * `style` is 'holo' or 'classic' (default: the 'cardStyle' setting, which the card then keeps following).
   */
  function create(cardId, opts) {
    const c = info(cardId);
    const o = opts || {};
    const style = resolveStyle(o.style);
    ensureAssets();
    const el = doc.createElement('div');
    el.className = 'card' + (o.thick ? ' card--thick' : '');
    el.setAttribute('data-id', String(c.id));
    el.setAttribute('data-suit', c.suitName);
    el.setAttribute('data-rank', String(c.rank));
    el.setAttribute('data-color', c.color);
    el.setAttribute('data-back', backId(o.back));
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', c.label);
    markStyle(el, style, STYLES.indexOf(o.style) !== -1, c);
    el.innerHTML = shell(frontMarkup(c, style), !!o.thick);
    if (STYLES.indexOf(o.style) === -1) follow(el);
    return el;
  }

  /**
   * A card showing the same back design on both sides (for back pickers and gallery previews). `style` as in
   * create(): a hologram card can show live foil on the two image backs, a classic one never does.
   */
  function createBackOnly(id, opts) {
    const o = opts || {};
    const key = backId(id);
    const style = resolveStyle(o.style);
    ensureAssets();
    const el = doc.createElement('div');
    el.className = 'card card--back-only' + (o.thick ? ' card--thick' : '');
    el.setAttribute('data-back', key);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Card back: ' + backName(key));
    markStyle(el, style, STYLES.indexOf(o.style) !== -1, null);
    el.innerHTML = shell('', !!o.thick);
    if (STYLES.indexOf(o.style) === -1) follow(el);
    return el;
  }

  /**
   * Switches an existing card (from create() or createBackOnly()) to 'holo' or 'classic': the inside of its
   * front is rebuilt, everything the owner set on the .card element (transform, classes, custom properties,
   * the back) stays. A style given here is kept; setStyle(el) without one hands the card back to the
   * 'cardStyle' setting.
   */
  function setStyle(el, value) {
    if (!el || !el.classList || !el.classList.contains('card')) return el;
    const fixed = STYLES.indexOf(value) !== -1;
    const style = resolveStyle(value);
    const backOnly = el.classList.contains('card--back-only');
    const id = el.getAttribute('data-id');
    const c = backOnly || id === null ? null : info(Number(id));
    const same = el.getAttribute('data-style') === style;
    if (!same) foil(el, null); // its sheets live in boxes that are about to be replaced
    markStyle(el, style, fixed, c);
    if (same || !c) return el; // (a back-only card has nothing inside its faces in either style)
    const front = el.querySelector('.card__front');
    if (front) front.innerHTML = frontMarkup(c, style);
    return el;
  }

  /*
   * Cards that follow the setting. Weak references, so a card nobody holds any more is simply forgotten; a
   * browser without WeakRef still switches every card that is in the document (see followSetting).
   */
  const followers = typeof root.WeakRef === 'function' ? [] : null;

  function follow(el) {
    if (!followers) return;
    if (followers.length >= 512) pruneFollowers();
    followers.push(new root.WeakRef(el));
  }

  function pruneFollowers() {
    let k = 0;
    for (let i = 0; i < followers.length; i++) {
      const el = followers[i].deref();
      if (el && !el.hasAttribute('data-style-fixed')) followers[k++] = followers[i];
    }
    followers.length = k;
  }

  /**
   * Every card that follows the setting takes the style it has now: cards in the document, and cards their
   * owner keeps outside it (a cache, a pool). Runs on 'settings:change' for 'cardStyle'.
   */
  function followSetting() {
    if (!doc) return;
    const style = currentStyle();
    const switchIt = function (el) {
      if (el.getAttribute('data-style') !== style && !el.hasAttribute('data-style-fixed')) setStyle(el);
    };
    const cards = doc.querySelectorAll('.card[data-style]:not([data-style-fixed])');
    for (let i = 0; i < cards.length; i++) switchIt(cards[i]);
    if (!followers) return;
    pruneFollowers();
    for (let i = 0; i < followers.length; i++) {
      const el = followers[i].deref();
      if (el) switchIt(el);
    }
  }

  // ------------------------------------------------------------------ live foil
  /*
   * A resting hologram card is static paint. While its owner calls foil() for it, the card carries SHEETS:
   * small boxes (cards.css says what each one shows), created on the first call and removed by
   * foil(el, null). Every call only writes `transform` and `opacity` on those sheets — nothing is inherited
   * through the card, so the card art is never restyled (measured: 14 times less style work per frame than the
   * same effect driven by custom properties on .card).
   *
   * One entry per sheet: cls -> class card__sheet--<cls>; host -> the box it goes into; first -> under the
   * host's other content instead of over it; m -> how far it slides, in percent of its own size per unit of
   * light position (none: it stays put); k -> its opacity at o = 1; big -> laid out at half size and scaled
   * up by 2 (see cards.css); tw -> it twinkles (a phase in degrees); peak -> it only shows while the light is
   * near this x (0..1), fading out over 0.45 to either side; inner -> it has an inner <b> that carries its
   * picture (see cards.css); thick -> only on a thick card.
   *
   * Hosts: 'win' and 'foil' are the window floor and the paper of the card as built. The other three exist
   * for the foil alone and only while the card is live, so foil() makes and removes them with the sheets:
   *   'figfx'  .card__figfx inside .card__fig      the figure's own light
   *   'spark'  .card__spark, just under .card__ink the sparkles in front of the figure
   *   'bfoil'  .card__bfoil inside a face that shows a picture back
   *
   * Two kinds are for LARGE cards only (cards.css shows them from a width of 130px and gives the moving sheets
   * of such a card another picture): 'ice' in the window and 'facet' in the paper of a number card are the
   * facets of the foil itself. They have no `m`: they stay where they are on the card, as the facets of real
   * cut foil do, and the rainbow that slides over them is blended INTO them, so every facet answers the light
   * in its own colour and at its own moment. At table size the facets would be noise two pixels wide: there the
   * two sheets are not displayed, and the rainbow brings its own, larger shards along.
   *
   * Everything a sheet does is `transform`, `opacity` and, for most kinds, a blend into the flat box it lies
   * in (screen, color-dodge or color-burn). No mask, clip-path or filter is ever applied while compositing: a
   * masked sheet on the figure and a clip-path round the sparkles cost a thick card a third of its frame rate
   * when they were tried (16.7 -> 22.9 ms per frame at 4x CPU throttle; without them the live foil measures
   * the same as no foil). The filter and the mask of the two gleam copies ('glow', 'glow-b': `inner`) are on
   * the inner <b>, which is rastered into its sheet once — the deliberate exception described in the header.
   */
  const SHEETS = {
    window: [
      { cls: 'ice', host: 'win', k: 0.26 },
      { cls: 'rainbow', host: 'win', m: 72, k: 0.75, big: true },
      { cls: 'stars', host: 'win', m: -50, k: 1, big: true, tw: 255 },
      { cls: 'glow', host: 'figfx', k: 0.8, peak: 0.26, inner: true, thick: true },
      { cls: 'glow-b', host: 'figfx', k: 0.8, peak: 0.74, inner: true, thick: true },
      { cls: 'glint', host: 'spark', m: 16, k: 0.9, tw: 0 },
      { cls: 'glint-b', host: 'spark', m: -12, k: 0.9, tw: 150, thick: true },
    ],
    pips: [
      { cls: 'paper', host: 'foil', first: true, m: 72, k: 0.9, big: true },
      { cls: 'facet', host: 'foil', first: true, k: 0.22 }, // (after 'paper', so it lands under it)
      { cls: 'light', host: 'foil', m: 72, k: 0.6, big: true },
    ],
    back: [
      { cls: 'back', host: 'bfoil', m: 72, k: 0.5, big: true },
      { cls: 'stars', host: 'bfoil', m: -50, k: 1, big: true, tw: 255 },
    ],
  };
  // .card -> { sig, lit, built, sheets: [{ el, def, t, o }], hosts: [el], front, deep, depth, ink, fig, spark }
  const liveCards = new WeakMap();

  function clamp01(v) {
    return v > 0 ? (v < 1 ? v : 1) : 0;
  }

  /** What decides which sheets a card needs; when it changes, they are rebuilt. */
  function foilSignature(el) {
    return (el.classList.contains('is-face-down') ? 'd' : 'u') + (el.classList.contains('card--thick') ? 't' : 'f') +
      el.getAttribute('data-back');
  }

  function removeSheets(st) {
    const gone = st.sheets.map((s) => s.el).concat(st.hosts);
    for (let i = 0; i < gone.length; i++) if (gone[i].parentNode) gone[i].parentNode.removeChild(gone[i]);
    st.sheets = [];
    st.hosts = [];
    st.spark = null;
  }

  /*
   * Depth of a thick window card (the `edge` argument of foil()): how far its three floating planes — indices,
   * figure, sparkles — stand off the face, as a factor from 1 (fully: the resting card) to 0 (sunk): 1 up to
   * HOLO.edgeFadeFrom, 0 from HOLO.edgeFadeTo. The planes are moved with inline transforms — the expressions
   * cards.css has for the resting card ("depth"), with the factor put in — and not with a custom property for
   * those rules to read. A custom property that changes on an ancestor makes the browser repaint every box
   * below it that paints a picture, which here are the window floor and the figure, both large, once per frame
   * of a turning card; a transform that changes repaints nothing. (Measured in the 3D preview, a 40-frame
   * turn: 35 repaints of each of the two layers with the property, none with the transforms; at 4x CPU
   * throttle the frame interval of a turn went from 17.7 to 17.1 ms, and from 53 to 29 ms for a card zoomed
   * in to 2.4.) In the compact layout the figure stays in the window whatever is written here: cards.css
   * says so with !important.
   */
  function r5(v) {
    return Math.round(v * 100000) / 100000;
  }

  function applyDepth(st) {
    const f = st.depth;
    if (f < 0 || !st.deep) return;
    const D = HOLO_LAYOUT.depth;
    if (st.ink) st.ink.style.transform = 'translateZ(calc(1px + var(--card-w) * ' + r5(D.ink * f) + '))';
    if (st.fig) st.fig.style.transform = 'translateZ(calc(-0.2px + (var(--card-w) * ' + D.figure + ' + 0.2px) * ' + f + '))';
    if (st.spark) st.spark.style.transform = 'translateZ(calc(1.5px + var(--card-w) * ' + r5(D.sparkle * f) + '))';
  }

  function setDepth(st, edge) {
    if (!st.deep) return;
    const from = HOLO_LAYOUT.edgeFadeFrom;
    const to = HOLO_LAYOUT.edgeFadeTo;
    const f = Math.round(clamp01((to - edge) / (to - from)) * 250) / 250; // steps far below a tenth of a pixel
    if (f === st.depth) return;
    st.depth = f;
    applyDepth(st);
  }

  function clearDepth(st) {
    if (st.depth < 0) return;
    st.depth = -1;
    if (st.ink) st.ink.style.removeProperty('transform');
    if (st.fig) st.fig.style.removeProperty('transform');
  }

  /** The box of a face that sheets of kind `name` go into; the foil-only ones are made here (see SHEETS). */
  function sheetHost(face, name, st) {
    let host = face.querySelector('.card__' + name);
    if (host || name === 'win' || name === 'foil') return host;
    const parent = name === 'figfx' ? face.querySelector('.card__fig') : face;
    if (!parent) return null;
    host = doc.createElement('i');
    host.className = 'card__' + name;
    parent.insertBefore(host, name === 'spark' ? face.querySelector('.card__ink') : null);
    st.hosts.push(host);
    if (name === 'spark') st.spark = host;
    return host;
  }

  function buildSheets(el, st) {
    const thick = el.classList.contains('card--thick');
    const down = el.classList.contains('is-face-down');
    const imageBack = !!IMAGE_BACKS[el.getAttribute('data-back')];
    const add = function (face, defs) {
      for (let i = 0; i < defs.length; i++) {
        const def = defs[i];
        if (def.thick && !thick) continue;
        const host = sheetHost(face, def.host, st);
        if (!host) continue;
        const s = doc.createElement('i');
        s.className = 'card__sheet card__sheet--' + def.cls;
        if (def.inner) s.appendChild(doc.createElement('b'));
        if (def.first) host.insertBefore(s, host.firstChild);
        else host.appendChild(s);
        st.sheets.push({ el: s, def: def, t: '', o: '' });
      }
    };
    // A table card shows one face: only that one gets sheets. A thick card is seen from every side, and so is
    // a back-only card (pickers turn those over to show that both sides are the same).
    const backOnly = el.classList.contains('card--back-only');
    const front = el.querySelector('.card__front');
    const back = el.querySelector('.card__back');
    if (front && (thick || backOnly || !down)) {
      if (backOnly) {
        if (imageBack) add(front, SHEETS.back);
      } else add(front, el.getAttribute('data-face') === 'pips' ? SHEETS.pips : SHEETS.window);
    }
    if (back && imageBack && (thick || backOnly || down)) add(back, SHEETS.back);
  }

  /**
   * Live foil. Call it for a hologram card whenever the light on it changes — every frame while the card
   * moves is fine — and once with null when the card comes to rest.
   *
   *   foil(el, x, y, o, edge?) -> el
   *     x, y   where the light is on the face the viewer sees, 0..1 from its left / top edge (0.5, 0.5 =
   *            straight on; values outside are clamped). The rainbow slides with it, the sparkles twinkle as
   *            it moves and, on a thick card, a gleam crosses the figure as x goes from 0 to 1. What matters is
   *            that x and y CHANGE as the card moves or tilts: a light that stands still is a still picture.
   *     o      0..1, how alive the foil is (0 = the resting look, 1 = vivid). Fade it in and out over a few
   *            frames; around 0.6 is plenty for a card that is merely lifted.
   *     edge   optional, 0..1: how far the card is turned away from the viewer (0 = facing, 1 = edge-on; for
   *            example 1 - |cos(yaw) * cos(pitch)|). Only a thick window card uses it: its floating planes sink
   *            back onto the card as it goes from 0.2 to 0.8. Leave it out for cards on the table.
   *   foil(el, null) -> el    back to rest: the sheets are removed, the planes of a thick card float again.
   *
   * The first call with o > 0 builds the card's sheets and sets the class .is-holo on it; they follow the card
   * when it is turned over, changes its back or its style, and they stay (invisible at o = 0) until
   * foil(el, null). Nothing happens for a Classic card, and with <html data-effects="low"> no sheets are made
   * (edge still works): the owner need not check either. Reduced motion is the owner's call: foil() does
   * what it is told.
   */
  function foil(el, x, y, o, edge) {
    if (!el || !el.classList || !doc) return el;
    let st = liveCards.get(el);
    if (x === null || x === undefined || el.getAttribute('data-style') !== 'holo') {
      if (st) {
        removeSheets(st);
        clearDepth(st);
        liveCards.delete(el);
        el.classList.remove('is-holo');
      }
      return el;
    }
    const sig = foilSignature(el);
    if (!st) {
      const front = el.querySelector('.card__front');
      // (only a thick court or ace has planes at different depths: see applyDepth)
      const deep = !!front && el.classList.contains('card--thick') && !el.classList.contains('card--back-only') &&
        el.getAttribute('data-face') !== 'pips';
      st = {
        sig: '', lit: false, built: false, sheets: [], hosts: [], front: front, deep: deep, depth: -1,
        ink: deep ? front.querySelector('.card__ink') : null, fig: deep ? front.querySelector('.card__fig') : null, spark: null,
      };
      liveCards.set(el, st);
    }
    const lit = doc.documentElement.getAttribute('data-effects') !== 'low';
    if (st.sig !== sig || st.lit !== lit) {
      removeSheets(st);
      st.sig = sig;
      st.lit = lit;
      st.built = false;
      el.classList.remove('is-holo');
    }
    if (edge !== undefined && edge !== null) setDepth(st, clamp01(Number(edge) || 0));
    const lx = clamp01(Number(x) || 0);
    const ly = clamp01(Number(y) || 0);
    const lo = clamp01(Number(o) || 0);
    // The sheets come with the first light: a card that is only told its edge (o = 0) stays as it is.
    if (lit && !st.built && lo > 0) {
      buildSheets(el, st);
      st.built = true;
      el.classList.add('is-holo');
      applyDepth(st); // (the sparkles' plane has only just been made)
    }
    for (let i = 0; i < st.sheets.length; i++) {
      const s = st.sheets[i];
      const d = s.def;
      let a = lo * d.k;
      if (d.tw !== undefined) a *= 0.5 + 0.5 * Math.sin(((lx * 900 + ly * 630 + d.tw) * Math.PI) / 180);
      if (d.peak !== undefined) a *= Math.max(0, 1 - Math.abs(lx - d.peak) / 0.45);
      const op = String(Math.round(a * 100) / 100);
      if (d.m !== undefined) {
        const t = 'translate(' + Math.round((lx - 0.5) * d.m * 10) / 10 + '%,' + Math.round((ly - 0.5) * d.m * 10) / 10 + '%)' +
          (d.big ? ' scale(2)' : '');
        if (t !== s.t) {
          s.el.style.transform = t;
          s.t = t;
        }
      }
      if (op !== s.o) {
        s.el.style.opacity = op;
        s.o = op;
      }
    }
    return el;
  }

  function setBack(el, id) {
    if (!el) return el;
    const key = backId(id);
    el.setAttribute('data-back', key);
    if (el.classList.contains('card--back-only')) el.setAttribute('aria-label', 'Card back: ' + backName(key));
    return el;
  }

  /**
   * Instantly shows the front (true) or the back (false): sets --flip and toggles .is-face-down. Animated flips
   * are the owner's job (tween --flip, then call this or toggle the class). A face-down card is announced as
   * such, so assistive tech cannot read hidden cards.
   */
  function setFaceUp(el, faceUp) {
    if (!el) return el;
    const up = !!faceUp;
    el.style.setProperty('--flip', up ? '0deg' : '180deg');
    el.classList.toggle('is-face-down', !up);
    const id = el.getAttribute('data-id');
    if (id !== null) el.setAttribute('aria-label', up ? label(Number(id)) : 'Face-down card');
    return el;
  }

  function isFaceUp(el) {
    return !!el && !el.classList.contains('is-face-down');
  }

  SOL.Cards = {
    BACKS: BACKS.map((b) => ({ id: b.id, name: b.name })),
    DEFAULT_BACK: DEFAULT_BACK,
    SUITS: SUITS.slice(),
    COMPACT_BELOW: COMPACT_BELOW,
    STYLES: STYLES.slice(),
    DEFAULT_STYLE: DEFAULT_STYLE,
    HOLO: HOLO_LAYOUT,
    create: create,
    createBackOnly: createBackOnly,
    setBack: setBack,
    setStyle: setStyle,
    styleOf: function (el) {
      return el && el.getAttribute && el.getAttribute('data-style') === 'holo' ? 'holo' : 'classic';
    },
    currentStyle: currentStyle,
    foil: foil,
    setFaceUp: setFaceUp,
    isFaceUp: isFaceUp,
    suitSvg: suitSvg,
    label: label,
    info: info,
    backUrl: backUrl,
    preload: preload,
    preloaded: preloaded,
    ensureAssets: ensureAssets,
  };

  if (SOL.Bus && typeof SOL.Bus.on === 'function') {
    SOL.Bus.on('settings:change', function (p) {
      if (!p || p.key === 'cardStyle') followSetting();
    });
  }

  // Inject the art as soon as the script runs so the first card paints complete, and start fetching the images.
  if (doc) {
    ensureAssets();
    preload();
  }
})(typeof window !== 'undefined' ? window : globalThis);
