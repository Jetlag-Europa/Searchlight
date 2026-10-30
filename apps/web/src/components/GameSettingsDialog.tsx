import type { Game, GameSettingsResponse, GameSettingsUpdate } from "@searchlight/shared";
import { type FormEvent, useState } from "react";

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
import { RawInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export const GAME_NAME_MAX_LENGTH = 120;

// Station names are drawn from zoom 11 / 13 / 17 (zoneLabelMinZoom).
const SIZE_OPTIONS: Record<Game["size"], string> = {
    large: "Large: region or country",
    medium: "Medium: city",
    small: "Small: district",
};
const SIZE_HINTS: Record<Game["size"], string> = {
    large: "names from zoom 11",
    medium: "names from zoom 13",
    small: "names from zoom 17",
};

export interface GameSettingsForm {
    name: string;
    size: Game["size"];
}

/**
 * The PATCH body for the fields that differ from the game, or null when
 * there is nothing to save (no change, an invalid name or no revision).
 */
export function gameSettingsUpdate(game: Game, form: GameSettingsForm): GameSettingsUpdate | null {
    const name = form.name.trim();
    if (!game.currentRevisionId || !name || name.length > GAME_NAME_MAX_LENGTH) return null;
    const update: GameSettingsUpdate = { baseRevisionId: game.currentRevisionId };
    // A stored name with stray spaces isn't a rename until the user edits it.
    if (name !== game.name.trim()) update.name = name;
    if (form.size !== game.size) update.size = form.size;
    return update.name === undefined && update.size === undefined ? null : update;
}

/** Change a game's name and size without importing its file again. */
export function GameSettingsDialog({
    game,
    onUpdated,
}: {
    game: Game;
    onUpdated: (game: Game) => void;
}) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState<GameSettingsForm>({ name: game.name, size: game.size });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The card's copy of the game is out of date; only a reload brings the new one.
    const [stale, setStale] = useState(false);

    const update = gameSettingsUpdate(game, form);

    const handleSave = async (e: FormEvent) => {
        e.preventDefault();
        if (!update || saving) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/games/${encodeURIComponent(game.id)}/settings`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(update),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { message?: string };
                if (res.status === 409) {
                    setStale(true);
                    setError(data.message ?? "This game was changed since this page loaded.");
                    return;
                }
                if (res.status === 403) throw new Error("You can no longer edit this server’s games.");
                throw new Error(data.message ?? `${res.status}`);
            }
            const data: GameSettingsResponse = await res.json();
            onUpdated(data.game);
            setOpen(false);
        } catch (e: unknown) {
            setError(`Failed to save: ${(e as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                // Closing mid-save would hide a failure.
                if (!v && saving) return;
                setOpen(v);
                if (v) {
                    setForm({ name: game.name, size: game.size });
                    setError(null);
                    setStale(false);
                }
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="outline" title="Change this game’s name or size">
                    Settings
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Settings for {game.name}</DialogTitle>
                    <DialogDescription>
                        Saving makes a new revision, as importing an edited file would. The new
                        name shows in game lists and links right away. Sessions already started
                        are offered the update, even for a rename; a new size applies there once
                        their creator accepts it. For a preloaded game, the next change to its
                        file replaces this edit.
                    </DialogDescription>
                </DialogHeader>

                <form className="space-y-4" onSubmit={handleSave}>
                    <div className="space-y-1.5">
                        <Label htmlFor={`game-name-${game.id}`}>Name</Label>
                        <RawInput
                            id={`game-name-${game.id}`}
                            value={form.name}
                            maxLength={GAME_NAME_MAX_LENGTH}
                            required
                            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor={`game-size-${game.id}`}>Size</Label>
                        <Select<Game["size"]>
                            id={`game-size-${game.id}`}
                            trigger="Size"
                            options={SIZE_OPTIONS}
                            hints={SIZE_HINTS}
                            value={form.size}
                            onValueChange={(size) => setForm((f) => ({ ...f, size }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            Sets how far you must zoom in before station names show.
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <p className="text-sm font-medium leading-none">ID</p>
                        <p className="text-sm font-mono">{game.gameKey}</p>
                        <p className="text-xs text-muted-foreground">
                            Never changes. Links, exports and file names use it.
                        </p>
                    </div>

                    {error && (
                        <div className="text-sm text-destructive p-3 bg-destructive/10 rounded-md space-y-2">
                            <p>{error}</p>
                            {stale && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => window.location.reload()}
                                >
                                    Reload
                                </Button>
                            )}
                        </div>
                    )}

                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!update || saving || stale}>
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
