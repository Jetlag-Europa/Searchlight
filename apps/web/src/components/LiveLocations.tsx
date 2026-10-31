import { useStore } from "@nanostores/react";
import * as L from "leaflet";
import { LocateFixed, MapPin, Pencil } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Circle, Marker, Tooltip } from "react-leaflet";
import { toast } from "react-toastify";

import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { RawInput } from "@/components/ui/input";
import { activeSessionId } from "@/lib/activeSession";
import { leafletMapContext } from "@/lib/context";
import {
    displayName,
    liveLocations,
    type LivePerson,
    setPersonLabel,
    setPersonShown,
    shownPeople,
    startLiveLocations,
} from "@/lib/liveLocations";
import { cn } from "@/lib/utils";

// A position older than this is drawn faded: the phone has stopped reporting.
const STALE_MS = 10 * 60_000;

function ago(timestamp: number | null, now: number): string {
    if (!timestamp) return "unknown";
    const minutes = Math.round((now - timestamp) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

function details(person: LivePerson, now: number): string {
    return [
        ago(person.timestamp, now),
        person.battery !== null &&
            `${person.battery}%${person.charging ? " charging" : ""}`,
        person.accuracy !== null && `±${Math.round(person.accuracy)} m`,
    ]
        .filter(Boolean)
        .join(" · ");
}

// Re-renders every 30 s, so "x min ago" keeps counting between polls.
function useNow(): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(id);
    }, []);
    return now;
}

