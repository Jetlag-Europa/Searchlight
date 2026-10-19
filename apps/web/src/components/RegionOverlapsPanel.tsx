import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";
import {
    markNoOverlaps,
    type OverlapPiece,
    type RegionOverlaps,
} from "@/maps/geo-utils/regionOverlaps";

type Region = Feature<Polygon | MultiPolygon>;

interface LayerCheck {
    index: number;
    name: string;
    regions: Region[];
    flagged: boolean;
    result?: RegionOverlaps;
    error?: string;
    /** Hiding zones an overlap reaches into. */
    zonesTouched?: number;
}

/** What the map shows for the layer picked here. */
export interface OverlapHighlight {
    pieces: Feature<Polygon>[];
    /** Where to zoom: the widest overlap. */
    focus: BBox;
}

const isRegionLayer = (layer: NonNullable<GameDefinition["features"]>[0]) =>
    layer.data.features.length > 0 &&
    layer.data.features.every(
        (f) =>
            f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
    );

const regionName = (regions: Region[], index: number) => {
    const name = regions[index]?.properties?.name;
    return typeof name === "string" && name ? name : `region ${index + 1}`;
};

const formatArea = (m2: number) =>
    m2 >= 100_000
        ? `${(m2 / 1e6).toFixed(2)} km²`
        : `${Math.round(m2).toLocaleString()} m²`;

function countZonesTouched(
    pieces: OverlapPiece[],
    zones: Feature<Polygon | MultiPolygon>[],
): number {
    const zoneBoxes = zones.map((zone) => turf.bbox(zone));
    let touched = 0;
    zones.forEach((zone, z) => {
        const [w, s, e, n] = zoneBoxes[z];
        const hit = pieces.some((piece) => {
            const [pw, ps, pe, pn] = turf.bbox(piece.geometry);
            if (pw > e || pe < w || ps > n || pn < s) return false;
            return turf.booleanIntersects(zone, piece.geometry);
        });
        if (hit) touched++;
    });
    return touched;
}

/**
 * Finds where each region layer's regions overlap, says what fixing it
 * would change, and fixes the layers picked: each overlap goes to the first
 * region in the file, and the layer is marked noOverlaps.
 */
