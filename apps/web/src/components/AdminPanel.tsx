import type { DiscordRole, RolePermissionEntry, ServerRolesResponse,ServersResponse, ServerWithPermissions } from "@searchlight/shared";
import { useCallback,useEffect, useState } from "react";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"] as const;

function ServerCard({ server }: { server: ServerWithPermissions }) {
  const isAdmin = server.permissions.includes("server.admin");
  const [expanded, setExpanded] = useState(false);
  const [rolesData, setRolesData] = useState<ServerRolesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/servers/${server.id}/roles`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load roles: ${res.status}`);
      setRolesData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  const togglePermission = async (roleId: string, permission: string, hasIt: boolean) => {
    if (hasIt) {
      await fetch(`${API_BASE}/servers/${server.id}/roles/${roleId}/permissions/${permission}`, {
        method: "DELETE",
        credentials: "include",
      });
    } else {
      await fetch(`${API_BASE}/servers/${server.id}/roles`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordRoleId: roleId, permission }),
      });
    }
    await loadRoles();
  };

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !rolesData) loadRoles();
  };

  return (
    <div className="border border-border rounded-lg p-4 mb-4 bg-card">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">{server.name}</h2>
        {isAdmin ? (
          <button
            onClick={handleToggleExpand}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {expanded ? "Collapse" : "Manage Roles"}
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">No admin access</span>
        )}
      </div>

      {expanded && isAdmin && (
        <div className="mt-4">
          {loading && <p className="text-sm text-muted-foreground">Loading roles…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {rolesData && !loading && (
            rolesData.roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No roles found in this server.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 font-medium">Role</th>
                    {PERMISSIONS.map((p) => (
                      <th key={p} className="text-center py-2 px-2 font-medium text-xs">
                        {p}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(rolesData.roles as DiscordRole[])
                    .filter((r) => r.name !== "@everyone")
                    .sort((a, b) => b.position - a.position)
                    .map((role) => (
                      <tr key={role.id} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-2 pr-4">
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
                        {PERMISSIONS.map((perm) => {
                          const hasIt = (rolesData.mappings as RolePermissionEntry[]).some(
                            (m) => m.discordRoleId === role.id && m.permission === perm,
                          );
                          return (
                            <td key={perm} className="text-center py-2 px-2">
                              <input
                                type="checkbox"
                                checked={hasIt}
                                onChange={() => togglePermission(role.id, perm, hasIt)}
                                className="cursor-pointer"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function AdminPanel() {
  const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/servers`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load servers: ${res.status}`);
        const data: ServersResponse = await res.json();
        setServers(data.servers);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

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
