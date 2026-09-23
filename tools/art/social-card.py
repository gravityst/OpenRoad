"""Renders assets/brand/social-card.jpg, the image a link to the game shows when
it is shared. It is the loading screen's own scene — same sky stops, same
ridgeline paths, same car — drawn at 2x and downsampled, so the preview a kid
sees in a chat is the first thing the game shows them too.

    python3 tools/art/social-card.py
"""
import math, re, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
S = 2                                   # supersample
w, h = W * S, H * S
HZ = int(h * 0.60)                      # horizon, a touch lower than the screen's 54%: the title needs sky

def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t): return tuple(int(round(lerp(a, b, t))) for a, b in zip(c1, c2))
def hexc(s): s = s.lstrip('#'); return tuple(int(s[i:i+2], 16) for i in (0, 2, 4))

img = Image.new('RGB', (w, h), (6, 8, 17))
d = ImageDraw.Draw(img)

# ---- sky: the loading screen's stops -------------------------------------
stops = [(0, '#02040c'), (.28, '#0a1030'), (.52, '#262048'), (.72, '#6a3350'),
         (.86, '#c2573f'), (.96, '#f09a4c'), (1, '#ffc875')]
stops = [(p, hexc(c)) for p, c in stops]
for y in range(HZ):
    t = y / HZ
    for i in range(len(stops) - 1):
        if stops[i][0] <= t <= stops[i+1][0]:
            u = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0]); break
    d.line([(0, y), (w, y)], fill=mix(stops[i][1], stops[i+1][1], u))
rnd = random.Random(7)
for _ in range(70):
    x, y = rnd.uniform(0, w), rnd.uniform(0, HZ * 0.45)
    r = rnd.choice([1, 1, 1.5, 2]) * S * 0.6
    a = rnd.randint(90, 220)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(a, a, min(255, a + 20)))

# ---- sun, with its glow on its own layer --------------------------------
sun_x, sun_y, sun_r = int(w * 0.70), int(HZ - h * 0.13), int(h * 0.075)
glow = Image.new('RGB', (w, h), (0, 0, 0))
gd = ImageDraw.Draw(glow)
for k, (rr, col) in enumerate([(4.2, (120, 50, 30)), (2.6, (190, 90, 40)), (1.6, (255, 150, 70))]):
    R = sun_r * rr; gd.ellipse([sun_x - R, sun_y - R, sun_x + R, sun_y + R], fill=col)
glow = glow.filter(ImageFilter.GaussianBlur(sun_r * 1.1))
img = Image.blend(img, Image.eval(Image.merge('RGB', [Image.eval(c, lambda v: v) for c in glow.split()]), lambda v: v), 0)  # keep img
img = Image.fromarray(__import__('numpy').clip(__import__('numpy').asarray(img, float) + __import__('numpy').asarray(glow, float) * 0.55, 0, 255).astype('uint8'))
d = ImageDraw.Draw(img)
for i in range(sun_r, 0, -1):
    t = i / sun_r
    col = mix(hexc('#fffaf0'), hexc('#ff8a3d'), t ** 1.6)
    d.ellipse([sun_x - i, sun_y - i, sun_x + i, sun_y + i], fill=col)

