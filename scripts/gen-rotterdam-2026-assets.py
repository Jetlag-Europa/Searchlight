#!/usr/bin/env python3
"""Generate the Rotterdam 12-09 game-specific assets into apps/web/public/.

Rotterdam 12-09 (`__bundled-rotterdam-2026-09__`) is Exter Rotterdam 26 plus one
extra POI category — the NS heavy-rail stations, which back the `rotterdam-ns`
matching + measuring pair — and one extra measuring asset, the municipality
border NETWORK behind `rotterdam-municipality-border`.

Every other asset is SHARED with Exter Rotterdam 26 and is not regenerated here:
  exter-rotterdam-stations.kml         206 hiding zones, 300 m
  exter-rotterdam-border.geojson       play-area outline
  exter-rotterdam-municipalities.geojson
  exter-rotterdam-hsl.geojson
  exter-rotterdam-coastline.geojson

Both outputs are SEPARATE files rather than additions to a shared one, so the
older game cannot pick them up:
  - POIs: parseKMLFolderPOI falls back to `folderName.toLowerCase()` for any
    folder the manifest's poiFolders map does not list, so an added folder in
    exter-rotterdam-poi.kml would silently load into Exter Rotterdam 26 too.
  - Municipality lines: this is a new question on the new game only, so it gets
    its own asset and its own gated question type.

Reads:
  apps/web/public/exter-rotterdam-poi.kml          (the 9 existing folders)
  ../Naamloze kaart- NS Stations.csv               (WKT POINT + name)
  ../Exter Rotterdam 26/Municipalities.kml         (10 full-resolution polygons)
Writes:
  apps/web/public/rotterdam-2026-poi.kml
  apps/web/public/rotterdam-2026-municipality-lines.geojson

Re-runs byte-identically.
"""
import csv
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "apps/web/public"
# The KML/CSV sources live beside the checkout, not in it. Overridable so the
# script also runs from a git worktree, where ROOT.parent is .claude/worktrees.
SRC_ROOT = Path(os.environ.get("WRITEMAP_SRC", ROOT.parent))
SRC_POI = PUBLIC / "exter-rotterdam-poi.kml"
BORDER = PUBLIC / "exter-rotterdam-border.geojson"
NS_CSV = SRC_ROOT / "Naamloze kaart- NS Stations.csv"
MUNI_KML = SRC_ROOT / "Exter Rotterdam 26" / "Municipalities.kml"
OUT = PUBLIC / "rotterdam-2026-poi.kml"
OUT_MUNI_LINES = PUBLIC / "rotterdam-2026-municipality-lines.geojson"

# Douglas-Peucker tolerance for the municipality border network, in degrees.
# ~11 m at this latitude (measured Hausdorff: 11.1 m), against a 300 m hiding
# radius. Ten times finer than gen-london-assets.py's BOROUGH_LINE_SIMPLIFY
# because this play area is a fifteenth of Greater London's and the whole point
# of the question is that the distance is honest; the file is still 69 KB.
MUNI_LINE_SIMPLIFY = 0.0001

# Snap municipality coordinates onto a 1e-6 degree grid (~0.07 m) before the
# overlaps are subtracted — the same grid the output is rounded to, so nothing
# survives the subtraction that the rounding would then collapse.
PRECISION_GRID = 1e-6

# Discard polygon fragments smaller than this after subtraction (m2).
MIN_PART_M2 = 500.0

# Discard border arcs shorter than this (m). Subtracting the overlaps nodes the
# network wherever a carved boundary meets an untouched one, which leaves a tail
# of sub-metre fragments — 43 of them, 25.7 m of border between them. Most abut
# longer arcs on the same boundary; a few are isolated specks out in the harbour,
# which are the more valuable to lose, since one of those reads as a stretch of
# municipal border in open water. The total is asserted below.
MIN_ARC_M = 1.0

