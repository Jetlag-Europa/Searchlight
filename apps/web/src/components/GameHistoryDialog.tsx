import type { Game } from "@searchlight/shared";

import { AuditLogPanel } from "@/components/AuditLogPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** A game's audit log, for whoever manages the game. */
export function GameHistoryDialog({ game }: { game: Game }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          History
        </Button>
      </DialogTrigger>
      {/* The title stays put while the entries scroll. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] flex-col rounded-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words pr-6">History of {game.name}</DialogTitle>
          <DialogDescription>
            Who uploaded each version and when, and who created or revoked game links.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AuditLogPanel serverId={game.serverId} gameId={game.id} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