# ---- ridgelines: the loading screen's SVG paths ---------------------------
def parse(path, sx, sy, ox, oy, steps=24):
    toks = re.findall(r'[MLHVQTCZmlhvqtcz]|-?\d*\.?\d+', path)
    pts, i, cur, cmd, last_ctrl, polys = [], 0, (0, 0), None, None, []
    def P(x, y): return (ox + x * sx, oy + y * sy)
    while i < len(toks):
        t = toks[i]
        if re.match(r'[A-Za-z]', t): cmd = t; i += 1
        if cmd == 'M':
            if pts: polys.append(pts); pts = []
            cur = (float(toks[i]), float(toks[i+1])); i += 2; pts.append(P(*cur)); cmd = 'L'; last_ctrl = None
        elif cmd == 'L':
            cur = (float(toks[i]), float(toks[i+1])); i += 2; pts.append(P(*cur)); last_ctrl = None
        elif cmd == 'H':
            cur = (float(toks[i]), cur[1]); i += 1; pts.append(P(*cur)); last_ctrl = None
        elif cmd == 'V':
            cur = (cur[0], float(toks[i])); i += 1; pts.append(P(*cur)); last_ctrl = None
        elif cmd in 'QT':
            if cmd == 'Q': c = (float(toks[i]), float(toks[i+1])); i += 2
            else: c = (2*cur[0] - last_ctrl[0], 2*cur[1] - last_ctrl[1]) if last_ctrl else cur
            e = (float(toks[i]), float(toks[i+1])); i += 2
            for k in range(1, steps + 1):
                u = k / steps
                pts.append(P((1-u)**2*cur[0] + 2*(1-u)*u*c[0] + u*u*e[0], (1-u)**2*cur[1] + 2*(1-u)*u*c[1] + u*u*e[1]))
            last_ctrl, cur = c, e
        elif cmd == 'C':
            c1 = (float(toks[i]), float(toks[i+1])); c2 = (float(toks[i+2]), float(toks[i+3])); e = (float(toks[i+4]), float(toks[i+5])); i += 6
            for k in range(1, steps + 1):
                u = k / steps; a, b, c_, dd = (1-u)**3, 3*(1-u)**2*u, 3*(1-u)*u*u, u**3
                pts.append(P(a*cur[0]+b*c1[0]+c_*c2[0]+dd*e[0], a*cur[1]+b*c1[1]+c_*c2[1]+dd*e[1]))
            cur, last_ctrl = e, None
        elif cmd in 'Zz':
            if pts: polys.append(pts); pts = []
            cmd = None
        else: i += 1
    if pts: polys.append(pts)
    return polys

html = open('index.html').read()
ridge_paths = re.findall(r'<path fill="(#[0-9a-f]{6})"[^>]*d="(M0 [^"]+)"', html)
band_top, band_h = HZ - h * 0.20, h * 0.20
for col, pth in ridge_paths:
    for poly in parse(pth, w / 1600, band_h / 200, 0, band_top):
        d.polygon(poly, fill=hexc(col))
tree = re.search(r'<path fill="#100d19" d="([^"]+)"', html).group(1)
for poly in parse(tree, w / 1600, band_h / 200, 0, band_top):
    d.polygon(poly, fill=hexc('#100d19'))

# ---- ground and the road ---------------------------------------------------
for y in range(HZ, h):
    t = (y - HZ) / (h - HZ)
    d.line([(0, y), (w, y)], fill=mix(hexc('#1b1622'), hexc('#07070c'), min(1, t * 1.6)))
haze = Image.new('L', (w, h), 0); hd = ImageDraw.Draw(haze)
for y in range(HZ, int(HZ + (h - HZ) * 0.3)):
    hd.line([(0, y), (w, y)], fill=int(140 * (1 - (y - HZ) / ((h - HZ) * 0.3)) ** 1.5))
img.paste(Image.new('RGB', (w, h), (240, 150, 90)), (0, 0), haze)
d = ImageDraw.Draw(img)

vx, vy = w / 2, HZ
CAR_X = w * 0.66                           # car in the right third; the words own the left
lane = w * 0.095                          # and in the right-hand lane of its road
cx_bottom = CAR_X - lane
hw_bottom = w * 0.20
def road_x(frac_across, y):
    # frac_across -1..1 across the road; linear toward the vanishing point
    t = (y - vy) / (h - vy)
    return vx + (cx_bottom + frac_across * hw_bottom - vx) * t
for y in range(int(vy) + 1, h):
    xl, xr = road_x(-1, y), road_x(1, y)
    d.line([(xl, y), (xr, y)], fill=(36, 37, 45))
    # edge lines
    ew = max(1, (xr - xl) * 0.03)
    d.line([(xl, y), (xl + ew, y)], fill=(217, 221, 230))
    d.line([(xr - ew, y), (xr, y)], fill=(217, 221, 230))
