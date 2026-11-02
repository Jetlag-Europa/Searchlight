import { describe, expect, test } from "vitest";

import { formatEventDate, rulesLink } from "@/lib/eventDate";

describe("formatEventDate", () => {
    test("shows the calendar day, whatever the time zone", () => {
        // Formatted in UTC, where the day was stored: a local midnight in
        // the Americas would otherwise show the day before.
        expect(formatEventDate("2026-09-19")).toMatch(/19/);
        expect(formatEventDate("2026-09-19")).not.toMatch(/18/);
        expect(formatEventDate("2026-09-19")).toMatch(/2026/);
    });

    test("shows a multi-day event as a range", () => {
        const range = formatEventDate("2026-10-02", "2026-10-03");
        expect(range).toMatch(/2/);
        expect(range).toMatch(/3/);
        expect(range).not.toBe(formatEventDate("2026-10-02"));
        expect(formatEventDate("2026-10-02", "2026-10-02")).toBe(
            formatEventDate("2026-10-02"),
        );
    });
});

describe("rulesLink", () => {
    test("opens https links only", () => {
        expect(rulesLink("https://docs.google.com/document/d/x/edit")).toBe(
            "https://docs.google.com/document/d/x/edit",
        );
        expect(rulesLink("javascript:alert(1)")).toBeNull();
        expect(rulesLink("http://example.com")).toBeNull();
        expect(rulesLink(null)).toBeNull();
    });
});
