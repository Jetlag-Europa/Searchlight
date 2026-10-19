import "leaflet/dist/leaflet.css";

import type {
    CatalogGame,
    GameCatalogResponse,
    GameSessionSummary,
} from "@searchlight/shared";
import L from "leaflet";
import {
    BookOpen,
    CalendarDays,
    Lock,
    LogIn,
    MapPin,
    Maximize2,
    Minimize2,
    Play,
    Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    CircleMarker,
    MapContainer,
    Popup,
    Rectangle,
    TileLayer,
    Tooltip,
    useMap,
    useMapEvents,
} from "react-leaflet";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { useDebounce } from "@/hooks/useDebounce";
import { PENDING_SESSION_KEY } from "@/lib/activeSession";
import { CARTO_API_KEY } from "@/lib/basemap";
import { formatEventDate, rulesLink } from "@/lib/eventDate";
import {
    type CatalogMatch,
    type CatalogSort,
    geocodePlace,
    type Place,
    searchCatalog,
} from "@/lib/gameCatalog";
import { readStorage, writeStorage } from "@/lib/safeStorage";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
// Shorter queries name too many places to be worth geocoding.
const MIN_PLACE_QUERY = 3;

const SORT_LABELS: Record<CatalogSort, string> = {
    nearest: "Nearest",
    date: "Newest event",
    name: "Name",
};

const latLng = ([lng, lat]: [number, number]): L.LatLngTuple => [lat, lng];
const latLngBounds = ([west, south, east, north]: [
    number,
    number,
    number,
    number,
]): L.LatLngBoundsExpression => [
    [south, west],
    [north, east],
];

function formatDistance(
    { distanceKm: km, inPlace }: CatalogMatch,
    placeName: string,
): string {
    // The Default Unit setting, read directly: its atom (lib/context) would
    // pull the map's geometry code into this page.
    const miles = readStorage("localStorage", "defaultUnit") === "miles";
    const value = miles ? km! / 1.609344 : km!;
    if (inPlace || value < 1) return `In ${placeName}`;
    return `${Math.round(value).toLocaleString()} ${miles ? "mi" : "km"} from ${placeName}`;
}

const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });

// From this zoom, the map names its games and outlines their areas.
const LABEL_ZOOM = 7;

/** Frames the games found, and flies to the selected game. */
function FitMap({
    matches,
    selected,
    place,
}: {
    matches: CatalogMatch[];
    selected: CatalogGame | null;
    place: Place | null;
}) {
    const map = useMap();
    // Sorted, so reordering the same games doesn't refit.
    const framedIds = matches
        .map((m) => m.game.id)
        .sort()
        .join();

    // Refit when the games found change, not when their order does.
    useEffect(() => {
        if (matches.length === 0) return;
        const bounds = L.latLngBounds(
            matches.map((m) => latLng(m.game.center)),
        );
        if (place) bounds.extend([place.lat, place.lng]);
        map.fitBounds(bounds, { padding: [32, 32], maxZoom: 9 });
    }, [map, framedIds, place]);

    // Closing a game's card leaves the map where it is, to look around.
    useEffect(() => {
        if (!selected) {
            map.closePopup();
            return;
        }
        if (selected.bounds) {
            map.flyToBounds(latLngBounds(selected.bounds), {
                padding: [24, 24],
                duration: 0.6,
            });
        } else {
            map.flyTo(latLng(selected.center), 10, { duration: 0.6 });
        }
    }, [map, selected?.id]);

    return null;
}

/** Keeps Leaflet's size in step with its box: the page layout and full screen change it. */
function TrackSize() {
    const map = useMap();
    useEffect(() => {
        const observer = new ResizeObserver(() => map.invalidateSize());
        observer.observe(map.getContainer());
        return () => observer.disconnect();
    }, [map]);
    return null;
}

/** Scrolling zooms only where it can't trap the page's own scrolling. */
function WheelZoom({ enabled }: { enabled: boolean }) {
    const map = useMap();
    useEffect(() => {
        if (enabled) map.scrollWheelZoom.enable();
        else map.scrollWheelZoom.disable();
    }, [map, enabled]);
    return null;
}

