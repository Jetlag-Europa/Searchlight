#!/usr/bin/env python3
"""Generate London 02-08 bundled assets into apps/web/public/.

Reads the single source KMZ (London_02_08_26.kmz, not vendored) and produces:
  london-stations.kml   (271 hiding-zone stations, uniform 400 m, no tier)
  london-poi.kml        (POIs, one <Folder> per category incl. custom
                         "stadium" and "rail_terminus")
  london-border.geojson (the Game Area circle: r=14.5 km around Charing Cross)
  london-boroughs.geojson      (27 borough polygons, for "Same Borough")
  london-borough-lines.geojson (their shared border network, deduped, for
                                "Distance to Borough Boundary")

Source layout (doc.kml inside the KMZ), 8 folders:
  Borough                          27 LineStrings  -- NAMES used, geometry not
                                   (see gen_boroughs below)
  HSR Line and Waterway (Landmass) 23 LineStrings  -- IGNORED (per Jules)
  Game Area and Hiding Zone       371 LineStrings  -- only the one placemark
                                   with <Data name="allowed">Game Area</Data>
                                   is used; the other 370 are the per-station
                                   400 m circles, which the app draws itself.
  Station                         370 Points       -- filtered, see below
  Cinema and Library              336 Points  \\
  Museum                          176 Points   |  category lives in
  Hospital                         39 Points   |  <description>, not <Data>
  Zoo, Aquarium, Golf Course,      51 Points  /
    Stadium, Rail Terminus

Two source quirks worth knowing:

1. The mixed POI folders ("Cinema and Library", "Zoo, Aquarium, ...") carry
   the real category as a bare word in <description> -- a Google-Earth export
   habit, same as Budapest's "Other Features". Splitting on it is exact: every
   placemark classifies, none fall through.

2. Stations carry BOTH a "category" and an "allowed" field and they disagree
   on exactly one row: Streatham Common is allowed=Yes but
   category="Not Allowed" (notes: "Due to low train frequency"). The hiding
   zone circle layer is 271 Game-Area-allowed / 99 not, which matches
   `category`, so `category` is the field we filter on. Streatham Common is
   excluded. STATION_EXPECTED asserts the count so a source update that
   changes this is loud rather than silent.

The rail termini go in a folder named "rail_terminus", deliberately NOT
"train_station": gamePOIData["train_station"] is the override consulted by the
generic same-train-line / same-length-station questions (matching.ts), and
pointing those at 14 termini instead of all London rail would silently break
them. "rail_terminus" is picked up as a custom category for the London-only
london-rail question instead.
"""
import json
import math
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

SRC_KMZ = "/Users/juleswitold/Dev/WriteMap-Dev/London_02_08_26.kmz"
OUT = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

KML_NS = "http://www.opengis.net/kml/2.2"
NS = {"k": KML_NS}

# <description> word -> canonical folder/category name. Every value except
# stadium / rail_terminus is one of the 13 rulebook POI_CATEGORIES.
POI_DESCRIPTIONS = {
    "Cinema": "cinema",
    "Library": "library",
    "Museum": "museum",
    "Hospital": "hospital",
    "Zoo": "zoo",
    "Aquarium": "aquarium",
    "Golf Course": "golf_course",
    "Stadium": "stadium",              # custom -> london-stadium
    "Rail Terminus": "rail_terminus",  # custom -> london-rail
}
POI_FOLDERS = [
    "Cinema and Library",
    "Museum",
    "Hospital",
    "Zoo, Aquarium, Golf Course, Stadium, Rail Terminus",
]
# Emission order for london-poi.kml (canonical categories first).
POI_ORDER = [
    "airport", "zoo", "aquarium", "golf_course", "museum", "cinema",
    "hospital", "library", "consulate", "park", "theme_park", "mountain",
    "rail", "stadium", "rail_terminus",
]

STATION_EXPECTED = 271
POI_EXPECTED = {
    "cinema": 111, "library": 225, "museum": 176, "hospital": 39,
    "zoo": 3, "aquarium": 2, "golf_course": 20,
    "stadium": 12, "rail_terminus": 14,
}


def xml_escape(s):
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def load_doc():
    with zipfile.ZipFile(SRC_KMZ) as z:
        return ET.fromstring(z.read("doc.kml"))


def folders(root):
    """{folder name: element} for every <Folder> in the document."""
    out = {}
    for f in root.iter(f"{{{KML_NS}}}Folder"):
        out[f.findtext("k:name", default="", namespaces=NS)] = f
    return out


def data_of(pm):
    """<ExtendedData><Data name=X><value>Y -> {X: Y}."""
    return {
        d.get("name"): (d.findtext("k:value", default="", namespaces=NS) or "").strip()
        for d in pm.findall(".//k:Data", NS)
    }


