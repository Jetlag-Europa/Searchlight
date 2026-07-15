#!/usr/bin/env python3
"""Generate Belgium 01.08 bundled assets into apps/web/public/.

Reads the WKT CSVs + the 2nd-admin KML in this directory and produces:
  belgium-stations.kml     (all 435 hiding-zone stations, 1 km, no tier)
  belgium-poi.kml          (POIs, one <Folder> per category incl. custom "castle")
  belgium-hsl.geojson      (high-speed rail lines)
  belgium-coastline.geojson(coastline)
  belgium-provinces.geojson(10 province polygons, for "Same Province" question)
  belgium-border.geojson   (Belgium national boundary, admin_level=2, from Nominatim)

Coord order in every source WKT is "lng lat" (WGS84).
"""
import csv
import json
import re
import sys
import time
import urllib.request

from shapely import wkt
from shapely.geometry import (
    LineString,
    MultiPolygon,
    Polygon,
    mapping,
    shape,
)
from shapely.geometry.polygon import orient

SRC = "/Users/juleswitold/Dev/WriteMap-Dev/Belgium 01.08"
OUT = "/Users/juleswitold/Dev/WriteMap-Dev/TaibledFork/apps/web/public"

# POI source file -> canonical folder/category name.
POI_FILES = {
    "Map making - Airports.csv": "airport",
    "Map making - Museum.csv": "museum",
    "Map making - Cinema.csv": "cinema",
    "Map making - Golf Course.csv": "golf_course",
    "Map making - Amusement parks.csv": "theme_park",
    "Map making - Zoo.csv": "zoo",
    "Map making - Foreign Consulate.csv": "consulate",
    "Map making - Library.csv": "library",
    "Map making - Hospital.csv": "hospital",
    "Map making - Castle_Fort.csv": "castle",  # custom category
}

BELGIUM_OSM_RELATION_ID = 52411


def read_rows(fname):
    """Yield (geom, naam) from a WKT,naam,beschrijving,type CSV."""
    with open(f"{SRC}/{fname}", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        assert header[0] == "WKT", f"{fname}: unexpected header {header}"
        for row in reader:
            if not row or not row[0].strip():
                continue
            yield wkt.loads(row[0]), (row[1].strip() if len(row) > 1 else "")


def xml_escape(s):
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def rnd_geom(geom, nd=6):
    def r(c):
        if isinstance(c, (list, tuple)):
            if c and isinstance(c[0], (int, float)):
                return [round(float(c[0]), nd), round(float(c[1]), nd)]
            return [r(x) for x in c]
        return c

    g = mapping(geom)
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


# ---------------------------------------------------------------- stations
def gen_stations():
    body = []
    n = 0
    for geom, name in read_rows("H+S Belgium- Stations.csv"):
        if geom.geom_type != "Point":
            continue
        lng, lat = geom.x, geom.y
        body.append(
            "    <Placemark>\n"
            f"      <name>{xml_escape(name)}</name>\n"
            f"      <Point><coordinates>{lng},{lat},0</coordinates></Point>\n"
            "    </Placemark>"
        )
        n += 1
    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n'
        "    <name>Belgium 01.08 Stations</name>\n"
        + "\n".join(body)
        + "\n  </Document>\n</kml>\n"
    )
    open(f"{OUT}/belgium-stations.kml", "w", encoding="utf-8").write(out)
    print(f"stations: {n} placemarks")


# ---------------------------------------------------------------- POIs
def gen_poi():
    folders = []
    total = 0
    counts = []
    for fname, cat in POI_FILES.items():
        rows = []
        for geom, name in read_rows(fname):
            if geom.geom_type != "Point":
                continue
            rows.append((name, geom.x, geom.y))
        total += len(rows)
        counts.append(f"{cat}:{len(rows)}")
        inner = "\n".join(
            f"    <Placemark>\n      <name>{xml_escape(nm)}</name>\n"
            f"      <Point><coordinates>{lng},{lat},0</coordinates></Point>\n"
            "    </Placemark>"
            for nm, lng, lat in rows
        )
        folders.append(f"  <Folder>\n    <name>{cat}</name>\n{inner}\n  </Folder>")
    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n'
        "    <name>Belgium 01.08 POIs</name>\n"
        + "\n".join(folders)
        + "\n  </Document>\n</kml>\n"
    )
    open(f"{OUT}/belgium-poi.kml", "w", encoding="utf-8").write(out)
    print(f"poi: {total} placemarks across {len(POI_FILES)} folders ({', '.join(counts)})")


