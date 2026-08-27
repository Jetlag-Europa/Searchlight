#!/usr/bin/env python3
"""
Generate the bundled assets for the "Milan 29-08" game (JetLag EU).

Sources (not vendored) live in `WriteMap-Dev/Milan 29-08/`:
  - milano_v1_stations.csv        269 hiding zones, name/lat/lon/type/radius
  - milano_v1_features.csv        792 POIs, name/lat/lon/type
  - Milano 12 km game boundary.kml  one closed 721-vertex LineString ring
  - Administrative divisions (1).kml  9 Municipi + 3 Outer catch-alls

Outputs (apps/web/public/):
  - milan-stations.kml
  - milan-poi.kml
  - milan-border.geojson
  - milan-municipi.geojson

Deterministic: re-running produces byte-identical files.
"""

import csv
import itertools
import json
import math
import os
import re
import sys
from xml.sax.saxutils import escape

from shapely.geometry import MultiPolygon, Point, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SRC = "/Users/juleswitold/Dev/WriteMap-Dev/Milan 29-08"
PUBLIC = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

STATIONS_CSV = os.path.join(SRC, "milano_v1_stations.csv")
FEATURES_CSV = os.path.join(SRC, "milano_v1_features.csv")
BOUNDARY_KML = os.path.join(SRC, "Milano 12 km game boundary.kml")
ADMIN_KML = os.path.join(SRC, "Administrative divisions (1).kml")

# Metres² per square degree at Milan's latitude, for reporting only.
M_PER_DEG2 = (111320**2) * math.cos(math.radians(45.47))

# CSV feature type -> POI folder name (the gamePOIData category key).
#
# Eleven map onto the 13 rulebook categories in POI_CATEGORIES; three are
# game-specific and are read only by their own milan-* question:
#
#   castle       -> milan-castle   (same key Belgium/Budapest use for castles;
#                                   the bare "castle" tentacle stays gated to
#                                   Budapest, exactly as it is for Belgium)
#   rail_station -> milan-train    (deliberately NOT "train_station": that key
#                                   hijacks the generic same-train-line /
#                                   same-length-station questions, which must
#                                   see all 269 stations, not just these 26)
#   water_body   -> milan-water    (deliberately NOT "water": the importer's
#                                   SKIPPED_POI_CATEGORIES drops a folder with
#                                   that name outright)
CATEGORY_MAP = {
    "amusement_park": "theme_park",
    "aquarium": "aquarium",
    "castle_fort": "castle",
    "cinema": "cinema",
    "commercial_airport": "airport",
    "foreign_consulate": "consulate",
    "golf_course": "golf_course",
    "hospital": "hospital",
    "library": "library",
    "mountain": "mountain",
    "museum": "museum",
    "park": "park",
    "train": "rail_station",
    "water_body": "water_body",
}


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def coord(lon, lat):
    """
    KML "lon,lat,0" at a fixed 6 decimal places (~0.11 m).

    NOT "{:g}": that is 6 SIGNIFICANT digits, so at Milan's latitude
    (45.4xxx) it keeps only 4 decimals — an 11 m quantisation — while longitude
    at -0.13x keeps 7, because leading zeros are not significant. The result is
    a boundary that staircases vertically and runs smooth horizontally, and
    every station and POI displaced by up to 5.6 m.
    """
    return f"{float(lon):.6f},{float(lat):.6f},0"


def build_stations(rows):
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        "<name>Milan Stations</name>",
    ]
    for r in sorted(rows, key=lambda x: (x["type"], x["name"])):
        out.append(
            f'<Placemark><name>{escape(r["name"])}</name>'
            f'<ExtendedData><Data name="tier"><value>{escape(r["type"])}</value>'
            f"</Data></ExtendedData>"
            f'<Point><coordinates>{coord(r["longitude"], r["latitude"])}'
            f"</coordinates></Point></Placemark>"
        )
    out.append("</Document></kml>")
    return "\n".join(out) + "\n"


