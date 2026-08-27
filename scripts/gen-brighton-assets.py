#!/usr/bin/env python3
"""Generate Brighton 29-08 bundled assets into apps/web/public/.

Source (not vendored): `WriteMap-Dev/Brighton H&S.kmz`, one doc.kml with six
folders — Stops (132 points), Hiding Zones (132 drawn 250 m circles), POIs (90
points, category carried by styleUrl), Wards (ONS 2026, names in the description
CDATA), Postcodes (8 districts) and Game Area (the play polygon plus two
"Coastline End" markers).

Produces:
  brighton-stations.kml     132 hiding zones, uniform 250 m
  brighton-poi.kml          90 POIs in 8 canonical folders
  brighton-border.geojson   the EXPANDED play area (see below)
  brighton-wards.geojson    24 wards + "Outer"
  brighton-postcodes.geojson 8 districts + "Outer"
  brighton-coastline.geojson the 18.6 km of OSM coast between the two markers
and, outside the repo, next to the source:
  Brighton Game Area.kml    the new play area as LineStrings, for My Maps

## The expanded play area

The supplied Game Area clipped 14 hiding zones. Jules asked for it to be pushed
out so nothing walkable is cut off, while leaving the zones that spill into the
English Channel alone.

It is expanded ADDITIVELY: `new = game ∪ (each clipped zone ∩ walkable)`. It
never subtracts, which matters — strictly clipping the south edge to the OSM
coastline would have deleted Brighton Palace Pier (~20,000 m²) and parts of the
Marina, all of which are walkable and were already in play. Net +48,276 m²
(+0.058%), nothing removed, and afterwards no zone is cut off on walkable
ground.

"Walkable" is OSM land (from natural=coastline) plus piers, breakwaters, jetties
and pedestrian areas, from the self-hosted Overpass. Deliberately NOT included:
  - West Pier — access=no, historic=ruins. A derelict skeleton in the sea.
  - Brighton Marina (Outer Harbour) and Southwick Marina — leisure=marina is the
    water basin boats moor in, not ground. Including it added 38,109 m² of open
    water to the Marina zone alone. The Marina's real walkable parts (breakwater,
    boardwalk, shops) are already inside the coastline or mapped as pedestrian
    areas, and are picked up that way.

## Admin layers

Both supplied layers are clipped to the OLD game area: the 24 wards tile it
exactly (zero overlap, 7 m² unaccounted) and the 8 postcodes cover 99.93%. So
every square metre the expansion adds falls outside both, and the seafront
already had postcode gaps. Those become a single "Outer" region per layer, the
Paris shape.

Seven ward placemarks are stored as closed LineStrings rather than polygons
(Kingston, Downland Villages ×2, Ditchling & Westmeston, Eastbrook, Bramber and
one more). All are degenerate slivers lying entirely outside the play area and
are dropped — asserted below, so a future source that puts real geometry there
fails loudly instead of silently losing a ward.
"""
import html
import json
import math
import os
import re
import sys
import zipfile

from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, unary_union

SRC_KMZ = "/Users/juleswitold/Dev/WriteMap-Dev/Brighton H&S.kmz"
PUBLIC = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"
GAME_AREA_KML_OUT = "/Users/juleswitold/Dev/WriteMap-Dev/Brighton Game Area.kml"
OVERPASS = "http://localhost:12345/api/interpreter"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".brighton-osm-cache")

# Geodesic measurement on the WGS84 sphere. Do NOT go back to scaling degrees by
# a flat 111320: at 50.85degN that overstates longitude by 1/cos(lat) ~ 1.58x,
# which reported this map's coastline as 26.7 km when it is 18.6 km. Same trap
# Entry 54 hit in Stockholm.
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


