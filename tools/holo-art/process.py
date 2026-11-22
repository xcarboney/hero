# Turn the generated art into the game's files: solitaire/art/holo/*.webp in two sizes.
#   python3 tools/holo-art/process.py RAW_DIR [name ...]      (no names = every .png in RAW_DIR)
# RAW_DIR holds the generated 3:4 PNGs named like the outputs: court-spades-13.png, ace-hearts.png, back-a.png.
import sys, os, glob
import numpy as np
from PIL import Image
RAW = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'solitaire', 'art', 'holo')
os.makedirs(OUT, exist_ok=True)
L = (720, 1008); S = (300, 420)             # both 5:7, like a card
def premult_resize(im, size):
    """Resize RGBA without dark fringes: scale colour premultiplied by alpha."""
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb = a[..., :3] * a[..., 3:4]
    pm = Image.fromarray((np.dstack([rgb, a[..., 3:4]]) * 255 + 0.5).astype(np.uint8), 'RGBA')
    r = np.asarray(pm.resize(size, Image.LANCZOS)).astype(np.float32) / 255.0
    al = r[..., 3:4]
    out = np.where(al > 1e-4, r[..., :3] / np.maximum(al, 1e-4), 0)
    return Image.fromarray((np.dstack([np.clip(out, 0, 1), al]) * 255 + 0.5).astype(np.uint8), 'RGBA')
def sprite(name):
    im = Image.open(f'{RAW}/{name}.png').convert('RGBA'); w, h = im.size
    cw = round(h * 5 / 7); x0 = (w - cw) // 2
    a = np.asarray(im)[..., 3]
    ys, xs = np.where(a > 24)
    lost = int((xs < x0).sum() + (xs >= x0 + cw).sum())
    im = im.crop((x0, 0, x0 + cw, h))
    arr = np.asarray(im).astype(np.float32)
    al = arr[..., 3]
    al = np.clip((al - 14) / (255 - 14), 0, 1) * 255          # drop the faintest haze, keep soft edges
    arr[..., 3] = al
    im = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    sizes = {}
    for tag, size in (('l', L), ('s', S)):
        o = premult_resize(im, size); p = f'{OUT}/{name}-{tag}.webp'
        o.save(p, 'WEBP', quality=86 if tag == 'l' else 88, alpha_quality=92, method=6, exact=False)
        sizes[tag] = os.path.getsize(p)
    al2 = np.asarray(premult_resize(im, L))[..., 3]
    ys, xs = np.where(al2 > 24)
    return {'kind': 'sprite', 'bytes': sizes, 'lostPixelsOutsideCrop': lost,
            'bbox': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]}
def back(name, inset):
    im = Image.open(f'{RAW}/{name}.png').convert('RGB'); w, h = im.size
    im = im.crop((inset, inset, w - inset, h - inset)); w, h = im.size
    cw = round(h * 5 / 7); x0 = (w - cw) // 2
    im = im.crop((x0, 0, x0 + cw, h))
    sizes = {}
    for tag, size in (('l', L), ('s', S)):
        p = f'{OUT}/{name}-{tag}.webp'; im.resize(size, Image.LANCZOS).save(p, 'WEBP', quality=84 if tag == 'l' else 88, method=6)
        sizes[tag] = os.path.getsize(p)
    return {'kind': 'back', 'bytes': sizes}
names = sys.argv[2:] or sorted(os.path.basename(p)[:-4] for p in glob.glob(RAW + '/*.png'))
rep = {}
for n in names:
    if n.startswith('back-'):
        rep[n] = back(n, 14)
    else:
        rep[n] = sprite(n)
    print(n, rep[n])
print('total bytes', sum(sum(v['bytes'].values()) for v in rep.values()))
