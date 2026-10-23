import { useStore } from "@nanostores/react";
import type { User } from "@searchlight/shared";

import { clearStoredRevisions } from "@/game-definition/revisionCache";
import {
    clearActiveSession,
    STORED_USER_KEY,
    verifiedUserId,
} from "@/lib/activeSession";
import { sessionPickerOpen } from "@/lib/context";
import { forgetGameViews } from "@/lib/gameView";
import { removeStorage } from "@/lib/safeStorage";

import { StatusChip } from "./StatusChip";

interface Props {
    user: User;
    apiBase: string;
}

export function UserChip({ user, apiBase }: Props) {
    const pickerOpen = useStore(sessionPickerOpen);

    async function handleLogout() {
        await fetch(`${apiBase}/auth/logout`, {
            method: "POST",
            credentials: "include",
            headers: { "X-CSRF": "1" },
        });
        verifiedUserId.set(null);
        clearActiveSession();
        forgetGameViews();
        // Without the stored account, nobody plays this browser's kept
        // sessions while offline. Their snapshots and unsent edits stay,
        // tagged with their owner: only that account sees them again, after
        // logging back in, and the edits still sync.
        removeStorage("localStorage", STORED_USER_KEY);
        await clearStoredRevisions();
        console.info(
            "[searchlight] logged out — active session, user and kept games cleared",
        );
        window.location.href = "/";
    }

    return (
        <StatusChip slot="user">
            <div
                inert={pickerOpen}
                className="flex w-max items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-white text-sm backdrop-blur-sm"
            >
                <img
                    src={user.avatarUrl}
                    alt={user.displayName}
                    className="w-6 h-6 rounded-full object-cover"
                    referrerPolicy="no-referrer"
                />
                <span className="max-w-[120px] truncate">
                    {user.displayName}
                </span>
                <button
                    onClick={handleLogout}
                    className="ml-1 text-white/70 hover:text-white transition-colors"
                    aria-label="Log out"
                    title="Log out"
                >
                    ×
                </button>
            </div>
        </StatusChip>
    );
}
