#!/usr/bin/env python3
"""Generate Graz 08-08 bundled assets into apps/web/public/.

Sources (not vendored) live in `WriteMap-Dev/Graz 08-08/`:
  Graz v1- Stations.csv           174 stops, WKT + name + mode (bus/tram/train)
  graz-feature-map-2026-08-07.kml 248 placemarks in 4 folders, every one
                                  carrying an ExtendedData "category"

Produces:
  graz-stations.kml    174 hiding zones, <Data name="tier"> = bus | tram | train
  graz-poi.kml         231 POIs, one <Folder> per canonical category
  graz-districts.geojson
                       the 17 admin_level=9 Bezirke, for the graz-district
                       matching + measuring questions
  graz-border.geojson  the Graz city boundary (admin_level=8, OSM relation
                       34719) from Nominatim

The districts come straight out of the KML — it already ships all 17 Bezirke as
full-resolution polygons with their OSM relation ids, so there is no Overpass
step here (contrast gen-belgium-assets.py, where the supplied admin geometry was
resampled and had to be re-pulled). The border does NOT: it is the separate
admin_level=8 city relation, per Jules. The two are asserted to agree closely
rather than assumed to — see check_border_vs_districts().

Coord order in the source WKT and KML is "lng lat" (WGS84).
"""
import csv
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

from shapely.geometry import MultiPolygon, Point, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SRC = "/Users/juleswitold/Dev/WriteMap-Dev/Graz 08-08"
OUT = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

STATIONS_CSV = f"{SRC}/Graz v1- Stations.csv"
FEATURE_KML = f"{SRC}/graz-feature-map-2026-08-07.kml"

GRAZ_OSM_RELATION_ID = 34719

KML_NS = "http://www.opengis.net/kml/2.2"
NS = {"k": KML_NS}

# The KML's own category values -> the canonical POI folder names the importer
# expects (POI_CATEGORIES in packages/shared/src/games.ts). Two need renaming;
# the rest are already canonical. "mountain" is the folder name even though the
# question type is internally "peak" (see docs/ADDING_GAMES.md).
CATEGORY_MAP = {
    "cinema": "cinema",
    "foreign_consulate": "consulate",
    "hospital": "hospital",
    "library": "library",
    "museum": "museum",
    "amusement_park": "theme_park",
    "golf_course": "golf_course",
    "park": "park",
    "zoo": "zoo",
    "mountain": "mountain",
}

# Asserted after parsing, so a revised source that adds or drops features fails
# loudly instead of silently shipping a different game.
EXPECTED_STATIONS = {"bus": 95, "tram": 72, "train": 7}
EXPECTED_POIS = {
    "cinema": 6,
    "consulate": 16,
    "hospital": 8,
    "library": 43,
    "museum": 23,
    "theme_park": 1,
    "golf_course": 4,
    "park": 92,
    "zoo": 3,
    "mountain": 35,
}
EXPECTED_DISTRICTS = 17


def rnd(x, n=6):
    return round(x, n)


def rnd_geom(geom):
    """mapping() with coordinates rounded to ~10 cm, to keep the assets small.

    Rounding can collapse two near-identical vertices onto each other, and a
    zero-length segment makes turf's pointToLineDistance throw ("coordinates
    must contain numbers") — which is how the measuring question consumes these
    rings. So consecutive duplicates are dropped, ring closure preserved.
    """
    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [rnd(c[0]), rnd(c[1])]
        out = [walk(x) for x in c]
        if out and isinstance(out[0], list) and out[0] and isinstance(out[0][0], float):
            # This level is a ring / line: a list of [lng, lat].
            deduped = [out[0]]
            for pt in out[1:]:
                if pt != deduped[-1]:
                    deduped.append(pt)
            if len(deduped) >= 3 and out[0] == out[-1] and deduped[0] != deduped[-1]:
                deduped.append(deduped[0])  # keep the ring closed
            return deduped
        return out

    g = mapping(geom)
    g["coordinates"] = walk(g["coordinates"])
    return g


