import { useStore } from "@nanostores/react";
import {
  CASUAL_SERVER_ID,
  type ServerRolesResponse,
  type ServersResponse,
  type ServerWithPermissions,
} from "@searchlight/shared";
import { useCallback, useEffect, useState } from "react";

import { AuditLogPanel } from "@/components/AuditLogPanel";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"] as const;
const PERMISSION_LABELS: Record<string, string> = {
  "games.create": "Create games",
  "games.edit": "Edit games",
  "games.delete": "Delete games",
  "server.admin": "Server admin",
};
// Casual Games borrows JetLag EU's roles, and they can only grant creating
// Casual games: managing them is up to each game's creator and global admins.
const CASUAL_PERMISSIONS = ["games.create"] as const;

function ServerCard({ server }: { server: ServerWithPermissions }) {
  const isAdmin = server.permissions.includes("server.admin");
  const casual = server.id === CASUAL_SERVER_ID;
  const permissions = casual ? CASUAL_PERMISSIONS : PERMISSIONS;
  const [expanded, setExpanded] = useState(false);
  const [rolesData, setRolesData] = useState<ServerRolesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"roles" | "activity">("roles");

  const loadRoles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/servers/${server.id}/roles`, { credentials: "include" });
      if (res.status === 403) {
        setRolesData(null);
        throw new Error(`You no longer administer ${server.name}.`);
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `Failed to load roles: ${res.status}`);
      }
      setRolesData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [server.id, server.name]);

  const togglePermission = async (
    roleId: string,
    roleName: string,
    permission: string,
    hasIt: boolean,
  ) => {
    if (
      hasIt &&
      permission === "server.admin" &&
      !confirm(
        `Untick Server admin for ${roleName}? Anyone who is admin only through this role loses admin access, maybe you. Only another admin can give it back.`,
      )
    ) {
      return;
    }
    let failure: string | null = null;
    try {
      const res = hasIt
        ? await fetch(
            `${API_BASE}/servers/${server.id}/roles/${roleId}/permissions/${permission}`,
            {
              method: "DELETE",
              credentials: "include",
            },
          )
        : await fetch(`${API_BASE}/servers/${server.id}/roles`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discordRoleId: roleId, permission }),
          });
      // On a 403 the reload below says that admin access is gone.
      if (!res.ok && res.status !== 403) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        failure = data.message ?? `Failed to change permission: ${res.status}`;
      }
    } catch (e) {
      failure = (e as Error).message;
    }
    // Reload either way so the checkboxes show what was saved; reloading
    // clears the error, so set it after.
    await loadRoles();
    if (failure) setError(failure);
  };

  const roles = rolesData?.roles ?? [];
  const shownRoles = roles
    .filter((r) => r.name !== "@everyone")
    .sort((a, b) => b.position - a.position);
  // Mappings for roles deleted in Discord (or @everyone) get rows too, so they can be removed.
  const goneRoleIds = new Set(
    (rolesData?.mappings ?? [])
      .filter((m) => (permissions as readonly string[]).includes(m.permission))
      .map((m) => m.discordRoleId)
      .filter((id) => !shownRoles.some((r) => r.id === id)),
  );
  const rows = [
    ...shownRoles.map((r) => ({ ...r, gone: false })),
    ...[...goneRoleIds].map((id) => ({
      id,
      name: roles.find((r) => r.id === id)?.name ?? "Deleted role",
      color: 0,
      gone: true,
    })),
  ];

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !rolesData) loadRoles();
  };

  return (
    <div className="border border-border rounded-lg p-3 sm:p-4 mb-3 bg-card">
      <div className="flex justify-between items-center gap-2">
        <h3 className="font-semibold">{server.name}</h3>
        {isAdmin ? (
          <button
            onClick={handleToggleExpand}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {expanded ? "Close" : "Manage"}
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">No admin access</span>
        )}
      </div>

      {expanded && isAdmin && (
        <div className="mt-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={tab}
            onValueChange={(v) => v && setTab(v as typeof tab)}
            className="justify-start mb-3"
          >
            <ToggleGroupItem value="roles">Roles</ToggleGroupItem>
            <ToggleGroupItem value="activity">Activity</ToggleGroupItem>
          </ToggleGroup>
          {tab === "activity" && <AuditLogPanel serverId={server.id} />}
          {tab === "roles" && casual && (
            <p className="text-xs text-muted-foreground mb-2">
              These are JetLag EU&apos;s Discord roles.
            </p>
          )}
          {tab === "roles" && loading && (
            <p className="text-sm text-muted-foreground">Loading roles…</p>
          )}
          {tab === "roles" && error && <p className="text-sm text-destructive">{error}</p>}
          {tab === "roles" &&
            rolesData &&
            !loading &&
            (rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No roles found in this server.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-2 font-medium">Role</th>
                      {permissions.map((p) => (
                        <th key={p} title={p} className="text-center py-2 px-1 font-medium text-xs">
                          {casual ? "Create Casual games" : PERMISSION_LABELS[p]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((role) => (
                      <tr key={role.id} className="border-b border-border/50 hover:bg-muted/30">
                        <td
                          className={`py-2 pr-2 break-words ${role.gone ? "italic text-muted-foreground" : ""}`}
                          title={role.gone ? role.id : undefined}
                        >
                          <span
                            className="inline-block w-3 h-3 rounded-full mr-2 align-middle"
                            style={{
                              backgroundColor: role.color
                                ? `#${role.color.toString(16).padStart(6, "0")}`
                                : "#888",
                            }}
                          />
                          {role.name}
                        </td>
                        {permissions.map((perm) => {
                          const hasIt = rolesData.mappings.some(
                            (m) => m.discordRoleId === role.id && m.permission === perm,
                          );
                          return (
                            <td key={perm} className="text-center py-2 px-1">
                              <input
                                type="checkbox"
                                checked={hasIt}
                                disabled={role.gone && !hasIt}
                                onChange={() => togglePermission(role.id, role.name, perm, hasIt)}
                                className="cursor-pointer disabled:cursor-not-allowed"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function AdminPanel() {
  const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = useStore(verifiedUserId);

  // Load once AuthGuard has verified the login, which waits out a server
  // that was down when the page opened.
  useEffect(() => {
    if (!userId) return;
    fetch(`${API_BASE}/servers`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load servers: ${res.status}`);
        const data: ServersResponse = await res.json();
        setServers(data.servers);
      })
      .catch((e: Error) => setError(e.message));
  }, [userId]);

  if (error) return <p className="text-destructive">Error: {error}</p>;
  if (!servers) return <p className="text-muted-foreground">Loading…</p>;
  if (servers.length === 0) return <p className="text-muted-foreground">No servers configured.</p>;

  return (
    <div>
      {servers.map((s) => (
        <ServerCard key={s.id} server={s} />
      ))}
    </div>
  );
}