def point_of(pm):
    c = pm.findtext(".//k:Point/k:coordinates", default="", namespaces=NS)
    if not c.strip():
        return None
    lng, lat = c.strip().split()[0].split(",")[:2]
    return float(lng), float(lat)


def name_of(pm):
    return (pm.findtext("k:name", default="", namespaces=NS) or "").strip()


def placemark(name, lng, lat):
    return (
        "    <Placemark>\n"
        f"      <name>{xml_escape(name)}</name>\n"
        f"      <Point><coordinates>{lng},{lat},0</coordinates></Point>\n"
        "    </Placemark>"
    )


# ---------------------------------------------------------------- stations
def gen_stations(root):
    """The 370 Station points minus the 99 category='Not Allowed'."""
    rows, skipped = [], []
    for pm in folders(root)["Station"].findall("k:Placemark", NS):
        d = data_of(pm)
        pt = point_of(pm)
        if pt is None:
            continue
        if d.get("category") == "Not Allowed":
            skipped.append(name_of(pm))
            continue
        rows.append((name_of(pm), pt[0], pt[1]))

    assert len(rows) == STATION_EXPECTED, (
        f"expected {STATION_EXPECTED} allowed stations, got {len(rows)} "
        f"({len(skipped)} excluded) -- source changed, re-check before shipping"
    )
    # Cross-check against the drawn hiding-zone circles: both layers key on the
    # same placemark names, so a disagreement means the source is inconsistent.
    circles = {
        name_of(pm)
        for pm in folders(root)["Game Area and Hiding Zone"].findall("k:Placemark", NS)
        if data_of(pm).get("allowed") == "Yes"
    }
    names = {r[0] for r in rows}
    assert names == circles, (
        "station filter disagrees with the hiding-zone circle layer: "
        f"only in stations {sorted(names - circles)}, "
        f"only in circles {sorted(circles - names)}"
    )

    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<kml xmlns="{KML_NS}">\n  <Document>\n'
        "    <name>London 02-08 Stations</name>\n"
        + "\n".join(placemark(n, lng, lat) for n, lng, lat in rows)
        + "\n  </Document>\n</kml>\n"
    )
    open(f"{OUT}/london-stations.kml", "w", encoding="utf-8").write(out)
    print(f"stations: {len(rows)} placemarks ({len(skipped)} 'Not Allowed' excluded)")


# ---------------------------------------------------------------- POIs
def gen_poi(root):
    F = folders(root)
    by_cat = {}
    unclassified = []
    for fname in POI_FOLDERS:
        for pm in F[fname].findall("k:Placemark", NS):
            pt = point_of(pm)
            if pt is None:
                continue
            desc = (pm.findtext("k:description", default="", namespaces=NS) or "").strip()
            cat = POI_DESCRIPTIONS.get(desc)
            if cat is None:
                unclassified.append((fname, name_of(pm), desc))
                continue
            by_cat.setdefault(cat, []).append((name_of(pm), pt[0], pt[1]))

    assert not unclassified, f"unclassified POI descriptions: {unclassified[:10]}"
    got = {k: len(v) for k, v in by_cat.items()}
    assert got == POI_EXPECTED, f"POI counts changed: {got} != {POI_EXPECTED}"

    blocks = []
    for cat in POI_ORDER:
        rows = by_cat.get(cat)
        if not rows:
            continue
        inner = "\n".join(placemark(n, lng, lat) for n, lng, lat in rows)
        blocks.append(f"  <Folder>\n    <name>{cat}</name>\n{inner}\n  </Folder>")

    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<kml xmlns="{KML_NS}">\n  <Document>\n'
        "    <name>London 02-08 POIs</name>\n"
        + "\n".join(blocks)
        + "\n  </Document>\n</kml>\n"
    )
    open(f"{OUT}/london-poi.kml", "w", encoding="utf-8").write(out)
    total = sum(got.values())
    print("poi: " + ", ".join(f"{c}:{got[c]}" for c in POI_ORDER if c in got)
          + f" (total {total})")


# ---------------------------------------------------------------- boundary
def signed_area(ring):
    """Shoelace on lng/lat; positive == counter-clockwise (RFC 7946)."""
    return sum(
        (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1])
        for i in range(len(ring) - 1)
    ) / 2.0


