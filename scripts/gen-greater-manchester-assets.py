#!/usr/bin/env python3
"""Generate Greater Manchester 19-9 bundled assets into apps/web/public/.

Source (not vendored): `WriteMap-Dev/Hide + Seek GM 2026.kmz`, one doc.kml with
nine folders. Used:
  Stations                    168 points — National Rail, Metrolink and bus
                              stations, all mixed in one folder
  Hiding Zones                168 drawn 400 m circles (LineStrings)
  Game Area                   the county boundary as a closed LineString, plus a
                              "Piccadilly Gardens" start marker (ignored)
  POIs                        category carried by styleUrl; the two West Coast
                              Main Line stretches are LineStrings in here too
  1st Administrative Divisions  the 10 metropolitan boroughs
  2nd Administrative Divisions  the 2024 wards
Deliberately ignored, per Jules (16/09/2026): Landmasses, OS Open Rivers, Busway.

Produces:
  gm-stations.kml         only the stations that HAVE a hiding circle
  gm-poi.kml              airport, zoo, aquarium, hospital, consulate, mountain
  gm-border.geojson       the play area
  gm-boroughs.geojson     10 boroughs, dissolved from the wards
  gm-wards.geojson        the 215 wards, tiling the play area exactly
  gm-hsl.geojson          the two WCML stretches, for measuring
  gm-hsl-regions.geojson  the play area split by which stretch is nearer, for
                          matching

## Stations vs hiding zones

A station is a hiding zone iff the source draws a circle for it (Jules' rule).
Circles are matched to stations by GEOMETRY, not by name: the zone labels drift
from the station labels ("Southern Cemetery" vs "Southern Cemetery Bus Station
(Stand B)").

## Library

No library data in the source; the library questions stay on Overpass. So there
is deliberately no `library` folder in gm-poi.kml — an empty one would override
Overpass with nothing.

## High-speed rail matching

The rulebook has no matching form for high-speed rail, and both supplied lines
are the same railway (the West Coast Main Line), so "same line" would always be
true. Matching is therefore "is your nearest high-speed stretch the same as
mine": the play area split by which of the two stretches is closer. They sit
at opposite ends of the county — Stockport south to the edge, Wigan north to
the edge — so this is in practice a SE/NW split along their bisector.
"""
import html
import json
import math
import os
import re
import sys
import zipfile

import shapely
from shapely.geometry import LineString, MultiPoint, MultiPolygon, Point, Polygon, box, mapping
from shapely.geometry.polygon import orient
from shapely.ops import transform, unary_union, voronoi_diagram

SRC_KMZ = "/Users/juleswitold/Dev/WriteMap-Dev/Hide + Seek GM 2026.kmz"
PUBLIC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "apps", "web", "public"
)

HIDING_RADIUS_M = 400
WARD_SIMPLIFY_DEG = 0.00005  # ~5 m at this latitude

# Geodesic measurement on the WGS84 sphere (see gen-brighton-assets.py for why
# degrees are never scaled by a flat 111320).
_R = 6371008.8


def geo_area(g):
    """Spherical-excess area in m², matching turf.area."""
    if g.is_empty:
        return 0.0
    if g.geom_type in ("MultiPolygon", "GeometryCollection"):
        return sum(geo_area(p) for p in g.geoms)
    if g.geom_type != "Polygon":
        return 0.0

    def ring(coords):
        pts = [(math.radians(x), math.radians(y)) for x, y in coords]
        t = 0.0
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            t += (x2 - x1) * (2 + math.sin(y1) + math.sin(y2))
        return abs(t * _R * _R / 2.0)

    a = ring(g.exterior.coords)
    for h in g.interiors:
        a -= ring(h.coords)
    return a


def geo_dist(a, b):
    """Great-circle distance in metres between two (lon, lat) tuples."""
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dl = math.radians(b[0] - a[0])
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * _R * math.asin(min(1.0, math.sqrt(h)))


# Local equal-scale projection for the HSL bisector. At 53.5°N a degree of
# longitude is ~0.59 of a degree of latitude; a Voronoi diagram in raw degrees
# would put the split in the wrong place.
_K = math.cos(math.radians(53.5))


def to_local(g):
    return transform(lambda x, y, z=None: (x * _K, y), g)


def from_local(g):
    return transform(lambda x, y, z=None: (x / _K, y), g)


# POI styleUrl -> canonical category. Everything here is a rulebook category,
# so the generic questions pick these up via the POI override — no game-prefixed
# types needed. "#icon-1807-FF5252" is the hospital style WITHOUT "-nodesc".
POI_STYLES = {
    "#icon-1417": "airport",
    "#icon-1121": "zoo",
    "#icon-1363": "aquarium",
    "#icon-1807-FF5252": "hospital",
    "#icon-1197": "consulate",
    "#icon-1634-795548-nodesc": "mountain",
}
HSL_STYLE_PREFIX = "#line-F57C00-"

