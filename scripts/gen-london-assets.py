#!/usr/bin/env python3
"""Generate London 02-08 bundled assets into apps/web/public/.

Reads the single source KMZ (London_02_08_26.kmz, not vendored) and produces:
  london-stations.kml   (271 hiding-zone stations, uniform 400 m, no tier)
  london-poi.kml        (POIs, one <Folder> per category incl. custom
                         "stadium" and "rail_terminus")
  london-border.geojson (the Game Area circle: r=14.5 km around Charing Cross)

Source layout (doc.kml inside the KMZ), 8 folders:
  Borough                          27 LineStrings  -- IGNORED (per Jules)
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


def main():
    root = load_doc()
    gen_stations(root)
    gen_poi(root)
    gen_border(root)


if __name__ == "__main__":
    sys.exit(main())
