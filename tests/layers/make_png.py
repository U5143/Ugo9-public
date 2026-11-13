# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# PNG files of every colour type and bit depth (and interlaced), written by Pillow, with the
# RGBA Pillow reads from each (SHA-256 of the 8-bit straight-alpha pixels): tests/layers_test.mjs
# checks tools/import_layers.mjs's PNG reader against them.
#   python3 tests/layers/make_png.py
import hashlib, json, os
from PIL import Image

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'png')
os.makedirs(here, exist_ok=True)
W, H = 23, 17
def rgba(x, y):
    return ((x * 11) % 256, (y * 15) % 256, ((x + y) * 7) % 256, 0 if (x + y) % 9 == 0 else (x * 13 + y * 5) % 256)
base = Image.new('RGBA', (W, H))
base.putdata([rgba(x, y) for y in range(H) for x in range(W)])
cases = {}
def save(name, im, **kw):
    path = os.path.join(here, name + '.png')
    im.save(path, **kw)
    back = Image.open(path)
    if back.mode == 'I;16' or back.mode == 'I':  # 16-bit grey: to 8 bits by the high byte, as tools/import_layers.mjs does
        px = [min(255, v >> 8) for v in back.getdata()]
        data = bytes(b for v in px for b in (v, v, v, 255))
    else:
        data = back.convert('RGBA').tobytes()
    cases[name] = hashlib.sha256(data).hexdigest()
save('rgba8', base)
save('rgb8', base.convert('RGB'))
save('grey8', base.convert('L'))
save('greyalpha8', base.convert('LA'))
pal = base.convert('RGB').quantize(37)
save('palette8', pal)
pal4 = base.convert('RGB').quantize(16)
save('palette4', pal4, bits=4)
pal1 = base.convert('RGB').quantize(2)
save('palette1', pal1, bits=1)
pt = base.convert('RGB').quantize(20)
save('palette_trns', pt, transparency=3)
save('grey1', base.convert('1'))
save('rgb_trns', base.convert('RGB'), transparency=(0, 0, 0))
g16 = Image.new('I;16', (W, H)); g16.putdata([(x * 2903 + y * 997) % 65536 for y in range(H) for x in range(W)])
save('grey16', g16)
with open(os.path.join(here, 'expected.json'), 'w') as f:
    json.dump(cases, f, indent=1, sort_keys=True)
print(len(cases), 'PNG files')
