import { useStore } from "@nanostores/react";
import type { AuditAction, AuditLogEntry, AuditLogResponse } from "@searchlight/shared";
import { useCallback, useEffect, useState } from "react";

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
  const userId = useStore(verifiedUserId);

  const load = useCallback(
    (before?: string) => {
      const params = new URLSearchParams();
      if (serverId) params.set("serverId", serverId);
      if (before) params.set("before", before);
      setLoading(true);
      fetch(`${API_BASE}/audit-log?${params}`, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: AuditLogResponse | null) => {
          if (!data) return;
          setEntries((prev) => [...(before ? (prev ?? []) : []), ...data.entries]);
          setNextCursor(data.nextCursor);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [serverId],
  );

  useEffect(() => {
    if (userId) load();
  }, [userId, load]);

  if (!entries) return null;

  return (
    <section className={serverId ? "mt-6" : "mt-10"}>
      {serverId ? (
        <h3 className="text-sm font-semibold mb-2">Activity</h3>
      ) : (
        <h2 className="text-lg font-semibold mb-3">Audit log</h2>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
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
