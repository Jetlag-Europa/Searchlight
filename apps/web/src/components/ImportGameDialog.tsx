import type { GameDefinition, GameImportResponse, ValidationIssue } from "@searchlight/shared";
import { resolveGameDefinitionId, validateGameDefinition } from "@searchlight/shared";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { importGameDefinitionAPI } from "@/game-definition/api";
import { checkGameQuality, type QualityIssue } from "@/game-definition/inspect";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

type ServerOption = { id: string; name: string; permissions?: string[] };

// The import API accepts any of these (games.create for new games,
// games.edit for updates, server.admin for both).
const IMPORT_PERMISSIONS = ["games.create", "games.edit", "server.admin"];
const canImportTo = (server: ServerOption) =>
  !server.permissions ||
  server.permissions.some((p) => IMPORT_PERMISSIONS.includes(p));

interface ImportGameDialogProps {
  serverId?: string;
  servers?: ServerOption[];
  onImported: () => void;
  trigger?: React.ReactNode;
}

export function ImportGameDialog({
  serverId,
  servers: initialServers,
  onImported,
  trigger,
}: ImportGameDialogProps) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerOption[]>(
    (initialServers || []).filter(canImportTo),
  );
  const [selectedServerId, setSelectedServerId] = useState<string>(serverId || "");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<GameDefinition | null>(null);
  const [allowUpdate, setAllowUpdate] = useState<boolean>(true);
  const [unlisted, setUnlisted] = useState<boolean>(false);
  const [validationErrors, setValidationErrors] = useState<ValidationIssue[]>([]);
  // The validator's warnings and the game checker's warnings and notes.
  const [validationWarnings, setValidationWarnings] = useState<QualityIssue[]>([]);
  const latestCheck = useRef(0);
  const [dryRunResult, setDryRunResult] = useState<GameImportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  // Load server list if not provided
  useEffect(() => {
    if (!initialServers || initialServers.length === 0) {
      fetch(`${API_BASE}/servers`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.servers) {
            const importable = (data.servers as ServerOption[]).filter(canImportTo);
            setServers(importable);
            if (!selectedServerId && importable.length > 0) {
              setSelectedServerId(importable[0].id);
            }
          }
        })
        .catch(() => {});
    }
  }, [initialServers]);

  const resetState = () => {
    setFileName(null);
    setParsedData(null);
    setValidationErrors([]);
    setValidationWarnings([]);
    latestCheck.current++;
    setDryRunResult(null);
    setApiError(null);
    setUnlisted(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiError(null);
    setDryRunResult(null);
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setParsedData(null);
    setValidationErrors([]);
    setValidationWarnings([]);
    const check = ++latestCheck.current;

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);

        // Determine server ID: use file's serverId if present, else current selection
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const targetServer = parsed.serverId || selectedServerId || servers[0]?.id || "";
          parsed.serverId = targetServer;
          if (typeof targetServer === "string") setSelectedServerId(targetServer);
        }

        const validation = validateGameDefinition(parsed);
        setValidationErrors(validation.errors);
        const warnings = validation.warnings.map((w): QualityIssue => ({ ...w, level: "warning", strict: false }));
        setValidationWarnings(warnings);
        setParsedData(validation.valid ? parsed as GameDefinition : null);

        // Play-quality checks; they never block the import.
        if (validation.valid) {
          checkGameQuality(parsed, file.size)
            .then((issues) => {
              if (check === latestCheck.current) setValidationWarnings([...warnings, ...issues]);
            })
            .catch(() => {});
        }

        // Auto dry-run test
        if (validation.valid) {
          try {
            const preview = await importGameDefinitionAPI(parsed, true, allowUpdate);
            setDryRunResult(preview);
          } catch (err: any) {
            setApiError(err.message || "Failed to inspect game collision");
          }
        }
      } catch (err: any) {
        setApiError(`Failed to parse JSON file: ${err.message}`);
        setParsedData(null);
      }
    };
    reader.readAsText(file);
  };

  const handleServerChange = async (newServerId: string) => {
    setSelectedServerId(newServerId);
    if (parsedData) {
      const updated = { ...parsedData, serverId: newServerId };
      setParsedData(updated);
      try {
        const preview = await importGameDefinitionAPI(updated, true, allowUpdate);
        setDryRunResult(preview);
        setApiError(null);
      } catch (err: any) {
        setApiError(err.message || "Server check failed");
      }
    }
  };

  const handleAllowUpdateToggle = async (checked: boolean) => {
    setAllowUpdate(checked);
    if (parsedData) {
      try {
        const preview = await importGameDefinitionAPI(parsedData, true, checked);
        setDryRunResult(preview);
        setApiError(null);
      } catch (err: any) {
        setApiError(err.message || "Dry run failed");
      }
    }
  };

  const handleImport = async () => {
    if (!parsedData) return;
    setLoading(true);
    setApiError(null);
    try {
      const toSend = { ...parsedData, serverId: selectedServerId };
      await importGameDefinitionAPI(toSend, false, allowUpdate, unlisted);
      setOpen(false);
      resetState();
      onImported();
    } catch (err: any) {
      setApiError(err.message || "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const gameId = parsedData ? resolveGameDefinitionId(parsedData) : "";
  // Root `unit` takes precedence over hidingZones.unit, as in the compiler.
  const unit = parsedData?.unit ?? parsedData?.hidingZones?.unit ?? "meters";
  const hidingRadius = parsedData?.hidingZones?.radius ?? 400;
  // The file's server may not be one the user can import to; show it anyway
  // so the selector matches where the import is sent.
  const unknownServer =
    selectedServerId && !servers.some((s) => s.id === selectedServerId)
      ? selectedServerId
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetState();
      }}
    >
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            Import JSON Game
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Game Definition</DialogTitle>
          <DialogDescription>
            Upload a game definition JSON file to import a new map or update an existing map.
            No file yet? Follow the{" "}
            <a
              href="/skills/create-game.md"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              game creation guide
            </a>
            , or give it to an AI agent along with your rules doc and map links.{" "}
            <a href="/designer" target="_blank" rel="noreferrer" className="underline">
              Preview a file on the map
            </a>{" "}
            before importing it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              Select Game Definition (.json)
            </label>
            <input
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="block w-full text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
            />
          </div>

          {fileName && parsedData && (
            <div className="border border-border rounded-lg p-3 text-sm space-y-3 bg-muted/40">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-base">{parsedData.name || "Unnamed Game"}</div>
                  <div className="text-xs text-muted-foreground font-mono">ID: {gameId}</div>
                </div>
                {dryRunResult && (
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${
                      dryRunResult.status === "created"
                        ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                        : dryRunResult.status === "updated"
                        ? "bg-blue-500/20 text-blue-600 dark:text-blue-400"
                        : "bg-slate-500/20 text-slate-600 dark:text-slate-400"
                    }`}
                  >
                    {dryRunResult.status === "created"
                      ? "New Map"
                      : dryRunResult.status === "updated"
                      ? `Update (Rev ${dryRunResult.revision})`
                      : "Identical (Up to date)"}
                  </span>
                )}
              </div>

              {/* Server selector */}
              {(servers.length > 0 || unknownServer) && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Target Server
                  </label>
                  <select
                    className="w-full border border-input rounded-md px-2.5 py-1.5 text-sm bg-background"
                    value={selectedServerId}
                    onChange={(e) => handleServerChange(e.target.value)}
                  >
                    {unknownServer && (
                      <option value={unknownServer}>
                        {unknownServer} (from file)
                      </option>
                    )}
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.id === "home-games" ? "Virtual" : s.id})
                      </option>
                    ))}
                  </select>
                  {unknownServer && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      Not one of the servers you can import to. The import will be refused unless you have game permissions there.
                    </p>
                  )}
                </div>
              )}

              {/* Game stats */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/50">
                <div>
                  Hiding Zones:{" "}
                  <span className="text-foreground font-medium">
                    {parsedData.hidingZones?.features?.features?.length ?? 0}
                  </span>
                </div>
                <div>
                  Hiding Radius:{" "}
                  <span className="text-foreground font-medium">
                    {hidingRadius} {unit}
                  </span>
                </div>
                <div>
                  POI Layers:{" "}
                  <span className="text-foreground font-medium">
                    {parsedData.features?.length ?? 0}
                  </span>
                </div>
                <div>
                  Radars:{" "}
                  <span className="text-foreground font-medium">
                    {Array.isArray(parsedData.radars)
                      ? `${parsedData.radars.join(", ")} ${unit}`
                      : parsedData.radars === true
                      ? `${hidingRadius} ${unit}`
                      : "Off"}
                  </span>
                </div>
                <div>
                  Thermometer:{" "}
                  <span className="text-foreground font-medium">
                    {parsedData.thermometer === true ? "On" : "Off"}
                  </span>
                </div>
              </div>

              {/* Collision & Update Option */}
              <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                <input
                  type="checkbox"
                  id="allow-update-checkbox"
                  checked={allowUpdate}
                  onChange={(e) => handleAllowUpdateToggle(e.target.checked)}
                  className="rounded border-input h-4 w-4"
                />
                <label
                  htmlFor="allow-update-checkbox"
                  className="text-xs font-medium cursor-pointer text-foreground select-none"
                >
                  Allow updating if a map with ID <code>{gameId}</code> already exists
                </label>
              </div>

              {/* Listing applies to new games; existing ones change it on the games page */}
              {dryRunResult?.status === "created" && (
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id="unlisted-checkbox"
                    checked={unlisted}
                    onChange={(e) => setUnlisted(e.target.checked)}
                    className="rounded border-input h-4 w-4 mt-0.5"
                  />
                  <label
                    htmlFor="unlisted-checkbox"
                    className="text-xs cursor-pointer text-foreground select-none"
                  >
                    <span className="font-medium">Unlisted</span>
                    <span className="block text-muted-foreground">
                      Not offered when creating a session, for anyone. Sessions start from game links; it stays on this page.
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {validationErrors.length > 0 && (
            <div className="border border-destructive/50 bg-destructive/10 text-destructive rounded-lg p-3 text-sm space-y-1 max-h-36 overflow-y-auto">
              <div className="font-semibold">Validation Errors ({validationErrors.length}):</div>
              {validationErrors.map((e, idx) => (
                <div key={idx} className="text-xs">
                  <span className="font-mono text-muted-foreground">{e.path}:</span> {e.message}
                </div>
              ))}
            </div>
          )}

          {validationWarnings.length > 0 && (
            <div className="border border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg p-3 text-sm space-y-1 max-h-40 overflow-y-auto">
              <div className="font-semibold">
                Warnings and notes ({validationWarnings.length}); the file still imports:
              </div>
              {validationWarnings.map((w, idx) => (
                <div
                  key={idx}
                  className={`text-xs ${
                    w.strict
                      ? "text-red-600 dark:text-red-400"
                      : w.level === "note"
                      ? "text-muted-foreground"
                      : ""
                  }`}
                >
                  <span className="font-semibold uppercase">{w.strict ? "Defect" : w.level}</span>{" "}
                  <span className="font-mono">{w.path}:</span> {w.message}
                </div>
              ))}
              {validationWarnings.some((w) => w.strict) && (
                <div className="text-xs text-muted-foreground pt-1">
                  Defects are always data mistakes (preloaded games must have none).
                </div>
              )}
            </div>
          )}

          {apiError && (
            <div className="border border-destructive/50 bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
              {apiError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={!parsedData || validationErrors.length > 0 || loading}
          >
            {loading
              ? "Saving..."
              : dryRunResult?.status === "updated"
              ? "Update Map"
              : "Import Map"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
