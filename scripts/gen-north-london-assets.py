#!/usr/bin/env python3
"""Generate North London 26-09 bundled assets into apps/web/public/.

Source (not vendored): `WriteMap-Dev/HS_North_London_FINAL.kmz`, one doc.kml:
  Parlimentary Constituency        12 polygons (1st admin, PCON24)
  Wards                            78 placemarks (2nd admin, WD25)
  HSR Line and Waterway (Landmass) WCML + Channel Tunnel Rail Link (HS1), as
                                   MultiGeometry of ~1,200 OSM way pieces
  Station                          56 points — Tube, Overground, National Rail
  Game Area and Hiding Zone        56 × 400 m circles, one per station; 8 styled
                                   "Closed" (engineering works)
  Cinema and Library               category is the bare <description> word
  Museum, Hospital                 one category each

Parks come from a separate CSV (`WriteMap-Dev/HS_North_London_parks.csv`,
26/09/2026): 55 parks from the Hackney, Islington and Camden council lists,
geocoded via Google (its WKT and lat/lon are the same point). It is the WHOLE
park list, so the park questions read these 55 and never Overpass. Named by
the `name` column. Rows whose geocode missed the council site were renamed in
the CSV to the park the point actually sits in (e.g. Gillespie Park).

Rules decided with Jules (16/09/2026):
  - The game area is GREATER LONDON (OSM relation 175342), not the circles.
  - All 56 stations are hiding zones, the 8 closed ones included.
  - Admin measuring is to EVERY border (the london-borough reading), so each
    admin layer also ships its deduped border network.
  - Body of water is bundled from OSM ("appears blue on Google Maps").

Produces:
  nl-stations.kml             56 hiding zones, uniform 400 m
  nl-poi.kml                  cinema, library, museum, hospital, park
  nl-border.geojson           Greater London
  nl-constituencies.geojson   12 constituencies + "Outer"
  nl-constituency-lines.geojson  their border network, deduped
  nl-wards.geojson            78 wards + "Outer"
  nl-ward-lines.geojson       their border network, deduped
  nl-hsl.geojson              WCML + HS1, clipped to Greater London
  nl-water.geojson            OSM water edges and canal lines in Greater London

## Why the admin layers carry an "Outer"

The supplied constituencies and wards cover only north/central London, while
the play area is all of Greater London. A seeker standing anywhere else must
still resolve to SOME region for matching, so each layer gets one "Outer"
region covering the rest — the Paris shape. Outer is deliberately NOT part of
the border networks: its edge is either a real border of a supplied region
(already in the network) or the Greater London boundary (not an admin border
in these rules).

## Water

OSM natural=water (every water=* subtype except wastewater — sewage-works
tanks are not somewhere a player can be "at"), waterway=riverbank/dock,
landuse=basin/reservoir, plus waterway=canal centre lines. Polygons are
unioned, clipped to Greater London, and shipped as their EDGES: measuring is
"how far to the water", and nobody hides in it. Fetched from the self-hosted
Overpass by bbox (that instance has no area index) and cached in
scripts/.north-london-osm-cache/.
"""
import csv
import html
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile

import shapely
from shapely.geometry import LineString, MultiLineString, Point, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, polygonize, transform, unary_union

SRC_KMZ = "/Users/juleswitold/Dev/WriteMap-Dev/HS_North_London_FINAL.kmz"
SRC_PARKS_CSV = "/Users/juleswitold/Dev/WriteMap-Dev/HS_North_London_parks.csv"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "apps", "web", "public")
CACHE = os.path.join(ROOT, "scripts", ".north-london-osm-cache")
OVERPASS = "http://localhost:12345/api/interpreter"
GREATER_LONDON_RELATION = 175342
BBOX = "51.28,-0.52,51.70,0.34"

HIDING_RADIUS_M = 400
ADMIN_SIMPLIFY_DEG = 0.00003   # ~2-3 m; coverage-simplified, so still tiles
LINE_SIMPLIFY_DEG = 0.00005    # ~4 m, for the measuring networks
WATER_SIMPLIFY_DEG = 0.00005
WATER_MIN_AREA_M2 = 20         # drops OSM digitising specks, keeps every pond

EXPECT = {
    "stations": 56, "closed": 8, "constituencies": 12, "wards": 78,
    "poi": {"cinema": 28, "library": 45, "museum": 44, "hospital": 14,
            "park": 55},
}

_R = 6371008.8
_KX = 111320 * math.cos(math.radians(51.5))


def m2(g):
    """Local equirectangular area in m² — plenty for thresholds at this size."""
    return transform(lambda x, y, z=None: (x * _KX, y * 110574), g).area


