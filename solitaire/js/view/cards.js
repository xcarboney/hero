/*
 * SOL.Cards — builds the 3D playing-card elements (fronts, backs, thickness) and their shared art.
 *
 * Public API
 * ----------
 *   Cards.BACKS            -> [{ id, name }]  ('royal', 'aurora', 'ember', 'lattice', 'petal', 'mono' — in this order)
 *   Cards.DEFAULT_BACK     -> 'royal'
 *   Cards.SUITS            -> ['spades', 'hearts', 'clubs', 'diamonds']
 *   Cards.COMPACT_BELOW    -> 60   card widths (CSS px) below this show the compact front layout (see "Art notes")
 *   Cards.create(cardId, { back, thick } = {})      -> HTMLElement  full card, face-up (--flip unset = 0deg)
 *   Cards.createBackOnly(backId, { thick } = {})    -> HTMLElement  the same back on both sides (gallery previews)
 *   Cards.setBack(el, backId)                       -> el           unknown ids fall back to DEFAULT_BACK
 *   Cards.setFaceUp(el, bool)                       -> el           instant: --flip 0deg / 180deg + .is-face-down
 *   Cards.isFaceUp(el)                              -> boolean      (reads the .is-face-down class)
 *   Cards.suitSvg(suit, { size, className } = {})   -> string       standalone <svg> markup, fill: currentColor;
 *                                                                   suit is 0..3 or 'spades' | 'hearts' | 'clubs' | 'diamonds'
 *   Cards.label(cardId)                             -> 'Queen of Hearts' | '7 of Clubs'
 *   Cards.info(cardId)                              -> { id, suit, rank, suitName, color: 'red' | 'black', label }
 *   Cards.backUrl(backId)                           -> string       CSS `url("data:image/svg+xml,…")` of a back design
 *                                                                   (for swatches that are not card elements)
 *   Cards.ensureAssets()                            -> void         injects the <svg> sprite + back styles (idempotent;
 *                                                                   create() calls it, so calling it is optional)
 *
 * Card model (contract section 4): id 0..51, suit = floor(id / 13) (0 spades, 1 hearts, 2 clubs, 3 diamonds),
 * rank = id % 13 + 1 (1 ace … 13 king), red when suit is odd. Derived here on purpose: no dependency on SOL.Engine.
 *
 * DOM (css/cards.css documents the custom properties each part reads, and why they are routed the way they are)
 * ---------------------------------------------------------------------------------------------------------------
 *   <div class="card [card--thick] [card--back-only] [is-face-down]" data-id data-suit data-rank data-color data-back
 *        role="img" aria-label="Queen of Hearts">
 *     <div class="card__shadow"></div>                         (two cross-faded lift shadows; rotates with the faces)
 *     <div class="card__tilt">
 *       <div class="card__flip">
 *         <div class="card__face card__front"><svg class="card__art">…two <use> into the sprite…</svg></div>
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
 * Art notes: all shapes live once in an injected <svg> sprite (#sol-card-sprite) and each front is two <use>
 * elements — a classic layout (corner indices, pips, ornamental ace, double-ended courts) and a compact one for
 * cards narrower than 60px (big rank + suit, one large suit or a single bust); a container query in cards.css
 * shows one of them. The six backs are procedurally generated SVG documents handed to CSS as data: URIs, so a
 * face-down card costs no extra DOM. Everything is original: suits, numerals, court figures and backs are drawn
 * from scratch below. A card is 10 DOM nodes (43 with { thick: true }).
 *
 * Optional attribute: data-layout="compact" | "classic" on the .card element pins the front layout whatever the
 * card's size (unset = automatic). Nothing in here sets it.
 *
 * Layout numbers other modules may lean on (fractions of the card height, measured from the top edge): the
 * corner index ends at 0.26 in the classic layout (rank alone: 0.17) and at 0.27 in the compact one, so a
 * tableau fan step of 0.27-0.28 keeps rank and suit of every covered card readable at any size. Sideways
 * (fractions of the card width from the left edge): the classic index needs 0.22; the compact rank needs 0.24
 * (0.33 for the 10) and the compact suit sits top-RIGHT, so a sideways fan of compact cards shows rank and
 * colour only.
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
  ];
  const DEFAULT_BACK = 'royal';
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

  // ------------------------------------------------------------------ sprite
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
      for (let r = 11; r <= 13; r++) s += '<g id="sol-bust-' + suit + '-' + r + '">' + bustMarkup(r, suit) + '</g>';
    }
    for (let id = 0; id < 52; id++) {
      s += '<g id="sol-face-' + id + '">' + faceMarkup(id) + '</g>';
      s += '<g id="sol-mini-' + id + '">' + compactMarkup(id) + '</g>';
    }
    return s;
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

  /** CSS url() of a back design (data: URI, so no request is ever made). */
  function backUrl(id) {
    const key = backId(id);
    if (!backUrlCache[key]) {
      backUrlCache[key] = 'url("data:image/svg+xml,' + encodeURIComponent(BACK_BUILDERS[key]()) + '")';
    }
    return backUrlCache[key];
  }

  // ------------------------------------------------------------------ asset injection
  let spriteQueued = false;

  /**
   * Injects, once: the hidden <svg> sprite every front references, and a <style> with one rule per back design
   * (data-back on .card selects the background image of .card__back). Safe to call before <body> exists (the sprite is added on DOM ready)
   * and self-healing: if something wiped the document, the next call puts the assets back.
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

    if (doc.getElementById('sol-card-sprite')) return;
    const addSprite = function () {
      spriteQueued = false;
      if (doc.getElementById('sol-card-sprite')) return;
      const holder = doc.createElement('div');
      // Not display:none — gradients/uses inside a display:none <svg> fail to render in some browsers.
      holder.innerHTML =
        '<svg id="sol-card-sprite" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false"' +
        ' style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"><defs>' + spriteMarkup() +
        '</defs></svg>';
      doc.body.insertBefore(holder.firstChild, doc.body.firstChild);
    };
    if (doc.body) addSprite();
    else if (!spriteQueued) {
      spriteQueued = true;
      doc.addEventListener('DOMContentLoaded', addSprite, { once: true });
    }
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

  /**
   * Full card, face-up. `back` is one of Cards.BACKS ids (default DEFAULT_BACK); `thick: true` adds visible
   * thickness for big 3D presentations (about 33 extra elements — use it for a few cards, not the whole table).
   */
  function create(cardId, opts) {
    const c = info(cardId);
    const o = opts || {};
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
    el.innerHTML = shell(
      '<svg class="card__art" viewBox="0 0 250 350" aria-hidden="true" focusable="false">' +
        '<use class="card__classic" href="#sol-face-' + c.id + '"/>' +
        '<use class="card__compact" href="#sol-mini-' + c.id + '"/></svg>',
      !!o.thick
    );
    return el;
  }

  /** A card showing the same back design on both sides (for back pickers and gallery previews). */
  function createBackOnly(id, opts) {
    const o = opts || {};
    const key = backId(id);
    ensureAssets();
    const el = doc.createElement('div');
    el.className = 'card card--back-only' + (o.thick ? ' card--thick' : '');
    el.setAttribute('data-back', key);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Card back: ' + backName(key));
    el.innerHTML = shell('', !!o.thick);
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
    create: create,
    createBackOnly: createBackOnly,
    setBack: setBack,
    setFaceUp: setFaceUp,
    isFaceUp: isFaceUp,
    suitSvg: suitSvg,
    label: label,
    info: info,
    backUrl: backUrl,
    ensureAssets: ensureAssets,
  };

  // Inject the art as soon as the script runs so the first card paints complete.
  if (doc) ensureAssets();
})(typeof window !== 'undefined' ? window : globalThis);