# Local equirectangular metres about Rotterdam, for the area assertions.
_KX = 111320 * math.cos(math.radians(51.92))

# The category key is "rail_station", NOT "train_station". "train_station"
# overrides the generic same-train-line / same-length-station questions, which
# must see all 206 of the map's stops — these are only the 9 NS heavy-rail ones.
# Same call as milan-train and brighton-rail.
NS_CATEGORY = "rail_station"

WKT_POINT = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)")


def esc(s):
    return (
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def read_ns_stations():
    """(name, lon, lat) for each NS station, in source order."""
    out = []
    with open(NS_CSV, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            wkt = (row.get("WKT") or "").strip()
            m = WKT_POINT.search(wkt)
            if not m:
                continue
            name = (row.get("name") or row.get("naam") or "").strip()
            if not name:
                sys.exit(f"NS station with no name: {wkt}")
            out.append((name, float(m.group(1)), float(m.group(2))))
    if not out:
        sys.exit("no NS stations parsed")
    names = [n for n, _, _ in out]
    if len(set(names)) != len(names):
        sys.exit("duplicate NS station names")
    return out


def source_folders():
    """The 9 existing folders, verbatim, so the shared POIs stay byte-identical."""
    text = SRC_POI.read_text(encoding="utf-8")
    blocks = re.findall(r"[ \t]*<Folder>.*?</Folder>\n?", text, re.S)
    if len(blocks) != 9:
        sys.exit(f"expected 9 folders in {SRC_POI.name}, found {len(blocks)}")
    return blocks


def report_containment(stations):
    """Report which NS stations fall outside the play area. Informational only."""
    try:
        from shapely.geometry import shape, Point
        from shapely.ops import unary_union
    except ImportError:
        print("  (shapely not installed — skipping containment check)")
        return
    fc = json.loads(BORDER.read_text(encoding="utf-8"))
    geom = unary_union([shape(f["geometry"]) for f in fc["features"]])
    outside = [
        (n, geom.distance(Point(lon, lat)) * 111_320)
        for n, lon, lat in stations
        if not geom.contains(Point(lon, lat))
    ]
    if outside:
        print(f"  {len(outside)} NS station(s) OUTSIDE the play area:")
        for n, d in outside:
            print(f"    {n}  ~{d:.0f} m out")
    else:
        print("  all NS stations inside the play area")


def area_m2(geom):
    from shapely.ops import transform

    return transform(lambda x, y, z=None: (x * _KX, y * 110570), geom).area


def length_m(coords):
    return sum(
        math.hypot(
            (coords[i + 1][0] - coords[i][0]) * _KX,
            (coords[i + 1][1] - coords[i][1]) * 110570,
        )
        for i in range(len(coords) - 1)
    )


def read_municipality_polygons():
    """{name: shapely Polygon} for the 10 full-resolution source municipalities.

    Deliberately NOT read from exter-rotterdam-municipalities.geojson: that
    asset was simplified per-polygon at 0.001 (~70-110 m), which is exactly the
    "simplify each region on its own and the tiling re-tears" failure
    gen-london-assets.py documents. It carries 0.63 km2 of pairwise overlap and
    one polygon with a hole outside its shell — usable for a point-in-polygon
    match, useless as a border network. So this starts from the source KML.
    """
    from shapely.geometry import Polygon
    from shapely.validation import make_valid

    def coords(s):
        out = []
        for tok in s.strip().split():
            p = tok.split(",")
            out.append((float(p[0]), float(p[1])))
        return out

    text = MUNI_KML.read_text(encoding="utf-8")
    polys = {}
    for block in re.findall(r"<Placemark>(.*?)</Placemark>", text, re.S):
        name_m = re.search(r"<name>(.*?)</name>", block, re.S)
        outer_m = re.search(
            r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", block, re.S
        )
        if not name_m or not outer_m:
            continue
        inners = [
            coords(m)
            for m in re.findall(
                r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", block, re.S
            )
        ]
        poly = Polygon(coords(outer_m.group(1)), inners)
        if not poly.is_valid:
            poly = make_valid(poly)
        polys[name_m.group(1).strip()] = poly
    if len(polys) != 10:
        sys.exit(f"expected 10 municipalities in {MUNI_KML.name}, found {len(polys)}")
    return polys


def dedupe_overlaps(polys):
    """Make the municipalities tile exactly, by ordered subtraction.

    The source polygons overlap by 71,105 m2 in total — nine pairs, almost all
    Rotterdam against a neighbour across harbour water. Left alone, each shared
    border would appear in the network TWICE as near-parallel arcs metres apart,
    and unary_union would node them into an unmergeable mess of fragments.
    Walking the names in sorted order and subtracting everything already claimed
    is deterministic and moves no boundary that was not already ambiguous — the
    same fix gen-stockholm-assets.py uses for its two slivers.

    Two pieces of hygiene the Stockholm version does not need, because there the
    overlaps were two clean slivers rather than nine ragged ones:

    - Coordinates are snapped to a PRECISION_GRID first. Subtracting boundaries
      that are near-coincident but not identical leaves zero-width spikes, which
      survive into the network as arcs that double back on themselves — and, once
      rounded to 6 dp on the way out, as arcs whose two points are the same
      point. turf's pointToLineDistance returns NaN on those rather than failing.
    - Fragments below MIN_PART_M2 are dropped. Ordered subtraction can shave a
      speck off a neighbour; a speck contributes a whole spurious ring.
    """
    from shapely import set_precision
    from shapely.geometry import MultiPolygon
    from shapely.ops import unary_union

    def clean(geom):
        geom = set_precision(geom, PRECISION_GRID).buffer(0)
        parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        kept = [p for p in parts if not p.is_empty and area_m2(p) >= MIN_PART_M2]
        if not kept:
            return geom
        return kept[0] if len(kept) == 1 else MultiPolygon(kept)

    out = {}
    claimed = None
    for name in sorted(polys):
        base = clean(polys[name])
        geom = base if claimed is None else clean(base.difference(claimed))
        if geom.is_empty:
            sys.exit(f"{name} was wholly consumed by its neighbours")
        out[name] = geom
        claimed = geom if claimed is None else unary_union([claimed, geom])
    return out


def gen_municipality_lines():
    """Write the shared municipality border network for measuring.

    This is the london-borough shape, NOT the belgium-province / paris-
    arrondissement one: measuring answers "distance to the nearest municipality
    border", against EVERY border on the map, not just the border of the
    municipality the seeker happens to be standing in. Jules' call, on the
    grounds that this play area is small (554 km2, 10 municipalities) so
    all-borders still discriminates well.

    One arc per boundary, not one ring per municipality: every internal border
    is shared by two municipalities, so rings would carry each of them twice.
    unary_union nodes the boundaries into two-point segments, which
    Douglas-Peucker cannot thin (it always keeps a segment's endpoints), so
    linemerge back into real arcs FIRST and only then simplify.

    The outer perimeter of the union is included, as it is for London: it is
    the play-area edge AND a genuine municipal boundary, so a seeker near it
    really is close to a municipality border.
    """
    from shapely.geometry import mapping, shape
    from shapely.ops import linemerge, unary_union
    from shapely.validation import make_valid

    raw = read_municipality_polygons()
    polys = dedupe_overlaps(raw)

    km2 = lambda g: area_m2(g) / 1e6

    names = sorted(polys)
    for i, n1 in enumerate(names):
        for n2 in names[i + 1:]:
            shared = polys[n1].intersection(polys[n2])
            assert km2(shared) < 1e-9, (
                f"{n1} and {n2} still overlap by {km2(shared) * 1e6:.1f} m2 "
                "after dedupe — the network would carry that border twice"
            )

    # The play area is the union of the municipalities (that is how
    # exter-rotterdam-border.geojson was built), so a mismatch here means the
    # source KML has drifted from the shipped border.
    union = unary_union(list(polys.values()))
    border_fc = json.loads(BORDER.read_text(encoding="utf-8"))
    border = unary_union([make_valid(shape(f["geometry"])) for f in border_fc["features"]])
    drift = km2(union.symmetric_difference(border)) / km2(border) * 100
    assert drift < 1.0, f"municipalities differ from the shipped border by {drift:.2f}%"

    merged = linemerge(unary_union([g.boundary for g in polys.values()]))
    arcs = list(merged.geoms) if merged.geom_type != "LineString" else [merged]
    raw_verts = sum(len(a.coords) for a in arcs)

    thinned = merged.simplify(MUNI_LINE_SIMPLIFY)
    thin_arcs = list(thinned.geoms) if thinned.geom_type != "LineString" else [thinned]

    # Round first, then drop what the rounding collapsed. An arc left with fewer
    # than two DISTINCT points is not a line: turf's pointToLineDistance returns
    # NaN for it, which propagates silently through the distance comparison and
    # is exactly the kind of quiet wrongness this game's questions keep hitting.
    kept, dropped_arcs = [], []
    for arc in thin_arcs:
        coords = []
        for x, y in mapping(arc)["coordinates"]:
            pt = [round(x, 6), round(y, 6)]
            if not coords or coords[-1] != pt:
                coords.append(pt)
        if len(coords) < 2 or length_m(coords) < MIN_ARC_M:
            dropped_arcs.append(arc)
            continue
        kept.append(coords)
    assert kept, "the border network came out empty"

    # Guard the drop by total length, not by position: some of these specks sit
    # on the network and some are isolated out in the harbour, and an isolated
    # one is the more useful to lose — it would otherwise read as a stretch of
    # municipal border in open water. What must stay true is that all of them
    # together are a rounding error against 305 km of real border.
    dropped_m = sum(a.length for a in dropped_arcs) * 111320
    assert dropped_m < 50.0, f"dropping {dropped_m:.1f} m of border is too much"

    features = [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        for coords in kept
    ]
    dropped = len(dropped_arcs)
    for f in features:
        cs = f["geometry"]["coordinates"]
        assert len(cs) >= 2 and len({tuple(c) for c in cs}) >= 2, (
            f"degenerate arc survived: {cs}"
        )

    OUT_MUNI_LINES.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT_MUNI_LINES.relative_to(ROOT)}")
    print(
        f"  {len(features)} arcs, "
        f"{sum(len(f['geometry']['coordinates']) for f in features)} verts "
        f"(from {raw_verts}), {dropped} specks dropped ({dropped_m:.1f} m), max deviation "
        f"{merged.hausdorff_distance(thinned) * 111320:.1f} m"
    )
    print(f"  play area {km2(union):.1f} km2, border drift {drift:.3f}%")


def main():
    stations = read_ns_stations()
    folders = source_folders()

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        "  <Document>",
        "    <name>Rotterdam 12-09 POIs</name>",
    ]
    parts.extend(b.rstrip("\n") for b in folders)
    parts.append("  <Folder>")
    parts.append(f"    <name>{NS_CATEGORY}</name>")
    for name, lon, lat in stations:
        parts.append("    <Placemark>")
        parts.append(f"      <name>{esc(name)}</name>")
        parts.append(
            f"      <Point><coordinates>{lon:.6f},{lat:.6f},0</coordinates></Point>"
        )
        parts.append("    </Placemark>")
    parts.append("  </Folder>")
    parts.append("  </Document>")
    parts.append("</kml>")

    OUT.write_text("\n".join(parts) + "\n", encoding="utf-8")

    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  9 shared folders + {NS_CATEGORY} ({len(stations)} NS stations)")
    report_containment(stations)
    gen_municipality_lines()


if __name__ == "__main__":
    main()
