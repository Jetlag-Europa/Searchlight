import "leaflet/dist/leaflet.css";

import {
    type GameDefinition,
    resolveGameDefinitionId,
    validateGameDefinition,
    type ValidationIssue,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Feature, GeoJsonObject } from "geojson";
import * as L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    GeoJSON,
    MapContainer,
    Rectangle,
    ScaleControl,
    TileLayer,
    useMap,
} from "react-leaflet";

import { ImportPanel } from "@/components/ImportPanel";
import {
    type OverlapHighlight,
    RegionOverlapsPanel,
} from "@/components/RegionOverlapsPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    type CompiledGame,
    compileGameDefinition,
} from "@/game-definition/compile";
import {
    checkGameQuality,
    formatFileSize,
    type QualityIssue,
    summarizeLayers,
} from "@/game-definition/inspect";
import { CARTO_API_KEY } from "@/lib/basemap";
import { cn } from "@/lib/utils";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";

const WORLD_BOUNDS: L.LatLngBoundsExpression = [
    [-90, -180],
    [90, 180],
];
const LAYER_COLORS = [
    "#e11d48",
    "#7c3aed",
    "#0891b2",
    "#ea580c",
    "#16a34a",
    "#c026d3",
    "#ca8a04",
    "#4f46e5",
];
const layerColor = (index: number) => LAYER_COLORS[index % LAYER_COLORS.length];
const ZONE_COLOR = "#2563eb";
const PLAY_AREA_COLOR = "#111827";
const OVERLAP_COLOR = "#dc2626";

interface Loaded {
    fileName: string;
    fileSize: number;
    errors: ValidationIssue[];
    issues: QualityIssue[];
    /** The file as validated, with any fixes made on the page. */
    definition: GameDefinition | null;
    compiled: CompiledGame | null;
    /** The file names no server; the import step asks for one. */
    noServer: boolean;
    /** Changed on the page since it was loaded. */
    changed: boolean;
    /** How the file indents its JSON; empty when it is on one line. */
    indent: string;
}

// Names come from the file: hand Leaflet a text node, never an HTML string.
function bindText(layer: L.Layer, text: string) {
    const el = document.createElement("span");
    el.textContent = text;
    layer.bindTooltip(el, { sticky: true });
}

function FeatureLayer({
    data,
    name,
    color,
}: {
    data: GeoJsonObject;
    name: string;
    color: string;
}) {
    return (
        <GeoJSON
            data={data}
            // Leaflet applies `style` to points' markers too; keep theirs.
            style={(f) =>
                f?.geometry.type === "Point"
                    ? {}
                    : { color, weight: 2, fillOpacity: 0.15 }
            }
            pointToLayer={(_, latlng) =>
                L.circleMarker(latlng, {
                    radius: 5,
                    color: "#fff",
                    weight: 1,
                    fillColor: color,
                    fillOpacity: 0.9,
                })
            }
            onEachFeature={(f: Feature, l) => {
                const featureName = f.properties?.name;
                bindText(
                    l,
                    typeof featureName === "string" && featureName
                        ? featureName
                        : name,
                );
            }}
        />
    );
}

function FitBounds({
    bounds,
    maxZoom,
}: {
    bounds: [number, number, number, number];
    maxZoom?: number;
}) {
    const map = useMap();
    useEffect(() => {
        const [west, south, east, north] = bounds;
        map.fitBounds(
            [
                [south, west],
                [north, east],
            ],
            { animate: false, maxZoom },
        );
    }, [map, bounds, maxZoom]);
    return null;
}