def esc(s):
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ------------------------------------------------------------------ sources
def read_kml():
    """Every placemark, as (folder, name, category, shapely geometry)."""
    root = ET.parse(FEATURE_KML).getroot()
    out = []
    for folder in root.iter(f"{{{KML_NS}}}Folder"):
        fname = folder.find("k:name", NS).text
        for pm in folder.findall("k:Placemark", NS):
            name = pm.find("k:name", NS).text
            data = {
                d.get("name"): d.find("k:value", NS).text
                for d in pm.findall(".//k:Data", NS)
            }
            pt = pm.find(".//k:Point/k:coordinates", NS)
            if pt is not None:
                lng, lat = (float(v) for v in pt.text.strip().split(",")[:2])
                geom = Point(lng, lat)
            else:
                poly = pm.find(".//k:Polygon", NS)
                if poly is None:
                    raise RuntimeError(f"placemark {name!r} has no Point or Polygon")
                geom = polygon_from_kml(poly)
            out.append((fname, name, data, geom))
    return out


def polygon_from_kml(poly_el):
    def ring(el):
        txt = el.find("k:coordinates", NS).text
        pts = []
        for tok in txt.split():
            lng, lat = (float(v) for v in tok.split(",")[:2])
            pts.append((lng, lat))
        return pts

    outer = ring(poly_el.find("k:outerBoundaryIs/k:LinearRing", NS))
    inners = [
        ring(el.find("k:LinearRing", NS))
        for el in poly_el.findall("k:innerBoundaryIs", NS)
    ]
    p = Polygon(outer, inners)
    if not p.is_valid:
        p = p.buffer(0)
    return p


def read_stations():
    rows = list(csv.DictReader(open(STATIONS_CSV, encoding="utf-8")))
    stations = []
    for r in rows:
        stations.append(
            {
                "name": r["name"].strip(),
                "lat": float(r["latitude"]),
                "lng": float(r["longitude"]),
                "tier": r["mode"].strip(),
            }
        )
    counts = {}
    for s in stations:
        counts[s["tier"]] = counts.get(s["tier"], 0) + 1
    assert counts == EXPECTED_STATIONS, f"station modes changed: {counts}"
    # The WKT column is redundant with lat/lng; verify they agree rather than
    # picking one and hoping.
    for r, s in zip(rows, stations):
        m = re.match(r"POINT \(([-\d.]+) ([-\d.]+)\)", r["WKT"])
        assert m, f"bad WKT: {r['WKT']!r}"
        assert abs(float(m.group(1)) - s["lng"]) < 1e-9, s["name"]
        assert abs(float(m.group(2)) - s["lat"]) < 1e-9, s["name"]
    return stations


# ------------------------------------------------------------------ outputs
def gen_stations(stations):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Graz Stations</name>',
    ]
    for s in stations:
        parts.append(
            "<Placemark>"
            f"<name>{esc(s['name'])}</name>"
            '<ExtendedData><Data name="tier">'
            f"<value>{s['tier']}</value>"
            "</Data></ExtendedData>"
            f"<Point><coordinates>{rnd(s['lng'])},{rnd(s['lat'])},0</coordinates></Point>"
            "</Placemark>"
        )
    parts.append("</Document></kml>")
    path = f"{OUT}/graz-stations.kml"
    open(path, "w", encoding="utf-8").write("\n".join(parts) + "\n")
    print(f"stations: {len(stations)} -> graz-stations.kml {EXPECTED_STATIONS}")


def gen_poi(placemarks):
    by_cat = {}
    for fname, name, data, geom in placemarks:
        cat = data.get("category")
        if cat == "admin_boundary":
            continue
        canonical = CATEGORY_MAP.get(cat)
        assert canonical, f"unmapped category {cat!r} on {name!r} (folder {fname!r})"
        by_cat.setdefault(canonical, []).append((name, geom))

    counts = {k: len(v) for k, v in by_cat.items()}
    assert counts == EXPECTED_POIS, f"POI counts changed: {counts}"

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Graz POIs</name>',
    ]
    for cat in sorted(by_cat):
        parts.append(f"<Folder><name>{cat}</name>")
        for name, geom in by_cat[cat]:
            parts.append(
                "<Placemark>"
                f"<name>{esc(name)}</name>"
                f"<Point><coordinates>{rnd(geom.x)},{rnd(geom.y)},0</coordinates></Point>"
                "</Placemark>"
            )
        parts.append("</Folder>")
    parts.append("</Document></kml>")
    path = f"{OUT}/graz-poi.kml"
    open(path, "w", encoding="utf-8").write("\n".join(parts) + "\n")
    total = sum(counts.values())
    print(f"poi: {total} in {len(counts)} folders -> graz-poi.kml {counts}")
    return by_cat


