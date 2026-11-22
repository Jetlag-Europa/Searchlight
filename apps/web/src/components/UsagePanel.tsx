import { useStore } from "@nanostores/react";
import { USAGE_EVENTS, type UsageResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

/** Usage counts for global admins; renders nothing for anyone else. */
export function UsagePanel() {
  const [counts, setCounts] = useState<UsageResponse["counts"] | null>(null);
  const userId = useStore(verifiedUserId);

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_BASE}/usage`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UsageResponse | null) => setCounts(data?.counts ?? null))
      .catch(() => {});
  }, [userId]);

  if (!counts) return null;
  const byEvent = new Map(counts.map((c) => [c.event, c]));

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold mb-3">Usage (UTC days)</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 pr-4 font-medium" />
            <th className="text-right py-2 px-2 font-medium">7 days</th>
            <th className="text-right py-2 px-2 font-medium">30 days</th>
            <th className="text-right py-2 pl-2 font-medium">All time</th>
          </tr>
        </thead>
        <tbody>
          {USAGE_EVENTS.map((event) => {
            const c = byEvent.get(event);
            return (
              <tr key={event} className="border-b border-border/50">
                <td className="py-2 pr-4">{event}</td>
                <td className="py-2 px-2 text-right tabular-nums">{c?.last7d ?? 0}</td>
                <td className="py-2 px-2 text-right tabular-nums">{c?.last30d ?? 0}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{c?.total ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