/** The indent of a JSON file's first nested line; empty on one line. */
const indentOf = (text: string) =>
    /^\s*[{[][ \t]*\r?\n([ \t]+)/.exec(text)?.[1] ?? "";

/**
 * The file as it is saved, indented as the original was, so a downloaded
 * copy reads like it and is no larger than it needs to be.
 */
const serialize = (definition: GameDefinition, indent: string) =>
    indent
        ? `${JSON.stringify(definition, null, indent)}\n`
        : JSON.stringify(definition);

async function inspectFile(file: File): Promise<Loaded> {
    const text = await file.text();
    const indent = indentOf(text);
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (err: any) {
        return {
            fileName: file.name,
            fileSize: file.size,
            errors: [
                {
                    path: "/",
                    code: "json",
                    message: `Not JSON: ${err.message}`,
                },
            ],
            issues: [],
            definition: null,
            compiled: null,
            noServer: false,
            changed: false,
            indent,
        };
    }
    // The import step fills in the server picked there.
    let noServer = false;
    if (parsed && typeof parsed === "object" && !parsed.serverId) {
        parsed.serverId = "home-games";
        noServer = true;
    }
    return inspectDefinition(
        parsed,
        file.name,
        file.size,
        noServer,
        false,
        indent,
    );
}

async function inspectDefinition(
    parsed: any,
    fileName: string,
    fileSize: number,
    noServer: boolean,
    changed: boolean,
    indent: string,
): Promise<Loaded> {
    const result: Loaded = {
        fileName,
        fileSize,
        errors: [],
        issues: [],
        definition: null,
        compiled: null,
        noServer,
        changed,
        indent,
    };
    const validation = validateGameDefinition(parsed);
    if (!validation.valid) {
        result.errors = validation.errors;
        return result;
    }
    result.definition = parsed as GameDefinition;
    // The checker loads lazily: after a deploy its chunk may be gone.
    try {
        result.issues = await checkGameQuality(parsed, fileSize);
    } catch (err: any) {
        result.issues = [
            {
                level: "warning",
                path: "/",
                message: `Checks couldn't run: ${err.message}`,
                strict: false,
            },
        ];
    }
    try {
        result.compiled = compileGameDefinition(parsed as GameDefinition);
    } catch (err: any) {
        result.errors = [
            {
                path: "/",
                code: "compile",
                message: `The app can't load it: ${err.message}`,
            },
        ];
    }
    return result;
}

function Toggle({
    id,
    checked,
    onChange,
    color,
    children,
}: {
    id: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    color?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-start gap-2 py-1">
            <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(v) => onChange(v === true)}
                className="mt-0.5"
            />
            <label
                htmlFor={id}
                className="flex-1 cursor-pointer select-none text-sm leading-tight"
            >
                {color && (
                    <span
                        className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle ring-1 ring-white/50"
                        style={{ backgroundColor: color }}
                    />
                )}
                {children}
            </label>
        </div>
    );
}

function IssueList({ issues }: { issues: QualityIssue[] }) {
    const styles = {
        error: "border-destructive/50 bg-destructive/10 text-destructive",
        warning:
            "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        note: "border-border bg-muted/40 text-muted-foreground",
        strict: "border-orange-600/60 bg-orange-500/15 text-orange-700 dark:text-orange-300",
    };
    return (
        <div className="space-y-1">
            {issues.map((issue, idx) => (
                <div
                    key={idx}
                    className={cn(
                        "rounded-md border px-2 py-1.5 text-xs",
                        styles[issue.strict ? "strict" : issue.level],
                    )}
                >
                    <span className="mr-1 font-semibold uppercase">
                        {issue.strict ? "defect" : issue.level}
                    </span>
                    <span className="font-mono opacity-80">{issue.path}:</span>{" "}
                    {issue.message}
                </div>
            ))}
        </div>
    );
}

export function GameDesigner({
    mode = "designer",
}: {
    /** "import" adds the import step, for the import page. */
    mode?: "designer" | "import";
}) {
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [highlight, setHighlight] = useState<OverlapHighlight | null>(null);
    // Null until the layers marked noOverlaps have been checked.
    const [wrongMarks, setWrongMarks] = useState<string[] | null>(null);
    // Counts files picked, not fixes, so the import step starts over (and
    // takes the new file's server) only for a new file.
    const [fileCount, setFileCount] = useState(0);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [loadCount, setLoadCount] = useState(0);
    const [shownLayers, setShownLayers] = useState<Set<number>>(new Set());
    const [showZones, setShowZones] = useState(true);
    const [showPlayArea, setShowPlayArea] = useState(true);
    const [showBounds, setShowBounds] = useState(true);
    const latestLoad = useRef(0);
    const panel = useRef<HTMLElement>(null);

    const loadFile = async (file: File) => {
        const load = ++latestLoad.current;
        setBusy(true);
        try {
            const result = await inspectFile(file);
            if (load !== latestLoad.current) return;
            setLoaded(result);
            setLoadCount((c) => c + 1);
            setShownLayers(new Set());
            setHighlight(null);
            setWrongMarks([]);
            setFileCount((c) => c + 1);
            // Show the new file's summary and checks first.
            panel.current?.scrollTo({ top: 0 });
        } finally {
            if (load === latestLoad.current) setBusy(false);
        }
    };

    /** Takes the file as fixed on the page, and checks it again. */
    const applyFix = async (fixed: GameDefinition) => {
        if (!loaded) return;
        const load = ++latestLoad.current;
        setBusy(true);
        try {
            const result = await inspectDefinition(
                fixed,
                loaded.fileName,
                new Blob([serialize(fixed, loaded.indent)]).size,
                loaded.noServer,
                true,
                loaded.indent,
            );
            if (load !== latestLoad.current) return;
            setLoaded(result);
            setLoadCount((c) => c + 1);
        } finally {
            if (load === latestLoad.current) setBusy(false);
        }
    };

    const download = () => {
        if (!loaded?.definition) return;
        const definition: Partial<GameDefinition> = { ...loaded.definition };
        // Leave out the stand-in server the page filled in.
        if (loaded.noServer) delete definition.serverId;
        const url = URL.createObjectURL(
            new Blob([serialize(definition as GameDefinition, loaded.indent)], {
                type: "application/json",
            }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = loaded.fileName;
        link.click();
        URL.revokeObjectURL(url);
    };

    const compiled = loaded?.compiled ?? null;
    const layers = useMemo(
        () => (compiled ? summarizeLayers(compiled) : []),
        [compiled],
    );
    const zones = useMemo(
        () => (compiled ? hidingZoneCircles(compiled) : []),
        [compiled],
    );
    const errors: QualityIssue[] = (loaded?.errors ?? []).map((e) => ({
        level: "error",
        path: e.path,
        message: e.message,
        strict: false,
    }));
    const issues = [...errors, ...(loaded?.issues ?? [])];
    const definition = compiled?.definition;
    const { baseRadius } = compiled?.hidingZones ?? {};
    const tiers = Object.entries(definition?.hidingZones?.tierOverrides ?? {});

    const toggleLayer = (index: number, on: boolean) =>
        setShownLayers((prev) => {
            const next = new Set(prev);
            if (on) next.add(index);
            else next.delete(index);
            return next;
        });

    return (
        <div
            className="flex min-h-dvh flex-col md:h-dvh md:flex-row"
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragging(true);
            }}
            onDragLeave={(e) => {
                // Moving onto a child isn't leaving the page.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragging(false);
                }
            }}
            onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) loadFile(file);
            }}
        >
            <div className="relative h-[55dvh] shrink-0 overflow-hidden md:h-auto md:flex-1">
                <MapContainer
                    center={[20, 0]}
                    zoom={2}
                    minZoom={2}
                    preferCanvas
                    className="!h-full w-full"
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>'
                        url={`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                        subdomains="abcd"
                        maxZoom={20}
                        minZoom={2}
                        noWrap
                        bounds={WORLD_BOUNDS}
                    />
                    <ScaleControl position="bottomleft" />
                    {compiled && (
                        <>
                            <FitBounds bounds={compiled.bounds} />
                            {showBounds && (
                                <Rectangle
                                    bounds={[
                                        [
                                            compiled.bounds[1],
                                            compiled.bounds[0],
                                        ],
                                        [
                                            compiled.bounds[3],
                                            compiled.bounds[2],
                                        ],
                                    ]}
                                    pathOptions={{
                                        color: "#6b7280",
                                        weight: 1,
                                        dashArray: "6 4",
                                        fill: false,
                                    }}
                                />
                            )}
                            {showPlayArea && (
                                <GeoJSON
                                    key={`play-area-${loadCount}`}
                                    data={compiled.playArea}
                                    style={{
                                        color: PLAY_AREA_COLOR,
                                        weight: 2,
                                        fillOpacity: 0.05,
                                    }}
                                />
                            )}
                            {showZones && (
                                <GeoJSON
                                    key={`zones-${loadCount}`}
                                    data={turf.featureCollection(zones)}
                                    style={{
                                        color: ZONE_COLOR,
                                        weight: 1.5,
                                        fillOpacity: 0.1,
                                    }}
                                    onEachFeature={(f, l) => {
                                        const { name, tier } =
                                            f.properties?.properties ?? {};
                                        bindText(
                                            l,
                                            tier ? `${name} (${tier})` : name,
                                        );
                                    }}
                                />
                            )}
                            {layers
                                .filter((layer) => shownLayers.has(layer.index))
                                .map((layer) => (
                                    <FeatureLayer
                                        key={`layer-${loadCount}-${layer.index}`}
                                        data={
                                            definition!.features![layer.index]
                                                .data
                                        }
                                        name={layer.name}
                                        color={layerColor(layer.index)}
                                    />
                                ))}
                            {highlight && (
                                <>
                                    <GeoJSON
                                        key={`overlaps-${loadCount}-${highlight.focus.join()}`}
                                        data={turf.featureCollection(
                                            highlight.pieces,
                                        )}
                                        style={{
                                            color: OVERLAP_COLOR,
                                            weight: 4,
                                            fillOpacity: 0.5,
                                        }}
                                    />
                                    <FitBounds
                                        bounds={
                                            highlight.focus as [
                                                number,
                                                number,
                                                number,
                                                number,
                                            ]
                                        }
                                        maxZoom={16}
                                    />
                                </>
                            )}
                        </>
                    )}
                </MapContainer>
                {dragging && (
                    <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-background/70 text-lg font-semibold">
                        Drop the game file
                    </div>
                )}
            </div>

            <aside
                ref={panel}
                className={cn(
                    "space-y-5 border-border p-4 md:w-96 md:overflow-y-auto md:border-l",
                    // Room for the account chip in the corner.
                    mode === "import" && "pt-14",
                )}
            >
                <div>
                    {mode === "import" ? (
                        <>
                            <a
                                href="/games"
                                className="text-xs text-muted-foreground underline"
                            >
                                ← Games
                            </a>
                            <h1 className="text-xl font-bold">Import a game</h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Check a <code>*.game.json</code> on the map, fix
                                what the page can, then import it. No file yet?
                                Follow the{" "}
                                <a
                                    href="/skills/create-game.md"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                >
                                    game creation guide
                                </a>
                                , or give it to an AI agent along with your
                                rules doc and map links.
                            </p>
                        </>
                    ) : (
                        <>
                            <h1 className="text-xl font-bold">Game designer</h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                See a <code>*.game.json</code> on the map and
                                check it before importing it. The file stays in
                                your browser.
                            </p>
                        </>
                    )}
                </div>

                <label
                    className={cn(
                        "block cursor-pointer rounded-lg border-2 border-dashed border-border p-4 text-center text-sm hover:bg-muted/40",
                        dragging && "bg-muted/40",
                    )}
                >
                    <span className="font-medium">
                        {busy
                            ? "Checking…"
                            : loaded
                              ? "Drop or pick another file"
                              : "Drop a game file here, or pick one"}
                    </span>
                    {loaded && (
                        <span className="mt-1 block break-all text-xs text-muted-foreground">
                            {loaded.fileName} ({formatFileSize(loaded.fileSize)}
                            )
                        </span>
                    )}
                    <input
                        type="file"
                        accept=".json,application/json"
                        className="sr-only"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) loadFile(file);
                        }}
                    />
                </label>

                {compiled && definition && (
                    <section className="space-y-1 text-sm">
                        <h2 className="text-base font-semibold">
                            {compiled.name}
                        </h2>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                            <dt className="text-muted-foreground">ID</dt>
                            <dd className="font-mono">
                                {resolveGameDefinitionId(definition)}
                            </dd>
                            <dt className="text-muted-foreground">Revision</dt>
                            <dd>{definition.revision ?? "not set"}</dd>
                            <dt className="text-muted-foreground">Server</dt>
                            <dd className="break-all">
                                {loaded?.noServer
                                    ? "not set (picked on import)"
                                    : definition.serverId}
                            </dd>
                            <dt className="text-muted-foreground">
                                Hiding zones
                            </dt>
                            <dd>
                                {zones.length}
                                {baseRadius &&
                                    `, ${baseRadius.value} ${baseRadius.unit}`}
                                {tiers.length > 0 &&
                                    ` (${tiers.map(([t, r]) => `${t} ${r}`).join(", ")})`}
                            </dd>
                            <dt className="text-muted-foreground">Layers</dt>
                            <dd>{layers.length}</dd>
                            <dt className="text-muted-foreground">Size</dt>
                            <dd>{compiled.size}</dd>
                        </dl>
                    </section>
                )}

                {loaded && (
                    <section className="space-y-2">
                        <h2 className="text-sm font-semibold">
                            {issues.length
                                ? `Checks: ${countLabel(issues)}`
                                : "Checks: nothing to report"}
                        </h2>
                        {issues.some((i) => i.strict) && (
                            <p className="text-xs text-muted-foreground">
                                Defects are warnings that are always data
                                mistakes; preloaded games must have none.
                            </p>
                        )}
                        <IssueList issues={issues} />
                    </section>
                )}

                {loaded?.definition && compiled && (
                    <RegionOverlapsPanel
                        definition={loaded.definition}
                        zones={zones}
                        onFix={applyFix}
                        onHighlight={setHighlight}
                        onWrongMarks={setWrongMarks}
                    />
                )}

                {loaded?.changed && loaded.definition && (
                    <section className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
                        <p>
                            The file was changed on this page. Download it to
                            keep your copy in step, or the next import of your
                            old copy will undo the fixes.
                        </p>
                        <Button size="sm" variant="outline" onClick={download}>
                            Download {loaded.fileName}
                        </Button>
                    </section>
                )}

                {mode === "import" && loaded?.definition && compiled && (
                    <ImportPanel
                        key={fileCount}
                        busy={busy || !wrongMarks}
                        blocked={
                            wrongMarks?.length
                                ? `${wrongMarks.join(", ")} ${wrongMarks.length === 1 ? "is" : "are"} marked noOverlaps but overlap: fix ${wrongMarks.length === 1 ? "it" : "them"} or remove the mark above first.`
                                : null
                        }
                        definition={loaded.definition}
                        noServer={loaded.noServer}
                    />
                )}

                {compiled && (
                    <section>
                        <h2 className="mb-1 text-sm font-semibold">Show</h2>
                        <Toggle
                            id="show-play-area"
                            checked={showPlayArea}
                            onChange={setShowPlayArea}
                            color={PLAY_AREA_COLOR}
                        >
                            Play area
                        </Toggle>
                        <Toggle
                            id="show-bounds"
                            checked={showBounds}
                            onChange={setShowBounds}
                            color="#6b7280"
                        >
                            Map bounds
                        </Toggle>
                        <Toggle
                            id="show-zones"
                            checked={showZones}
                            onChange={setShowZones}
                            color={ZONE_COLOR}
                        >
                            Hiding zones ({zones.length})
                        </Toggle>
                        {layers.map((layer) => (
                            <Toggle
                                key={layer.index}
                                id={`show-layer-${layer.index}`}
                                checked={shownLayers.has(layer.index)}
                                onChange={(on) => toggleLayer(layer.index, on)}
                                color={layerColor(layer.index)}
                            >
                                {layer.name}
                                <span className="block text-xs text-muted-foreground">
                                    {layer.featureCount === 0
                                        ? "no features"
                                        : `${layer.featureCount} ${
                                              layer.featureCount === 1
                                                  ? layer.geometry.replace(
                                                        /s$/,
                                                        "",
                                                    )
                                                  : layer.geometry
                                          }`}
                                    {layer.questions.length > 0
                                        ? ` · ${layer.questions.join(", ")}`
                                        : " · no questions"}
                                </span>
                            </Toggle>
                        ))}
                    </section>
                )}

                {compiled && (
                    <section>
                        <h2 className="mb-1 text-sm font-semibold">
                            Questions offered ({compiled.questions.length})
                        </h2>
                        <ul className="space-y-0.5 text-xs">
                            {compiled.questions.map((q) => (
                                <li key={q.id}>
                                    {q.label}{" "}
                                    <span className="font-mono text-muted-foreground">
                                        {q.id}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {mode === "designer" && (
                            <p className="mt-3 text-xs text-muted-foreground">
                                Looks right?{" "}
                                <a href="/games/import" className="underline">
                                    Import it
                                </a>
                                .
                            </p>
                        )}
                    </section>
                )}
            </aside>
        </div>
    );
}

function countLabel(issues: QualityIssue[]) {
    const count = (level: QualityIssue["level"], word: string) => {
        const n = issues.filter((i) => i.level === level).length;
        return n ? `${n} ${word}${n === 1 ? "" : "s"}` : null;
    };
    return [
        count("error", "error"),
        count("warning", "warning"),
        count("note", "note"),
    ]
        .filter(Boolean)
        .join(", ");
}
