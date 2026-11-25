import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture each button's click handler by its text.
const buttons = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => {
    buttons.set(String(children), onClick);
    return null;
  },
}));

// Its dialog reads `document`; Load doesn't paste.
vi.mock("@/components/PasteFallback", () => ({
  usePasteText: () => ({ readPaste: async () => null, pasteDialog: null }),
}));

import CustomPresets from "@/components/CustomPresets";
import { customPresets } from "@/lib/context";

afterEach(() => {
  customPresets.set([]);
  buttons.clear();
});

describe("custom presets", () => {
  it("Load replaces only the points, not the position, answer or colour", () => {
    const points = [{ type: "Feature", geometry: { type: "Point", coordinates: [8.5, 47.4] } }];
    customPresets.set([
      {
        id: "p1",
        name: "Stations",
        type: "custom-points",
        createdAt: "2026-11-25T00:00:00Z",
        data: {
          type: "custom-points",
          lat: 47.55,
          lng: 8.64,
          same: true,
          color: "red",
          geo: points,
        },
      },
    ]);
    const data = {
      type: "custom-points",
      lat: 51.5,
      lng: -0.12,
      same: false,
      color: "blue",
      geo: [],
    };
    renderToStaticMarkup(<CustomPresets data={data} presetTypeHint="custom-points" />);
    buttons.get("Load")!();
    expect(data).toMatchObject({ lat: 51.5, lng: -0.12, same: false, color: "blue", geo: points });
  });
});
