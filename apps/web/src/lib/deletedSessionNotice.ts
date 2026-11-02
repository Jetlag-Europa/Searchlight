/**
 * What to tell someone whose session the server no longer has, or null to
 * say nothing. Only a 404 means it was deleted (a 403 is lost access, which
 * stays silent), and only the session still open here is news. A tab that
 * deleted it itself knows: it has usually cleared the session by the time its
 * own stream finds out, and `deletedHere` covers a delete whose reply was lost.
 */
export function deletedSessionNotice({
    sessionId,
    status,
    activeSessionId,
    deletedHere,
    role,
    name,
}: {
    sessionId: string;
    status: number;
    activeSessionId: string;
    deletedHere: boolean;
    // Unknown while a stored session is still being restored.
    role?: "creator" | "member";
    name?: string;
}): string | null {
    if (status !== 404 || sessionId !== activeSessionId || deletedHere)
        return null;
    const session = name ? `The session “${name}”` : "The session you had open";
    // Only the creator can delete a session.
    if (role === "creator")
        return `${session} was deleted from another tab or device.`;
    if (role === "member") return `${session} was deleted by its creator.`;
    return `${session} was deleted.`;
}