EXPECT = {
    "stations": 168,
    "zones": 168,
    "boroughs": 10,
    "hsl": 2,
    "poi": {"airport": 1, "zoo": 3, "aquarium": 1, "hospital": 19,
            "consulate": 16, "mountain": 13},
}


# ── KML parsing ──────────────────────────────────────────────────────────────
def load_doc():
    with zipfile.ZipFile(SRC_KMZ) as z:
        return z.read("doc.kml").decode("utf-8")


def folder(doc, name):
    m = re.search(
        r"<Folder>\s*<name>" + re.escape(name) + r"</name>([\s\S]*?)"
        r"(?=<Folder>\s*<name>|</Document>)",
        doc,
    )
    if not m:
        sys.exit(f"folder {name!r} not found")
    return m.group(1)


def placemarks(body):
    return re.findall(r"<Placemark>([\s\S]*?)</Placemark>", body)


def pm_name(pm):
    m = re.search(r"<name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</name>", pm)
    # Strip, including the non-breaking spaces My Maps leaves on some labels.
    return html.unescape(m.group(1)).strip().strip("\xa0").strip() if m else ""


def pm_style(pm):
    m = re.search(r"<styleUrl>([^<]*)</styleUrl>", pm)
    return m.group(1) if m else ""


def parse_coords(text):
    return [tuple(map(float, c.split(",")[:2])) for c in text.split()]


def first_coords(pm):
    m = re.search(r"<coordinates>([\s\S]*?)</coordinates>", pm)
    return parse_coords(m.group(1)) if m else None


def pm_polygons(pm):
    """Every polygon in a placemark, from <Polygon> and from closed LineStrings."""
    out = []
    for poly in re.findall(r"<Polygon>([\s\S]*?)</Polygon>", pm):
        ob = re.search(
            r"<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly
        )
        if not ob:
            continue
        ins = [
            parse_coords(ring)
            for ring in re.findall(
                r"<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly
            )
        ]
        out.append(Polygon(parse_coords(ob.group(1)), ins).buffer(0))
    for ring in re.findall(
        r"<LineString>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", pm
    ):
        pts = parse_coords(ring)
        if len(pts) > 3 and pts[0] == pts[-1]:
            out.append(Polygon(pts).buffer(0))
    return [p for p in out if not p.is_empty]


# ── writers ──────────────────────────────────────────────────────────────────
def coord(lon, lat):
    """KML "lon,lat,0" at a fixed 6 decimal places (~0.11 m). Never "{:g}"."""
    return f"{float(lon):.6f},{float(lat):.6f},0"


def rounded(geom):
    return transform(lambda x, y, z=None: (round(x, 6), round(y, 6)), geom)


def fc(features):
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, separators=(",", ":")
    ) + "\n"


def feature(geom, props):
    geom = rounded(geom)
    g = (
        orient(geom, 1.0)
        if geom.geom_type == "Polygon"
        else MultiPolygon([orient(p, 1.0) for p in geom.geoms])
        if geom.geom_type == "MultiPolygon"
        else geom
    )
    return {"type": "Feature", "properties": props, "geometry": mapping(g)}


def write(name, body):
    with open(os.path.join(PUBLIC, name), "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"wrote {name:26s} {len(body.encode('utf-8')):>10,d} b")


def polygon_parts(g):
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type == "MultiPolygon":
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]


