# Procedural, seamless foil masks for the hologram finish (deterministic: fixed seeds).
#   python3 tools/holo-art/foil.py        writes solitaire/art/holo/foil-ice.webp and foil-sparkle.webp
import os
import numpy as np
from PIL import Image
N = 512
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'solitaire', 'art', 'holo')
def ice(seed=7, cells=46):
    rng = np.random.default_rng(seed)
    pts = rng.random((cells, 2)) * N
    tone = rng.random(cells)                      # brightness of each shard
    ang = rng.random(cells) * np.pi * 2           # direction of each shard's own gradient
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    best = np.full((N, N), 1e9, np.float32); second = np.full((N, N), 1e9, np.float32)
    idx = np.zeros((N, N), np.int32); bx = np.zeros((N, N), np.float32); by = np.zeros((N, N), np.float32)
    for i, (px, py) in enumerate(pts):
        for ox in (-N, 0, N):
            for oy in (-N, 0, N):                 # torus: the tile wraps
                dx = xx - (px + ox); dy = yy - (py + oy)
                # anisotropic distance makes long angular shards instead of round cells
                a = ang[i]; u = dx * np.cos(a) + dy * np.sin(a); v = -dx * np.sin(a) + dy * np.cos(a)
                d = np.sqrt((u * 0.55) ** 2 + (v * 1.35) ** 2)
                closer = d < best
                second = np.where(closer, best, np.minimum(second, d))
                idx = np.where(closer, i, idx); bx = np.where(closer, u, bx); by = np.where(closer, v, by)
                best = np.where(closer, d, best)
    g = tone[idx] * 0.78 + 0.11
    g = g + (bx / 90.0) * 0.16                    # each shard is a little facet, lit along its own axis
    edge = np.clip((second - best) / 2.2, 0, 1)   # thin dark seams between shards
    g = np.clip(g, 0, 1) * (0.55 + 0.45 * edge)
    return (np.clip(g, 0, 1) * 255).astype(np.uint8)
def sparkle(seed=11, count=520):
    rng = np.random.default_rng(seed)
    img = np.zeros((N, N, 3), np.float32)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    for _ in range(count):
        px, py = rng.random(2) * N
        r = rng.choice([0.7, 0.9, 1.2, 1.7, 2.6], p=[0.38, 0.3, 0.18, 0.1, 0.04])
        b = rng.uniform(0.35, 1.0)
        hue = rng.random()
        col = np.array([0.5 + 0.5 * np.cos(2 * np.pi * (hue + k / 3.0)) for k in range(3)], np.float32)
        col = 0.55 + 0.45 * col                    # pastel spectral tint
        star = r > 1.5
        for ox in (-N, 0, N):
            for oy in (-N, 0, N):
                cx, cy = px + ox, py + oy
                if cx < -12 or cx > N + 12 or cy < -12 or cy > N + 12: continue
                x0, x1 = int(max(0, cx - 12)), int(min(N, cx + 13)); y0, y1 = int(max(0, cy - 12)), int(min(N, cy + 13))
                if x0 >= x1 or y0 >= y1: continue
                dx = xx[y0:y1, x0:x1] - cx; dy = yy[y0:y1, x0:x1] - cy
                core = np.exp(-(dx * dx + dy * dy) / (2 * r * r))
                if star:                             # a four-point glint on the biggest ones
                    core = core + 0.55 * np.exp(-(dx * dx) / 0.5 - (dy * dy) / (2 * (r * 3.2) ** 2)) + 0.55 * np.exp(-(dy * dy) / 0.5 - (dx * dx) / (2 * (r * 3.2) ** 2))
                img[y0:y1, x0:x1] += (core * b)[..., None] * col
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)
os.makedirs(OUT, exist_ok=True)
Image.fromarray(ice(), 'L').save(os.path.join(OUT, 'foil-ice.webp'), 'WEBP', quality=82, method=6)
Image.fromarray(sparkle(), 'RGB').save(os.path.join(OUT, 'foil-sparkle.webp'), 'WEBP', quality=82, method=6)
