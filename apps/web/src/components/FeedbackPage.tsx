import { useEffect, useRef, useState } from "react";
import type { FeedbackItem, FeedbackListResponse, CreateFeedbackResponse } from "@taibled/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

type Me = { discordId: string; displayName: string; avatarUrl: string };
type FilterType = "all" | "bug" | "feature";
type FormState = {
    type: "bug" | "feature";
    title: string;
    description: string;
    severity: "low" | "medium" | "high";
    images: File[];
};

function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function TypeBadge({ type }: { type: "bug" | "feature" }) {
    return (
        <span className={cn(
            "text-xs font-medium px-2 py-0.5 rounded-full border",
            type === "bug"
                ? "bg-red-500/15 text-red-400 border-red-500/30"
                : "bg-blue-500/15 text-blue-400 border-blue-500/30",
        )}>
            {type === "bug" ? "Bug" : "Feature"}
        </span>
    );
}

function SeverityBadge({ severity }: { severity: "low" | "medium" | "high" }) {
    const styles = {
        low: "bg-green-500/15 text-green-400 border-green-500/30",
        medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
        high: "bg-red-500/15 text-red-400 border-red-500/30",
    };
    return (
        <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border", styles[severity])}>
            {severity}
        </span>
    );
}

function Avatar({ avatarUrl, displayName }: { avatarUrl: string; displayName: string }) {
    return (
        <img
            src={avatarUrl}
            alt={displayName}
            className="w-5 h-5 rounded-full"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
    );
}

