import { useStore } from "@nanostores/react";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { activeSessionData, activeSessionId, setActiveSession } from "@/lib/activeSession";
import { switchToGame } from "@/lib/games";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

/**
 * Load a session's new game revision, and only once the board shows it,
 * publish it as the session's revision.
 */
export async function loadRevision(sessionId: string, revision: number, gameRevisionId: string) {
  const current = activeSessionData.get();
  if (current?.id !== sessionId || activeSessionId.get() !== sessionId) return;
  const loaded = await switchToGame({ id: current.gameId }, { revisionId: gameRevisionId, sessionId });
  const latest = activeSessionData.get();
  if (latest?.id !== sessionId || activeSessionId.get() !== sessionId) return;
  if (!loaded) throw new Error("The revision was updated, but the game board could not load. Refresh the page to try again.");
  // The creator's own upgrade also arrives as an event; both share one load.
  if (latest.gameRevisionId === gameRevisionId) return;
  // Upgrades always move to the game's current revision. That can have a
  // lower number than the one we knew, when an older definition is reimported.
  setActiveSession({
    ...latest,
    sessionRevision: revision,
    gameRevisionId,
    currentRevision: revision,
    hasNewerRevision: false,
  });
  toast.success(`Revision ${revision} loaded.`);
}

export function SessionUpgradeBanner() {
  const session = useStore(activeSessionData);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setUpdating(false);
    const handleUpgrade = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; revision: number; gameRevisionId: string }>).detail;
      if (detail?.sessionId !== session?.id || activeSessionData.get()?.gameRevisionId === detail.gameRevisionId) return;
      setUpdating(true);
      loadRevision(detail.sessionId, detail.revision, detail.gameRevisionId)
        .catch((err: Error) => setError(err.message))
        .finally(() => setUpdating(false));
    };
    window.addEventListener("session-revision-upgraded", handleUpgrade);
    return () => window.removeEventListener("session-revision-upgraded", handleUpgrade);
  }, [session?.id]);

  async function handleUpgrade() {
    if (!session || updating) return;
    setUpdating(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/sessions/${session.id}/upgrade-revision`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not update the session. Please try again.");
      const result: { newRevision: number; gameRevisionId: string } = await response.json();
      await loadRevision(session.id, result.newRevision, result.gameRevisionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the session.");
    } finally {
      setUpdating(false);
    }
  }

  if (!session || (!session.hasNewerRevision && !updating && !error)) return null;

  return (
    <section aria-label="Session game revision" aria-busy={updating}
      className="shrink-0 border-b bg-background px-3 py-2 text-foreground sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {updating ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />
            : <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          <div className="text-xs">
            <p className="font-medium" role="status">{updating ? "Updating game board…" : error ? "Game update needs attention" : "Game update available"}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span>Session revision {session.sessionRevision ?? "unknown"}</span>
              {session.hasNewerRevision && <>
                <ArrowRight aria-hidden="true" className="size-3" />
                <span>Available revision {session.currentRevision}</span>
              </>}
            </p>
          </div>
        </div>
        {error && !session.hasNewerRevision ? (
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Refresh page</Button>
        ) : session.role === "creator" ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={updating}>Review update</Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="max-w-[calc(100vw-2rem)] rounded-lg sm:max-w-lg">
              <AlertDialogHeader>
                <AlertDialogTitle>Update this session’s game board?</AlertDialogTitle>
                <AlertDialogDescription>
                  Move from revision {session.sessionRevision ?? "unknown"} to the latest revision
                  (currently {session.currentRevision}) for everyone in this session.
                  <span className="mt-3 block">
                    Your session is not restarted. Drawings, hider location, and planning mode
                    stay in place. Map results may change, and questions no longer supported
                    by the updated game may be removed.
                  </span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep current revision</AlertDialogCancel>
                <AlertDialogAction onClick={handleUpgrade}>Update session</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : !updating ? (
          <p className="text-xs text-muted-foreground">Only the session creator can update the game board.</p>
        ) : null}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
