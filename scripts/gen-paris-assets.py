#!/usr/bin/env python3
"""Generate the Paris 15-08 bundled assets into apps/web/public/.

Sources (not vendored) live in `WriteMap-Dev/Final Paris Map 16-08/` as eight
KMZs, each a single-folder layer whose placemarks all carry structured
ExtendedData. This is the cleanest source any bundled game has had: nothing is
sniffed out of <description>, no style parsing, no category guessing.

  Paris v0.1 - 1 Map Outline.kmz        1 LineString  the play-area rectangle
  Paris v0.1 - 2 Hiding Zones.kmz     412 LineStrings drawn circles + radius_m
  Paris v0.1 - 3 Stations.kmz         412 Points      mode + zone
  Paris v0.1 - 4 Culture Learning.kmz    1106 Points  library/museum/cinema
  Paris v0.1 - 5 Heritage Recreation.kmz  526 Points  park/golf/theme/zoo/aq.
  Paris v0.1 - 6 Civic International.kmz  160 Points  hospital/consulate
  Paris v0.1 - 7 Airports.kmz             2 Points    airport
  Paris Arrondissements v0.1.kmz         21 Polygons  20 + an "Outer" catch-all

Produces:
  paris-stations.kml          412 hiding zones, <Data name="tier"> = Inner|Outer
  paris-poi.kml             1,794 POIs, one <Folder> per canonical category
  paris-arrondissements.geojson  21 polygons, for the paris-arrondissement
                              matching + measuring questions
  paris-border.geojson        the play-area rectangle from the Map Outline layer

This REPLACES the previous Paris 2026 assets in place, under the same sentinel
`__bundled-paris-2026__` (Jules' call). The 412 stations are unchanged — same
names, same inner/outer split, same radii — so existing sessions keep their
strokes and questions. What is new is the POI file (the old game shipped none,
so every POI question fell through to Overpass) and the arrondissements. The
boundary DOES change: the old asset was a 12-vertex polygon of 1,556 km², this
is the author's 2,115 km² rectangle.

Why "Inner"/"Outer" and not the source's lowercase "inner"/"outer": the tier
values are matched against `tierRadiusOverrides` in the manifest, which already
reads `{ Outer: 600 }`. Keeping the capitalisation means the already-seeded prod
Game row stays correct even before `seed:prod` runs. The source's orthogonal
`mode` (metro/rail) is carried through as extra ExtendedData for readability —
the importer only regexes out `tier` and ignores the rest — but nothing reads it:
the radius depends on `zone` alone.

Coord order in the KML is "lng,lat" (WGS84).
"""
import json
import zipfile
import xml.etree.ElementTree as ET

from shapely.geometry import MultiPolygon, Point, Polygon, shape, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SRC = "/Users/juleswitold/Dev/WriteMap-Dev/Final Paris Map 16-08"
OUT = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

KML_NS = "http://www.opengis.net/kml/2.2"
NS = {"k": KML_NS}

OUTLINE_KMZ = f"{SRC}/Paris v0.1 - 1 Map Outline.kmz"
ZONES_KMZ = f"{SRC}/Paris v0.1 - 2 Hiding Zones.kmz"
STATIONS_KMZ = f"{SRC}/Paris v0.1 - 3 Stations.kmz"
ARRONDISSEMENTS_KMZ = f"{SRC}/Paris Arrondissements v0.1.kmz"
POI_KMZS = [
    f"{SRC}/Paris v0.1 - 4 Culture Learning.kmz",
    f"{SRC}/Paris v0.1 - 5 Heritage Recreation.kmz",
    f"{SRC}/Paris v0.1 - 6 Civic International.kmz",
    f"{SRC}/Paris v0.1 - 7 Airports.kmz",
]

# Every source category is already one of POI_CATEGORIES
# (packages/shared/src/games.ts), so this map is an identity check rather than a
# rename table — assert membership instead of translating.
CANONICAL = {
    "airport", "zoo", "aquarium", "golf_course", "museum", "cinema",
    "hospital", "library", "consulate", "park", "theme_park", "mountain",
    "rail",
}

# The radius each zone band gets, and the tier string written into the KML.
ZONE_TIERS = {"inner": ("Inner", 400), "outer": ("Outer", 600)}