# centre dashes in true perspective: on a flat road, a point at distance z
# lands at y = horizon + (h - horizon) * z_near / z, so equal spacing on the
# ground bunches up toward the horizon on screen, as it should.
PERIOD, DASH = 0.55, 0.24
for k in range(0, 400):
    z0 = 1.0 + k * PERIOD + 0.18
    z1 = z0 + DASH
    y0 = vy + (h - vy) / z0
    y1 = vy + (h - vy) / z1
    if y0 - y1 < 0.6: break
    x0a, x1a = road_x(0, y0), road_x(0, y1)
    wd0, wd1 = (road_x(1, y0) - road_x(-1, y0)) * 0.012, (road_x(1, y1) - road_x(-1, y1)) * 0.012
    d.polygon([(x0a - wd0, y0), (x0a + wd0, y0), (x1a + wd1, y1), (x1a - wd1, y1)], fill=hexc('#f2c46a'))

# headlight beam and tail-light spill, blurred
light = Image.new('RGB', (w, h), (0, 0, 0)); ld = ImageDraw.Draw(light)
bx, by = CAR_X, h * 0.80
ld.ellipse([bx - w * 0.11, by - h * 0.16, bx + w * 0.11, by], fill=(120, 110, 90))
ld.ellipse([bx - w * 0.16, h * 0.93, bx + w * 0.16, h * 1.02], fill=(120, 20, 18))
light = light.filter(ImageFilter.GaussianBlur(w * 0.03))
import numpy as np
img = Image.fromarray(np.clip(np.asarray(img, float) + np.asarray(light, float), 0, 255).astype('uint8'))
d = ImageDraw.Draw(img)

# ---- the car, from the loading screen's SVG --------------------------------
car_svg = html[html.index('<svg class="boot__car"'):html.index('</svg>', html.index('<svg class="boot__car"'))]
cw = w * 0.25; csx = cw / 400; cox = CAR_X - cw / 2; coy = h - 230 * csx - h * 0.015
body, lamps = [], []
for m in re.finditer(r'<(path|rect|ellipse)([^>]*)/?>', car_svg):
    tag, attrs = m.group(1), m.group(2)
    fill = re.search(r'fill="([^"]+)"', attrs); fill = fill.group(1) if fill else '#000'
    if 'stroke=' in attrs and 'fill="none"' in attrs: continue
    if tag == 'path':
        for poly in parse(re.search(r'd="([^"]+)"', attrs).group(1), csx, csx, cox, coy):
            (lamps if 'lamp' in fill else body).append((poly, fill))
    elif tag == 'rect':
        # (?<![a-z]) so the x inside rx= (a corner radius) is never read as x.
        g = {k: float(v) for k, v in re.findall(r'(?<![a-z])(x|y|width|height)="([\d.]+)"', attrs)}
        poly = [(cox + g['x']*csx, coy + g['y']*csx), (cox + (g['x']+g['width'])*csx, coy + g['y']*csx),
                (cox + (g['x']+g['width'])*csx, coy + (g['y']+g['height'])*csx), (cox + g['x']*csx, coy + (g['y']+g['height'])*csx)]
        (lamps if '#ff' in fill else body).append((poly, fill))
    elif tag == 'ellipse':
        g = {k: float(v) for k, v in re.findall(r'(?<![a-z])(cx|cy|rx|ry)="([\d.]+)"', attrs)}
        body.append(([(cox + (g['cx'] + g['rx']*math.cos(a))*csx, coy + (g['cy'] + g['ry']*math.sin(a))*csx) for a in [i*math.pi/24 for i in range(48)]], fill))
def solid(fill):
    return {'url(#bc-body)': (14, 18, 27), 'url(#bc-glass)': (70, 44, 70)}.get(fill, hexc(fill) if fill.startswith('#') and len(fill) == 7 else (10, 12, 18))