function TrackZoom({ onZoom }: { onZoom: (zoom: number) => void }) {
    const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
    return null;
}

/** The map's card for a game: what it is, and how to play it. */
function GamePopup({
    game,
    starting,
    onPlay,
}: {
    game: CatalogGame;
    starting: boolean;
    onPlay: () => void;
}) {
    const rules = rulesLink(game.rulesUrl);
    return (
        <div className="flex w-56 flex-col gap-2 text-foreground">
            <div>
                <p className="font-semibold leading-snug">
                    {game.locked && (
                        <Lock
                            className="mr-1 inline h-3.5 w-3.5 align-[-2px]"
                            role="img"
                            aria-label="Locked"
                        />
                    )}
                    {game.name}
                </p>
                <p className="text-xs text-muted-foreground">
                    {game.serverName} ·{" "}
                    <span className="capitalize">{game.size}</span> ·{" "}
                    {game.zoneCount.toLocaleString()} hiding zones
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {game.date && (
                        <span className="flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {formatEventDate(game.date, game.endDate)}
                        </span>
                    )}
                    {game.archived && <span>Archived</span>}
                    {rules && (
                        <a
                            href={rules}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 underline hover:text-foreground"
                        >
                            <BookOpen className="h-3 w-3" />
                            Rules
                        </a>
                    )}
                </p>
            </div>
            {game.locked ? (
                game.joinUrl && (
                    <Button size="sm" variant="outline" asChild>
                        <a
                            href={game.joinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <LogIn />
                            Join {game.serverName}
                        </a>
                    </Button>
                )
            ) : (
                <Button size="sm" onClick={onPlay} disabled={starting}>
                    <Play />
                    {starting ? "Starting…" : "Play"}
                </Button>
            )}
        </div>
    );
}

function BrowserMap({
    matches,
    selected,
    hoveredId,
    place,
    startingId,
    onSelect,
    onDeselect,
    onPlay,
}: {
    matches: CatalogMatch[];
    selected: CatalogGame | null;
    hoveredId: string | null;
    place: Place | null;
    startingId: string | null;
    onSelect: (game: CatalogGame) => void;
    onDeselect: (game: CatalogGame) => void;
    onPlay: (game: CatalogGame) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [zoom, setZoom] = useState(4);
    const wide = useMediaQuery("(min-width: 1024px)");
    const markers = useRef(new Map<string, L.CircleMarker>());
    const showLabels = zoom >= LABEL_ZOOM;

    // The selected game's card opens on the map, wherever it was selected.
    useEffect(() => {
        if (selected) markers.current.get(selected.id)?.openPopup();
    }, [selected?.id]);

    // Full screen: Escape closes it, and the page behind doesn't scroll.
    useEffect(() => {
        if (!expanded) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setExpanded(false);
        };
        const overflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        window.addEventListener("keydown", onKey);
        return () => {
            document.body.style.overflow = overflow;
            window.removeEventListener("keydown", onKey);
        };
    }, [expanded]);

    return (
        <div
            className={`browse-map ${
                expanded
                    ? "fixed inset-0 z-[1100] bg-background"
                    : "relative h-[45svh] min-h-72 lg:h-full"
            }`}
        >
            <MapContainer
                center={[48, 8]}
                zoom={4}
                minZoom={2}
                scrollWheelZoom={false}
                maxBounds={[
                    [-90, -180],
                    [90, 180],
                ]}
                // globals.css makes every map full height; this one sits in the page.
                style={{ height: "100%" }}
                className={`z-0 w-full ${expanded ? "" : "rounded-lg border border-border"}`}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    url={`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                    subdomains="abcd"
                    maxZoom={20}
                    minZoom={2}
                    noWrap
                />
                <FitMap matches={matches} selected={selected} place={place} />
                <TrackSize />
                <TrackZoom onZoom={setZoom} />
                <WheelZoom enabled={expanded || wide} />
                {matches.map(({ game }) =>
                    game.bounds && (showLabels || game.id === selected?.id) ? (
                        <Rectangle
                            key={`area-${game.id}`}
                            bounds={latLngBounds(game.bounds)}
                            interactive={false}
                            pathOptions={
                                game.id === selected?.id
                                    ? {
                                          color: "#facc15",
                                          weight: 2,
                                          fillOpacity: 0.05,
                                      }
                                    : {
                                          color: game.locked
                                              ? "#6b7280"
                                              : "#e11d48",
                                          weight: 1,
                                          dashArray: "4 4",
                                          fillOpacity: 0.04,
                                      }
                            }
                        />
                    ) : null,
                )}
                {place && (
                    <CircleMarker
                        center={[place.lat, place.lng]}
                        radius={5}
                        pathOptions={{
                            color: "#ffffff",
                            fillColor: "#ffffff",
                            fillOpacity: 1,
                            weight: 1,
                        }}
                    >
                        <Tooltip direction="top">{place.label}</Tooltip>
                    </CircleMarker>
                )}
                {matches.map(({ game }) => {
                    const isSelected = game.id === selected?.id;
                    const isHovered = game.id === hoveredId;
                    return (
                        <CircleMarker
                            key={game.id}
                            ref={(marker) => {
                                if (marker)
                                    markers.current.set(game.id, marker);
                                else markers.current.delete(game.id);
                            }}
                            center={latLng(game.center)}
                            radius={isSelected ? 10 : isHovered ? 9 : 7}
                            pathOptions={{
                                color: isSelected ? "#facc15" : "#ffffff",
                                fillColor: isSelected
                                    ? "#facc15"
                                    : game.locked
                                      ? "#6b7280"
                                      : "#e11d48",
                                fillOpacity: game.locked ? 0.7 : 0.9,
                                opacity: game.locked && !isHovered ? 0.6 : 1,
                                weight: isHovered ? 3 : 2,
                            }}
                            eventHandlers={{
                                click: () => onSelect(game),
                                popupclose: () => onDeselect(game),
                            }}
                        >
                            {/* Remounted to switch: Leaflet reads `permanent` once. */}
                            <Tooltip
                                key={showLabels ? "label" : "hover"}
                                direction="top"
                                offset={[0, -6]}
                                permanent={showLabels}
                                className={showLabels ? "game-label" : ""}
                            >
                                {game.locked && !showLabels
                                    ? `${game.name} (join ${game.serverName} to play)`
                                    : game.name}
                            </Tooltip>
                            <Popup autoPan={false} closeButton={false}>
                                <GamePopup
                                    game={game}
                                    starting={startingId === game.id}
                                    onPlay={() => onPlay(game)}
                                />
                            </Popup>
                        </CircleMarker>
                    );
                })}
            </MapContainer>
            <Button
                size="icon"
                variant="secondary"
                onClick={() => setExpanded((v) => !v)}
                className="absolute right-2.5 top-2.5 z-[1000] shadow-md"
                aria-label={
                    expanded ? "Close full screen map" : "Full screen map"
                }
                title={expanded ? "Close full screen (Esc)" : "Full screen"}
            >
                {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
        </div>
    );
}

function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(
        () => window.matchMedia(query).matches,
    );
    useEffect(() => {
        const mql = window.matchMedia(query);
        const onChange = () => setMatches(mql.matches);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
    }, [query]);
    return matches;
}

function GameCard({
    match,
    place,
    selected,
    starting,
    rechecking,
    onSelect,
    onHover,
    onPlay,
    onRecheck,
}: {
    match: CatalogMatch;
    place: Place | null;
    selected: boolean;
    starting: boolean;
    rechecking: boolean;
    onSelect: () => void;
    onHover: (hovered: boolean) => void;
    onPlay: () => void;
    onRecheck: () => void;
}) {
    const { game } = match;
    const rules = rulesLink(game.rulesUrl);
    // A locked game's details are greyed out; its join actions are not.
    const dimmed = game.locked ? "opacity-50 grayscale" : "";
    return (
        <li
            id={`game-${game.id}`}
            onMouseEnter={() => onHover(true)}
            onMouseLeave={() => onHover(false)}
            className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors ${
                selected
                    ? "border-yellow-400 bg-yellow-400/5"
                    : game.locked
                      ? "border-dashed border-border"
                      : "border-border hover:bg-accent/40"
            }`}
        >
            <div className={dimmed}>
                <h2 className="font-semibold leading-snug">
                    {game.locked && (
                        <Lock
                            className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]"
                            role="img"
                            aria-label="Locked"
                        />
                    )}
                    <button
                        type="button"
                        onClick={onSelect}
                        className="text-left hover:underline"
                        title="Show on the map"
                    >
                        {game.name}
                    </button>
                </h2>
                {game.archived && (
                    <span
                        className="mb-1 inline-block rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                        title="A past event: its managers archived it. You can still play it."
                    >
                        Archived
                    </span>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                    {game.serverName} ·{" "}
                    <span className="capitalize">{game.size}</span> ·{" "}
                    {game.zoneCount.toLocaleString()} hiding zones
                </p>
            </div>
            <div className="flex items-end justify-between gap-3">
                <div
                    className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground ${dimmed}`}
                >
                    {match.near && place && (
                        <span className="flex items-center gap-1 text-foreground/80">
                            <MapPin className="h-3 w-3" />
                            {formatDistance(match, place.name)}
                        </span>
                    )}
                    {game.date ? (
                        <span className="flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            <time dateTime={game.date}>
                                {formatEventDate(game.date, game.endDate)}
                            </time>
                        </span>
                    ) : (
                        <span>Updated {formatDate(game.updatedAt)}</span>
                    )}
                    {rules && (
                        <a
                            href={rules}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 underline hover:text-foreground"
                            aria-label={`Rules of ${game.name} (opens in a new tab)`}
                        >
                            <BookOpen className="h-3 w-3" />
                            Rules
                        </a>
                    )}
                </div>
                {game.locked ? (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                        {game.joinUrl && (
                            <Button size="sm" variant="outline" asChild>
                                <a
                                    href={game.joinUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <LogIn />
                                    Join {game.serverName}
                                </a>
                            </Button>
                        )}
                        <button
                            type="button"
                            onClick={onRecheck}
                            disabled={rechecking}
                            className="text-xs text-muted-foreground underline hover:text-foreground disabled:no-underline"
                        >
                            {rechecking ? "Checking…" : "Joined? Check again"}
                        </button>
                    </div>
                ) : (
                    <Button size="sm" onClick={onPlay} disabled={starting}>
                        <Play />
                        {starting ? "Starting…" : "Play"}
                    </Button>
                )}
            </div>
        </li>
    );
}

export function GameBrowser() {
    const [games, setGames] = useState<CatalogGame[] | null>(null);
    const [unavailableServers, setUnavailableServers] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState(
        () => new URLSearchParams(window.location.search).get("q") ?? "",
    );
    const [serverId, setServerId] = useState("");
    // Nearest once the search names a place, newest event until then.
    const [sort, setSort] = useState<CatalogSort>("nearest");
    const [showArchived, setShowArchived] = useState(false);
    const [geocoded, setGeocoded] = useState<{
        query: string;
        place: Place | null;
    } | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [startingId, setStartingId] = useState<string | null>(null);
    // Servers whose membership is being rechecked.
    const [rechecking, setRechecking] = useState<ReadonlySet<string>>(
        new Set(),
    );
    const debouncedQuery = useDebounce(query.trim(), 400);

    // Throws when the catalog can't be loaded; the caller says so.
    const loadCatalog = useCallback(async () => {
        const res = await fetch(`${API_BASE}/games/catalog`, {
            credentials: "include",
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data: GameCatalogResponse = await res.json();
        setGames(data.games);
        setUnavailableServers(data.unavailableServers);
    }, []);

    const retryLoad = useCallback(() => {
        setError(null);
        loadCatalog().catch((e: Error) => setError(e.message));
    }, [loadCatalog]);

    useEffect(retryLoad, [retryLoad]);

    // Keep the search in the address, so it can be shared and survives Back.
    useEffect(() => {
        const url = new URL(window.location.href);
        if (debouncedQuery) url.searchParams.set("q", debouncedQuery);
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url);
    }, [debouncedQuery]);

    // A query that names a place also finds the games played there.
    useEffect(() => {
        if (debouncedQuery.length < MIN_PLACE_QUERY) {
            setGeocoded(null);
            return;
        }
        const controller = new AbortController();
        geocodePlace(debouncedQuery, controller.signal)
            .then((place) => setGeocoded({ query: debouncedQuery, place }))
            .catch((e: Error) => {
                if (e.name === "AbortError") return;
                console.warn("[searchlight:browse] geocoding failed:", e);
                setGeocoded({ query: debouncedQuery, place: null });
            });
        return () => controller.abort();
    }, [debouncedQuery]);

    // Only the place of the query shown applies, not one still resolving.
    const place =
        geocoded && geocoded.query === query.trim() ? geocoded.place : null;
    const effectiveSort = sort === "nearest" && !place ? "date" : sort;

    const servers = useMemo(() => {
        const names = new Map<string, string>();
        for (const game of games ?? [])
            names.set(game.serverId, game.serverName);
        return [...names].sort((a, b) => a[1].localeCompare(b[1]));
    }, [games]);

    const matches = useMemo(
        () =>
            searchCatalog(games ?? [], {
                query,
                place,
                serverId,
                sort: effectiveSort,
                showArchived,
            }),
        [games, query, place, serverId, effectiveSort, showArchived],
    );
    // Past events the current search and server filter would show.
    const archivedCount = useMemo(
        () =>
            searchCatalog(games ?? [], {
                query,
                place,
                serverId,
                sort: effectiveSort,
                showArchived: true,
            }).filter((m) => m.game.archived).length,
        [games, query, place, serverId, effectiveSort],
    );
    const nearPlace = matches.filter((m) => m.near).length;
    const lockedCount = matches.filter((m) => m.game.locked).length;
    const selected =
        matches.find((m) => m.game.id === selectedId)?.game ?? null;

    // A card's name toggles its game on the map; a pin on the map opens it.
    const selectGame = (game: CatalogGame, toggle: boolean) => {
        setSelectedId((prev) => (toggle && prev === game.id ? null : game.id));
        document
            .getElementById(`game-${game.id}`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const deselectGame = (game: CatalogGame) =>
        setSelectedId((prev) => (prev === game.id ? null : prev));

    // After joining a server on Discord: ask again, past the membership cache.
    const recheck = async (game: CatalogGame) => {
        const { serverId, serverName } = game;
        if (rechecking.has(serverId)) return;
        const setChecking = (checking: boolean) =>
            setRechecking((prev) => {
                const next = new Set(prev);
                if (checking) next.add(serverId);
                else next.delete(serverId);
                return next;
            });
        setChecking(true);
        try {
            const res = await fetch(
                `${API_BASE}/servers/${encodeURIComponent(serverId)}/membership`,
                { method: "POST", credentials: "include" },
            );
            const data = (await res.json().catch(() => ({}))) as {
                isMember?: boolean;
                message?: string;
            };
            if (!res.ok) {
                toast.error(data.message ?? `Couldn't check (${res.status})`);
                return;
            }
            if (!data.isMember) {
                toast.info(
                    `Discord doesn't list you in ${serverName} yet. Join it, then check again.`,
                );
                return;
            }
            try {
                await loadCatalog();
                toast.success(
                    `You're in ${serverName}: its games are unlocked.`,
                );
            } catch (e: unknown) {
                toast.error(
                    `You're in ${serverName}, but the games didn't reload (${(e as Error).message}). Reload the page.`,
                );
            }
        } catch (e: unknown) {
            toast.error(`Couldn't check with Discord: ${(e as Error).message}`);
        } finally {
            setChecking(false);
        }
    };

    const play = async (game: CatalogGame) => {
        setStartingId(game.id);
        try {
            const res = await fetch(`${API_BASE}/sessions`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gameId: game.id, name: game.name }),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as {
                    message?: string;
                };
                throw new Error(data.message ?? `${res.status}`);
            }
            const session: GameSessionSummary = await res.json();
            writeStorage("localStorage", PENDING_SESSION_KEY, session.id);
            window.location.href = "/map";
        } catch (e: unknown) {
            toast.error(`Couldn't start a session: ${(e as Error).message}`);
            setStartingId(null);
        }
    };

    if (error) {
        return (
            <div className="flex flex-col items-start gap-3">
                <p className="text-destructive">
                    Couldn&apos;t load the games: {error}
                </p>
                <Button size="sm" variant="outline" onClick={retryLoad}>
                    Try again
                </Button>
            </div>
        );
    }
    if (!games) return <p className="text-muted-foreground">Loading games…</p>;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 sm:flex-row">
                <label className="relative flex-1">
                    <span className="sr-only">Search games</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        type="search"
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search a city, region or game name…"
                        className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                </label>
                <div className="flex gap-2">
                    {servers.length > 1 && (
                        <select
                            aria-label="Server"
                            value={serverId}
                            onChange={(e) => setServerId(e.target.value)}
                            className="flex-1 sm:flex-none rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                            <option value="">All servers</option>
                            {servers.map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    )}
                    <select
                        aria-label="Sort by"
                        value={effectiveSort}
                        onChange={(e) => setSort(e.target.value as CatalogSort)}
                        className="flex-1 sm:flex-none rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                        {(Object.keys(SORT_LABELS) as CatalogSort[])
                            .filter((key) => key !== "nearest" || place)
                            .map((key) => (
                                <option key={key} value={key}>
                                    {SORT_LABELS[key]}
                                </option>
                            ))}
                    </select>
                </div>
            </div>

            {/* On wide screens the map stays in view beside the list. */}
            <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start lg:gap-6">
                <div className="lg:sticky lg:top-16 lg:col-start-2 lg:row-start-1 lg:h-[calc(100svh-5rem)]">
                    <BrowserMap
                        matches={matches}
                        selected={selected}
                        hoveredId={hoveredId}
                        place={nearPlace > 0 ? place : null}
                        startingId={startingId}
                        onSelect={(game) => selectGame(game, false)}
                        onDeselect={deselectGame}
                        onPlay={play}
                    />
                </div>
                <div className="flex flex-col gap-5 lg:col-start-1 lg:row-start-1">
                    <p
                        className="text-sm text-muted-foreground"
                        aria-live="polite"
                    >
                        {matches.length === 0
                            ? games.length === 0
                                ? "There are no games to show yet."
                                : `No games match “${query.trim()}”.`
                            : nearPlace > 0
                              ? `${nearPlace} ${nearPlace === 1 ? "game" : "games"} played near ${place!.label}${
                                    matches.length > nearPlace
                                        ? `, ${matches.length - nearPlace} more by name`
                                        : ""
                                }`
                              : `${matches.length} ${matches.length === 1 ? "game" : "games"}`}
                        {lockedCount === 0
                            ? ""
                            : lockedCount < matches.length
                              ? `, ${lockedCount} of them on servers you haven't joined`
                              : lockedCount === 1
                                ? ", on a server you haven't joined"
                                : ", all on servers you haven't joined"}
                    </p>
                    {archivedCount > 0 && (
                        <label className="-mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                            <input
                                type="checkbox"
                                checked={showArchived}
                                onChange={(e) =>
                                    setShowArchived(e.target.checked)
                                }
                                className="h-4 w-4 accent-current"
                            />
                            Show past events ({archivedCount} archived)
                        </label>
                    )}
                    {unavailableServers.length > 0 && (
                        <p className="text-sm text-amber-400">
                            Couldn&apos;t check your membership of{" "}
                            {unavailableServers.join(", ")} with Discord just
                            now, so their games are missing. Reload to try
                            again.
                        </p>
                    )}

                    {matches.length > 0 && (
                        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                            {matches.map((match) => (
                                <GameCard
                                    key={match.game.id}
                                    match={match}
                                    place={place}
                                    selected={match.game.id === selectedId}
                                    starting={startingId === match.game.id}
                                    rechecking={rechecking.has(
                                        match.game.serverId,
                                    )}
                                    onSelect={() =>
                                        selectGame(match.game, true)
                                    }
                                    onHover={(on) =>
                                        setHoveredId(on ? match.game.id : null)
                                    }
                                    onPlay={() => play(match.game)}
                                    onRecheck={() => recheck(match.game)}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
