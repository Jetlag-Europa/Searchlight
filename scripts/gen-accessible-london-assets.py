#!/usr/bin/env python3
"""Generate Accessible London 02-08 assets into apps/web/public/.

Emits exactly ONE file:
  accessible-london-stations.kml   (65 step-free hiding zones, 400 m)

Everything else -- POIs, the game-area circle, the borough polygons and the
borough border network -- is shared with the base London 02-08 game and reused
as-is. The two source KMZs were diffed layer by layer and every layer except
Station is byte-identical, so duplicating those assets would only create two
copies to keep in sync. assert_shared_layers_unchanged() below re-checks that
on every run: if a future revision of either KMZ touches a POI, a borough or
the boundary, this fails loudly rather than letting the two games drift apart.

The KML emitters and parsers are imported from gen-london-assets.py so both
stations files are produced by identical code.

## Which stations are hiding zones

The accessible KMZ reuses the "Game Area and Hiding Zone" circle layer's
`allowed` field to carry an ACCESSIBILITY CLASS rather than the base map's
Yes/No:

    Full 70   Partial 20   Interchange 3   Travel 3   None 274

Per Jules: **accessible_type Full or Partial, and nothing else** -- 70 + 20 = 90.
`category="Not Allowed"` is deliberately NOT applied here, unlike the base game.
Partial means step-free on some lines or directions only; the station's
`step_free_note` says which, e.g. Waterloo "Jubilee only", Wimbledon "District
and Tram only".

Interchange and Travel remain excluded: Interchange is step-free only to change
trains, not to enter or leave, and Travel is Thameslink-only.

**Consequence worth knowing: this list is NOT a subset of the base game's.** Five
stations here -- Canary Wharf (x2), Heron Quays, Shadwell, West India Quay -- are
`Not Allowed` on the map (all "Due to proximity to another station") and so are
absent from london-stations.kml. In accessible mode the step-free set is sparse
enough that proximity stops being a reason to drop a zone.

(That Not Allowed list is in any case recomputed per map and is NOT the base
game's: Balham, Brixton and Charing Cross are allowed here; Elephant & Castle,
London Bridge and Vauxhall are not.)

Two data quirks that do not affect the Full-only rule but would bite a wider one:

- The Station layer's `accessible_type` and the circle layer's `allowed`
  disagree on 5 stations -- Euston, Kennington, Monument, South Kensington and
  Stockwell are `Interchange` on the station but `None` on the circle. Their
  step_free_note explains it: step-free only to change trains, not to enter or
  leave. The circle layer is authoritative (as in Entry 48). For `Full` the two
  layers agree exactly, which the assertion below pins down.
- `Travel` means Thameslink-only (Blackfriars, London Bridge, St Pancras) and
  all three are already `Not Allowed`.
"""
import importlib.util
import sys
import zipfile
from pathlib import Path

_BASE = Path(__file__).with_name("gen-london-assets.py")
_spec = importlib.util.spec_from_file_location("gen_london_assets", _BASE)
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

SRC_KMZ = "/Users/juleswitold/Dev/WriteMap-Dev/Accessible_London_02_08_26.kmz"
OUT = base.OUT
NS = base.NS

# Layers that must stay identical to the base KMZ, since their assets are
# shared. "HSR Lines and Waterways (Landmass)" is excluded: it is ignored by
# both games and the accessible file has 24 features to the base file's 23.
SHARED_LAYERS = [
    "Borough",
    "Cinema and Library",
    "Museum",
    "Hospital",
    "Zoo, Aquarium, Golf Course, Stadium, Rail Terminus",
]

ACCESSIBLE_CLASSES = {"Full", "Partial"}
STATION_EXPECTED = 90


def load_accessible():
    with zipfile.ZipFile(SRC_KMZ) as z:
        import xml.etree.ElementTree as ET

        return ET.fromstring(z.read("doc.kml"))


def _fingerprint(root, layer):
    """(name, description, coordinates) per placemark — order-independent."""
    return {
        (
            base.name_of(pm),
            (pm.findtext("k:description", default="", namespaces=NS) or "").strip(),
            " ".join(
                (pm.findtext(".//k:coordinates", default="", namespaces=NS) or "").split()
            ),
        )
        for pm in base.folders(root)[layer].findall("k:Placemark", NS)
    }