def geo_dist(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dl = math.radians(b[0] - a[0])
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * _R * math.asin(min(1.0, math.sqrt(h)))


# ── KML ──────────────────────────────────────────────────────────────────────
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
    return html.unescape(m.group(1)).strip().strip("\xa0").strip() if m else ""


def pm_desc(pm):
    m = re.search(r"<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>", pm)
    return html.unescape(m.group(1)).strip() if m else ""


def field(pm, key):
    """A 'key: value' or 'key value' pair from a My Maps description."""
    m = re.search(r"(?:^|<br>)\s*" + re.escape(key) + r":?\s+([^<]*)<", pm_desc(pm) + "<")
    return m.group(1).strip() if m else None


def parse_coords(text):
    return [tuple(map(float, c.split(",")[:2])) for c in text.split()]


def all_coord_lists(pm):
    return [parse_coords(t) for t in re.findall(r"<coordinates>([\s\S]*?)</coordinates>", pm)]


def pm_polygons(pm):
    out = []
    for poly in re.findall(r"<Polygon>([\s\S]*?)</Polygon>", pm):
        ob = re.search(r"<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly)
        ins = [parse_coords(r) for r in re.findall(
            r"<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly)]
        out.append(Polygon(parse_coords(ob.group(1)), ins).buffer(0))
    return [p for p in out if not p.is_empty]


# ── OSM ──────────────────────────────────────────────────────────────────────
def overpass(query, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        return json.load(open(path))
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": query}).encode())
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
    json.dump(data, open(path, "w"))
    return data


def relation_polygon(rel):
    def rings(role):
        ways = [
            LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
            for m in rel.get("members", [])
            if m.get("type") == "way" and m.get("role", "") == role and len(m.get("geometry", [])) > 1
        ]
        return list(polygonize(linemerge(unary_union(ways)))) if ways else []
    outer = unary_union(rings("outer") + rings(""))
    inner = rings("inner")
    return (outer.difference(unary_union(inner)) if inner else outer).buffer(0)


def greater_london():
    d = overpass(f"[out:json][timeout:250];rel({GREATER_LONDON_RELATION});out geom;", "greater-london.json")
    g = relation_polygon(d["elements"][0])
    if g.geom_type != "Polygon":
        g = max(g.geoms, key=lambda p: p.area)
    return Polygon(g.exterior)


def water(area):
    q = (
        f"[out:json][timeout:500];("
        f'way["natural"="water"]({BBOX});rel["natural"="water"]({BBOX});'
        f'way["waterway"="riverbank"]({BBOX});way["waterway"="canal"]({BBOX});'
        f'way["waterway"="dock"]({BBOX});way["landuse"="basin"]({BBOX});'
        f'way["landuse"="reservoir"]({BBOX});rel["landuse"="reservoir"]({BBOX});'
        f");out geom;"
    )
    polys, canals, skipped = [], [], 0
    for e in overpass(q, "water.json")["elements"]:
        t = e.get("tags", {})
        if t.get("water") == "wastewater":
            skipped += 1
            continue
        if e["type"] == "relation":
            try:
                g = relation_polygon(e)
            except Exception:
                continue
            if not g.is_empty:
                polys.append(g)
            continue
        pts = [(p["lon"], p["lat"]) for p in e.get("geometry", [])]
        if len(pts) < 2:
            continue
        closed = len(pts) >= 4 and pts[0] == pts[-1]
        if t.get("waterway") == "canal" and not closed:
            canals.append(LineString(pts))
        elif closed:
            p = Polygon(pts).buffer(0)
            if not p.is_empty:
                polys.append(p)
    water_poly = unary_union(polys).intersection(area)
    parts = [p for p in getattr(water_poly, "geoms", [water_poly])
             if p.geom_type == "Polygon" and m2(p) >= WATER_MIN_AREA_M2]
    edges = unary_union([p.boundary for p in parts])
    canal_lines = unary_union(canals).intersection(area)
    # Canal centre lines inside a canal polygon are redundant for "distance to
    # the water" — the polygon edge is nearer — so keep only the stretches that
    # the polygons do not already cover (culverted/unmapped-bank sections).
    canal_lines = canal_lines.difference(unary_union(parts).buffer(0.00002))
    net = linemerge(unary_union([edges, canal_lines])).simplify(WATER_SIMPLIFY_DEG)
    print(f"\nwater: {len(parts)} polygons, {len(canals)} canal ways, "
          f"{skipped} wastewater skipped, {m2(unary_union(parts)) / 1e6:.2f} km²")
    return net


# ── writers ──────────────────────────────────────────────────────────────────
def coord(lon, lat):
    return f"{float(lon):.6f},{float(lat):.6f},0"


def rounded(g):
    return transform(lambda x, y, z=None: (round(x, 6), round(y, 6)), g)


def feature(geom, props):
    geom = rounded(geom)
    if geom.geom_type == "Polygon":
        geom = orient(geom, 1.0)
    elif geom.geom_type == "MultiPolygon":
        geom = shapely.MultiPolygon([orient(p, 1.0) for p in geom.geoms])
    return {"type": "Feature", "properties": props, "geometry": mapping(geom)}


def lines_of(g):
    if g.is_empty:
        return []
    return [g] if g.geom_type == "LineString" else [x for x in g.geoms if x.geom_type == "LineString"]


def write_fc(name, features):
    body = json.dumps({"type": "FeatureCollection", "features": features},
                      separators=(",", ":")) + "\n"
    with open(os.path.join(PUBLIC, name), "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"wrote {name:32s} {len(body):>10,d} b")


def write_text(name, body):
    with open(os.path.join(PUBLIC, name), "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"wrote {name:32s} {len(body):>10,d} b")


def main():
    doc = load_doc()
    area = greater_london()
    print(f"Greater London {m2(area) / 1e6:,.1f} km², {len(area.exterior.coords)} vertices")

    # ---- stations and zones --------------------------------------------------
    stations = []
    for pm in placemarks(folder(doc, "Station")):
        c = all_coord_lists(pm)[0][0]
        stations.append((pm_name(pm), c, field(pm, "allowed")))
    closed = [n for n, _, a in stations if a == "Closed"]
    if len(stations) != EXPECT["stations"] or len(closed) != EXPECT["closed"]:
        sys.exit(f"stations {len(stations)} / closed {len(closed)} not as expected")
    by_name = {n: c for n, c, _ in stations}
    if len(by_name) != len(stations):
        sys.exit("duplicate station names")
    zones = placemarks(folder(doc, "Game Area and Hiding Zone"))
    if sorted(pm_name(z) for z in zones) != sorted(by_name):
        sys.exit("hiding-zone labels do not match station labels one-to-one")
    for z in zones:
        c = by_name[pm_name(z)]
        ds = [geo_dist(c, v) for v in all_coord_lists(z)[0]]
        if max(abs(d - HIDING_RADIUS_M) for d in ds) > 5:
            sys.exit(f"zone {pm_name(z)!r} is not a 400 m circle on its station")
    outside = [n for n, c, _ in stations if not area.contains(Point(c))]
    if outside:
        sys.exit(f"stations outside Greater London: {outside}")
    print(f"\nstations: {len(stations)} hiding zones (closed, still zones: {closed})")

    # ---- POIs ----------------------------------------------------------------
    by_cat = {}
    for fname in ("Cinema and Library", "Museum", "Hospital"):
        for pm in placemarks(folder(doc, fname)):
            cat = pm_desc(pm).lower()
            if cat not in EXPECT["poi"]:
                sys.exit(f"{fname}: unexpected category {cat!r} on {pm_name(pm)!r}")
            c = all_coord_lists(pm)[0][0]
            if not area.contains(Point(c)):
                sys.exit(f"POI outside Greater London: {pm_name(pm)}")
            by_cat.setdefault(cat, []).append((pm_name(pm), c))
    # The header's second column carries a stray BOM; read by position up to
    # `longitude` only, and skip the trailing blank line.
    with open(SRC_PARKS_CSV, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    if rows[0][3] != "name" or rows[0][5:7] != ["latitude", "longitude"]:
        sys.exit(f"parks CSV: unexpected header {rows[0][:7]}")
    for r in rows[1:]:
        if not any(r):
            continue
        c = (float(r[6]), float(r[5]))
        if not area.contains(Point(c)):
            sys.exit(f"park outside Greater London: {r[3]}")
        by_cat.setdefault("park", []).append((r[3].strip(), c))
    got = {k: len(v) for k, v in by_cat.items()}
    if got != EXPECT["poi"]:
        sys.exit(f"POI counts {got} != {EXPECT['poi']}")

    # ---- admin layers --------------------------------------------------------
    def admin_layer(fname, name_key, lad_key, expect):
        raw = {}
        for pm in placemarks(folder(doc, fname)):
            nm = pm_name(pm)
            lad = field(pm, lad_key) if lad_key else None
            raw.setdefault((nm, lad), []).extend(pm_polygons(pm))
        names = [n for n, _ in raw]
        shared = {n for n in names if names.count(n) > 1}
        feats = {}
        for (nm, lad), polys in raw.items():
            label = f"{nm} ({lad})" if nm in shared else nm
            feats[label] = unary_union(polys).buffer(0).intersection(area)
        if len(feats) != expect:
            sys.exit(f"{fname}: expected {expect} regions, got {len(feats)}")
        keys = sorted(feats)
        worst = 0.0
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                a, b = feats[keys[i]], feats[keys[j]]
                if a.intersects(b):
                    worst = max(worst, m2(a.intersection(b)))
        if worst > 50:
            sys.exit(f"{fname}: regions overlap by up to {worst:.0f} m²")
        simple = shapely.coverage_simplify([feats[k] for k in keys], ADMIN_SIMPLIFY_DEG)
        feats = {k: g.buffer(0) for k, g in zip(keys, simple)}
        covered = unary_union(list(feats.values())).buffer(0)
        # Pinholes between neighbours (digitising gaps) join the neighbour
        # with the most shared edge; the big remainder becomes Outer.
        holes = [p for p in getattr(covered, "interiors", [])] if covered.geom_type == "Polygon" else []
        for ring in holes:
            hole = Polygon(ring)
            best = max(keys, key=lambda k: hole.buffer(1e-6).intersection(feats[k]).area)
            feats[best] = unary_union([feats[best], hole]).buffer(0)
        covered = unary_union(list(feats.values())).buffer(0)
        outer = area.difference(covered).buffer(0)
        homeless = [n for n, c, _ in stations
                    if sum(1 for g in feats.values() if g.covers(Point(c))) != 1]
        if homeless:
            sys.exit(f"{fname}: stations not in exactly one supplied region: {homeless}")
        net = linemerge(unary_union([g.boundary for g in feats.values()])).simplify(LINE_SIMPLIFY_DEG)
        print(f"\n{fname}: {len(feats)} regions (disambiguated: {sorted(shared)}), "
              f"{len(holes)} pinholes absorbed, cover {m2(covered) / 1e6:.2f} km², "
              f"Outer {m2(outer) / 1e6:.1f} km²; all 56 zones inside a real region")
        polys = [(k, feats[k]) for k in keys] + [("Outer", outer)]
        return polys, net

    constituencies, con_net = admin_layer(
        "Parlimentary Constituency", "PCON24NM", None, EXPECT["constituencies"])
    wards, ward_net = admin_layer("Wards", "WD25NM", "LAD25NM", EXPECT["wards"])

    # ---- HSL -----------------------------------------------------------------
    hsl = []
    for pm in placemarks(folder(doc, "HSR Line and Waterway (Landmass)")):
        pieces = [LineString(c) for c in all_coord_lists(pm) if len(c) > 1]
        merged = linemerge(unary_union(pieces)).intersection(area).simplify(LINE_SIMPLIFY_DEG)
        km = sum(geo_dist(a, b) for l in lines_of(merged) for a, b in zip(l.coords, l.coords[1:])) / 1000
        print(f"\nHSL {pm_name(pm)}: {len(pieces)} pieces -> {len(lines_of(merged))} lines, "
              f"{km:.1f} km inside Greater London")
        hsl.append((pm_name(pm), merged))
    if sorted(n for n, _ in hsl) != ["Channel Tunnel Rail Link", "West Coast Main Line"]:
        sys.exit(f"unexpected HSL lines {[n for n, _ in hsl]}")

    net = water(area)

    # ---- write ---------------------------------------------------------------
    st = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
          "<name>North London Stations</name>"]
    for n, c, _ in sorted(stations):
        st.append(f"<Placemark><name>{html.escape(n, quote=False)}</name>"
                  f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>")
    st.append("</Document></kml>")
    write_text("nl-stations.kml", "\n".join(st) + "\n")

    poi = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
           "<name>North London POIs</name>"]
    for cat in sorted(by_cat):
        poi.append(f"<Folder><name>{cat}</name>")
        for n, c in sorted(by_cat[cat]):
            poi.append(f"<Placemark><name>{html.escape(n, quote=False)}</name>"
                       f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>")
        poi.append("</Folder>")
    poi.append("</Document></kml>")
    write_text("nl-poi.kml", "\n".join(poi) + "\n")

    write_fc("nl-border.geojson", [feature(area.simplify(0.00005), {"name": "Greater London"})])
    write_fc("nl-constituencies.geojson", [feature(g, {"name": n}) for n, g in constituencies])
    write_fc("nl-constituency-lines.geojson", [feature(l, {}) for l in lines_of(con_net)])
    write_fc("nl-wards.geojson", [feature(g, {"name": n}) for n, g in wards])
    write_fc("nl-ward-lines.geojson", [feature(l, {}) for l in lines_of(ward_net)])
    write_fc("nl-hsl.geojson", [feature(l, {"name": n}) for n, g in hsl for l in lines_of(g)])
    write_fc("nl-water.geojson", [feature(l, {}) for l in lines_of(net)])

    print("\nPOIs:", {k: len(v) for k, v in sorted(by_cat.items())})


if __name__ == "__main__":
    main()
