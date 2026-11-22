import { expect, test } from "vitest";

import { summarizeDetails } from "@/components/AuditLogPanel";

test("summarizes common details and falls back to JSON", () => {
  expect(summarizeDetails({})).toBe("");
  expect(summarizeDetails({ revision: 3, source: "upload" })).toBe("revision: 3, source: upload");
  expect(summarizeDetails({ name: { from: "Old", to: "New" }, unlisted: true })).toBe(
    "name: Old → New, unlisted: true",
  );
  expect(summarizeDetails({ zones: [1, 2] })).toBe("zones: [1,2]");
});
