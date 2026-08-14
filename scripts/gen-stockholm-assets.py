#!/usr/bin/env python3
"""Generate the Stockholm 15-08 bundled assets into apps/web/public/.

Sources (not vendored) live in `WriteMap-Dev/Stockholm 15-08/`:
  Hide and seek Stockholm July 2026.kmz   9 layers, 2.0 MB doc.kml
  POI Airport.kml                         2 placemarks, no folders

Produces:
  stockholm-stations.kml      191 hiding zones, uniform 500 m (no <Data name="tier">)
  stockholm-poi.kml            51 POIs in 4 folders: ikea, hospital, golf_course,
                               airport
  stockholm-admin1.geojson      3 divisions  (South, North-West, North-East)
  stockholm-admin2.geojson      9 divisions  (Innerstan, Västerort, …)
  stockholm-admin3.geojson     25 divisions  (14 kommuner + 11 stadsdelsområden)
  stockholm-border.geojson     the play area, dissolved from level 3

The three admin levels each drive a matching AND a measuring question
(`stockholm-admin1/2/3`), and all three cover the same ground — their unions
agree to within 0.006%, so any of them dissolves to the play boundary. Level 3
is used for the border because it is the only level whose divisions tile with
exactly zero overlap in the source.

Levels 1 and 2 do NOT tile cleanly as supplied: in each, `North-West` and
`North-East` overlap by ~27,000 m² / ~26,000 m². Both question families resolve
"the ONE division containing the seeker", so a point inside that sliver would
get an answer that depends on feature order. dedupe_overlaps() fixes it by
walking the divisions in name-sorted order and subtracting everything already
claimed — deterministic, and cheaper than Entry 49's polygonize recipe for a
single sliver. Zero overlap is then asserted, as in Graz and Paris.

There is no Game Area layer, and the "Transit lines" layer (16 LineStrings) is
deliberately unused — no question was asked for it (cf. London's ignored
HSR/waterway layers).

Coord order in the KML is "lng,lat" (WGS84).
"""
import json
import math
import zipfile
import xml.etree.ElementTree as ET

from shapely.geometry import MultiPolygon, Point, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SRC = "/Users/juleswitold/Dev/WriteMap-Dev/Stockholm 15-08"
OUT = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

KMZ = f"{SRC}/Hide and seek Stockholm July 2026.kmz"
AIRPORT_KML = f"{SRC}/POI Airport.kml"

KML_NS = "http://www.opengis.net/kml/2.2"
NS = {"k": KML_NS}

# Source folder -> canonical POI category. "ikea" is a game-specific category,
# not one of the 13 rulebook ones (POI_CATEGORIES in packages/shared/src/games.ts);
# it reaches gamePOIData under its own key and is read only by the
# `stockholm-ikea` question, via CATEGORY_ALIASES in apps/web/src/lib/poiOverride.ts.
# Same shape as budapest "castle"/"stadium" and bucharest "covrigarie".
POI_FOLDERS = {
    "POI IKEAs": "ikea",
    "POI Hospitals": "hospital",
    "POI Golf courses": "golf_course",
}

ADMIN_LAYERS = {
    "First Administrative Divisions": ("stockholm-admin1.geojson", 3),
    "Second Administrative Divisions": ("stockholm-admin2.geojson", 9),
    "Third Administrative Divisions": ("stockholm-admin3.geojson", 25),
}
BORDER_FROM = "Third Administrative Divisions"

# Asserted after parsing, so a revised source that adds or drops features fails
# loudly instead of silently shipping a different game.
EXPECTED_STATIONS = 191
EXPECTED_RADIUS_M = 500
EXPECTED_POIS = {"ikea": 5, "hospital": 15, "golf_course": 29, "airport": 2}

# Rough metres-per-degree at Stockholm's latitude, for reporting only — all
# geometry work is done in degrees and all assertions are relative.
LAT0 = 59.33
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LNG = 111_320.0 * math.cos(math.radians(LAT0))


