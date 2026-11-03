import { useStore } from "@nanostores/react";
import type { GoogleMapLoadsResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { verifiedUserId } from "@/lib/activeSession";
import { FREE_MAP_LOADS_PER_MONTH } from "@/lib/googleMaps";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

/** "2026-11" moved by `by` months. */
function shiftMonth(month: string, by: number): string {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + by);
    return date.toISOString().slice(0, 7);
}

/**
 * Google map loads per Discord user and per day, for the instance's admins
 * (ADMIN_DISCORD_IDS), who pay for the Google key. Hidden for everyone else.
 */
export function GoogleMapLoads() {
    const userId = useStore(verifiedUserId);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const [month, setMonth] = useState(thisMonth);
    const [data, setData] = useState<GoogleMapLoadsResponse | null>(null);
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!userId) return;
        let stale = false;
        setError(null);
        fetch(`${API_BASE}/admin/google-map-loads?month=${month}`, {
            credentials: "include",
        })
            .then(async (res) => {
                if (res.status === 403) return setHidden(true);
                if (!res.ok)
                    throw new Error(`Failed to load map loads: ${res.status}`);
                const body: GoogleMapLoadsResponse = await res.json();
                if (!stale) setData(body);
            })
            .catch((e: Error) => !stale && setError(e.message));
        return () => {
            stale = true;
        };
    }, [userId, month]);

    // Nothing until the first answer: most visitors aren't admins.
    if (hidden || (!data && !error)) return null;

    return (
        <section className="mt-10">
            <h2 className="text-lg font-semibold mb-1">Google Maps loads</h2>
            <p className="text-sm text-muted-foreground mb-3">
                Each page that shows the Google Maps basemap is one billed map
                load; {FREE_MAP_LOADS_PER_MONTH.toLocaleString("en")} a month
                are free. Counted by the app, so close to the count Google bills
                rather than exactly it. Months and days are UTC.
            </p>
            <div className="flex items-center gap-2 mb-3">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMonth(shiftMonth(month, -1))}
                >
                    Previous month
                </Button>
                <span className="font-mono text-sm" data-testid="gml-month">
                    {month}
                </span>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={month >= thisMonth}
                    onClick={() => setMonth(shiftMonth(month, 1))}
                >
                    Next month
                </Button>
            </div>
            {error && <p className="text-destructive">Error: {error}</p>}
            {!error && (!data || data.month !== month) && (
                <p className="text-muted-foreground">Loading…</p>
            )}
            {!error && data && data.month === month && (
                <>
                    <p className="mb-3" data-testid="gml-total">
                        <strong>{data.total.toLocaleString("en")}</strong> of{" "}
                        {FREE_MAP_LOADS_PER_MONTH.toLocaleString("en")} free
                        loads
                    </p>
                    {data.users.length === 0 ? (
                        <p className="text-muted-foreground">
                            No loads this month.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-8">
                            <table className="text-sm" data-testid="gml-users">
                                <thead>
                                    <tr className="text-left text-muted-foreground">
                                        <th className="pr-6 font-normal">
                                            User
                                        </th>
                                        <th className="text-right font-normal">
                                            Loads
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.users.map((u) => (
                                        <tr key={u.discordId}>
                                            <td
                                                className="pr-6"
                                                title={`${u.username} (${u.discordId})`}
                                            >
                                                {u.displayName ||
                                                    u.username ||
                                                    u.discordId}
                                            </td>
                                            <td className="text-right tabular-nums">
                                                {u.loads}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <table className="text-sm" data-testid="gml-days">
                                <thead>
                                    <tr className="text-left text-muted-foreground">
                                        <th className="pr-6 font-normal">
                                            Day
                                        </th>
                                        <th className="text-right font-normal">
                                            Loads
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.days.map((d) => (
                                        <tr key={d.day}>
                                            <td className="pr-6 font-mono">
                                                {d.day}
                                            </td>
                                            <td className="text-right tabular-nums">
                                                {d.loads}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
