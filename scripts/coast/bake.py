#!/usr/bin/env python3
"""
Bakes real island outlines into the game's frame: packages/shared/src/world/coast-data.ts.

Source: osm-islands.geojson next to this file — OpenStreetMap natural=coastline rings for every
game island, fetched from the Overpass API and trimmed to the islands the game has.
(c) OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright

The game world is not a uniform map: the Marathon chain is compressed about 1:2.5-1:6 and bent onto
chainZ's parabola, and Miami is laid out about 1:4 and turned so the city faces south. So each real
outline is fitted to the island it replaces rather than projected wholesale:

  1. project lon/lat to metres (local equirectangular per region), north = -z as in the game;
  2. turn the whole region by one rotation, the least-squares fit of the real island centres onto
     the game's (so every island keeps its real heading relative to its neighbours);
  3. per island, turn by the island's own heading (th), then scale and centre the outline's box onto
     the island's old footprint (2a x 2b at x,z): the length exactly, the width within ANISO of the
     length's scale so the real shape stays recognisable;
  4. simplify (Douglas-Peucker, TOL game metres) and drop crumbs.

Islands the real map joins (Knight's Key to Vaca by fill; Fat Deer, Crawl and Grassy Key) are cut
apart at CUTS so the game keeps its channels between them. Pure stdlib; run with:
  python3 -I scripts/coast/bake.py [--svg out.svg]
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'packages/shared/src/world/coast-data.ts')
GAME = os.path.join(HERE, 'game-islands.json')  # written by dump-game.mjs (the current ISL_DEF/MIAMI_ISL)

TOL = 1.6
ANISO = 1.8
MIN_AREA = 120.0

# game island name -> list of (source feature name, optional cut along the chain in real metres)
MARATHON = {
    'Little Duck Key': ['Little Duck Key'],
    'Pigeon Key': ['Pigeon Key'],
    "Knight's Key": [("Vaca Key (Marathon) + Knight's Key", None, -81.1165)],
    # without the Hog Key / Sister Creek mangroves south of the spine, which would close Boot Key Harbor
    'Marathon (Vaca Key)': [("Vaca Key (Marathon) + Knight's Key", -81.1165, None, (-81.09, 24.7035))],
    'Boot Key': ['Boot Key'],
    'Fat Deer Key': [('Fat Deer Key / Crawl Key / Grassy Key', None, -80.9905)],
    'Key Colony Beach': ['Key Colony Beach'],
    'Crawl Key': [('Fat Deer Key / Crawl Key / Grassy Key', -80.9905, -80.9625)],
    'Grassy Key': [('Fat Deer Key / Crawl Key / Grassy Key', -80.9625, None)],
    'East Sister Rock': ['East Sister Rock'],
    'Molasses Keys': ['Molasses Keys', 'Molasses Keys (south islet)'],
    'Rachel Key': ['Rachel Key'],
    'Bamboo Key': ['Bamboo Key'],
    'Money Key': ['Money Key'],
    'Bay mangroves': ['Bay mangroves'],
}
MIAMI = {
    'Brickell Key': ['Brickell Key'],
    'Dodge Island (PortMiami)': ['Dodge Island (PortMiami)'],
    'Watson Island': [('Watson Island', 'clip', (-80.1725, 25.7845, 420))],  # without the MacArthur Causeway
    'Star Island': ['Star Island'],
    'Hibiscus Island': ['Hibiscus Island'],
    'Palm Island': ['Palm Island'],
    'Fisher Island': ['Fisher Island'],
    'Miami Beach': ['Miami Beach'],
    'Venetian Islands#0': ['San Marco (Venetian)'],
    'Venetian Islands#1': ['San Marino (Venetian)'],
    'Venetian Islands#2': ['Di Lido (Venetian)'],
    'Venetian Islands#3': ['Rivo Alto (Venetian)'],
    'Virginia Key': ['Virginia Key'],
    'Key Biscayne': ['Key Biscayne', 'Key Biscayne (west islet, outer member of OSM relation)'],
}
CHAIN_BEARING = math.radians(65)  # the Middle Keys run ENE


def project(lon, lat, lon0, lat0):
    """lon/lat -> (east, -north) metres: the game's handedness, where north is -z."""
    return ((lon - lon0) * 111320.0 * math.cos(math.radians(lat0)), -(lat - lat0) * 110540.0)


def area(r):
    return 0.5 * sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))


def centroid(rings):
    A = cx = cz = 0.0
    for r in rings:
        for i in range(len(r)):
            (x0, z0), (x1, z1) = r[i - 1], r[i]
            k = x0 * z1 - x1 * z0
            A += k; cx += (x0 + x1) * k; cz += (z0 + z1) * k
    return (cx / (3 * A), cz / (3 * A))