for poly, fill in body: d.polygon(poly, fill=solid(fill))
glowl = Image.new('RGB', (w, h), (0, 0, 0)); gl = ImageDraw.Draw(glowl)
for poly, fill in lamps: gl.polygon(poly, fill=(255, 40, 36))
glowl = glowl.filter(ImageFilter.GaussianBlur(w * 0.006))
img = Image.fromarray(np.clip(np.asarray(img, float) + np.asarray(glowl, float) * 1.4, 0, 255).astype('uint8'))
d = ImageDraw.Draw(img)
for poly, fill in lamps: d.polygon(poly, fill=(255, 70, 60) if 'lamp' in fill else (255, 58, 54))

# ---- scrim, vignette -------------------------------------------------------
shade = Image.new('L', (w, h), 0); sd = ImageDraw.Draw(shade)
for x in range(0, int(w * 0.62)):
    sd.line([(x, 0), (x, h)], fill=int(150 * (1 - x / (w * 0.62)) ** 1.4))
img.paste(Image.new('RGB', (w, h), (4, 5, 10)), (0, 0), shade)
d = ImageDraw.Draw(img)

# ---- words -----------------------------------------------------------------
din = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
avn = '/System/Library/Fonts/Avenir Next.ttc'
title_f = ImageFont.truetype(din, int(h * 0.30))
kick_f = ImageFont.truetype(avn, int(h * 0.030), index=5)      # Demi Bold
line_f = ImageFont.truetype(avn, int(h * 0.036), index=5)
mx = int(w * 0.065)
mark = Image.open('assets/brand/gs-mark.webp').convert('RGBA')
mh = int(h * 0.058); mark = mark.resize((int(mark.width * mh / mark.height), mh), Image.LANCZOS)
ky = int(h * 0.10)
img.paste(mark, (mx, ky - int(mh * 0.25)), mark)
def tracked(draw, xy, text, font, fill, track):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + track
tracked(d, (mx + mark.width + int(w * 0.012), ky), 'A GRAVITY STUDIOS GAME', kick_f, (222, 230, 242), int(h * 0.009))
# Title with a silver gradient: draw a mask, fill through a gradient.
tm = Image.new('L', (w, h), 0); tdraw = ImageDraw.Draw(tm)
ty = int(h * 0.165)
tdraw.text((mx - int(h * 0.01), ty), 'OPEN', font=title_f, fill=255)
tdraw.text((mx - int(h * 0.01), ty + int(h * 0.245)), 'ROAD', font=title_f, fill=255)
grad = Image.new('RGB', (w, h))
gg = ImageDraw.Draw(grad)
for y in range(h):
    t = min(1, max(0, (y - ty) / (h * 0.52)))
    gg.line([(0, y), (w, y)], fill=mix((255, 255, 255), (185, 193, 206), t))
shadow = tm.filter(ImageFilter.GaussianBlur(h * 0.02))
img.paste(Image.new('RGB', (w, h), (0, 0, 0)), (0, int(h * 0.008)), Image.eval(shadow, lambda v: int(v * 0.5)))
img.paste(grad, (0, 0), tm)
d = ImageDraw.Draw(img)
ly = ty + int(h * 0.53)
d.rectangle([mx, ly, mx + int(w * 0.035), ly + int(h * 0.006)], fill=hexc('#ffb24a'))
# Two short lines: one long one ran into the road's bright edge line.
for n, text in enumerate(['Five places to explore.', 'Races, jumps and your friends.']):
    d.text((mx, ly + int(h * 0.028) + n * int(h * 0.052)), text, font=line_f, fill=(232, 236, 244))

out = img.resize((W, H), Image.LANCZOS)
out.save('assets/brand/social-card.jpg', quality=90, optimize=True, progressive=True)
print('wrote assets/brand/social-card.jpg', out.size)