function timeAgo(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

function FeedbackCard({
    item,
    me,
    isAdmin,
    onVote,
    onToggleStatus,
    onImageClick,
    votingId,
    togglingId,
}: {
    item: FeedbackItem;
    me: Me | null;
    isAdmin: boolean;
    onVote: (id: string, voteType: "up" | "down") => void;
    onToggleStatus: (id: string, status: "open" | "closed") => void;
    onImageClick: (src: string) => void;
    votingId: string | null;
    togglingId: string | null;
}) {
    const [expanded, setExpanded] = useState(false);
    const long = item.description.length > 280;
    const displayDesc = long && !expanded ? item.description.slice(0, 280) + "…" : item.description;


    return (
        <div className={cn(
            "rounded-lg border border-border bg-card p-4 space-y-3",
            item.status === "closed" && "opacity-60",
        )}>
            <div className="flex items-start gap-2 flex-wrap">
                <TypeBadge type={item.type} />
                {item.type === "bug" && item.severity && <SeverityBadge severity={item.severity} />}
                {item.status === "closed" && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-muted/30 text-muted-foreground border-border">
                        Closed
                    </span>
                )}
                <span className="text-sm font-semibold leading-snug">{item.title}</span>
            </div>

            <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {displayDesc}
                {long && (
                    <button
                        onClick={() => setExpanded(v => !v)}
                        className="ml-1 text-primary underline-offset-2 hover:underline"
                    >
                        {expanded ? "Show less" : "Show more"}
                    </button>
                )}
            </p>

            {item.imageIds.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                    {item.imageIds.map((imgId) => (
                        <button
                            key={imgId}
                            onClick={() => onImageClick(`${API_BASE}/feedback/images/${imgId}`)}
                            className="rounded border border-border overflow-hidden w-20 h-16 flex-shrink-0 hover:border-primary transition-colors"
                        >
                            <img
                                src={`${API_BASE}/feedback/images/${imgId}`}
                                alt="screenshot"
                                className="w-full h-full object-cover"
                            />
                        </button>
                    ))}
                </div>
            )}

            {isAdmin && item.type === "bug" && item.voters && item.voters.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    Reproduced by: {item.voters.map((v) => v.displayName).join(", ")}
                </p>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                    <Avatar avatarUrl={item.author.avatarUrl} displayName={item.author.displayName} />
                    <span className="truncate">{item.author.displayName}</span>
                    <span>·</span>
                    <span className="shrink-0">{timeAgo(item.createdAt)}</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {isAdmin && (
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={togglingId === item.id}
                            onClick={() => onToggleStatus(item.id, item.status === "open" ? "closed" : "open")}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {togglingId === item.id ? "…" : item.status === "open" ? "Close" : "Reopen"}
                        </Button>
                    )}
                    {item.status === "open" && item.type === "bug" && (
                        <Button
                            size="sm"
                            variant={item.userVote === "up" ? "default" : "outline"}
                            disabled={!me || votingId === `${item.id}-up`}
                            onClick={() => me ? onVote(item.id, "up") : loginRedirect()}
                            className="text-xs"
                        >
                            {votingId === `${item.id}-up` ? "…" : `✓ Reproduces${item.upvoteCount > 0 ? ` · ${item.upvoteCount}` : ""}`}
                        </Button>
                    )}
                    {item.status === "open" && item.type === "feature" && (
                        <div className="flex gap-1.5">
                            <Button
                                size="sm"
                                variant={item.userVote === "up" ? "default" : "outline"}
                                disabled={!me || votingId === `${item.id}-up`}
                                onClick={() => me ? onVote(item.id, "up") : loginRedirect()}
                                className="text-xs"
                            >
                                {votingId === `${item.id}-up` ? "…" : `▲${item.upvoteCount > 0 ? ` ${item.upvoteCount}` : ""}`}
                            </Button>
                            <Button
                                size="sm"
                                variant={item.userVote === "down" ? "destructive" : "outline"}
                                disabled={!me || votingId === `${item.id}-down`}
                                onClick={() => me ? onVote(item.id, "down") : loginRedirect()}
                                className="text-xs"
                            >
                                {votingId === `${item.id}-down` ? "…" : `▼${item.downvoteCount > 0 ? ` ${item.downvoteCount}` : ""}`}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function loginRedirect() {
    localStorage.setItem("taibled-return-to", "/feedback");
    window.location.href = `${API_BASE}/auth/discord/login`;
}

function SubmitForm({
    form,
    setForm,
    onSubmit,
    onCancel,
    submitting,
    error,
}: {
    form: FormState;
    setForm: (f: FormState) => void;
    onSubmit: () => void;
    onCancel: () => void;
    submitting: boolean;
    error: string | null;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFiles = (files: FileList | null) => {
        if (!files) return;
        const incoming = Array.from(files).slice(0, MAX_IMAGES - form.images.length);
        const oversized = incoming.filter((f) => f.size > 3 * 1024 * 1024);
        if (oversized.length > 0) {
            alert(`${oversized.map(f => f.name).join(", ")} exceed the 3 MB limit.`);
            return;
        }
        setForm({ ...form, images: [...form.images, ...incoming].slice(0, MAX_IMAGES) });
    };

    const MAX_IMAGES = 3;

    return (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4 mb-6">
            <p className="text-sm font-medium">New submission</p>

            {/* Type toggle */}
            <div className="flex gap-2">
                {(["bug", "feature"] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => setForm({ ...form, type: t })}
                        className={cn(
                            "px-3 py-1.5 text-sm rounded-md border transition-colors",
                            form.type === t
                                ? "bg-primary text-primary-foreground border-primary"
                                : "border-border text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {t === "bug" ? "Bug Report" : "Feature Request"}
                    </button>
                ))}
            </div>

            {/* Severity (bugs only) */}
            {form.type === "bug" && (
                <div className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground">Severity:</span>
                    {(["low", "medium", "high"] as const).map((s) => (
                        <button
                            key={s}
                            onClick={() => setForm({ ...form, severity: s })}
                            className={cn(
                                "px-2.5 py-1 text-xs rounded-full border capitalize transition-colors",
                                form.severity === s
                                    ? s === "low"
                                        ? "bg-green-500/20 text-green-400 border-green-500/50"
                                        : s === "medium"
                                            ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/50"
                                            : "bg-red-500/20 text-red-400 border-red-500/50"
                                    : "border-border text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            )}

            {/* Title */}
            <input
                type="text"
                placeholder="Title"
                maxLength={200}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
            />

            {/* Description */}
            <textarea
                placeholder={form.type === "bug" ? "Describe the bug and steps to reproduce…" : "Describe the feature you'd like…"}
                maxLength={5000}
                rows={4}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background resize-y"
            />

            {/* Image upload (bugs only) */}
            {form.type === "bug" && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Screenshots (up to 3, max 3 MB each)</span>
                        {form.images.length < MAX_IMAGES && (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="text-xs text-primary hover:underline underline-offset-2"
                            >
                                + Add image
                            </button>
                        )}
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => handleFiles(e.target.files)}
                    />
                    {form.images.length > 0 && (
                        <div className="flex gap-2 flex-wrap">
                            {form.images.map((file, i) => (
                                <div key={i} className="relative">
                                    <img
                                        src={URL.createObjectURL(file)}
                                        alt={file.name}
                                        className="w-20 h-16 object-cover rounded border border-border"
                                    />
                                    <button
                                        onClick={() => setForm({ ...form, images: form.images.filter((_, j) => j !== i) })}
                                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center leading-none"
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
                <Button size="sm" onClick={onSubmit} disabled={submitting || !form.title.trim() || !form.description.trim()}>
                    {submitting ? "Submitting…" : "Submit"}
                </Button>
            </div>
        </div>
    );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <img
                src={src}
                alt="screenshot"
                className="max-w-full max-h-full rounded shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            />
        </div>
    );
}

export function FeedbackPage({ isAdmin = false }: { isAdmin?: boolean }) {
    const [me, setMe] = useState<Me | null>(null);
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<FilterType>("all");
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<FormState>({ type: "bug", title: "", description: "", severity: "medium", images: [] });
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [votingId, setVotingId] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const [showClosed, setShowClosed] = useState(false);

    const listEndpoint = isAdmin ? `${API_BASE}/feedback/admin` : `${API_BASE}/feedback`;

    useEffect(() => {
        Promise.all([
            fetch(`${API_BASE}/me`, { credentials: "include" }).then((r) => r.ok ? r.json() : null),
            fetch(listEndpoint, { credentials: "include" }).then((r) => r.ok ? r.json() : { items: [] }),
        ]).then(([meData, listData]: [{ user: Me } | null, FeedbackListResponse]) => {
            setMe(meData?.user ?? null);
            setItems(listData.items ?? []);
        }).finally(() => setLoading(false));
    }, [listEndpoint]);

    const filtered = (list: FeedbackItem[]) =>
        filter === "all" ? list : list.filter((i) => i.type === filter);

    const openItems = filtered(items.filter((i) => i.status === "open"));
    const closedItems = isAdmin ? filtered(items.filter((i) => i.status === "closed")) : [];

    const counts = {
        all: items.filter((i) => i.status === "open").length,
        bug: items.filter((i) => i.status === "open" && i.type === "bug").length,
        feature: items.filter((i) => i.status === "open" && i.type === "feature").length,
    };

    const handleSubmit = async () => {
        if (!form.title.trim() || !form.description.trim()) return;
        setSubmitting(true);
        setFormError(null);
        try {
            const images = await Promise.all(
                form.images.map(async (file) => ({
                    filename: file.name,
                    mimeType: file.type,
                    data: await readAsBase64(file),
                })),
            );
            const res = await fetch(`${API_BASE}/feedback`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: form.type,
                    title: form.title.trim(),
                    description: form.description.trim(),
                    severity: form.type === "bug" ? form.severity : undefined,
                    images: images.length > 0 ? images : undefined,
                }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const { id } = await res.json() as CreateFeedbackResponse;

            // Fetch the new item and prepend it
            const listRes = await fetch(listEndpoint, { credentials: "include" });
            if (listRes.ok) {
                const data: FeedbackListResponse = await listRes.json();
                setItems(data.items ?? []);
            }

            setShowForm(false);
            setForm({ type: "bug", title: "", description: "", severity: "medium", images: [] });
            void id;
        } catch {
            setFormError("Failed to submit. Please try again.");
        } finally {
            setSubmitting(false);
        }
    };

    const handleVote = async (id: string, voteType: "up" | "down") => {
        if (!me) return loginRedirect();
        setVotingId(`${id}-${voteType}`);
        try {
            const res = await fetch(`${API_BASE}/feedback/${id}/vote`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ voteType }),
            });
            if (!res.ok) return;
            const { userVote } = await res.json() as { userVote: "up" | "down" | null };
            setItems((prev) =>
                prev.map((item) => {
                    if (item.id !== id) return item;
                    let { upvoteCount, downvoteCount } = item;
                    if (item.userVote === "up") upvoteCount--;
                    if (item.userVote === "down") downvoteCount--;
                    if (userVote === "up") upvoteCount++;
                    if (userVote === "down") downvoteCount++;
                    return { ...item, userVote, upvoteCount, downvoteCount };
                }),
            );
        } finally {
            setVotingId(null);
        }
    };

    const handleToggleStatus = async (id: string, newStatus: "open" | "closed") => {
        setTogglingId(id);
        try {
            const res = await fetch(`${API_BASE}/feedback/${id}/status`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) return;
            setItems((prev) =>
                prev.map((item) => item.id === id ? { ...item, status: newStatus } : item),
            );
        } finally {
            setTogglingId(null);
        }
    };

    const cardProps = { me, isAdmin, onVote: handleVote, onToggleStatus: handleToggleStatus, onImageClick: setLightboxSrc, votingId, togglingId };

    return (
        <div className="min-h-screen bg-background text-foreground">
            <div className="max-w-3xl mx-auto px-4 py-10">

                {/* Header */}
                <div className="flex items-start justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Feedback</h1>
                        <p className="text-sm text-muted-foreground mt-1">Report bugs or suggest features.</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {me ? (
                            <Button onClick={() => setShowForm((v) => !v)}>
                                {showForm ? "Cancel" : "+ Submit"}
                            </Button>
                        ) : (
                            <Button onClick={loginRedirect}>Log in to Submit</Button>
                        )}
                        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">← Back</a>
                    </div>
                </div>

                {!me && (
                    <div className="rounded-lg border border-border bg-card/50 px-4 py-3 mb-6 text-sm text-muted-foreground">
                        <button onClick={loginRedirect} className="text-primary hover:underline underline-offset-2">Log in with Discord</button>
                        {" "}to submit reports or vote.
                    </div>
                )}

                {/* Submit form */}
                {showForm && me && (
                    <SubmitForm
                        form={form}
                        setForm={setForm}
                        onSubmit={handleSubmit}
                        onCancel={() => { setShowForm(false); setFormError(null); }}
                        submitting={submitting}
                        error={formError}
                    />
                )}

                {/* Filter tabs */}
                <div className="flex gap-1 border-b border-border mb-6">
                    {([
                        { key: "all", label: "All" },
                        { key: "bug", label: "Bugs" },
                        { key: "feature", label: "Feature Requests" },
                    ] as { key: FilterType; label: string }[]).map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => setFilter(key)}
                            className={cn(
                                "px-4 py-2 text-sm font-medium transition-colors",
                                filter === key
                                    ? "border-b-2 border-primary text-foreground"
                                    : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {label}
                            {counts[key] > 0 && (
                                <span className="ml-1.5 text-xs bg-muted text-muted-foreground rounded-full px-1.5 py-0.5">
                                    {counts[key]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* List */}
                {loading ? (
                    <div className="flex justify-center py-16">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    </div>
                ) : openItems.length === 0 ? (
                    <p className="text-center text-sm text-muted-foreground py-16">
                        {filter === "all" ? "No open reports yet." : `No open ${filter === "bug" ? "bug reports" : "feature requests"} yet.`}
                    </p>
                ) : (
                    <div className="space-y-3">
                        {openItems.map((item) => (
                            <FeedbackCard key={item.id} item={item} {...cardProps} />
                        ))}
                    </div>
                )}

                {/* Admin: closed section */}
                {isAdmin && closedItems.length > 0 && (
                    <div className="mt-8">
                        <button
                            onClick={() => setShowClosed((v) => !v)}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-3"
                        >
                            <span>{showClosed ? "▾" : "▸"}</span>
                            Closed ({closedItems.length})
                        </button>
                        {showClosed && (
                            <div className="space-y-3">
                                {closedItems.map((item) => (
                                    <FeedbackCard key={item.id} item={item} {...cardProps} />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
        </div>
    );
}
