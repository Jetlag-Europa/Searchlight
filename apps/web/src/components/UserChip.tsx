import type { User } from "@taibled/shared";

interface Props {
  user: User;
  apiBase: string;
}

export function UserChip({ user, apiBase }: Props) {
  async function handleLogout() {
    await fetch(`${apiBase}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF": "1" },
    });
    window.location.href = "/";
  }

  return (
    <div className="fixed top-2 right-14 z-[1031] flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-white text-sm backdrop-blur-sm">
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