def clip_half(ring, nx, nz, c):
    """Sutherland-Hodgman against the half-plane nx*x + nz*z >= c (works for concave subjects)."""
    out = []
    for i in range(len(ring)):
        p, q = ring[i - 1], ring[i]
        dp, dq = p[0] * nx + p[1] * nz - c, q[0] * nx + q[1] * nz - c
        if dq >= 0:
            if dp < 0:
                t = dp / (dp - dq); out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
            out.append(q)
        elif dp >= 0:
            t = dp / (dp - dq); out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


def despike(r):
    """Drops the zero-width slivers a concave clip leaves along its cut line: repeated points and
    vertices where the outline doubles straight back on itself."""
    changed = True
    while changed and len(r) > 3:
        changed = False
        out = []
        for i in range(len(r)):
            p, q, n = r[i - 1], r[i], r[(i + 1) % len(r)]
            ax, az, bx, bz = q[0] - p[0], q[1] - p[1], n[0] - q[0], n[1] - q[1]
            la, lb = math.hypot(ax, az), math.hypot(bx, bz)
            if la < 1e-6 or (lb > 1e-6 and (ax * bx + az * bz) / (la * lb) < -0.9999 and abs(ax * bz - az * bx) / (la * lb) < 1e-3):
                changed = True; continue
            out.append(q)
        r = out
    return r


def dp_simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, az), (bx, bz) = pts[a], pts[b]
        dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L
            if d > best: best, bi = d, i
        if best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(r, tol):
    # split the closed ring at its farthest-apart pair so DP has two open chains
    i0 = 0
    j0 = max(range(len(r)), key=lambda j: (r[j][0] - r[0][0]) ** 2 + (r[j][1] - r[0][1]) ** 2)
    a = dp_simplify(r[i0:j0 + 1], tol); b = dp_simplify(r[j0:] + [r[0]], tol)
    return a[:-1] + b[:-1]


def fit_rotation(pairs):
    """Least-squares rotation (no reflection) taking real centres onto game centres."""
    rx = sum(p[0][0] for p in pairs) / len(pairs); rz = sum(p[0][1] for p in pairs) / len(pairs)
    gx = sum(p[1][0] for p in pairs) / len(pairs); gz = sum(p[1][1] for p in pairs) / len(pairs)
    s = c = 0.0
    for (a, b) in pairs:
        ax, az, bx, bz = a[0] - rx, a[1] - rz, b[0] - gx, b[1] - gz
        c += ax * bx + az * bz; s += ax * bz - az * bx
    return math.atan2(s, c)


def rot(p, a):
    ca, sa = math.cos(a), math.sin(a)
    return (p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca)


