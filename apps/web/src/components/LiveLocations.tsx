import { useStore } from "@nanostores/react";
import * as L from "leaflet";
import { LocateFixed, MapPin } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Circle, Marker, Tooltip } from "react-leaflet";

import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { activeSessionId } from "@/lib/activeSession";
import { leafletMapContext } from "@/lib/context";
import {
    liveLocations,
    type LivePerson,
    setPersonShown,
    shownPeople,
    shownPersonIds,
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

function Avatar({ person, size }: { person: LivePerson; size: number }) {
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
            {person.name.charAt(0).toUpperCase()}
        </span>
    );
}

// react-leaflet rebuilds a marker's DOM whenever its icon changes, so share
// one icon per look.
const icons = new Map<string, L.DivIcon>();
function personIcon(person: LivePerson, stale: boolean): L.DivIcon {
    const key = `${person.name}|${person.photoUrl}|${stale}`;
    let icon = icons.get(key);
    if (!icon) {
        const picture = person.photoUrl
            ? `<img src="${escapeHtml(person.photoUrl)}" referrerpolicy="no-referrer" alt="" style="width:100%;height:100%;object-fit:cover">`
            : `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:#0284c7;color:#fff;font:600 16px sans-serif">${escapeHtml(person.name.charAt(0).toUpperCase())}</span>`;
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

/** The people this device shows, inside the MapContainer. */
export function LiveLocationMarkers() {
    const $shownPeople = useStore(shownPeople);
    const now = useNow();
    return $shownPeople.map((person) => {
        const stale = !person.timestamp || now - person.timestamp > STALE_MS;
        const center: L.LatLngTuple = [person.lat, person.lng];
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
                    icon={personIcon(person, stale)}
                    zIndexOffset={1000}
                >
                    <Tooltip direction="bottom" permanent>
                        <span className="font-medium">{person.name}</span>
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

/**
 * The live locations chip in the map's chip stack, and its dialog for picking
 * whom to show on this device. Also runs the polling.
 */
export function LiveLocationsChip() {
    const $sessionId = useStore(activeSessionId);
    const $state = useStore(liveLocations);
    const $shownIds = useStore(shownPersonIds);
    const [open, setOpen] = useState(false);
    const now = useNow();

    useEffect(() => startLiveLocations(), []);

    if (!$sessionId) return null;

    const problem = !$state.reachable || !$state.ok ? $state.error : null;
    const shownCount = $state.people.filter((p) =>
        $shownIds.includes(p.id),
    ).length;

    const goTo = (person: LivePerson) => {
        leafletMapContext
            .get()
            ?.flyTo(
                [person.lat, person.lng],
                Math.max(15, leafletMapContext.get()!.getZoom()),
            );
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
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Live locations</DialogTitle>
                        <DialogDescription>
                            From Google Maps location sharing. Whom you show
                            only changes this device, for this session.
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
                                ? "Nobody is sharing their location with the tracker's account."
                                : !problem && "Loading…"}
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {$state.people.map((person) => (
                                <li
                                    key={person.id}
                                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
                                >
                                    <label className="flex flex-1 min-w-0 items-center gap-3 cursor-pointer">
                                        <Checkbox
                                            checked={$shownIds.includes(
                                                person.id,
                                            )}
                                            onCheckedChange={(checked) =>
                                                setPersonShown(
                                                    person.id,
                                                    checked === true,
                                                )
                                            }
                                        />
                                        <Avatar person={person} size={28} />
                                        <span className="flex flex-col min-w-0">
                                            <span className="text-sm font-medium truncate">
                                                {person.name}
                                            </span>
                                            <span className="text-xs text-muted-foreground truncate">
                                                {details(person, now)}
                                            </span>
                                        </span>
                                    </label>
                                    <button
                                        type="button"
                                        title={`Go to ${person.name}`}
                                        onClick={() => goTo(person)}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        <LocateFixed className="h-4 w-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