def gen_border(root):
    """The one 'Game Area' placemark -- a 360-vertex circle, r = 14.5 km."""
    ga = folders(root)["Game Area and Hiding Zone"]
    matches = [
        pm for pm in ga.findall("k:Placemark", NS)
        if data_of(pm).get("allowed") == "Game Area"
    ]
    assert len(matches) == 1, f"expected 1 Game Area placemark, got {len(matches)}"
    coords_text = matches[0].findtext(".//k:coordinates", default="", namespaces=NS)
    ring = [
        (float(p.split(",")[0]), float(p.split(",")[1]))
        for p in coords_text.split()
    ]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    # RFC 7946: exterior ring counter-clockwise. The KML export is clockwise.
    if signed_area(ring) < 0:
        ring.reverse()

    # Report the circle fit so a source change is visible in the run log.
    pts = ring[:-1]
    clng = sum(p[0] for p in pts) / len(pts)
    clat = sum(p[1] for p in pts) / len(pts)
    d = [
        math.hypot(
            (p[0] - clng) * 111.32 * math.cos(math.radians(clat)),
            (p[1] - clat) * 111.32,
        )
        for p in pts
    ]

    # MUST be a FeatureCollection, not a bare Feature: the client sets
    # polyGeoJSON from this and reads .features[...]; a bare Feature throws on
    # the custom-boundary path and the error is swallowed silently, so boundary
    # questions just stop eliminating zones. See docs/ADDING_GAMES.md.
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "London 02-08 Game Area"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring]],
            },
        }],
    }
    with open(f"{OUT}/london-border.geojson", "w", encoding="utf-8") as fh:
        json.dump(fc, fh)
        fh.write("\n")
    print(
        f"border: {len(pts)} vertices, centre {clat:.5f},{clng:.5f}, "
        f"radius {min(d):.3f}-{max(d):.3f} km, CCW"
    )
    lngs = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    print(
        f"        extent [N,W,S,E] = [{max(lats)}, {min(lngs)}, "
        f"{min(lats)}, {max(lngs)}]"
    )


# ---------------------------------------------------------------- boroughs
# The KMZ's own Borough geometry is NOT used. 12 of its 27 rings are capped at
# exactly 201 vertices -- the same resampling signature that put 62 km2 of gaps
# and 38 km2 of overlaps into Belgium's arrondissements (Entry 44). Here it is
# milder (0.31 km2 of pairwise overlap, 1.58 km2 of interior slivers) but OSM
# carries the same 27 divisions at full resolution and gap-free, so we pull
# those and keep only the KMZ's *names*.
#
# That name list is the author's trim and it is correct: of the 6 Greater
# London boroughs it omits, Bexley / Havering / Hillingdon fall entirely
# outside the play circle, and Kingston upon Thames / Sutton / Harrow clip it
# (5.18 / 4.77 / 0.71 km2) but contain no hiding zone at all -- the nearest
# station to any of them is 2.7-3.4 km away, against a 400 m radius.
#
# City of London is admin_level 6, not 8 (it is sui generis), so it needs an
# explicit relation id or it goes silently missing.
LONDON_BBOX = "51.28,-0.52,51.70,0.34"
CITY_OF_LONDON_RELATION = 51800
OVERPASS_URL = "http://localhost:12345/api/interpreter"

# Polygons: ~3.5 m. Verified not to move any of the 271 stations into a
# different borough (the closest sits 3 m from a boundary, so this is checked,
# not assumed -- see the assertion below).
BOROUGH_SIMPLIFY = 0.00005
# Border lines: ~35 m, far below anything a distance band resolves.
BOROUGH_LINE_SIMPLIFY = 0.0005


def _osm_short_name(name):
    """'London Borough of Camden' -> 'Camden'; City of London keeps its name."""
    if name == "City of London":
        return name
    return re.sub(r"^(London Borough of |Royal Borough of |City of )", "", name)