def geo_len(line):
    """Great-circle length in metres, matching turf.length."""
    c = list(line.coords)
    tot = 0.0
    for (x1, y1), (x2, y2) in zip(c, c[1:]):
        p1, p2 = math.radians(y1), math.radians(y2)
        dl = math.radians(x2 - x1)
        h = (math.sin((p2 - p1) / 2) ** 2
             + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
        tot += 2 * _R * math.asin(min(1.0, math.sqrt(h)))
    return tot

# POI styleUrl -> canonical category. Eight categories; "rail_station" is
# deliberately NOT "train_station", which would hijack the generic
# same-train-line / same-length-station questions with 7 of the 132 stops.
POI_STYLES = {
    "#icon-1720-097138-nodesc": ("park", "Park"),
    "#icon-985-nodesc": ("library", "Library"),
    "#icon-1636-757575-nodesc": ("museum", "Museum"),
    "#icon-1459-nodesc": ("rail_station", "Station"),
    "#icon-1634-795548-nodesc": ("mountain", "Trig Point"),
    "#icon-1807-FF5252-nodesc": ("hospital", "Hospital"),
    "#icon-1367-nodesc": ("golf_course", "Golf Course"),
    "#icon-1635-9C27B0-nodesc": ("cinema", "Cinema"),
}

COAST_END_W = (-0.216034, 50.827584)
COAST_END_E = (-0.0385633, 50.7990792)


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
    m = re.search(r"<name>([^<]*)</name>", pm)
    return html.unescape(m.group(1).strip()) if m else ""


def first_coords(pm):
    m = re.search(r"<coordinates>([\s\S]*?)</coordinates>", pm)
    if not m:
        return None
    return [tuple(map(float, c.split(",")[:2])) for c in m.group(1).split()]


def pm_polygons(pm):
    """Every polygon in a placemark, from <Polygon> and from closed LineStrings."""
    out = []
    for poly in re.findall(r"<Polygon>([\s\S]*?)</Polygon>", pm):
        ob = re.search(
            r"<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly
        )
        if not ob:
            continue
        ext = [tuple(map(float, c.split(",")[:2])) for c in ob.group(1).split()]
        ins = [
            [tuple(map(float, c.split(",")[:2])) for c in ring.split()]
            for ring in re.findall(
                r"<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", poly
            )
        ]
        try:
            out.append(Polygon(ext, ins).buffer(0))
        except Exception:
            pass
    for ring in re.findall(
        r"<LineString>[\s\S]*?<coordinates>([\s\S]*?)</coordinates>", pm
    ):
        pts = [tuple(map(float, c.split(",")[:2])) for c in ring.split()]
        if len(pts) > 3 and pts[0] == pts[-1]:
            try:
                out.append(Polygon(pts).buffer(0))
            except Exception:
                pass
    return [p for p in out if not p.is_empty]


# ── OSM ──────────────────────────────────────────────────────────────────────
def overpass(query, cache_name):
    """Query the self-hosted Overpass, caching so re-runs are deterministic."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path):
        return json.load(open(path))
    import urllib.parse
    import urllib.request

    req = urllib.request.Request(
        OVERPASS, data=urllib.parse.urlencode({"data": query}).encode()
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    json.dump(data, open(path, "w"))
    return data


BBOX = "50.78,-0.28,50.90,-0.01"


def coastline_chain():
    d = overpass(
        f"[out:json][timeout:120];way[natural=coastline]({BBOX});out geom;",
        "coastline.json",
    )
    segs = [
        LineString([(n["lon"], n["lat"]) for n in w["geometry"]])
        for w in d["elements"]
        if w.get("geometry")
    ]
    merged = linemerge(unary_union(segs))
    parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    chain = max(parts, key=lambda l: l.length)
    coords = list(chain.coords)
    if coords[0][0] > coords[-1][0]:  # orient west -> east
        coords = coords[::-1]
    return LineString(coords)


def walkable_mask(coast):
    """OSM land, plus walkable structures seaward of the coastline."""
    coords = list(coast.coords)
    land = Polygon(
        coords + [(0.04, 50.95), (-0.32, 50.95), (coords[0][0], coords[0][1])]
    ).buffer(0)

    d = overpass(
        f"""[out:json][timeout:120];
(
  way["man_made"~"^(pier|breakwater|groyne|jetty)$"]({BBOX});
  way["leisure"="marina"]({BBOX});
  way["highway"]["area"="yes"]({BBOX});
);
out geom;""",
        "walkable.json",
    )
    extra, excluded = [], []
    for e in d["elements"]:
        tags, geom = e.get("tags", {}), e.get("geometry")
        if not geom or len(geom) < 4:
            continue
        name = tags.get("name") or "(unnamed)"
        if tags.get("access") == "no" or "ruins" in tags:
            excluded.append((name, "ruins / no access"))
            continue
        if tags.get("leisure") == "marina":
            excluded.append((name, "harbour water, not ground"))
            continue
        if not (
            tags.get("man_made") in ("pier", "breakwater", "jetty")
            or (tags.get("highway") and tags.get("area") == "yes")
        ):
            continue
        pts = [(n["lon"], n["lat"]) for n in geom]
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        try:
            p = Polygon(pts).buffer(0)
            if p.area > 0:
                extra.append(p)
        except Exception:
            pass
    return unary_union([land] + extra).buffer(0), extra, excluded


# ── writers ──────────────────────────────────────────────────────────────────
def coord(lon, lat):
    """
    KML "lon,lat,0" at a fixed 6 decimal places (~0.11 m).

    NOT "{:g}": that is 6 SIGNIFICANT digits, so at Brighton's latitude
    (50.8xxx) it keeps only 4 decimals — an 11 m quantisation — while longitude
    at -0.13x keeps 7, because leading zeros are not significant. The result is
    a boundary that staircases vertically and runs smooth horizontally, and
    every station and POI displaced by up to 5.6 m.
    """
    return f"{float(lon):.6f},{float(lat):.6f},0"


def fc(features):
    return json.dumps(
        {"type": "FeatureCollection", "features": features}, separators=(",", ":")
    ) + "\n"


def feature(geom, props):
    g = (
        orient(geom, 1.0)
        if geom.geom_type == "Polygon"
        else MultiPolygon([orient(p, 1.0) for p in geom.geoms])
        if geom.geom_type == "MultiPolygon"
        else geom
    )
    return {"type": "Feature", "properties": props, "geometry": mapping(g)}


def write(name, body, out_dir=PUBLIC):
    path = os.path.join(out_dir, name) if out_dir else name
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"wrote {os.path.basename(path):28s} {len(body.encode('utf-8')):>9,d} b")


def main():
    doc = load_doc()

    # ---- game area, stops, zones -------------------------------------------
    ga = folder(doc, "Game Area")
    game = Polygon(
        first_coords([p for p in placemarks(ga) if "<Polygon" in p][0])
    ).buffer(0)

    stops, unnamed = [], 0
    for pm in placemarks(folder(doc, "Stops")):
        c = first_coords(pm)
        if not c:
            continue
        n = pm_name(pm)
        if not n:
            unnamed += 1
            n = f"Stop {unnamed}"
        stops.append((n, c[0]))
    if len(stops) != 132:
        sys.exit(f"expected 132 stops, got {len(stops)}")

    zones = []
    for pm in placemarks(folder(doc, "Hiding Zones")):
        c = first_coords(pm)
        if c and len(c) > 3:
            zones.append(Polygon(c).buffer(0))
    if len(zones) != 132:
        sys.exit(f"expected 132 hiding zones, got {len(zones)}")

    def nearest_stop(g):
        return min(stops, key=lambda s: Point(s[1]).distance(g.centroid))[0]

    # ---- expand the play area ----------------------------------------------
    coast = coastline_chain()
    walk, extra, excluded = walkable_mask(coast)
    print(f"walkable: OSM land + {len(extra)} structures")
    for n, why in sorted(set(excluded)):
        print(f"  excluded {n} — {why}")

    adds = []
    for z in zones:
        gained = z.difference(game).intersection(walk)
        if geo_area(gained) > 1:
            adds.append((nearest_stop(z), gained))
    new_area = unary_union([game] + [g for _, g in adds]).buffer(0)
    # Drop pinhole interior rings the union leaves behind (one 0.3 m² artifact).
    if new_area.geom_type == "Polygon" and new_area.interiors:
        keep = [r for r in new_area.interiors if geo_area(Polygon(r)) > 10]
        new_area = Polygon(new_area.exterior, keep)
    if new_area.geom_type != "Polygon":
        sys.exit(f"expanded area is {new_area.geom_type}, expected a single Polygon")
    lost = geo_area(game.difference(new_area))
    if lost > 1:
        sys.exit(f"expansion removed {lost:.0f} m² — it must be additive only")
    left = [
        nearest_stop(z)
        for z in zones
        if geo_area(z.difference(new_area).intersection(walk)) > 50
    ]
    if left:
        sys.exit(f"zones still cut off on walkable ground: {left}")
    print(
        f"\nplay area {geo_area(game) / 1e6:.4f} -> {geo_area(new_area) / 1e6:.4f} km² "
        f"(+{(geo_area(new_area) - geo_area(game)):,.0f} m², +"
        f"{100 * (geo_area(new_area) - geo_area(game)) / geo_area(game):.3f}%), nothing removed"
    )
    for n, g in sorted(adds, key=lambda x: -x[1].area):
        print(f"   +{geo_area(g):9,.0f} m²  {n}")

    # ---- admin layers, each with an Outer -----------------------------------
    def admin_layer(folder_name, name_re, expect):
        feats, dropped = [], []
        for pm in placemarks(folder(doc, folder_name)):
            polys = [p for p in pm_polygons(pm) if geo_area(p) > 1]
            m = re.search(name_re, pm)
            nm = html.unescape(m.group(1).strip()) if m else "?"
            if not polys:
                dropped.append(nm)
                continue
            g = unary_union(polys).buffer(0).intersection(new_area)
            if g.is_empty or geo_area(g) < 1:
                dropped.append(nm)
                continue
            feats.append((nm, g))
        if len(feats) != expect:
            sys.exit(f"{folder_name}: expected {expect} in-area features, got {len(feats)}")
        covered = unary_union([g for _, g in feats]).buffer(0)
        outer = new_area.difference(covered).buffer(0)
        # Drop hairline slivers left by the clip; keep anything a player could stand in.
        keep = [
            p
            for p in (list(outer.geoms) if outer.geom_type == "MultiPolygon" else [outer])
            if geo_area(p) > 20
        ]
        outer = unary_union(keep).buffer(0) if keep else None
        print(f"\n{folder_name}: {len(feats)} regions, dropped {len(dropped)}")
        if outer is not None and not outer.is_empty:
            n_parts = len(outer.geoms) if outer.geom_type == "MultiPolygon" else 1
            print(
                f"  Outer: {geo_area(outer):,.0f} m² "
                f"({100 * geo_area(outer) / geo_area(new_area):.3f}% of play area, {n_parts} parts)"
            )
            feats.append(("Outer", outer))
        return feats

    wards = admin_layer("Wards", r"WD26NM:\s*([^<]*)<", 24)
    postcodes = admin_layer("Postcodes", r"<name>([^<]*)</name>", 8)

    for label, feats in (("wards", wards), ("postcodes", postcodes)):
        u = unary_union([g for _, g in feats]).buffer(0)
        sym = new_area.symmetric_difference(u).area / new_area.area
        if sym > 0.0005:
            sys.exit(f"{label} do not tile the play area: {100 * sym:.4f}% differ")
        for i in range(len(feats)):
            for j in range(i + 1, len(feats)):
                ov = geo_area(feats[i][1].intersection(feats[j][1]))
                if ov > 5:
                    sys.exit(
                        f"{label} overlap: {feats[i][0]} / {feats[j][0]} = {ov:.0f} m²"
                    )
        homeless = [
            n for n, c in stops if not any(g.contains(Point(c)) for _, g in feats)
        ]
        print(f"  {label}: tiles play area, no overlaps, "
              f"{len(stops) - len(homeless)}/{len(stops)} stops placed")
        if homeless:
            print(f"    unplaced: {homeless}")

    # ---- coastline ----------------------------------------------------------
    a = coast.project(Point(*COAST_END_W))
    b = coast.project(Point(*COAST_END_E))
    lo, hi = sorted((a, b))
    pts = [
        p
        for p in coast.coords
        if lo <= coast.project(Point(p)) <= hi
    ]
    coast_seg = LineString(pts)
    print(f"\ncoastline: {geo_len(coast_seg) / 1000:.2f} km, {len(pts)} nodes")

    # ---- write --------------------------------------------------------------
    st = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
          "<name>Brighton Stations</name>"]
    for n, c in sorted(stops):
        st.append(
            f"<Placemark><name>{html.escape(n)}</name>"
            f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>"
        )
    st.append("</Document></kml>")
    write("brighton-stations.kml", "\n".join(st) + "\n")

    by_cat, fallback = {}, {}
    for pm in placemarks(folder(doc, "POIs")):
        c = first_coords(pm)
        s = re.search(r"<styleUrl>([^<]*)</styleUrl>", pm)
        if not c or not s:
            continue
        if s.group(1) not in POI_STYLES:
            sys.exit(f"unmapped POI style {s.group(1)!r}")
        cat, label = POI_STYLES[s.group(1)]
        n = pm_name(pm)
        if not n:
            fallback[cat] = fallback.get(cat, 0) + 1
            n = f"{label} {fallback[cat]}"
        by_cat.setdefault(cat, []).append((n, c[0]))
    poi = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
           "<name>Brighton POIs</name>"]
    for cat in sorted(by_cat):
        poi.append(f"<Folder><name>{cat}</name>")
        for n, c in sorted(by_cat[cat]):
            poi.append(
                f"<Placemark><name>{html.escape(n)}</name>"
                f"<Point><coordinates>{coord(*c)}</coordinates></Point></Placemark>"
            )
        poi.append("</Folder>")
    poi.append("</Document></kml>")
    write("brighton-poi.kml", "\n".join(poi) + "\n")

    write("brighton-border.geojson",
          fc([feature(new_area, {"name": "Brighton 29-08 play area"})]))
    write("brighton-wards.geojson",
          fc([feature(g, {"name": n}) for n, g in sorted(wards)]))
    write("brighton-postcodes.geojson",
          fc([feature(g, {"name": n}) for n, g in sorted(postcodes)]))
    write("brighton-coastline.geojson",
          fc([feature(coast_seg, {"name": "Brighton coastline"})]))

    # The standalone play-area KML, as LineStrings rather than a Polygon: a
    # filled polygon in My Maps swallows clicks on everything inside it.
    ring = list(new_area.exterior.coords)
    kml = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
           "<name>Brighton 29-08 Game Area</name>",
           "<Style id=\"ga\"><LineStyle><color>ff0000ff</color><width>3</width>"
           "</LineStyle></Style>",
           "<Placemark><name>Game Area</name><styleUrl>#ga</styleUrl>",
           "<LineString><tessellate>1</tessellate><coordinates>",
           " ".join(coord(x, y) for x, y in ring),
           "</coordinates></LineString></Placemark>"]
    for i, hole in enumerate(new_area.interiors, 1):
        kml += [f"<Placemark><name>Hole {i}</name><styleUrl>#ga</styleUrl>",
                "<LineString><tessellate>1</tessellate><coordinates>",
                " ".join(coord(x, y) for x, y in hole.coords),
                "</coordinates></LineString></Placemark>"]
    kml.append("</Document></kml>")
    write(os.path.basename(GAME_AREA_KML_OUT), "\n".join(kml) + "\n",
          os.path.dirname(GAME_AREA_KML_OUT))
    print(f"  ({len(ring)} vertices, {len(new_area.interiors)} holes, "
          f"LineString not Polygon so My Maps stays clickable)")

    print("\nPOIs:")
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        print(f"  {len(by_cat[cat]):4d}  {cat}")


if __name__ == "__main__":
    main()