def build_poi(rows):
    by_cat = {}
    for r in rows:
        cat = CATEGORY_MAP.get(r["type"])
        if cat is None:
            sys.exit(f"unmapped feature type: {r['type']!r}")
        by_cat.setdefault(cat, []).append(r)

    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        "<name>Milan POIs</name>",
    ]
    for cat in sorted(by_cat):
        out.append(f"<Folder><name>{cat}</name>")
        for r in sorted(by_cat[cat], key=lambda x: x["name"]):
            out.append(
                f'<Placemark><name>{escape(r["name"])}</name>'
                f'<Point><coordinates>{coord(r["longitude"], r["latitude"])}'
                f"</coordinates></Point></Placemark>"
            )
        out.append("</Folder>")
    out.append("</Document></kml>")
    return "\n".join(out) + "\n", {k: len(v) for k, v in by_cat.items()}


def build_border():
    text = open(BOUNDARY_KML, encoding="utf-8").read()
    raw = re.search(r"<coordinates>([\s\S]*?)</coordinates>", text).group(1)
    ring = []
    for tok in raw.split():
        lon, lat = tok.split(",")[:2]
        ring.append([float(lon), float(lat)])

    if ring[0] != ring[-1]:
        ring.append(ring[0])

    # RFC 7946: exterior ring counterclockwise. Shoelace > 0 == CCW.
    area = sum(
        (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1])
        for i in range(len(ring) - 1)
    )
    if area > 0:  # clockwise under this formulation
        ring.reverse()

    # MUST be a FeatureCollection, not a bare Feature — the client reads
    # .features[…] off the border and a bare Feature throws into a swallowed
    # try/catch, silently breaking boundary questions.
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Milan 29-08 play area"},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
        ],
    }
    return json.dumps(fc, separators=(",", ":")) + "\n", len(ring)


def parse_admin_kml():
    """{name: shapely geometry} for the 12 divisions, in KML order."""
    text = open(ADMIN_KML, encoding="utf-8").read()
    out = {}
    for pm in re.findall(r"<Placemark>([\s\S]*?)</Placemark>", text):
        name = re.search(r"<name>([^<]*)</name>", pm).group(1)
        polys = []
        for poly in re.findall(r"<Polygon>([\s\S]*?)</Polygon>", pm):
            # No <innerBoundaryIs> anywhere in this file — asserted below.
            ring = re.findall(r"<coordinates>([\s\S]*?)</coordinates>", poly)[0]
            polys.append(
                Polygon([tuple(map(float, c.split(",")[:2])) for c in ring.split()])
            )
        out[name] = polys[0] if len(polys) == 1 else MultiPolygon(polys)
    if "<innerBoundaryIs" in text:
        sys.exit("admin KML has interior rings — the parser above ignores them")
    return out


def dedupe_overlaps(divs):
    """
    Make the divisions tile exactly: walk in name-sorted order and subtract
    everything already claimed. Deterministic and boundary-preserving — it only
    ever removes area from the later division of an overlapping pair.

    Milan's raw slivers total ~206 m² across 8 pairs (Stockholm's were ~53,000
    m² across 2). Tiny, but both question families resolve "the ONE division
    containing the seeker", so a point inside a sliver would otherwise get an
    answer that depended on feature order. Same fix as Entry 54.
    """
    claimed = None
    out = {}
    for name in sorted(divs):
        g = divs[name]
        if claimed is not None:
            g = g.difference(claimed)
        out[name] = g
        claimed = g if claimed is None else unary_union([claimed, g])
    return out