# Asserted after parsing, so a revised source that adds or drops features fails
# loudly instead of silently shipping a different game.
EXPECTED_ZONES = {"inner": 226, "outer": 186}
EXPECTED_MODES = {"metro": 231, "rail": 181}
EXPECTED_POIS = {
    "library": 577, "museum": 295, "cinema": 234, "park": 455,
    "golf_course": 37, "theme_park": 17, "zoo": 14, "aquarium": 3,
    "hospital": 119, "consulate": 41, "airport": 2,
}
EXPECTED_ARRONDISSEMENTS = 21  # 20 real + the "Outer" catch-all
OUTER_NAME = "Outer"


def rnd(x, n=6):
    return round(x, n)


def rnd_geom(geom):
    """mapping() with coordinates rounded to ~10 cm, to keep the assets small.

    Rounding can collapse two near-identical vertices onto each other, and a
    zero-length segment makes turf's pointToLineDistance throw ("coordinates
    must contain numbers") — which is how the measuring question consumes these
    rings. So consecutive duplicates are dropped, ring closure preserved.
    (Copied from gen-graz-assets.py, where it was learned the hard way.)
    """
    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [rnd(c[0]), rnd(c[1])]
        out = [walk(x) for x in c]
        if out and isinstance(out[0], list) and out[0] and isinstance(out[0][0], float):
            deduped = [out[0]]
            for pt in out[1:]:
                if pt != deduped[-1]:
                    deduped.append(pt)
            if len(deduped) >= 3 and out[0] == out[-1] and deduped[0] != deduped[-1]:
                deduped.append(deduped[0])
            return deduped
        return out

    g = mapping(geom)
    g["coordinates"] = walk(g["coordinates"])
    return g


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def ccw(geom):
    if geom.geom_type == "Polygon":
        return orient(geom, sign=1.0)
    return MultiPolygon([orient(p, sign=1.0) for p in geom.geoms])


# ------------------------------------------------------------------ sources
def read_kmz(path):
    """Every placemark in a layer KMZ, as (name, data dict, element)."""
    root = ET.fromstring(zipfile.ZipFile(path).read("doc.kml"))
    out = []
    for pm in root.findall(".//k:Placemark", NS):
        name_el = pm.find("k:name", NS)
        name = name_el.text.strip() if name_el is not None and name_el.text else ""
        data = {}
        for d in pm.findall(".//k:Data", NS):
            v = d.find("k:value", NS)
            data[d.get("name")] = v.text if v is not None else None
        out.append((name, data, pm))
    return out


def coords_of(el, path):
    txt = el.find(path, NS).text
    return [tuple(float(v) for v in tok.split(",")[:2]) for tok in txt.split()]


def polygon_from_kml(poly_el):
    outer = coords_of(poly_el, "k:outerBoundaryIs/k:LinearRing/k:coordinates")
    inners = [
        coords_of(e, "k:LinearRing/k:coordinates")
        for e in poly_el.findall("k:innerBoundaryIs", NS)
    ]
    p = Polygon(outer, inners)
    return p if p.is_valid else p.buffer(0)


