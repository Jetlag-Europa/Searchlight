import { useStore } from "@nanostores/react";
import type { User } from "@searchlight/shared";

import { clearActiveSession, verifiedUserId } from "@/lib/activeSession";
import { sessionPickerOpen, sidebarContextR } from "@/lib/context";
import { forgetGameViews } from "@/lib/gameView";
import { removeStorage } from "@/lib/safeStorage";

interface Props {
    user: User;
    apiBase: string;
}

export function UserChip({ user, apiBase }: Props) {
    const sidebar = useStore(sidebarContextR);
    const pickerOpen = useStore(sessionPickerOpen);
    const right = sidebar.open ? "calc(16rem + 3.5rem)" : "3.5rem";

    async function handleLogout() {
        await fetch(`${apiBase}/auth/logout`, {
            method: "POST",
            credentials: "include",
            headers: { "X-CSRF": "1" },
        });
        verifiedUserId.set(null);
        clearActiveSession();
        forgetGameViews();
        removeStorage("localStorage", "taibled-authed-user");
        console.info(
            "[searchlight] logged out — active session and user cleared",
        );
        window.location.href = "/";
    }

    return (
        <div
            inert={pickerOpen}
            className="fixed top-2 z-[1041] flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-white text-sm backdrop-blur-sm transition-[right] duration-200 ease-linear"
            style={{ right }}
        >
            <img
                src={user.avatarUrl}
                alt={user.displayName}
                className="w-6 h-6 rounded-full object-cover"
                referrerPolicy="no-referrer"
            />
            <span className="max-w-[120px] truncate">{user.displayName}</span>
            <button
                onClick={handleLogout}
                className="ml-1 text-white/70 hover:text-white transition-colors"
                aria-label="Log out"
                title="Log out"
            >
                ×
            </button>
        </div>
    );
}