def main():
    src = json.load(open(os.path.join(HERE, 'osm-islands.geojson')))
    feats = {f['properties']['name']: f for f in src['features']}
    game = json.load(open(GAME))
    by_name = {}
    for i, I in enumerate(game):
        k = I['name']
        n = sum(1 for J in game[:i] if J['name'] == k)
        by_name[f'{k}#{n}' if k == 'Venetian Islands' else k] = I

    baked = {}
    for region, table in (('marathon', MARATHON), ('miami', MIAMI)):
        fs = [f for f in src['features'] if f['properties']['region'] == region]
        lon0 = sum(c[0] for f in fs for c in f['geometry']['coordinates'][0]) / sum(len(f['geometry']['coordinates'][0]) for f in fs)
        lat0 = sum(c[1] for f in fs for c in f['geometry']['coordinates'][0]) / sum(len(f['geometry']['coordinates'][0]) for f in fs)
        chain_u = (math.sin(CHAIN_BEARING), -math.cos(CHAIN_BEARING))  # ENE in (east, -north)

        def pieces(spec):
            out = []
            for s in spec:
                if isinstance(s, str):
                    out.append([project(*c, lon0, lat0) for c in feats[s]['geometry']['coordinates'][0][:-1]])
                    continue
                name, a, b, south = (*s, None)[:4]
                ring = [project(*c, lon0, lat0) for c in feats[name]['geometry']['coordinates'][0][:-1]]
                if a == 'clip':  # keep only what lies within r metres of (lon, lat)
                    cx, cz = project(b[0], b[1], lon0, lat0); b = b[2]
                    for ang in range(0, 360, 15):
                        nx, nz = math.cos(math.radians(ang)), math.sin(math.radians(ang))
                        ring = clip_half(ring, -nx, -nz, -(cx * nx + cz * nz + b))
                    out.append(despike(ring)); continue
                # cut perpendicular to the chain at the given longitudes (at the ring's latitude)
                for lon, sign in ((a, 1), (b, -1)):
                    if lon is None: continue
                    px, pz = project(lon, lat0, lon0, lat0)
                    c = (px * chain_u[0] + pz * chain_u[1]) * sign
                    ring = clip_half(ring, chain_u[0] * sign, chain_u[1] * sign, c)
                if south:  # keep only the land north of a line along the chain through this point
                    px, pz = project(*south, lon0, lat0)
                    nx, nz = chain_u[1], -chain_u[0]  # chain normal pointing north (-z)
                    ring = clip_half(ring, nx, nz, px * nx + pz * nz)
                out.append(despike(ring))
            return [r for r in out if len(r) >= 3]

        real = {k: pieces(v) for k, v in table.items()}
        pairs = [(centroid(real[k]), (by_name[k]['x'], by_name[k]['z'])) for k in table]
        R = math.radians(90) - CHAIN_BEARING if region == "marathon" else fit_rotation(pairs)
        print(f'{region}: regional rotation {math.degrees(R):.1f} deg', file=sys.stderr)

        for k, rings in real.items():
            I = by_name[k]
            th = I['th'] if region == 'marathon' else 0.0
            # into the island's own frame: region rotation, then undo the island heading so the
            # box we fit is aligned with the old ellipse's a/b axes
            loc = [[rot(p, R) for p in r] for r in rings]
            xs = [p[0] for r in loc for p in r]; zs = [p[1] for r in loc for p in r]
            mx, mz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
            su, sv = 2 * I['a'] / (max(xs) - min(xs)), 2 * I['b'] / (max(zs) - min(zs))
            sv = min(max(sv, su / ANISO), su * ANISO)  # length rules: the island spans its old run of the chain
            res = []
            for r in loc:
                w = [rot(((p[0] - mx) * su, (p[1] - mz) * sv), th) for p in r]
                w = [(I['x'] + p[0], I['z'] + p[1]) for p in w]
                w = despike(simplify_ring(w, TOL))
                if len(w) < 3 or abs(area(w)) < MIN_AREA: continue
                if area(w) < 0: w = w[::-1]
                res.append(w)
            baked[k] = {'rings': res, 'scale': (su, sv)}
            print(f'  {k:28s} scale {su:.3f} x {sv:.3f}  verts {sum(len(r) for r in res)}', file=sys.stderr)

    # keyed in island-list order so chain.ts can pair them by index
    order = []
    for i, I in enumerate(game):
        k = I['name']; n = sum(1 for J in game[:i] if J['name'] == k)
        key = f'{k}#{n}' if k == 'Venetian Islands' else k
        order.append((I['name'], baked.get(key)))

    lines = [
        '/**',
        ' * GENERATED by scripts/coast/bake.py from scripts/coast/osm-islands.geojson. Do not edit by hand.',
        ' *',
        ' * Real island outlines, fitted into the game frame (see bake.py for how): one entry per island',
        ' * in chain.ts\'s island order, each a list of closed rings [x0, z0, x1, z1, ...] in world metres,',
        ' * counter-clockwise in (x, z). null = no real outline (the procedural mainland).',
        ' *',
        ' * Coastline data (c) OpenStreetMap contributors, available under the Open Database License (ODbL 1.0):',
        ' * https://www.openstreetmap.org/copyright',
        ' */',
        'export const COAST_RINGS: ReadonlyArray<readonly (readonly number[])[] | null> = [',
    ]
    for name, b in order:
        if not b:
            lines.append(f'  null, // {name}'); continue
        lines.append(f'  [ // {name}')
        for r in b['rings']:
            flat = ','.join(f'{v:.1f}'.rstrip('0').rstrip('.') for p in r for v in p)
            lines.append(f'    [{flat}],')
        lines.append('  ],')
    lines.append('];')
    lines.append('')
    open(OUT, 'w').write('\n'.join(lines))
    print(f'wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)', file=sys.stderr)

    if '--svg' in sys.argv:
        svg_path = sys.argv[sys.argv.index('--svg') + 1]
        write_svg(svg_path, game, order)


def write_svg(path, game, order):
    x0, z0, W, H = -4300, -4300, 8600, 9600
    s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%d %d %d %d" width="2000" height="%d">' % (x0, z0, W, H, int(2000 * H / W)),
         '<rect x="%d" y="%d" width="%d" height="%d" fill="#bfe3f2"/>' % (x0, z0, W, H)]
    for I in game:
        s.append('<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" transform="rotate(%.3f %.1f %.1f)" fill="none" stroke="#c0392b" stroke-width="4" stroke-dasharray="14 10"/>'
                 % (I['x'], I['z'], I['a'], I['b'], math.degrees(I['th']), I['x'], I['z']))
    for name, b in order:
        if not b: continue
        for r in b['rings']:
            s.append('<polygon points="%s" fill="#e3c27a" stroke="#6b4f1d" stroke-width="2"/>' % ' '.join('%.1f,%.1f' % p for p in r))
    s.append('</svg>')
    open(path, 'w').write('\n'.join(s))


if __name__ == '__main__':
    main()