# ------------------------------------------------------------------ outputs
def gen_stations():
    """The station layer, cross-checked against the drawn hiding-zone circles.

    Two independent layers describe the same 412 zones: the Station points and
    the Hiding Zone circles (which carry center_latitude/center_longitude and
    radius_m). London's source contradicted itself across exactly this pair
    (Entry 48), so the agreement is asserted, not assumed.
    """
    stations = []
    for name, d, pm in read_kmz(STATIONS_KMZ):
        lng, lat = coords_of(pm, ".//k:Point/k:coordinates")[0]
        stations.append({
            "name": name, "lat": lat, "lng": lng,
            "zone": d["zone"], "mode": d["mode"],
        })

    zones = {}
    for name, d, pm in read_kmz(ZONES_KMZ):
        zones[name] = {
            "lat": float(d["center_latitude"]),
            "lng": float(d["center_longitude"]),
            "radius": int(float(d["radius_m"])),
            "zone": d["zone"], "mode": d["mode"],
        }

    counts = {}
    modes = {}
    for s in stations:
        counts[s["zone"]] = counts.get(s["zone"], 0) + 1
        modes[s["mode"]] = modes.get(s["mode"], 0) + 1
    assert counts == EXPECTED_ZONES, f"zone split changed: {counts}"
    assert modes == EXPECTED_MODES, f"mode split changed: {modes}"

    assert len(zones) == len(stations), (
        f"{len(zones)} circles vs {len(stations)} stations"
    )
    assert set(zones) == {s["name"] for s in stations}, (
        "station and hiding-zone layers name different places"
    )
    for s in stations:
        z = zones[s["name"]]
        assert abs(z["lat"] - s["lat"]) < 1e-6, f"{s['name']}: centre lat differs"
        assert abs(z["lng"] - s["lng"]) < 1e-6, f"{s['name']}: centre lng differs"
        assert z["zone"] == s["zone"] and z["mode"] == s["mode"], s["name"]
        # The radius must be a pure function of the zone band, or
        # tierRadiusOverrides cannot express it.
        assert z["radius"] == ZONE_TIERS[s["zone"]][1], (
            f"{s['name']}: radius {z['radius']} but zone {s['zone']}"
        )

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Paris 15-08 Stations</name>',
    ]
    for s in sorted(stations, key=lambda x: x["name"]):
        tier = ZONE_TIERS[s["zone"]][0]
        parts.append(
            "<Placemark>"
            f"<name>{esc(s['name'])}</name>"
            '<ExtendedData>'
            f'<Data name="tier"><value>{tier}</value></Data>'
            f'<Data name="mode"><value>{esc(s["mode"])}</value></Data>'
            "</ExtendedData>"
            f"<Point><coordinates>{rnd(s['lng'])},{rnd(s['lat'])},0</coordinates></Point>"
            "</Placemark>"
        )
    parts.append("</Document></kml>")
    open(f"{OUT}/paris-stations.kml", "w", encoding="utf-8").write("\n".join(parts) + "\n")
    print(f"stations: {len(stations)} -> paris-stations.kml {counts} modes={modes}")
    return stations


def gen_poi():
    by_cat = {}
    for path in POI_KMZS:
        for name, d, pm in read_kmz(path):
            cat = d.get("category")
            assert cat in CANONICAL, f"non-canonical category {cat!r} on {name!r}"
            lng, lat = coords_of(pm, ".//k:Point/k:coordinates")[0]
            by_cat.setdefault(cat, []).append((name, lng, lat))

    counts = {k: len(v) for k, v in by_cat.items()}
    assert counts == EXPECTED_POIS, f"POI counts changed: {counts}"

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Paris 15-08 POIs</name>',
    ]
    for cat in sorted(by_cat):
        parts.append(f"<Folder><name>{cat}</name>")
        for name, lng, lat in by_cat[cat]:
            parts.append(
                "<Placemark>"
                f"<name>{esc(name)}</name>"
                f"<Point><coordinates>{rnd(lng)},{rnd(lat)},0</coordinates></Point>"
                "</Placemark>"
            )
        parts.append("</Folder>")
    parts.append("</Document></kml>")
    open(f"{OUT}/paris-poi.kml", "w", encoding="utf-8").write("\n".join(parts) + "\n")
    print(f"poi: {sum(counts.values())} in {len(counts)} folders -> paris-poi.kml {counts}")
    return by_cat


def gen_border():
    pms = read_kmz(OUTLINE_KMZ)
    assert len(pms) == 1, f"{len(pms)} outline placemarks, expected 1"
    pts = coords_of(pms[0][2], ".//k:LineString/k:coordinates")
    assert pts[0] == pts[-1], "the map outline LineString is not closed"
    geom = ccw(Polygon(pts))
    assert geom.is_valid
    # A bare Feature here fails silently on the custom-boundary path — the
    # client reads .features[…]. Always a FeatureCollection.
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "Paris 15-08 play area"},
            "geometry": rnd_geom(geom),
        }],
    }
    json.dump(fc, open(f"{OUT}/paris-border.geojson", "w"))
    print(f"border: {len(pts) - 1}-vertex {geom.geom_type} -> paris-border.geojson")
    return geom


