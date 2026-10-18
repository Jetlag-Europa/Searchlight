import {
    getTestStorage,
    setTestStorageKey,
    useTestStorageEngine,
} from "@nanostores/persistent";
import type { GameSessionSummary } from "@searchlight/shared";
import { expect, it } from "vitest";

import { clearActiveSession, setActiveSession } from "@/lib/activeSession";
import { disabledStations, setDisabledStations } from "@/lib/disabledZones";

useTestStorageEngine();

it("keeps working after another tab removes the disabled zones", () => {
    setActiveSession({ id: "session-one" } as GameSessionSummary);
    const seen: (readonly string[])[] = [];
    const unbind = disabledStations.subscribe((ids) => seen.push(ids));
    setDisabledStations(["a"]);

    // Another tab removed the key: the next storage event, for any key,
    // empties the atom.
    delete getTestStorage().disabledZones;
    setTestStorageKey("autoSave", "true");
    expect(disabledStations.get()).toEqual([]);

    setDisabledStations(["b"]);
    expect(seen).toEqual([[], ["a"], [], ["b"]]);
    unbind();
    clearActiveSession();
});