def assert_shared_layers_unchanged(acc_root):
    base_root = base.load_doc()
    for layer in SHARED_LAYERS:
        a, b = _fingerprint(base_root, layer), _fingerprint(acc_root, layer)
        assert a == b, (
            f'shared layer "{layer}" differs between the two KMZs '
            f"(+{len(b - a)} / -{len(a - b)}). The Accessible London game reuses "
            f"the base game's asset for this layer, so it can no longer do so — "
            f"either regenerate both games' assets or stop sharing this one."
        )

    # The game-area circle backs the shared london-border.geojson.
    def game_area(root):
        hits = [
            pm
            for pm in base.folders(root)["Game Area and Hiding Zone"].findall(
                "k:Placemark", NS
            )
            if base.data_of(pm).get("allowed") == "Game Area"
        ]
        assert len(hits) == 1, f"expected 1 Game Area placemark, got {len(hits)}"
        return " ".join(
            (hits[0].findtext(".//k:coordinates", default="", namespaces=NS) or "").split()
        )

    assert game_area(base_root) == game_area(acc_root), (
        "the game-area circle differs between the two KMZs — "
        "london-border.geojson can no longer be shared"
    )
    print(f"shared layers: {len(SHARED_LAYERS)} + game area identical to the base KMZ")


def gen_stations(root):
    """Every circle classed in ACCESSIBLE_CLASSES. `category` is not consulted."""
    circles = {
        base.data_of(pm).get("id"): base.data_of(pm).get("allowed")
        for pm in base.folders(root)["Game Area and Hiding Zone"].findall(
            "k:Placemark", NS
        )
        if base.data_of(pm).get("allowed") != "Game Area"
    }

    rows, not_allowed_kept = [], []
    mismatched = []
    for pm in base.folders(root)["Station"].findall("k:Placemark", NS):
        d = base.data_of(pm)
        pt = base.point_of(pm)
        if pt is None:
            continue
        klass = circles.get(d.get("@id"))
        # For the classes we accept, the station attribute and the drawn circle
        # must agree; the two layers DO diverge on Interchange (5 stations), so
        # this is checked, not assumed — it is the guard that would fire if
        # Interchange were ever added to ACCESSIBLE_CLASSES.
        if (d.get("accessible_type") in ACCESSIBLE_CLASSES) != (
            klass in ACCESSIBLE_CLASSES
        ):
            mismatched.append((base.name_of(pm), d.get("accessible_type"), klass))
        if klass not in ACCESSIBLE_CLASSES:
            continue
        # Deliberately kept: `category` is not a filter in accessible mode.
        # Tracked only so the run log names the stations that differ from the
        # base game.
        if d.get("category") == "Not Allowed":
            not_allowed_kept.append(base.name_of(pm))
        rows.append((base.name_of(pm), pt[0], pt[1]))

    assert not mismatched, (
        "station accessible_type and circle class disagree (name, station, circle) "
        f"for: {mismatched}"
    )
    assert len(rows) == STATION_EXPECTED, (
        f"expected {STATION_EXPECTED} accessible stations, got {len(rows)} "
        "— source changed"
    )

    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<kml xmlns="{base.KML_NS}">\n  <Document>\n'
        "    <name>Accessible London 02-08 Stations</name>\n"
        + "\n".join(base.placemark(n, lng, lat) for n, lng, lat in rows)
        + "\n  </Document>\n</kml>\n"
    )
    open(f"{OUT}/accessible-london-stations.kml", "w", encoding="utf-8").write(out)
    print(
        f"stations: {len(rows)} placemarks "
        f"(classes={'+'.join(sorted(ACCESSIBLE_CLASSES))}; "
        f"{len(not_allowed_kept)} kept despite category='Not Allowed', so absent "
        f"from the base game: {', '.join(sorted(not_allowed_kept))})"
    )


def main():
    root = load_accessible()
    assert_shared_layers_unchanged(root)
    gen_stations(root)


if __name__ == "__main__":
    sys.exit(main())
