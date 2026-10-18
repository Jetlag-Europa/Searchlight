import {
    type Game,
    type UpdateGameBody,
    validateGameDetails,
} from "@searchlight/shared";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

const inputClass =
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Set a game's event date(s) and rules link, for its game managers. */
export function GameDetailsDialog({
    game,
    onUpdated,
}: {
    game: Game;
    onUpdated: (game: Game) => void;
}) {
    const [open, setOpen] = useState(false);
    const [date, setDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [rulesUrl, setRulesUrl] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The date and end date go together, so they always fit each other.
    const body: UpdateGameBody = {
        date: date || null,
        endDate: (date && endDate) || null,
        rulesUrl: rulesUrl.trim() || null,
    };
    const issues = validateGameDetails(body);

    const save = async () => {
        setError(null);
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/games/${game.id}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as {
                    message?: string;
                };
                throw new Error(data.message ?? `${res.status}`);
            }
            onUpdated(await res.json());
            setOpen(false);
        } catch (e: unknown) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                setOpen(v);
                if (v) {
                    setDate(game.date ?? "");
                    setEndDate(game.endDate ?? "");
                    setRulesUrl(game.rulesUrl ?? "");
                    setError(null);
                }
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                    Details
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Details of {game.name}</DialogTitle>
                    <DialogDescription>
                        When the game is played, which orders game lists (newest
                        first), and its rules doc, which players open with the
                        Rules button. A game file that sets these changes them
                        again when its values change.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (issues.length === 0) save();
                    }}
                >
                    <div className="grid grid-cols-2 gap-3">
                        <label className="space-y-1.5 text-sm font-medium">
                            <span>Date</span>
                            <input
                                type="date"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <label className="space-y-1.5 text-sm font-medium">
                            <span>Last day (optional)</span>
                            <input
                                type="date"
                                value={date ? endDate : ""}
                                min={date || undefined}
                                disabled={!date}
                                onChange={(e) => setEndDate(e.target.value)}
                                className={inputClass}
                            />
                        </label>
                    </div>
                    <label className="block space-y-1.5 text-sm font-medium">
                        <span>Rules doc link</span>
                        <input
                            type="url"
                            inputMode="url"
                            placeholder="https://docs.google.com/document/d/…"
                            value={rulesUrl}
                            onChange={(e) => setRulesUrl(e.target.value)}
                            className={inputClass}
                        />
                    </label>
                    {issues.length > 0 && (
                        <p className="text-xs text-destructive">
                            {issues.map((issue) => issue.message).join(". ")}
                        </p>
                    )}
                    {error && (
                        <p className="text-xs text-destructive">{error}</p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={saving || issues.length > 0}
                        >
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