def gen_districts(placemarks):
    feats = []
    for fname, name, data, geom in placemarks:
        if data.get("category") != "admin_boundary":
            continue
        assert data.get("admin_level") == "9", f"{name}: admin_level {data.get('admin_level')}"
        g = orient(geom, sign=1.0) if geom.geom_type == "Polygon" else MultiPolygon(
            [orient(p, sign=1.0) for p in geom.geoms]
        )
        feats.append(
            {
                "type": "Feature",
                "properties": {"name": name, "osm_id": int(data["osm_id"])},
                "geometry": rnd_geom(g),
            }
        )
    assert len(feats) == EXPECTED_DISTRICTS, f"{len(feats)} districts, expected 17"

    # The measuring question finds the ONE district containing the seeker, so
    # overlapping districts would make the answer depend on feature order.
    polys = [shape(f["geometry"]) for f in feats]
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            ov = polys[i].intersection(polys[j]).area
            assert ov < 1e-9, (
                f"{feats[i]['properties']['name']} overlaps "
                f"{feats[j]['properties']['name']} by {ov}"
            )

    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(f"{OUT}/graz-districts.geojson", "w"))
    names = ", ".join(sorted(f["properties"]["name"] for f in feats))
    print(f"districts: {len(feats)} -> graz-districts.geojson ({names})")
    return unary_union(polys)


def gen_border():
    url = (
        "https://nominatim.openstreetmap.org/lookup"
        f"?osm_ids=R{GRAZ_OSM_RELATION_ID}&polygon_geojson=1&format=json"
    )
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "WriteMap-devscript/1.0 (juleslouineau@luciferslabproductions.com)"
        },
    )
    for attempt in range(3):
        try:
            data = json.load(urllib.request.urlopen(req, timeout=30))
            break
        except Exception as e:  # noqa: BLE001
            print(f"border fetch attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(3)
    else:
        raise RuntimeError("could not fetch the Graz border from Nominatim")

    assert data[0]["osm_id"] == GRAZ_OSM_RELATION_ID, data[0]
    geom = shape(data[0]["geojson"])
    if not geom.is_valid:
        geom = geom.buffer(0)
    geom = orient(geom, sign=1.0) if geom.geom_type == "Polygon" else MultiPolygon(
        [orient(p, sign=1.0) for p in geom.geoms]
    )
    # A bare Feature here fails silently on the custom-boundary path — the
    # client reads .features[…]. Always a FeatureCollection.
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Graz"},
                "geometry": rnd_geom(geom),
            }
        ],
    }
    json.dump(fc, open(f"{OUT}/graz-border.geojson", "w"))
    print(f"border: {geom.geom_type} -> graz-border.geojson")
    return geom


# ------------------------------------------------------------------- checks
def check_border_vs_districts(border, districts_union):
    """The 17 Bezirke tile the city, so their union should be the border.

    They come from different sources (KML vs Nominatim) at different
    resolutions, so they will not be identical — but a real disagreement (a
    missing district, a different city) would show up as a large symmetric
    difference. Anything under ~1% of the city area is resolution noise.
    """
    sym = border.symmetric_difference(districts_union).area
    frac = sym / border.area
    print(f"border vs district union: symmetric difference {frac * 100:.3f}% of city area")
    assert frac < 0.01, f"border and districts disagree by {frac * 100:.2f}%"


def check_stations(stations, border, districts_union):
    outside = [s for s in stations if not border.covers(Point(s["lng"], s["lat"]))]
    print(f"stations outside the city border: {len(outside)}")
    if outside:
        for s in outside[:10]:
            print(f"  - {s['name']} ({s['tier']}) {s['lat']},{s['lng']}")

    # Every hiding zone must sit in exactly one district, or the district
    # questions cannot answer for a hider standing there.
    homeless = []
    for s in stations:
        p = Point(s["lng"], s["lat"])
        if not districts_union.covers(p):
            homeless.append(s)
    print(f"stations in no district: {len(homeless)}")
    for s in homeless[:10]:
        print(f"  - {s['name']} ({s['tier']}) {s['lat']},{s['lng']}")


def check_pois(by_cat, border):
    for cat, items in sorted(by_cat.items()):
        outside = [n for n, g in items if not border.covers(g)]
        if outside:
            print(f"  {cat}: {len(outside)}/{len(items)} outside the border: {outside[:5]}")


def main():
    placemarks = read_kml()
    stations = read_stations()

    gen_stations(stations)
    by_cat = gen_poi(placemarks)
    districts_union = gen_districts(placemarks)
    border = gen_border()

    check_border_vs_districts(border, districts_union)
    check_stations(stations, border, districts_union)
    check_pois(by_cat, border)
    print("done")


if __name__ == "__main__":
    main()