def main():
    doc = load_doc()

    # ---- play area ------------------------------------------------------------
    ga = [p for p in placemarks(folder(doc, "Game Area"))
          if pm_name(p) == "Greater Manchester"]
    if len(ga) != 1:
        sys.exit("expected one 'Greater Manchester' game-area placemark")
    area_polys = pm_polygons(ga[0])
    if len(area_polys) != 1:
        sys.exit(f"game area should be one closed ring, got {len(area_polys)}")
    game = area_polys[0]
    print(f"play area {geo_area(game) / 1e6:,.2f} km², "
          f"{len(game.exterior.coords)} vertices, {len(game.interiors)} holes")

    # ---- stations and hiding zones -------------------------------------------
    stations = []
    for pm in placemarks(folder(doc, "Stations")):
        c = first_coords(pm)
        if c:
            stations.append((pm_name(pm), c[0]))
    if len(stations) != EXPECT["stations"]:
        sys.exit(f"expected {EXPECT['stations']} stations, got {len(stations)}")

    zones = []
    for pm in placemarks(folder(doc, "Hiding Zones")):
        c = first_coords(pm)
        if not c or len(c) < 4:
            continue
        # The circle's centre is the mean of its vertices. For a circle the
        # source clipped (Broadbottom, cut by the county boundary) that mean
        # drifts, so fall back to the vertex-to-vertex extent below.
        zones.append((pm_name(pm), Polygon(c).buffer(0), c))
    if len(zones) != EXPECT["zones"]:
        sys.exit(f"expected {EXPECT['zones']} hiding zones, got {len(zones)}")

    # Assign each circle to the station whose distance to every vertex is
    # closest to 400 m. Robust to a clipped circle, whose arc still sits at 400 m.
    def fit(station, ring):
        ds = sorted(geo_dist(station, v) for v in ring)
        arc = ds[len(ds) // 2:]  # the outer half — the part still on the arc
        return sum(abs(d - HIDING_RADIUS_M) for d in arc) / len(arc)

    used, zoned, renamed = {}, [], []
    for zname, _poly, ring in zones:
        cx = sum(x for x, _ in ring) / len(ring)
        cy = sum(y for _, y in ring) / len(ring)
        near = sorted(
            range(len(stations)), key=lambda i: geo_dist(stations[i][1], (cx, cy))
        )[:4]
        best = min(near, key=lambda i: fit(stations[i][1], ring))
        err = fit(stations[best][1], ring)
        if err > 15:
            sys.exit(f"zone {zname!r}: no station sits at its centre (best off by {err:.0f} m)")
        if best in used:
            sys.exit(f"zones {used[best]!r} and {zname!r} both matched {stations[best][0]!r}")
        used[best] = zname
        sname = stations[best][0]
        if sname != zname:
            renamed.append((zname, sname))
        zoned.append(stations[best])

    unzoned = [stations[i] for i in range(len(stations)) if i not in used]
    print(f"\nstations: {len(stations)}, with a hiding circle: {len(zoned)}")
    for n, c in unzoned:
        print(f"  no circle, NOT a hiding zone: {n} ({c[1]:.5f}, {c[0]:.5f})")
    for z, s in renamed:
        print(f"  zone label {z!r} → station {s!r}")

    outside = [n for n, c in zoned if not game.contains(Point(c))]
    if outside:
        sys.exit(f"stations outside the play area: {outside}")
    clipped = [
        z for z, poly, _ in zones
        if geo_area(poly) < 0.97 * math.pi * HIDING_RADIUS_M ** 2
    ]
    print(f"  source-clipped circles: {clipped}")

    # Duplicate names are fine for the importer but make the list ambiguous.
    names = [n for n, _ in zoned]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        print(f"  duplicate station names (kept, both are real stops): {dupes}")

    # ---- POIs and HSL ----------------------------------------------------------
    by_cat, hsl = {}, []
    for pm in placemarks(folder(doc, "POIs")):
        style = pm_style(pm)
        n = pm_name(pm)
        if style.startswith(HSL_STYLE_PREFIX):
            hsl.append((n, LineString(first_coords(pm))))
            continue
        if style not in POI_STYLES:
            sys.exit(f"unmapped POI style {style!r} on {n!r}")
        c = first_coords(pm)
        by_cat.setdefault(POI_STYLES[style], []).append((n, c[0]))
    got = {k: len(v) for k, v in by_cat.items()}
    if got != EXPECT["poi"]:
        sys.exit(f"POI counts {got} != expected {EXPECT['poi']}")
    if len(hsl) != EXPECT["hsl"]:
        sys.exit(f"expected {EXPECT['hsl']} HSL lines, got {len(hsl)}")

    # ---- admin layers ------------------------------------------------------------
    # Wards are the precise layer (ONS 2024, zero overlaps). The supplied
    # borough polygons are not: they overlap each other by 0.61 km² in total
    # (Oldham/Tameside alone 0.20 km²) and leave 0.77 km² of gaps. So boroughs
    # are BUILT from the wards, dissolved on each ward's LAD24NM — the two
    # layers then agree exactly, and a pin is never in two boroughs or none.
    ward_parts, dropped = {}, []
    for pm in placemarks(folder(doc, "2nd Administrative Divisions")):
        nm = pm_name(pm)
        lad = re.search(r"LAD24NM:\s*([^<]*)<", pm)
        if not lad:
            sys.exit(f"ward {nm!r} has no LAD24NM")
        lad = html.unescape(lad.group(1)).strip()
        polys = [p for p in pm_polygons(pm) if geo_area(p) > 1]
        if not polys:
            dropped.append(nm)
            continue
        ward_parts.setdefault((nm, lad), []).extend(polys)
    if dropped:
        sys.exit(f"wards with no polygon: {dropped}")

    # "Brooklands" and "Manor" are each two different wards in two boroughs.
    names = [n for n, _ in ward_parts]
    shared = {n for n in names if names.count(n) > 1}
    wards = {}
    for (nm, lad), polys in ward_parts.items():
        label = f"{nm} ({lad})" if nm in shared else nm
        g = unary_union(polys).buffer(0).intersection(game)
        if geo_area(g) < 1:
            sys.exit(f"ward {label!r} lies outside the play area")
        wards[label] = [g, lad]
    print(f"\nwards: {len(wards)}; names disambiguated: {sorted(shared)}")

    # The ward layer and the county ring were digitised separately and differ by
    # a hairline along the edge (~0.06 km² of gap). Rather than an "Outer"
    # region — whose border, for measuring, would be a meaningless sliver — each
    # gap piece joins the ward it shares the most edge with.
    covered = unary_union([g for g, _ in wards.values()]).buffer(0)
    gap = polygon_parts(game.difference(covered))
    gap_area = sum(geo_area(p) for p in gap)
    for part in gap:
        ring = part.buffer(1e-6)
        best = max(wards, key=lambda k: ring.intersection(wards[k][0]).area)
        if ring.intersection(wards[best][0]).area == 0:
            sys.exit(f"gap piece of {geo_area(part):.0f} m² touches no ward")
        wards[best][0] = unary_union([wards[best][0], part]).buffer(0)
    print(f"  absorbed {len(gap)} edge gap pieces, {gap_area:,.0f} m² total")

    # Full-resolution wards are 4.1 MB, downloaded by every phone that opens a
    # ward question. Simplify them as a COVERAGE (~5 m), which moves each shared
    # edge once for both neighbours, so the layer still tiles with no slivers —
    # independent per-polygon simplification would open gaps between wards.
    keys = list(wards)
    simple = shapely.coverage_simplify(
        [wards[k][0] for k in keys], WARD_SIMPLIFY_DEG
    )
    for k, g in zip(keys, simple):
        wards[k][0] = g.buffer(0)
    # The simplified outer edge no longer matches the full-resolution county
    # ring exactly, so the play area is rebuilt from the wards: the border and
    # the admin layers must agree or pins near the edge fall in no ward.
    game = unary_union([g for g, _ in wards.values()]).buffer(0)
    if game.geom_type == "MultiPolygon":
        game = max(game.geoms, key=lambda p: p.area)
    game = Polygon(game.exterior)

    ward_list = sorted((n, g) for n, (g, _) in wards.items())
    for i in range(len(ward_list)):
        for j in range(i + 1, len(ward_list)):
            a, b = ward_list[i][1], ward_list[j][1]
            if a.intersects(b):
                ov = geo_area(a.intersection(b))
                if ov > 5:
                    sys.exit(f"ward overlap {ward_list[i][0]} / {ward_list[j][0]} = {ov:.0f} m²")

    lads = sorted({lad for _, lad in wards.values()})
    supplied = {pm_name(pm): unary_union(pm_polygons(pm)).buffer(0)
                for pm in placemarks(folder(doc, "1st Administrative Divisions"))}
    if lads != sorted(supplied) or len(lads) != EXPECT["boroughs"]:
        sys.exit(f"ward LADs {lads} != supplied boroughs {sorted(supplied)}")
    boroughs = [
        (lad, unary_union([g for g, l in wards.values() if l == lad]).buffer(0))
        for lad in lads
    ]
    wards = ward_list

    def check_tiles(label, feats):
        u = unary_union([g for _, g in feats]).buffer(0)
        sym = geo_area(game.symmetric_difference(u))
        if sym > 100:
            sys.exit(f"{label} do not tile the play area: {sym:,.0f} m² differ")
        homeless = [n for n, c in zoned
                    if sum(1 for _, g in feats if g.covers(Point(c))) != 1]
        if homeless:
            sys.exit(f"{label}: stations not in exactly one region: {homeless}")
        print(f"  {label}: {len(feats)} regions tile the play area "
              f"({sym:,.0f} m² residue); all {len(zoned)} zones in exactly one")

    check_tiles("boroughs", boroughs)
    check_tiles("wards", wards)

    # Where the derived boroughs disagree with the supplied polygons, say so for
    # any station it affects — those are the ones a player checking against the
    # My Maps layer could read differently.
    for n, c in zoned:
        mine = next(b for b, g in boroughs if g.covers(Point(c)))
        theirs = sorted(b for b, g in supplied.items() if g.covers(Point(c)))
        if theirs != [mine]:
            print(f"  borough differs from supplied layer: {n}: {mine} vs {theirs}")

    # ---- HSL nearest-stretch regions ----------------------------------------------
    # Dense samples along both stretches, Voronoi in an equal-scale projection,
    # cells unioned per stretch, clipped to a generous frame around the play area
    # (the frame, not the play area, so a pin dropped just outside still resolves).
    frame = box(*game.buffer(0.1).bounds)
    samples, labels = [], []
    for idx, (_, line) in enumerate(hsl):
        loc = to_local(line)
        n = max(2, int(loc.length / 0.0005))  # ~55 m spacing
        for k in range(n + 1):
            samples.append(loc.interpolate(k / n, normalized=True))
            labels.append(idx)
    cells = voronoi_diagram(
        MultiPoint(samples), envelope=to_local(frame).buffer(1)
    )
    tree = {}
    from shapely.strtree import STRtree
    st = STRtree(samples)
    for cell in cells.geoms:
        hits = st.query(cell, predicate="contains")
        if len(hits) != 1:
            sys.exit("voronoi cell without exactly one sample")
        tree.setdefault(labels[hits[0]], []).append(cell)
    hsl_regions = []
    for idx, (name, _) in enumerate(hsl):
        r = from_local(unary_union(tree[idx])).intersection(frame).buffer(0)
        hsl_regions.append((name, r))
    ov = hsl_regions[0][1].intersection(hsl_regions[1][1]).area
    if ov > 1e-9:
        sys.exit(f"HSL regions overlap by {ov}")
    # Spot-check the split against a brute-force nearest-line test.
    import random
    random.seed(1)
    minx, miny, maxx, maxy = game.bounds
    bad = 0
    for _ in range(2000):
        p = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
        lp = to_local(p)
        want = min(range(len(hsl)), key=lambda i: to_local(hsl[i][1]).distance(lp))
        got_r = [i for i, (_, r) in enumerate(hsl_regions) if r.covers(p)]
        if got_r and got_r[0] != want and abs(
            to_local(hsl[0][1]).distance(lp) - to_local(hsl[1][1]).distance(lp)
        ) > 0.0002:
            bad += 1
    if bad:
        sys.exit(f"HSL region split disagrees with brute force at {bad} points")
    print("\nHSL:")
    for (name, line), (_, r) in zip(hsl, hsl_regions):
        in_play = r.intersection(game)
        nz = sum(1 for _, c in zoned if r.covers(Point(c)))
        print(f"  {name}: {len(line.coords)} vertices, nearer for "
              f"{100 * geo_area(in_play) / geo_area(game):.1f}% of play area, {nz} zones")

    # ---- write ----------------------------------------------------------------------
    st_kml = ['<?xml version="1.0" encoding="UTF-8"?>',
              '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
              "<name>Greater Manchester Stations</name>"]
    for n, c in sorted(zoned):
        st_kml.append(
            f"<Placemark><name>{html.escape(n)}</name>"
            f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>"
        )
    st_kml.append("</Document></kml>")
    write("gm-stations.kml", "\n".join(st_kml) + "\n")

    poi = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
           "<name>Greater Manchester POIs</name>"]
    for cat in sorted(by_cat):
        poi.append(f"<Folder><name>{cat}</name>")
        for n, c in sorted(by_cat[cat]):
            poi.append(
                f"<Placemark><name>{html.escape(n)}</name>"
                f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>"
            )
        poi.append("</Folder>")
    poi.append("</Document></kml>")
    write("gm-poi.kml", "\n".join(poi) + "\n")

    write("gm-border.geojson",
          fc([feature(game, {"name": "Greater Manchester 19-9 play area"})]))
    write("gm-boroughs.geojson", fc([feature(g, {"name": n}) for n, g in boroughs]))
    write("gm-wards.geojson", fc([feature(g, {"name": n}) for n, g in wards]))
    write("gm-hsl.geojson", fc([feature(l, {"name": n}) for n, l in hsl]))
    # Simplify ONE side and derive the other as its complement, so the shared
    # bisector stays shared — simplifying both independently opens slivers
    # where a pin lands in neither region.
    a_name, a_reg = hsl_regions[0]
    a_simple = a_reg.simplify(0.0001).buffer(0)
    b_simple = frame.difference(a_simple).buffer(0)
    write("gm-hsl-regions.geojson",
          fc([feature(a_simple, {"name": a_name}),
              feature(b_simple, {"name": hsl_regions[1][0]})]))

    print("\nPOIs:")
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        print(f"  {len(by_cat[cat]):4d}  {cat}")


if __name__ == "__main__":
    main()