# ---------------------------------------------------------------- line assets
def _linestrings_from_geom(geom):
    """Flatten any WKT geometry into a list of shapely LineStrings."""
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type == "MultiLineString":
        return list(geom.geoms)
    if geom.geom_type == "GeometryCollection":
        out = []
        for g in geom.geoms:
            out.extend(_linestrings_from_geom(g))
        return out
    return []


def gen_lines(fname, out_name, label):
    feats = []
    for geom, name in read_rows(fname):
        for ls in _linestrings_from_geom(geom):
            if len(ls.coords) < 2:
                continue
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"name": name or label},
                    "geometry": rnd_geom(LineString(ls)),
                }
            )
    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(f"{OUT}/{out_name}", "w"))
    print(f"{label}: {len(feats)} line feature(s) -> {out_name}")


# ---------------------------------------------------------- provinces (KML)
def _kml_polygons(block):
    """Parse all <Polygon> outer+inner rings inside a KML placemark block."""
    polys = []
    for poly_block in re.findall(r"<Polygon>(.*?)</Polygon>", block, re.S):
        outer_m = re.search(
            r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", poly_block, re.S
        )
        if not outer_m:
            continue

        def parse(s):
            pts = []
            for tok in s.strip().split():
                p = tok.split(",")
                pts.append((float(p[0]), float(p[1])))
            return pts

        outer = parse(outer_m.group(1))
        inners = [
            parse(m)
            for m in re.findall(
                r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", poly_block, re.S
            )
        ]
        if len(outer) >= 4:
            polys.append(Polygon(outer, inners))
    return polys


def gen_provinces():
    txt = open(f"{SRC}/2nd Admin.kml", encoding="utf-8").read()
    feats = []
    for block in re.findall(r"<Placemark>(.*?)</Placemark>", txt, re.S):
        name_m = re.search(r"<name>(.*?)</name>", block, re.S)
        name = name_m.group(1).strip() if name_m else ""
        polys = _kml_polygons(block)
        if not polys:
            continue
        geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        if not geom.is_valid:
            geom = geom.buffer(0)
        geom = geom.simplify(0.0005, preserve_topology=True)
        geom = orient(geom, sign=1.0) if geom.geom_type == "Polygon" else MultiPolygon(
            [orient(p, sign=1.0) for p in geom.geoms]
        )
        feats.append(
            {
                "type": "Feature",
                "properties": {"name": name},
                "geometry": rnd_geom(geom),
            }
        )
    fc = {"type": "FeatureCollection", "features": feats}
    json.dump(fc, open(f"{OUT}/belgium-provinces.geojson", "w"))
    print(f"provinces: {len(feats)} features ({', '.join(f['properties']['name'] for f in feats)})")


# ---------------------------------------------------------- national border
def gen_border():
    url = (
        "https://nominatim.openstreetmap.org/lookup"
        f"?osm_ids=R{BELGIUM_OSM_RELATION_ID}&polygon_geojson=1&format=json"
    )
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "WriteMap-devscript/1.0 (juleslouineau@luciferslabproductions.com)"},
    )
    for attempt in range(3):
        try:
            data = json.load(urllib.request.urlopen(req, timeout=30))
            break
        except Exception as e:  # noqa: BLE001
            print(f"border fetch attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(3)
    else:
        print("ERROR: could not fetch Belgium border from Nominatim", file=sys.stderr)
        return
    geom = shape(data[0]["geojson"])
    geom = geom.simplify(0.001, preserve_topology=True)
    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.geom_type == "Polygon":
        geom = orient(geom, sign=1.0)
    else:  # MultiPolygon
        geom = MultiPolygon([orient(p, sign=1.0) for p in geom.geoms])
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": "Belgium"}, "geometry": rnd_geom(geom)}
        ],
    }
    json.dump(fc, open(f"{OUT}/belgium-border.geojson", "w"))
    print(f"border: {geom.geom_type} -> belgium-border.geojson")


if __name__ == "__main__":
    gen_stations()
    gen_poi()
    gen_lines("Map making - High Speed Lines.csv", "belgium-hsl.geojson", "hsl")
    gen_lines("Map making - Coastline.csv", "belgium-coastline.geojson", "coastline")
    gen_provinces()
    gen_border()
    print("done")