def gen_arrondissements():
    """The 20 arrondissements plus the "Outer" catch-all, as one flat layer.

    "Outer" is the play-area rectangle with Paris punched out as a hole — it is
    not an administrative division, it is the rest of the map. It is kept as a
    21st region on purpose (Jules' call): 186 of the 412 hiding zones sit out
    there, and without it "same arrondissement" would be unanswerable for them.
    With it, two hiders both outside the city correctly match.
    """
    feats = []
    for name, d, pm in read_kmz(ARRONDISSEMENTS_KMZ):
        rings = [polygon_from_kml(p) for p in pm.findall(".//k:Polygon", NS)]
        geom = unary_union(rings)
        if not geom.is_valid:
            geom = geom.buffer(0)
        props = {"name": name, "osm_id": int(d["osm_id"]), "outer": name == OUTER_NAME}
        if d.get("number") and d["number"] != "-":
            props["number"] = int(d["number"])
        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": rnd_geom(ccw(geom)),
        })

    assert len(feats) == EXPECTED_ARRONDISSEMENTS, f"{len(feats)} arrondissements"
    outers = [f for f in feats if f["properties"]["outer"]]
    assert len(outers) == 1, f"{len(outers)} features named {OUTER_NAME!r}"
    numbers = sorted(f["properties"]["number"] for f in feats if "number" in f["properties"])
    assert numbers == list(range(1, 21)), f"arrondissement numbers: {numbers}"

    # Both question families find the ONE region containing the seeker, so any
    # overlap would make the answer depend on feature order.
    polys = [shape(f["geometry"]) for f in feats]
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            ov = polys[i].intersection(polys[j]).area
            assert ov < 1e-9, (
                f"{feats[i]['properties']['name']} overlaps "
                f"{feats[j]['properties']['name']} by {ov}"
            )

    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(f"{OUT}/paris-arrondissements.geojson", "w"))
    print(f"arrondissements: {len(feats)} (20 + {OUTER_NAME}) -> paris-arrondissements.geojson")
    return unary_union(polys)


# ------------------------------------------------------------------- checks
def check_tiling(border, union):
    """The 21 regions are built to tile the play-area rectangle exactly.

    Unlike Graz — where the border came from Nominatim and the districts from a
    KML, so a ~0.01% resolution mismatch was expected — both of these come from
    the same authoring pass, so they should agree to rounding only.
    """
    frac = border.symmetric_difference(union).area / border.area
    print(f"border vs arrondissement union: symmetric difference {frac * 100:.4f}%")
    assert frac < 0.001, f"border and arrondissements disagree by {frac * 100:.3f}%"


def check_stations(stations, border, feats_union, arr_fc_path):
    outside = [s for s in stations if not border.covers(Point(s["lng"], s["lat"]))]
    print(f"stations outside the play area: {len(outside)}")
    assert not outside, [s["name"] for s in outside[:10]]

    fc = json.load(open(arr_fc_path))
    polys = [(f["properties"]["name"], shape(f["geometry"])) for f in fc["features"]]
    bad = []
    for s in stations:
        p = Point(s["lng"], s["lat"])
        hits = [n for n, g in polys if g.covers(p)]
        if len(hits) != 1:
            bad.append((s["name"], hits))
    print(f"stations not in exactly one arrondissement: {len(bad)}")
    assert not bad, bad[:10]

    # Sanity: the inner/outer band should line up with Paris proper vs the
    # catch-all, since that is what the author drew.
    inner_in_outer = [
        s["name"] for s in stations
        if s["zone"] == "inner"
        and any(n == OUTER_NAME and g.covers(Point(s["lng"], s["lat"])) for n, g in polys)
    ]
    print(f"inner-zone stations sitting in the {OUTER_NAME} region: {len(inner_in_outer)}")


def check_pois(by_cat, border):
    for cat, items in sorted(by_cat.items()):
        outside = [n for n, lng, lat in items if not border.covers(Point(lng, lat))]
        if outside:
            print(f"  {cat}: {len(outside)}/{len(items)} outside the border: {outside[:5]}")


def main():
    stations = gen_stations()
    by_cat = gen_poi()
    border = gen_border()
    union = gen_arrondissements()

    check_tiling(border, union)
    check_stations(stations, border, union, f"{OUT}/paris-arrondissements.geojson")
    check_pois(by_cat, border)
    print("done")


if __name__ == "__main__":
    main()
