import { useStore } from "@nanostores/react";
import type { User } from "@searchlight/shared";

import { clearActiveSession } from "@/lib/activeSession";
import { sessionPickerOpen } from "@/lib/context";
import { forgetGameViews } from "@/lib/gameView";
import { forgetAccount } from "@/lib/offlineAccess";

import { StatusChip } from "./StatusChip";

interface Props {
    user: User;
    apiBase: string;
}

export function UserChip({ user, apiBase }: Props) {
    const pickerOpen = useStore(sessionPickerOpen);

    async function handleLogout() {
        try {
            await fetch(`${apiBase}/auth/logout`, {
                method: "POST",
                credentials: "include",
                headers: { "X-CSRF": "1" },
            });
        } catch (err) {
            console.warn("[searchlight] logout request failed:", err);
        } finally {
            // Whatever the server answered, this browser forgets the account:
            // nobody plays this browser's kept sessions while offline. Their
            // snapshots and unsent edits stay, each in its owner's queue, for
            // that account alone, after logging back in.
            clearActiveSession();
            forgetGameViews();
            await forgetAccount();
            console.info(
                "[searchlight] logged out — active session, user and kept games cleared",
            );
            window.location.href = "/";
        }
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