export function RegionOverlapsPanel({
    definition,
    zones,
    onFix,
    onHighlight,
    onWrongMarks,
}: {
    definition: GameDefinition;
    zones: Feature<Polygon | MultiPolygon>[];
    /** Takes the fixed file; resolves once it has been checked again. */
    onFix: (fixed: GameDefinition) => Promise<void>;
    onHighlight: (highlight: OverlapHighlight | null) => void;
    /**
     * The layers marked noOverlaps that do overlap: imported like that,
     * their distance questions would measure to borders that cross them.
     * Null while a marked layer is still being checked.
     */
    onWrongMarks: (layers: string[] | null) => void;
}) {
    const initial = useMemo(
        () =>
            (definition.features ?? []).flatMap((layer, index) =>
                isRegionLayer(layer)
                    ? [
                          {
                              index,
                              name: layer.name,
                              regions: layer.data.features as Region[],
                              flagged: layer.noOverlaps === true,
                          },
                      ]
                    : [],
            ),
        [definition],
    );
    const [checks, setChecks] = useState<LayerCheck[]>(initial);
    const [picked, setPicked] = useState<Set<number>>(new Set());
    const [shown, setShown] = useState<number | null>(null);
    const [fixing, setFixing] = useState(false);
    const [fixError, setFixError] = useState<string | null>(null);

    // Each layer is checked in the geometry worker, one after another.
    useEffect(() => {
        let current = true;
        setChecks(initial);
        setPicked(new Set());
        setShown(null);
        setFixError(null);
        onHighlight(null);
        (async () => {
            for (const layer of initial) {
                let update: Partial<LayerCheck>;
                try {
                    const result = await requestGeometry({
                        kind: "regionOverlaps",
                        regions: layer.regions,
                    });
                    update = {
                        result,
                        zonesTouched: countZonesTouched(result.pieces, zones),
                    };
                } catch (err: any) {
                    update = { error: err.message ?? String(err) };
                }
                if (!current) return;
                setChecks((prev) =>
                    prev.map((c) =>
                        c.index === layer.index ? { ...c, ...update } : c,
                    ),
                );
                // Offer every layer that can be fixed or marked.
                if (update.result && !update.result.hidden.length) {
                    if (update.result.pieces.length || !layer.flagged) {
                        setPicked((prev) => new Set(prev).add(layer.index));
                    }
                }
            }
        })();
        return () => {
            current = false;
        };
        // zones follow the definition.
    }, [initial]);

    const overlaps = (check: LayerCheck) =>
        !!check.result &&
        (check.result.pieces.length > 0 || check.result.hidden.length > 0);
    const wrongMarks = checks
        .filter((check) => check.flagged && overlaps(check))
        .map((check) => check.name);
    const wrongMarksKey = wrongMarks.join("\n");
    const checkingMarks = checks.some(
        (check) => check.flagged && !check.result && !check.error,
    );
    useEffect(() => {
        onWrongMarks(
            checkingMarks
                ? null
                : wrongMarksKey
                  ? wrongMarksKey.split("\n")
                  : [],
        );
        // The names are the dependency, not the array's identity.
    }, [wrongMarksKey, checkingMarks]);

    if (!initial.length) return null;

    const checking = checks.some((c) => !c.result && !c.error);

    const show = (check: LayerCheck) => {
        if (shown === check.index || !check.result?.pieces.length) {
            setShown(null);
            onHighlight(null);
            return;
        }
        const widest = check.result.pieces.reduce((a, b) =>
            b.width > a.width ? b : a,
        );
        setShown(check.index);
        onHighlight({
            pieces: check.result.pieces.map((p) => turf.feature(p.geometry)),
            focus: turf.bbox(widest.geometry),
        });
    };

    const fix = async () => {
        setFixing(true);
        setFixError(null);
        try {
            const features = [...(definition.features ?? [])];
            for (const check of checks) {
                if (!picked.has(check.index) || !check.result) continue;
                const layer = features[check.index];
                const regions = check.result.pieces.length
                    ? await requestGeometry({
                          kind: "removeRegionOverlaps",
                          regions: check.regions,
                      })
                    : check.regions;
                features[check.index] = markNoOverlaps(layer, regions);
            }
            await onFix({ ...definition, features });
        } catch (err: any) {
            setFixError(err.message ?? String(err));
        } finally {
            setFixing(false);
        }
    };

    /** Takes the mark off a layer that can't be fixed. */
    const unmark = async (check: LayerCheck) => {
        setFixing(true);
        setFixError(null);
        try {
            const features = [...(definition.features ?? [])];
            const layer = { ...features[check.index] };
            delete layer.noOverlaps;
            features[check.index] = layer;
            await onFix({ ...definition, features });
        } catch (err: any) {
            setFixError(err.message ?? String(err));
        } finally {
            setFixing(false);
        }
    };

    const pickedChecks = checks.filter((c) => picked.has(c.index));
    const widestPicked = Math.max(
        0,
        ...pickedChecks.flatMap(
            (c) => c.result?.pieces.map((p) => p.width) ?? [],
        ),
    );

    return (
        <section className="space-y-2">
            <h2 className="text-sm font-semibold">Region overlaps</h2>
            <p className="text-xs text-muted-foreground">
                Neighbouring regions should share their borders exactly. Where
                two overlap, the app already puts a player in the first one in
                the file. Fixing a layer gives each overlap to that region, so{" "}
                <strong>players stay in the regions they were in</strong> (new
                corners are rounded to about 0.1 m), and distances to a border
                move by at most the overlap&apos;s width. A fixed layer is
                marked <code>noOverlaps</code>, which lets the app answer
                distance-to-border questions faster.
            </p>
            <div className="space-y-1">
                {checks.map((check) => {
                    const result = check.result;
                    const fixable = result && !result.hidden.length;
                    const widest = result?.pieces.length
                        ? Math.max(...result.pieces.map((p) => p.width))
                        : 0;
                    const area =
                        result?.pieces.reduce((sum, p) => sum + p.area, 0) ?? 0;
                    return (
                        <div
                            key={check.index}
                            className="rounded-md border border-border px-2 py-1.5 text-xs"
                        >
                            <div className="flex items-start gap-2">
                                <Checkbox
                                    id={`fix-layer-${check.index}`}
                                    checked={picked.has(check.index)}
                                    disabled={!fixable || fixing}
                                    onCheckedChange={(on) =>
                                        setPicked((prev) => {
                                            const next = new Set(prev);
                                            if (on === true)
                                                next.add(check.index);
                                            else next.delete(check.index);
                                            return next;
                                        })
                                    }
                                    className="mt-0.5"
                                />
                                <label
                                    htmlFor={`fix-layer-${check.index}`}
                                    className="flex-1 select-none"
                                >
                                    <span className="font-medium">
                                        {check.name}
                                    </span>{" "}
                                    <span className="text-muted-foreground">
                                        ({check.regions.length} regions)
                                    </span>
                                    {check.flagged && overlaps(check) && (
                                        <span className="block font-medium text-destructive">
                                            Marked noOverlaps, but its regions
                                            overlap: fix it or remove the mark
                                            before importing.
                                        </span>
                                    )}
                                    <span className="block text-muted-foreground">
                                        {check.error
                                            ? `Couldn't check: ${check.error}`
                                            : !result
                                              ? "Checking…"
                                              : result.hidden.length
                                                ? `Can't fix: ${result.hidden
                                                      .map(
                                                          (h) =>
                                                              `${regionName(check.regions, h.region)} lies entirely inside ${h.by.map((b) => regionName(check.regions, b)).join(" and ")}, so no one is ever in it`,
                                                      )
                                                      .join(
                                                          "; ",
                                                      )}. Remove it or move it before them.`
                                                : result.pieces.length
                                                  ? `${result.pieces.length} overlap${result.pieces.length === 1 ? "" : "s"}, ${formatArea(area)} in all, the widest about ${widest < 10 ? widest.toFixed(1) : Math.round(widest)} m; ${check.zonesTouched} hiding zone${check.zonesTouched === 1 ? "" : "s"} reach into one.`
                                                  : check.flagged
                                                    ? "No overlaps; marked noOverlaps."
                                                    : "No overlaps; not marked yet."}
                                    </span>
                                </label>
                                {check.flagged && !fixable && !!result && (
                                    <button
                                        type="button"
                                        className="shrink-0 underline"
                                        disabled={fixing}
                                        onClick={() => unmark(check)}
                                    >
                                        Remove mark
                                    </button>
                                )}
                                {!!result?.pieces.length && (
                                    <button
                                        type="button"
                                        className="shrink-0 underline"
                                        aria-pressed={shown === check.index}
                                        onClick={() => show(check)}
                                    >
                                        {shown === check.index
                                            ? "Hide"
                                            : "Show"}
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {fixError && <p className="text-xs text-destructive">{fixError}</p>}
            {pickedChecks.length > 0 && (
                <Button
                    size="sm"
                    className="w-full"
                    disabled={checking || fixing}
                    onClick={fix}
                >
                    {fixing
                        ? "Fixing…"
                        : widestPicked > 0
                          ? `Fix overlaps and mark ${pickedChecks.length} layer${pickedChecks.length === 1 ? "" : "s"}`
                          : `Mark ${pickedChecks.length} layer${pickedChecks.length === 1 ? "" : "s"} noOverlaps`}
                </Button>
            )}
        </section>
    );
}