def build_municipi(border):
    raw = parse_admin_kml()
    if len(raw) != 12:
        sys.exit(f"expected 12 divisions, got {len(raw)}")
    for n, g in raw.items():
        if not g.is_valid:
            sys.exit(f"invalid geometry: {n}")

    before = sum(
        raw[a].intersection(raw[b]).area for a, b in itertools.combinations(raw, 2)
    )

    # NB: do not "tidy" this by snapping coordinates to a 1e-6 grid to shrink the
    # file. Tried both orders: snapping after dedupe re-introduces ~0.3 m² of
    # overlap and snapping before leaves ~0.1 m², because moving a vertex can
    # push it back across a neighbour's edge. Full precision is what makes the
    # overlap exactly zero, and an unambiguous "which ONE division am I in?"
    # lookup is worth more than the ~380 KB (the file gzips to a fraction of its
    # size on the wire).
    divs = dedupe_overlaps(raw)
    after = sum(
        divs[a].intersection(divs[b]).area for a, b in itertools.combinations(divs, 2)
    )
    if after > 1e-14:
        sys.exit(f"divisions still overlap after dedupe: {after * M_PER_DEG2:.1f} m²")

    # They must tile the play area: the questions are only answerable if every
    # point inside the boundary belongs to exactly one division.
    union = unary_union(list(divs.values()))
    sym = union.symmetric_difference(border).area / border.area
    if sym > 0.001:
        sys.exit(f"divisions do not tile the play area: {100 * sym:.4f}% differ")

    features = []
    for name in sorted(divs):
        # RFC 7946 winding: exterior CCW, holes CW.
        g = divs[name]
        g = orient(g, 1.0) if g.geom_type == "Polygon" else MultiPolygon(
            [orient(p, 1.0) for p in g.geoms]
        )
        features.append(
            {
                "type": "Feature",
                "properties": {"name": name},
                "geometry": mapping(g),
            }
        )
    fc = {"type": "FeatureCollection", "features": features}
    return (
        json.dumps(fc, separators=(",", ":")) + "\n",
        divs,
        before * M_PER_DEG2,
        100 * sym,
    )


def main():
    stations = read_csv(STATIONS_CSV)
    features = read_csv(FEATURES_CSV)

    radii = {r["hiding_radius_m"] for r in stations}
    if radii != {"400.0"}:
        sys.exit(f"expected a uniform 400 m radius, got {sorted(radii)}")

    kml = build_stations(stations)
    poi, counts = build_poi(features)
    border, nverts = build_border()
    municipi, divs, sliver_m2, sym_pct = build_municipi(
        Polygon(json.loads(border)["features"][0]["geometry"]["coordinates"][0])
    )

    # Every hiding zone must land in exactly one division, or its questions are
    # unanswerable from that zone.
    homeless, ambiguous = [], []
    for r in stations:
        pt = Point(float(r["longitude"]), float(r["latitude"]))
        hits = [n for n, g in divs.items() if g.contains(pt)]
        if not hits:
            homeless.append(r["name"])
        elif len(hits) > 1:
            ambiguous.append(r["name"])
    if homeless or ambiguous:
        sys.exit(f"zones in no division: {homeless}; in >1: {ambiguous}")

    for name, body in (
        ("milan-stations.kml", kml),
        ("milan-poi.kml", poi),
        ("milan-border.geojson", border),
        ("milan-municipi.geojson", municipi),
    ):
        path = os.path.join(PUBLIC, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        print(f"wrote {name:24s} {len(body.encode('utf-8')):>8,d} b")

    print(f"\nmunicipi: {len(divs)} divisions tile the play area "
          f"(symmetric difference {sym_pct:.4f}%)")
    print(f"          {sliver_m2:.1f} m² of raw overlap removed by dedupe_overlaps")
    zone_counts = {}
    for r in stations:
        pt = Point(float(r["longitude"]), float(r["latitude"]))
        for n, g in divs.items():
            if g.contains(pt):
                zone_counts[n] = zone_counts.get(n, 0) + 1
                break
    for n in sorted(divs, key=lambda x: -divs[x].area):
        print(f"  {divs[n].area * M_PER_DEG2 / 1e6:7.1f} km²  "
              f"{zone_counts.get(n, 0):3d} zones  {n}")

    print(f"\nstations: {len(stations)} @ 400 m uniform")
    print(f"border:   {nverts} vertices (closed, CCW)")
    print(f"POIs:     {sum(counts.values())} in {len(counts)} folders")
    for cat in sorted(counts, key=lambda c: -counts[c]):
        print(f"  {counts[cat]:>4d}  {cat}")


if __name__ == "__main__":
    main()
