import { useStore } from "@nanostores/react";
import {
  CASUAL_SERVER_ID,
  type DiscordRole,
  type RolePermissionEntry,
  type ServerRolesResponse,
  type ServersResponse,
  type ServerWithPermissions,
} from "@searchlight/shared";
import { useCallback,useEffect, useState } from "react";

import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin", "locations.view"] as const;
// Casual Games borrows JetLag EU's roles, and they can only grant creating
// Casual games: managing them is up to each game's creator and global admins.
const CASUAL_PERMISSIONS = ["games.create"] as const;

interface TrackerAccountStatus {
  name: string;
  // logged_out: Google ended the login; the tracker leaves it alone until
  // new cookies are uploaded.
  status: "starting" | "ok" | "error" | "logged_out";
  error: string | null;
  signedInAs: string | null;
  loggedOutAt: number | null;
  cookiesUpdatedAt: number | null;
  people: number;
}

interface LocationAccountInfo {
  account: string | null;
  canChoose: boolean;
  trackerReachable: boolean;
  status: TrackerAccountStatus | null;
  // Every account the tracker has: global admins only.
  accounts: TrackerAccountStatus[] | null;
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `HTTP ${res.status}`;
}

// Tracker stack: the Google account whose location sharing the server's
// sessions show. Its admins see whether it works and can upload new cookies
// when Google logs it out; global admins also pick the account.
function LocationAccount({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<LocationAccountInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [cookies, setCookies] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API_BASE}/servers/${serverId}/location-account`, { credentials: "include" });
    const data = res.ok ? ((await res.json()) as LocationAccountInfo) : null;
    setInfo(data);
    return data;
  }, [serverId]);

  useEffect(() => {
    load()
      .then((data) => setDraft(data?.account ?? ""))
      .catch(() => setInfo(null));
  }, [load]);

  // While the tracker tries new cookies, check back until it knows.
  const checking = info?.status?.status === "starting";
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [checking, load]);

  if (!info) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const account = draft.trim() || null;
      const res = await fetch(`${API_BASE}/servers/${serverId}/location-account`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      if (!res.ok) throw new Error(res.status === 400 ? "Use lowercase letters, digits and dashes" : `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const upload = async () => {
    setUploading(true);
    setUploadError(null);
    try {
      const res = await fetch(`${API_BASE}/servers/${serverId}/location-account/cookies`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: cookies.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      // The cookies stay out of the page once they're sent.
      setCookies("");
      setCookiesOpen(false);
      await load();
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const s = info.status;
  const loggedOut = s?.status === "logged_out";
  const broken = loggedOut || s?.status === "error";
  const status = !info.account
    ? info.canChoose
      ? "Sessions on this server show no live locations."
      : "Sessions on this server show no live locations. A global admin picks the Google account."
    : !info.trackerReachable
      ? "The location tracker isn't running."
      : !s
        ? `No cookies for "${info.account}" yet: upload them below.`
        : s.status === "starting"
          ? "Checking the login…"
          : s.status === "ok"
            ? `Working${s.signedInAs ? `, signed in as ${s.signedInAs}` : ""}: ${s.people} ${s.people === 1 ? "person shares" : "people share"} their location.`
            : loggedOut
              ? `Logged out by Google${s.loggedOutAt ? ` on ${formatTime(s.loggedOutAt)}` : ""}. The tracker stopped using this account until someone uploads new cookies.`
              : `Not working: ${s.error}`;
  const canUpload = Boolean(info.account) && info.trackerReachable;

  return (
    <div className="mb-4 rounded border border-border p-3 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">Live locations account</span>
        {!info.canChoose && info.account && <code className="text-xs text-muted-foreground">{info.account}</code>}
      </div>
      {info.canChoose && (
        <div className="mt-2 flex gap-2">
          <input
            id={`location-account-${serverId}`}
            aria-label="Live locations account"
            list={`location-accounts-${serverId}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="none"
            className="flex-1 rounded border border-border bg-background px-2 py-1"
          />
          <datalist id={`location-accounts-${serverId}`}>
            {info.accounts?.map((a) => <option key={a.name} value={a.name} />)}
          </datalist>
          <button
            onClick={save}
            disabled={saving || draft.trim() === (info.account ?? "")}
            className="px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
      <p
        role="status"
        className={`mt-2 text-xs ${loggedOut ? "text-destructive" : broken ? "text-amber-500" : "text-muted-foreground"}`}
      >
        {error ?? status}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {s?.cookiesUpdatedAt ? `Cookies from ${formatTime(s.cookiesUpdatedAt)}. ` : ""}Who sees the locations: roles
        with locations.view below.
      </p>
      {canUpload && !cookiesOpen && (
        <button
          onClick={() => setCookiesOpen(true)}
          className={`mt-2 px-3 py-1 rounded text-xs ${
            broken || !s
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "border border-border hover:bg-accent"
          }`}
        >
          {broken || !s ? "Upload new cookies" : "Replace cookies"}
        </button>
      )}
      {canUpload && cookiesOpen && (
        <div className="mt-3 space-y-2">
          <ol className="list-decimal pl-5 text-xs text-muted-foreground space-y-0.5">
            <li>In Firefox, open a private window and log in to the Google account on google.com.</li>
            <li>
              With the Cookie-Editor extension (allowed in private windows), choose Export → JSON. It copies the
              cookies.
            </li>
            <li>Paste them below and upload.</li>
            <li>Close the private window. Don&apos;t click &quot;Sign out&quot;: that ends the login for the tracker too.</li>
          </ol>
          <textarea
            aria-label="Cookie export (JSON)"
            value={cookies}
            onChange={(e) => setCookies(e.target.value)}
            placeholder='[{"domain": ".google.com", "name": "SID", …}]'
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            These cookies log in to the Google account. They go to the tracker only and aren&apos;t shown again.
          </p>
          {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
          <div className="flex gap-2">
            <button
              onClick={upload}
              disabled={uploading || !cookies.trim()}
              className="px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
            <button
              onClick={() => {
                setCookiesOpen(false);
                setCookies("");
                setUploadError(null);
              }}
              className="px-3 py-1 rounded border border-border hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServerCard({ server }: { server: ServerWithPermissions }) {
  const isAdmin = server.permissions.includes("server.admin");
  const casual = server.id === CASUAL_SERVER_ID;
  const permissions = casual ? CASUAL_PERMISSIONS : PERMISSIONS;
  const [expanded, setExpanded] = useState(false);
  const [rolesData, setRolesData] = useState<ServerRolesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/servers/${server.id}/roles`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(data.message ?? `Failed to load roles: ${res.status}`);
      }
      setRolesData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  const togglePermission = async (roleId: string, permission: string, hasIt: boolean) => {
    let failure: string | null = null;
    try {
      const res = hasIt
        ? await fetch(`${API_BASE}/servers/${server.id}/roles/${roleId}/permissions/${permission}`, {
          method: "DELETE",
          credentials: "include",
        })
        : await fetch(`${API_BASE}/servers/${server.id}/roles`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ discordRoleId: roleId, permission }),
        });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string };
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
          {casual && (
            <p className="text-xs text-muted-foreground mb-2">These are JetLag EU&apos;s Discord roles.</p>
          )}
          <LocationAccount serverId={server.id} />
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
                    {permissions.map((p) => (
                      <th key={p} className="text-center py-2 px-2 font-medium text-xs">
                        {casual ? "Create Casual games" : p}
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
                        {permissions.map((perm) => {
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
