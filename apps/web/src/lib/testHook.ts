import {
    hiderMode,
    mapGeoJSON,
    polyGeoJSON,
    questionFinishedMapData,
    questions,
} from "@/lib/context";

/**
 * Test-only window hook for Playwright e2e (Phase 3 of the testing harness).
 *
 * When `PUBLIC_ENABLE_TEST_HOOK === "1"` (set only in the `searchlight-test` stack),
 * exposes the live values of the map/question nanostores on `window.__searchlight`,
 * so an e2e test can read the GeoJSON the app rendered — `mapGeoJSON` is the
 * play area, `eliminationGeoJSON` the elimination mask the answered questions
 * produce — and run the same numeric/geometric assertions as the Phase 1/2
 * logic layer. The properties
 * are getters that read `atom.get()` on access, so they always reflect current
 * state without needing a subscription. No-op (and not even attached) unless the
 * flag is on, so it can never leak into production.
 */
export function installTestHook(): void {
    if (import.meta.env.PUBLIC_ENABLE_TEST_HOOK !== "1") return;
    if (typeof window === "undefined") return;

    Object.defineProperty(window, "__searchlight", {
        configurable: true,
        value: {
            get mapGeoJSON() {
                return mapGeoJSON.get();
            },
            get polyGeoJSON() {
                return polyGeoJSON.get();
            },
            get eliminationGeoJSON() {
                return questionFinishedMapData.get();
            },
            get questions() {
                return questions.get();
            },
            get hiderMode() {
                return hiderMode.get();
            },
        },
    });
}