const escapeHtml = (s: string) =>
    s.replace(
        /[&<>"']/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[c]!,
    );

function Avatar({
    person,
    name,
    size,
}: {
    person: LivePerson;
    name: string;
    size: number;
}) {
    return person.photoUrl ? (
        <img
            src={person.photoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="rounded-full object-cover shrink-0"
            style={{ width: size, height: size }}
        />
    ) : (
        <span
            className="rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 font-semibold"
            style={{ width: size, height: size, fontSize: size / 2 }}
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

// react-leaflet rebuilds a marker's DOM whenever its icon changes, so share
// one icon per look.
const icons = new Map<string, L.DivIcon>();
function personIcon(
    person: LivePerson,
    name: string,
    stale: boolean,
): L.DivIcon {
    const initial = name.charAt(0).toUpperCase();
    const key = `${initial}|${person.photoUrl}|${stale}`;
    let icon = icons.get(key);
    if (!icon) {
        const picture = person.photoUrl
            ? `<img src="${escapeHtml(person.photoUrl)}" referrerpolicy="no-referrer" alt="" style="width:100%;height:100%;object-fit:cover">`
            : `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:#0284c7;color:#fff;font:600 16px sans-serif">${escapeHtml(initial)}</span>`;
        icon = L.divIcon({
            className: "",
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            tooltipAnchor: [0, 22],
            html: `<div style="width:36px;height:36px;border-radius:50%;overflow:hidden;border:3px solid ${stale ? "#9ca3af" : "#0284c7"};box-shadow:0 1px 4px rgba(0,0,0,.4);background:#fff;${stale ? "filter:grayscale(1);opacity:.7" : ""}">${picture}</div>`,
        });
        icons.set(key, icon);
    }
    return icon;
}

/** The session's pinned people, inside the MapContainer. */
export function LiveLocationMarkers() {
    const $shownPeople = useStore(shownPeople);
    const { labels } = useStore(liveLocations);
    const now = useNow();
    return $shownPeople.map((person) => {
        const stale = !person.timestamp || now - person.timestamp > STALE_MS;
        const center: L.LatLngTuple = [person.lat, person.lng];
        const name = displayName(person, labels);
        return (
            <Fragment key={person.id}>
                {person.accuracy !== null && person.accuracy > 0 && (
                    <Circle
                        center={center}
                        radius={person.accuracy}
                        interactive={false}
                        pathOptions={{
                            color: stale ? "#9ca3af" : "#0284c7",
                            weight: 1,
                            fillOpacity: 0.1,
                        }}
                    />
                )}
                <Marker
                    position={center}
                    icon={personIcon(person, name, stale)}
                    zIndexOffset={1000}
                >
                    <Tooltip direction="bottom" permanent>
                        <span className="font-medium">{name}</span>
                        <span className="text-muted-foreground">
                            {" "}
                            {ago(person.timestamp, now)}
                        </span>
                    </Tooltip>
                </Marker>
            </Fragment>
        );
    });
}

const saveFailed = () => toast.error("Couldn't save the pin");

function PersonRow({
    person,
    label,
    shown,
    now,
    onGoTo,
}: {
    person: LivePerson;
    label: string | undefined;
    shown: boolean;
    now: number;
    onGoTo: () => void;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const name = label ?? person.name;

    const finishEditing = () => {
        if (editing === null) return;
        setEditing(null);
        if (editing.trim() !== (label ?? "")) {
            setPersonLabel(person.id, editing).catch(saveFailed);
        }
    };

    return (
        <li className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent">
            <Checkbox
                checked={shown}
                aria-label={`Pin ${name}`}
                onCheckedChange={(checked) =>
                    setPersonShown(person.id, checked === true).catch(
                        saveFailed,
                    )
                }
            />
            <Avatar person={person} name={name} size={28} />
            <span className="flex flex-1 flex-col min-w-0">
                {editing !== null ? (
                    <RawInput
                        autoFocus
                        value={editing}
                        maxLength={40}
                        placeholder={person.name}
                        aria-label={`Name for ${person.name}`}
                        className="h-7 text-sm"
                        onChange={(e) => setEditing(e.target.value)}
                        onBlur={finishEditing}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") finishEditing();
                            // The dialog stays open (see its onEscapeKeyDown).
                            if (e.key === "Escape") setEditing(null);
                        }}
                    />
                ) : (
                    <span className="text-sm font-medium truncate">{name}</span>
                )}
                <span className="text-xs text-muted-foreground truncate">
                    {label && `${person.name} · `}
                    {details(person, now)}
                </span>
            </span>
            <button
                type="button"
                title={`Rename ${name}'s pin`}
                onClick={() => setEditing(label ?? "")}
                className="text-muted-foreground hover:text-foreground"
            >
                <Pencil className="h-4 w-4" />
            </button>
            <button
                type="button"
                title={`Go to ${name}`}
                onClick={onGoTo}
                className="text-muted-foreground hover:text-foreground"
            >
                <LocateFixed className="h-4 w-4" />
            </button>
        </li>
    );
}

/**
 * The live locations chip in the map's chip stack, and its dialog for picking
 * and renaming the session's pins. Also runs the polling.
 */
export function LiveLocationsChip() {
    const $sessionId = useStore(activeSessionId);
    const $state = useStore(liveLocations);
    const [open, setOpen] = useState(false);
    const now = useNow();

    useEffect(() => startLiveLocations(), []);

    if (!$sessionId || $state.allowed !== true || !$state.account) return null;

    const problem = !$state.reachable || !$state.ok ? $state.error : null;
    const shownCount = $state.people.filter((p) =>
        $state.shown.includes(p.id),
    ).length;

    const goTo = (person: LivePerson) => {
        const map = leafletMapContext.get();
        map?.flyTo([person.lat, person.lng], Math.max(15, map.getZoom()));
        setOpen(false);
    };

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    "flex w-max items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border shadow-sm backdrop-blur-sm whitespace-nowrap hover:bg-accent",
                    problem ? "border-amber-500" : "border-border",
                )}
            >
                <MapPin className="h-3.5 w-3.5" />
                {shownCount > 0
                    ? `${shownCount} live location${shownCount === 1 ? "" : "s"}`
                    : "Live locations"}
                {problem && <span className="text-amber-500">!</span>}
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent
                    className="max-w-md"
                    // Escape in a pin's name field only stops renaming.
                    onEscapeKeyDown={(e) => {
                        if (document.activeElement instanceof HTMLInputElement)
                            e.preventDefault();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Live locations</DialogTitle>
                        <DialogDescription>
                            From Google Maps location sharing. Pins and their
                            names are saved with this session, for everyone in
                            it who can see live locations.
                        </DialogDescription>
                    </DialogHeader>
                    {problem && (
                        <p className="text-sm text-amber-500">
                            {problem}
                            {$state.updatedAt &&
                                ` (last read ${ago($state.updatedAt, now)})`}
                        </p>
                    )}
                    {$state.people.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {$state.reachable && $state.ok
                                ? "Nobody is sharing their location with this server's account."
                                : !problem && "Loading…"}
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {$state.people.map((person) => (
                                <PersonRow
                                    key={person.id}
                                    person={person}
                                    label={$state.labels[person.id]}
                                    shown={$state.shown.includes(person.id)}
                                    now={now}
                                    onGoTo={() => goTo(person)}
                                />
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