def rnd(x, n=6):
    return round(x, n)


def rnd_geom(geom):
    """mapping() with coordinates rounded to ~10 cm, to keep the assets small.

    Rounding can collapse two near-identical vertices onto each other, and a
    zero-length segment makes turf's pointToLineDistance throw ("coordinates
    must contain numbers") — which is how the measuring question consumes these
    rings. So consecutive duplicates are dropped, ring closure preserved.
    (From gen-graz-assets.py, where it was learned the hard way.)
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


def area_m2(geom):
    return geom.area * M_PER_DEG_LAT * M_PER_DEG_LNG


# ------------------------------------------------------------------ sources
def folders(root):
    """{folder name: [placemark elements]} for a parsed KML root."""
    out = {}
    for fol in root.iter(f"{{{KML_NS}}}Folder"):
        name_el = fol.find("k:name", NS)
        if name_el is None:
            continue
        out[name_el.text.strip()] = fol.findall("k:Placemark", NS)
    return out


def pm_name(pm):
    el = pm.find("k:name", NS)
    return el.text.strip() if el is not None and el.text else ""


def pm_point(pm):
    txt = pm.find(".//k:Point/k:coordinates", NS).text
    lng, lat = (float(v) for v in txt.strip().split(",")[:2])
    return lng, lat


def pm_polygon(pm):
    """Every Polygon in a placemark, unioned (handles the one MultiGeometry)."""
    polys = []
    for poly in pm.findall(".//k:Polygon", NS):
        outer = ring(poly.find("k:outerBoundaryIs/k:LinearRing/k:coordinates", NS))
        inners = [
            ring(e.find("k:LinearRing/k:coordinates", NS))
            for e in poly.findall("k:innerBoundaryIs", NS)
        ]
        p = Polygon(outer, inners)
        polys.append(p if p.is_valid else p.buffer(0))
    g = unary_union(polys)
    return g if g.is_valid else g.buffer(0)


def ring(el):
    return [
        tuple(float(v) for v in tok.split(",")[:2]) for tok in el.text.split()
    ]


# ------------------------------------------------------------------ outputs
def gen_stations(L):
    """The station points, cross-checked against the drawn hiding-zone circles.

    Two independent layers describe the same 191 zones. London's source
    contradicted itself across exactly this pair (Entry 48), so the agreement is
    asserted rather than assumed: every circle must have a station at its
    centre, 1:1, and every radius must be the uniform 500 m the manifest
    encodes.
    """
    stations = []
    for pm in L["Stations"]:
        lng, lat = pm_point(pm)
        stations.append({"name": pm_name(pm), "lat": lat, "lng": lng})
    assert len(stations) == EXPECTED_STATIONS, f"{len(stations)} stations"
    names = [s["name"] for s in stations]
    assert len(set(names)) == len(names), "duplicate station names"

    circles = [pm_polygon(pm) for pm in L["Hiding zones"]]
    assert len(circles) == EXPECTED_STATIONS, f"{len(circles)} hiding zones"

    # Pair each circle to its nearest station centre, then require the pairing
    # to be a bijection — a station without a circle (or two circles sharing
    # one) means the layers have diverged.
    paired = {}
    for c in circles:
        cen = c.centroid
        best = min(
            stations,
            key=lambda s: (s["lng"] - cen.x) ** 2 + (s["lat"] - cen.y) ** 2,
        )
        off = math.hypot(
            (best["lng"] - cen.x) * M_PER_DEG_LNG,
            (best["lat"] - cen.y) * M_PER_DEG_LAT,
        )
        assert off < 25, f"{best['name']}: circle centre {off:.0f} m off the station"
        assert best["name"] not in paired, f"two circles claim {best['name']}"
        radii = [
            math.hypot(
                (x - cen.x) * M_PER_DEG_LNG, (y - cen.y) * M_PER_DEG_LAT
            )
            for x, y in c.exterior.coords
        ]
        r = sum(radii) / len(radii)
        assert abs(r - EXPECTED_RADIUS_M) < 5, f"{best['name']}: radius {r:.0f} m"
        paired[best["name"]] = r
    assert len(paired) == EXPECTED_STATIONS

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Stockholm 15-08 Stations</name>',
    ]
    for s in sorted(stations, key=lambda x: x["name"]):
        # No <Data name="tier">: the radius is uniform, so the manifest carries
        # it as hidingRadius alone and there are no tierRadiusOverrides.
        parts.append(
            "<Placemark>"
            f"<name>{esc(s['name'])}</name>"
            f"<Point><coordinates>{rnd(s['lng'])},{rnd(s['lat'])},0</coordinates></Point>"
            "</Placemark>"
        )
    parts.append("</Document></kml>")
    open(f"{OUT}/stockholm-stations.kml", "w", encoding="utf-8").write(
        "\n".join(parts) + "\n"
    )
    lo, hi = min(paired.values()), max(paired.values())
    print(
        f"stations: {len(stations)} -> stockholm-stations.kml "
        f"(radius {lo:.0f}-{hi:.0f} m, uniform)"
    )
    return stations


def gen_poi(L):
    by_cat = {}
    for folder, cat in POI_FOLDERS.items():
        for pm in L[folder]:
            lng, lat = pm_point(pm)
            by_cat.setdefault(cat, []).append((pm_name(pm), lng, lat))

    # Airports ship as a separate file with no folders.
    air = ET.parse(AIRPORT_KML).getroot()
    for pm in air.findall(".//k:Placemark", NS):
        lng, lat = pm_point(pm)
        by_cat.setdefault("airport", []).append((pm_name(pm), lng, lat))

    counts = {k: len(v) for k, v in by_cat.items()}
    assert counts == EXPECTED_POIS, f"POI counts changed: {counts}"

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<kml xmlns="{KML_NS}"><Document><name>Stockholm 15-08 POIs</name>',
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
    open(f"{OUT}/stockholm-poi.kml", "w", encoding="utf-8").write(
        "\n".join(parts) + "\n"
    )
    print(f"poi: {sum(counts.values())} in {len(counts)} folders -> stockholm-poi.kml {counts}")
    return by_cat


def dedupe_overlaps(divisions):
    """Make a level's divisions tile exactly, deterministically.

    Levels 1 and 2 each ship one overlapping pair (North-West ∩ North-East).
    Walking in name-sorted order and subtracting everything already claimed
    removes the overlap without moving any other boundary, and gives the same
    answer on every run regardless of source ordering.
    """
    out = {}
    claimed = None
    removed = 0.0
    for name in sorted(divisions):
        g = divisions[name]
        if claimed is not None and g.intersects(claimed):
            trimmed = g.difference(claimed)
            removed += area_m2(g) - area_m2(trimmed)
            g = trimmed if trimmed.is_valid else trimmed.buffer(0)
        assert not g.is_empty, f"{name} was entirely consumed by earlier divisions"
        out[name] = g
        claimed = g if claimed is None else unary_union([claimed, g])
    if removed > 1.0:
        print(f"    trimmed {removed:,.0f} m2 of overlap")
    return out


def gen_admin(L):
    levels = {}
    for layer, (fname, expected) in ADMIN_LAYERS.items():
        divisions = {}
        for pm in L[layer]:
            # One 2nd-level name carries a trailing non-breaking space.
            name = pm_name(pm).replace("\xa0", " ").strip()
            assert name, f"unnamed division in {layer}"
            assert name not in divisions, f"duplicate division {name!r} in {layer}"
            divisions[name] = pm_polygon(pm)
        assert len(divisions) == expected, f"{layer}: {len(divisions)} != {expected}"

        print(f"  {layer}: {len(divisions)} divisions")
        divisions = dedupe_overlaps(divisions)

        # Both question families resolve the ONE division containing the seeker.
        names = sorted(divisions)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                ov = area_m2(divisions[names[i]].intersection(divisions[names[j]]))
                assert ov < 1.0, f"{names[i]} still overlaps {names[j]} by {ov:.0f} m2"

        feats = [
            {
                "type": "Feature",
                "properties": {"name": n},
                "geometry": rnd_geom(ccw(divisions[n])),
            }
            for n in names
        ]
        json.dump(
            {"type": "FeatureCollection", "features": feats},
            open(f"{OUT}/{fname}", "w"),
        )
        print(f"    -> {fname}")
        levels[layer] = divisions
    return levels


def gen_border(levels):
    geom = unary_union(list(levels[BORDER_FROM].values()))
    if not geom.is_valid:
        geom = geom.buffer(0)
    geom = ccw(geom)
    # A bare Feature here fails silently on the custom-boundary path — the
    # client reads .features[…]. Always a FeatureCollection.
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Stockholm 15-08 play area"},
                "geometry": rnd_geom(geom),
            }
        ],
    }
    json.dump(fc, open(f"{OUT}/stockholm-border.geojson", "w"))
    w, s, e, n = geom.bounds
    print(
        f"border: {geom.geom_type} {area_m2(geom) / 1e6:,.0f} km2 -> stockholm-border.geojson"
    )
    print(f"  manifest extent [N, W, S, E] = [{n:.4f}, {w:.4f}, {s:.4f}, {e:.4f}]")
    return geom


# ------------------------------------------------------------------- checks
def check_levels_agree(levels, border):
    """All three levels should describe the same ground."""
    for layer, divisions in levels.items():
        u = unary_union(list(divisions.values()))
        frac = u.symmetric_difference(border).area / border.area
        print(f"  {layer} union vs border: symmetric difference {frac * 100:.4f}%")
        assert frac < 0.001, f"{layer} disagrees with the border by {frac * 100:.3f}%"


def check_nesting(levels):
    """Each division should sit inside exactly one at the level above."""
    order = list(ADMIN_LAYERS)
    for child_layer, parent_layer in zip(order[1:], order[:-1]):
        worst = 1.0
        for cn, cg in levels[child_layer].items():
            frac, pn = max(
                (cg.intersection(pg).area / cg.area, pn)
                for pn, pg in levels[parent_layer].items()
            )
            if frac < worst:
                worst, worst_pair = frac, (cn, pn)
        print(f"  {child_layer} nests in {parent_layer}: worst {worst * 100:.2f}%")
        assert worst > 0.99, f"{worst_pair} only {worst * 100:.1f}% contained"


def check_stations(stations, levels, border):
    outside = [
        s for s in stations if not border.covers(Point(s["lng"], s["lat"]))
    ]
    print(f"stations outside the play area: {len(outside)}")
    assert not outside, [s["name"] for s in outside[:10]]

    for layer, divisions in levels.items():
        bad = []
        for s in stations:
            p = Point(s["lng"], s["lat"])
            hits = [n for n, g in divisions.items() if g.covers(p)]
            if len(hits) != 1:
                bad.append((s["name"], hits))
        print(f"  {layer}: stations not in exactly one division: {len(bad)}")
        assert not bad, bad[:10]


def check_pois(by_cat, border):
    for cat, items in sorted(by_cat.items()):
        outside = [n for n, lng, lat in items if not border.covers(Point(lng, lat))]
        if outside:
            print(f"  {cat}: {len(outside)}/{len(items)} outside the border: {outside}")


def main():
    root = ET.fromstring(zipfile.ZipFile(KMZ).read("doc.kml"))
    L = folders(root)

    stations = gen_stations(L)
    by_cat = gen_poi(L)
    levels = gen_admin(L)
    border = gen_border(levels)

    check_levels_agree(levels, border)
    check_nesting(levels)
    check_stations(stations, levels, border)
    check_pois(by_cat, border)
    print("done")


if __name__ == "__main__":
    main()