def gen_boroughs(root):
    import urllib.parse
    import urllib.request

    from shapely.geometry import Point, mapping
    from shapely.geometry.polygon import orient
    from shapely.ops import linemerge, polygonize, transform, unary_union

    # Local equirectangular metres about London, for the area assertions below.
    kx = 111320 * math.cos(math.radians(51.5))
    km2 = lambda g: transform(lambda x, y, z=None: (x * kx, y * 110570), g).area / 1e6

    wanted = {
        name_of(pm)
        for pm in folders(root)["Borough"].findall("k:Placemark", NS)
    }
    query = (
        f"[out:json][timeout:120];("
        f'rel["boundary"="administrative"]["admin_level"="8"]({LONDON_BBOX});'
        f"rel({CITY_OF_LONDON_RELATION});"
        f");out geom;"
    )
    req = urllib.request.Request(
        OVERPASS_URL, data=urllib.parse.urlencode({"data": query}).encode()
    )
    with urllib.request.urlopen(req, timeout=240) as fh:
        elements = json.load(fh)["elements"]

    geo = {}
    for e in elements:
        rings = [
            [(p["lon"], p["lat"]) for p in m["geometry"]]
            for m in e.get("members", [])
            if m.get("type") == "way" and m.get("role") in ("outer", "") and "geometry" in m
        ]
        if not rings:
            continue
        polys = list(polygonize(linemerge(rings)))
        if not polys:
            continue
        short = _osm_short_name(e.get("tags", {}).get("name", "?"))
        if short in wanted:
            geo[short] = unary_union(polys)

    assert set(geo) == wanted, (
        f"OSM did not supply every KMZ borough: missing {sorted(wanted - set(geo))}, "
        f"unexpected {sorted(set(geo) - wanted)}"
    )

    # Simplifying each borough on its own re-tears the tiling: a shared border
    # is two separate rings, Douglas-Peucker thins them differently, and the
    # pair no longer coincides (measured: slivers up to ~2,000 m2). So simplify
    # the border NETWORK once -- union the boundaries so every shared border is
    # a single arc, linemerge (without it unary_union's two-point segments are
    # untouchable by DP), simplify, re-polygonize -- then hand each resulting
    # face back to the borough whose original polygon contains it. Every face
    # belongs to exactly one borough, so the result tiles exactly.
    faces = list(polygonize(linemerge(unary_union([g.boundary for g in geo.values()])).simplify(BOROUGH_SIMPLIFY)))
    assigned = {n: [] for n in geo}
    orphans = []
    for face in faces:
        pt = face.representative_point()
        owner = next((n for n, g in geo.items() if g.contains(pt)), None)
        if owner is None:
            orphans.append(face)
            continue
        assigned[owner].append(face)
    # Orphan faces are holes between boroughs that exist in the source data
    # (the Thames is not one -- boroughs meet mid-river). Keep the guard tight.
    orphan_area = sum(km2(f) for f in orphans)
    assert orphan_area < 0.5, (
        f"{len(orphans)} face(s) totalling {orphan_area:.3f} km2 belong to no "
        "borough -- the network simplification tore the tiling"
    )
    simplified = {n: unary_union(polys) for n, polys in assigned.items() if polys}
    assert set(simplified) == wanted, (
        f"boroughs lost during face assignment: {sorted(wanted - set(simplified))}"
    )

    # Simplifying can in principle drag a boundary across a station that sits
    # almost on it (the closest is 3 m away), which would silently answer
    # "Same Borough" wrong. Assert it does not.
    stations = [
        (name_of(pm), Point(*point_of(pm)))
        for pm in folders(root)["Station"].findall("k:Placemark", NS)
        if point_of(pm) and data_of(pm).get("category") != "Not Allowed"
    ]
    for st_name, pt in stations:
        before = [n for n, g in geo.items() if g.covers(pt)]
        after = [n for n, g in simplified.items() if g.covers(pt)]
        assert len(after) == 1 and before == after, (
            f"simplification moved {st_name}: {before} -> {after}"
        )

    features = [
        {
            "type": "Feature",
            "properties": {"name": n},
            "geometry": mapping(orient(simplified[n], 1.0)),  # CCW, RFC 7946
        }
        for n in sorted(simplified)
    ]
    with open(f"{OUT}/london-boroughs.geojson", "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh)
        fh.write("\n")
    print(f"boroughs: {len(features)} polygons")

    # Measuring wants the border NETWORK, not 27 separate rings: every internal
    # boundary is shared by two boroughs, so ring-per-borough would buffer each
    # shared line twice. unary_union nodes them into two-point segments, which
    # Douglas-Peucker cannot thin (it always keeps each segment's endpoints), so
    # linemerge back into real arcs FIRST -- the Entry 44 lesson.
    merged = linemerge(unary_union([g.boundary for g in geo.values()]))
    arcs = list(merged.geoms) if merged.geom_type != "LineString" else [merged]
    raw_verts = sum(len(a.coords) for a in arcs)
    thinned = merged.simplify(BOROUGH_LINE_SIMPLIFY)
    thin_arcs = list(thinned.geoms) if thinned.geom_type != "LineString" else [thinned]
    line_features = [
        {"type": "Feature", "properties": {}, "geometry": mapping(a)}
        for a in thin_arcs
    ]
    with open(f"{OUT}/london-borough-lines.geojson", "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": line_features}, fh)
        fh.write("\n")
    print(
        f"borough lines: {len(thin_arcs)} arcs, "
        f"{sum(len(a.coords) for a in thin_arcs)} verts (from {raw_verts})"
    )


def main():
    root = load_doc()
    gen_stations(root)
    gen_poi(root)
    gen_border(root)
    gen_boroughs(root)


if __name__ == "__main__":
    sys.exit(main())
