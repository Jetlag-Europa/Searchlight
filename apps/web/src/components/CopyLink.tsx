import { useCallback, useEffect, useRef, useState } from "react";

/** The link to an invite or share link of a session. */
export function sessionLinkUrl(token: string): string {
    return `${window.location.origin}/join?token=${token}`;
}

/**
 * A loaded link list, plus the links created since the load started
 * (`createdIds`) that it lacks: a list read just before a link was created
 * must not hide that link.
 */
export function withCreatedLinks<T extends { id: string }>(
    loaded: T[],
    current: T[],
    createdIds: ReadonlySet<string>,
): T[] {
    const loadedIds = new Set(loaded.map((l) => l.id));
    return [
        ...current.filter((l) => createdIds.has(l.id) && !loadedIds.has(l.id)),
        ...loaded,
    ];
}

/**
 * Copies links to the clipboard. `copiedId` is the link to show "Copied!" on
 * for 2 seconds; `uncopiedUrl` is a link the clipboard refused (e.g. Safari
 * after an awaited request, or no clipboard on a non-secure origin), for
 * {@link UncopiedLinkField} to show instead.
 */
export function useCopyLink() {
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [uncopiedUrl, setUncopiedUrl] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => () => clearTimeout(timer.current), []);

    const copyLink = useCallback(async (id: string, url: string) => {
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            setUncopiedUrl(url);
            return;
        }
        setUncopiedUrl(null);
        setCopiedId(id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopiedId(null), 2000);
    }, []);

    return { copiedId, uncopiedUrl, setUncopiedUrl, copyLink };
}

export function UncopiedLinkField({ url }: { url: string | null }) {
    if (!url) return null;
    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
                Couldn’t copy automatically. Copy the link here:
            </p>
            <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full border border-input rounded-md px-3 py-1.5 text-xs font-mono bg-background"
            />
        </div>
    );
}
