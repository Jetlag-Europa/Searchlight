import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── localStorage mock ─────────────────────────────────────────────────────────
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
});

// ── Imports (after globals are stubbed) ───────────────────────────────────────
import { applyPreferences, collectPreferences, PREF_ENTRIES } from "@/lib/preferencesSync";
import {
    allowGooglePlusCodes,
    animateMapMovements,
    autoLockQuestions,
    autoSave,
    autoZoom,
    baseTileLayer,
    customInitPreference,
    defaultCustomQuestions,
    defaultUnit,
    followMe,
    showZoneNames,
    thunderforestApiKey,
    warningAlarm,
} from "@/lib/context";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetAtomDefaults() {
    defaultUnit.set("miles");
    customInitPreference.set("ask");
    baseTileLayer.set("voyager");
    animateMapMovements.set(false);
    autoSave.set(true);
    warningAlarm.set(false);
    autoZoom.set(true);
    defaultCustomQuestions.set(false);
    allowGooglePlusCodes.set(false);
    showZoneNames.set(false);
    autoLockQuestions.set(false);
    followMe.set(false);
    thunderforestApiKey.set("");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PREF_ENTRIES", () => {
    test("does not include followMe", () => {
        const keys = PREF_ENTRIES.map((e) => e.key);
        expect(keys).not.toContain("followMe");
    });

    test("includes all expected preference keys", () => {
        const keys = PREF_ENTRIES.map((e) => e.key);
        expect(keys).toContain("defaultUnit");
        expect(keys).toContain("autoZoom");
        expect(keys).toContain("warningAlarm");
        expect(keys).toContain("autoLockQuestions");
        expect(keys).toContain("baseTileLayer");
        expect(keys).toContain("penToolbarVisible");
        expect(keys).toContain("showZoneNames");
        expect(keys).toContain("lastSeenRelease");
    });
});

describe("collectPreferences()", () => {
    beforeEach(resetAtomDefaults);

    test("returns current atom values", () => {
        defaultUnit.set("kilometers");
        autoZoom.set(false);
        warningAlarm.set(true);
        autoLockQuestions.set(true);

        const prefs = collectPreferences();

        expect(prefs.defaultUnit).toBe("kilometers");
        expect(prefs.autoZoom).toBe(false);
        expect(prefs.warningAlarm).toBe(true);
        expect(prefs.autoLockQuestions).toBe(true);
    });

    test("does not include followMe", () => {
        followMe.set(true);
        const prefs = collectPreferences();
        expect((prefs as any).followMe).toBeUndefined();
    });

    test("includes all PREF_ENTRIES keys", () => {
        const prefs = collectPreferences();
        for (const { key } of PREF_ENTRIES) {
            expect(key in prefs).toBe(true);
        }
    });
});

describe("applyPreferences()", () => {
    beforeEach(resetAtomDefaults);

    test("applies each preference to the corresponding atom", () => {
        applyPreferences({
            defaultUnit: "meters",
            autoZoom: false,
            warningAlarm: true,
            baseTileLayer: "dark",
            autoLockQuestions: true,
        });

        expect(defaultUnit.get()).toBe("meters");
        expect(autoZoom.get()).toBe(false);
        expect(warningAlarm.get()).toBe(true);
        expect(baseTileLayer.get()).toBe("dark");
        expect(autoLockQuestions.get()).toBe(true);
    });

    test("skips keys with undefined value (does not reset atoms)", () => {
        autoZoom.set(false);

        applyPreferences({ defaultUnit: "kilometers" }); // autoZoom not included

        expect(autoZoom.get()).toBe(false); // unchanged
        expect(defaultUnit.get()).toBe("kilometers"); // updated
    });

    test("server preferences override the current atom value (localStorage wins on init, server wins after load)", () => {
        // Simulate: user had "miles" in localStorage, server says "kilometers"
        defaultUnit.set("miles");

        applyPreferences({ defaultUnit: "kilometers" });

        expect(defaultUnit.get()).toBe("kilometers");
    });

});

describe("collectPreferences / applyPreferences round-trip", () => {
    beforeEach(resetAtomDefaults);

    test("round-trips all values without loss", () => {
        defaultUnit.set("meters");
        autoZoom.set(false);
        warningAlarm.set(true);
        autoLockQuestions.set(true);
        baseTileLayer.set("dark");
        customInitPreference.set("blank");
        animateMapMovements.set(true);
        autoSave.set(false);
        defaultCustomQuestions.set(true);
        allowGooglePlusCodes.set(true);
        showZoneNames.set(true);
        thunderforestApiKey.set("my-api-key");

        const snapshot = collectPreferences();

        // Reset to defaults
        resetAtomDefaults();

        // Apply the snapshot
        applyPreferences(snapshot);

        // Verify everything was restored
        expect(defaultUnit.get()).toBe("meters");
        expect(autoZoom.get()).toBe(false);
        expect(warningAlarm.get()).toBe(true);
        expect(autoLockQuestions.get()).toBe(true);
        expect(baseTileLayer.get()).toBe("dark");
        expect(customInitPreference.get()).toBe("blank");
        expect(animateMapMovements.get()).toBe(true);
        expect(autoSave.get()).toBe(false);
        expect(defaultCustomQuestions.get()).toBe(true);
        expect(allowGooglePlusCodes.get()).toBe(true);
        expect(showZoneNames.get()).toBe(true);
        expect(thunderforestApiKey.get()).toBe("my-api-key");
    });
});
