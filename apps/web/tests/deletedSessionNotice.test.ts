import { describe, expect, it } from "vitest";

import { deletedSessionNotice } from "@/lib/deletedSessionNotice";

describe("deletedSessionNotice", () => {
    it("names the open session that was deleted", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s1",
                deletedHere: false,
                role: "member",
                name: "Team B",
            }),
        ).toBe("The session “Team B” was deleted by its creator.");
    });

    it("says which session it was without its name", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s1",
                deletedHere: false,
                role: "member",
            }),
        ).toBe("The session you had open was deleted by its creator.");
    });

    it("stays silent after losing access", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 403,
                activeSessionId: "s1",
                deletedHere: false,
                name: "Team B",
            }),
        ).toBeNull();
    });

    // The tab that deleted it cleared it before its own stream got the 404.
    it("stays silent for a session no longer open here", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "",
                deletedHere: false,
                name: "Team B",
            }),
        ).toBeNull();
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s2",
                deletedHere: false,
                name: "Team B",
            }),
        ).toBeNull();
    });

    // Its reply was lost, so it never cleared the session it deleted.
    it("stays silent in the tab that deleted it", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s1",
                deletedHere: true,
                name: "Team B",
            }),
        ).toBeNull();
    });

    // Only the creator can delete it, so they did, somewhere else.
    it("tells the creator it went from elsewhere", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s1",
                deletedHere: false,
                role: "creator",
                name: "Team B",
            }),
        ).toBe("The session “Team B” was deleted from another tab or device.");
    });

    // A stored session can turn out deleted before its details have loaded.
    it("doesn't say who deleted it without knowing the role", () => {
        expect(
            deletedSessionNotice({
                sessionId: "s1",
                status: 404,
                activeSessionId: "s1",
                deletedHere: false,
                name: "Team B",
            }),
        ).toBe("The session “Team B” was deleted.");
    });
});
