import type { UserPreferences } from "@searchlight/shared";
import type { WritableAtom } from "nanostores";

import { penToolbarVisible } from "@/annotations/hooks/useAnnotationStore";
import {
    allowGooglePlusCodes,
    alwaysUsePastebin,
    animateMapMovements,
    autoLockQuestions,
    autoSave,
    autoZoom,
    baseTileLayer,
    customInitPreference,
    defaultCustomQuestions,
    defaultUnit,
    pastebinApiKey,
    showZoneNames,
    thunderforestApiKey,
    warningAlarm,
} from "@/lib/context";

export const PREF_ENTRIES: { key: keyof UserPreferences; atom: WritableAtom<any> }[] = [
    { key: "defaultUnit", atom: defaultUnit },
    { key: "customInitPreference", atom: customInitPreference },
    { key: "baseTileLayer", atom: baseTileLayer },
    { key: "thunderforestApiKey", atom: thunderforestApiKey },
    { key: "pastebinApiKey", atom: pastebinApiKey },
    { key: "animateMapMovements", atom: animateMapMovements },
    { key: "alwaysUsePastebin", atom: alwaysUsePastebin },
    { key: "autoSave", atom: autoSave },
    { key: "warningAlarm", atom: warningAlarm },
    { key: "autoZoom", atom: autoZoom },
    { key: "defaultCustomQuestions", atom: defaultCustomQuestions },
    { key: "allowGooglePlusCodes", atom: allowGooglePlusCodes },
    { key: "penToolbarVisible", atom: penToolbarVisible },
    { key: "showZoneNames", atom: showZoneNames },
    { key: "autoLockQuestions", atom: autoLockQuestions },
];

export function collectPreferences(): UserPreferences {
    return Object.fromEntries(
        PREF_ENTRIES.map(({ key, atom }) => [key, atom.get()])
    ) as UserPreferences;
}

export function applyPreferences(preferences: UserPreferences): void {
    for (const { key, atom } of PREF_ENTRIES) {
        const val = preferences[key];
        if (val !== undefined) atom.set(val);
    }
}
