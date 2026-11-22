import { useStore } from "@nanostores/react";
import type {
  AuditAction,
  AuditLogEntry,
  AuditLogFilters,
  AuditLogResponse,
} from "@searchlight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

const LABELS: Record<AuditAction, string> = {
  "game.create": "Imported game",
  "game.revision": "Updated game",
  "game.listing": "Changed listing",
  "game.delete": "Deleted game",
  "link.create": "Created link",
  "link.revoke": "Revoked link",
  "role.grant": "Granted permission",
  "role.revoke": "Revoked permission",
};

// "" means any.
const NO_FILTER = { serverId: "", action: "", actorId: "", targetId: "" };
type Filter = typeof NO_FILTER;

const byName = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1]);

const show = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

/** One line for an entry's details, e.g. `revision: 3, name: Old → New`. */
export function summarizeDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([key, value]) => {
      if (typeof value === "object" && value !== null && "from" in value && "to" in value) {
        return `${key}: ${show(value.from)} → ${show(value.to)}`;
      }
      return `${key}: ${show(value)}`;
    })
    .join(", ");
}

/**
 * Audit log of one server, or of all servers without `serverId`. Renders
 * nothing when the API refuses (non-global admins for the global log).
 */
export function AuditLogPanel({ serverId }: { serverId?: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState(NO_FILTER);
  const [options, setOptions] = useState<AuditLogFilters | null>(null);
  // Only the latest request's answer counts, after quick filter changes.
  const latest = useRef(0);
  const userId = useStore(verifiedUserId);

  const load = useCallback(
    (before?: string) => {
      const params = new URLSearchParams(
        Object.entries({ ...filter, serverId: serverId ?? filter.serverId }).filter(([, v]) => v),
      );
      if (before) params.set("before", before);
      // A new first page drops the old cursor, so "Load older" can't mix them.
      else setNextCursor(null);
      const request = ++latest.current;
      setLoading(true);
      fetch(`${API_BASE}/audit-log?${params}`, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: AuditLogResponse | null) => {
          if (request !== latest.current) return;
          if (!data) {
            // A refused first page hides the panel, e.g. after switching accounts.
            if (!before) setEntries(null);
            return;
          }
          setEntries((prev) => [...(before ? (prev ?? []) : []), ...data.entries]);
          setNextCursor(data.nextCursor);
        })
        .catch(() => {})
        .finally(() => {
          if (request === latest.current) setLoading(false);
        });
    },
    [serverId, filter],
  );

  useEffect(() => {
    if (userId) load();
  }, [userId, load]);

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_BASE}/audit-log/filters${serverId ? `?serverId=${serverId}` : ""}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(setOptions)
      .catch(() => {});
  }, [userId, serverId]);

  if (!entries) return null;

  const serverNames = new Map(options?.servers.map((s) => [s.id, s.name ?? s.id]));
  const select = (key: keyof Filter, label: string, any: string, choices: [string, string][]) => (
    <select
      aria-label={label}
      className="min-w-0 max-w-full border border-input rounded-md px-2 py-1 text-sm bg-background"
      value={filter[key]}
      // Another server's games don't match, so a new server clears the game.
      onChange={(e) =>
        setFilter({ ...filter, [key]: e.target.value, ...(key === "serverId" && { targetId: "" }) })
      }
    >
      <option value="">{any}</option>
      {choices.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <section className={serverId ? undefined : "mt-10"}>
      {!serverId && <h2 className="text-lg font-semibold mb-3">Audit log</h2>}
      {options && (
        <div className="flex flex-wrap gap-2 mb-3">
          {select("action", "Change", "All changes", Object.entries(LABELS))}
          {select(
            "actorId",
            "User",
            "All users",
            options.actors.map((a): [string, string] => [a.id, a.name ?? a.id]).sort(byName),
          )}
          {!serverId && select("serverId", "Server", "All servers", [...serverNames].sort(byName))}
          {select(
            "targetId",
            "Game",
            "All games",
            options.games
              .filter((g) => !filter.serverId || g.serverId === filter.serverId)
              .map((g): [string, string] => [
                g.id,
                serverId || filter.serverId ? g.name : `${g.name} (${serverNames.get(g.serverId)})`,
              ])
              .sort(byName),
          )}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity.</p>
      ) : (
        <ul className="text-sm">
          {entries.map((e) => (
            <li key={e.id} className="py-2 border-b border-border/50">
              <div className="flex flex-wrap gap-x-2">
                <span className="font-medium">{LABELS[e.action] ?? e.action}</span>
                <span className="break-all">{e.targetName}</span>
              </div>
              <div className="text-xs text-muted-foreground break-words">
                {[
                  new Date(e.createdAt).toLocaleString(),
                  e.actorId ? (e.actorName ?? e.actorId) : "System",
                  !serverId && (e.serverName ?? e.serverId),
                  summarizeDetails(e.details),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={loading}
          onClick={() => load(nextCursor)}
        >
          {loading ? "Loading…" : "Load older"}
        </Button>
      )}
    </section>
  );
}
