#!/usr/bin/env python3
"""Generate the Rotterdam 12-09 POI KML into apps/web/public/.

Rotterdam 12-09 (`__bundled-rotterdam-2026-09__`) is Exter Rotterdam 26 plus one
extra POI category: the NS heavy-rail stations, which back the
`rotterdam-ns` matching + measuring pair.

Every other asset is SHARED with Exter Rotterdam 26 and is not regenerated here:
  exter-rotterdam-stations.kml         206 hiding zones, 300 m
  exter-rotterdam-border.geojson       play-area outline
  exter-rotterdam-municipalities.geojson
  exter-rotterdam-hsl.geojson
  exter-rotterdam-coastline.geojson

Only the POI file is game-specific, and it is a SEPARATE file rather than an
extra folder in exter-rotterdam-poi.kml on purpose: parseKMLFolderPOI falls
back to `folderName.toLowerCase()` for any folder the manifest's poiFolders map
does not list, so an added folder would silently load into the old game too.

Reads:
  apps/web/public/exter-rotterdam-poi.kml          (the 9 existing folders)
  ../Naamloze kaart- NS Stations.csv               (WKT POINT + name)
Writes:
  apps/web/public/rotterdam-2026-poi.kml

Re-runs byte-identically.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "apps/web/public"
SRC_POI = PUBLIC / "exter-rotterdam-poi.kml"
BORDER = PUBLIC / "exter-rotterdam-border.geojson"
NS_CSV = ROOT.parent / "Naamloze kaart- NS Stations.csv"
OUT = PUBLIC / "rotterdam-2026-poi.kml"

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


if __name__ == "__main__":
    main()
