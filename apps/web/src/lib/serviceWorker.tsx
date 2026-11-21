import { toast } from "react-toastify";
import { registerSW } from "virtual:pwa-register";

import { editingInOtherTab } from "@/lib/otherTab";

// Registers the service worker (src/sw.ts); Layout.astro runs this on every
// page. In `astro dev` the plugin swaps in a registerSW that does nothing.

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
// Phones switch apps often; coming back checks at most this often.
const MIN_UPDATE_CHECK_GAP = 10 * 60 * 1000;

const UPDATE_TOAST_ID = "service-worker-update";

export const RELOAD_FALLBACK_MS = 1500;

export interface WaitingWorker {
    readonly state: ServiceWorkerState;
    addEventListener(type: "statechange", listener: () => void): void;
    removeEventListener(type: "statechange", listener: () => void): void;
}

export interface ServiceWorkerReloaderDeps {
    hasController: boolean;
    isEditingInOtherTab: () => boolean;
    getWaiting: () => WaitingWorker | null | undefined;
    updateServiceWorker: (reloadPage?: boolean) => Promise<void> | void;
    reloadPage: () => void;
    fallbackMs?: number;
}

function isWaitingDone(worker: WaitingWorker): boolean {
    return worker.state === "activated" || worker.state === "redundant";
}

export function createServiceWorkerReloader({
    hasController,
    isEditingInOtherTab,
    getWaiting,
    updateServiceWorker,
    reloadPage,
    fallbackMs = RELOAD_FALLBACK_MS,
}: ServiceWorkerReloaderDeps) {
    let reloadsOnTakeOver = hasController;
    let reloading = false;
    let reloadTappedHere = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupWaitingListener: (() => void) | undefined;

    function clearPendingFallback() {
        if (fallbackTimer !== undefined) {
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
        }
        cleanupWaitingListener?.();
        cleanupWaitingListener = undefined;
    }

    function reloadPageOnce() {
        if (reloading) return;
        reloading = true;
        clearPendingFallback();
        reloadPage();
    }

    function onControllerChange() {
        if (reloading) return;
        if (!reloadsOnTakeOver) {
            reloadsOnTakeOver = true;
            return;
        }
        if (isEditingInOtherTab() && !reloadTappedHere) return;
        reloadPageOnce();
    }

    function onUpdateAvailable() {
        // A page opened without a worker reloads into the update it offers.
        reloadsOnTakeOver = true;
    }

    function reload() {
        if (reloading) return;
        reloadTappedHere = true;
        // Another page may have activated it already.
        const waiting = getWaiting();
        if (!waiting) {
            reloadPageOnce();
            return;
        }
        clearPendingFallback();
        // A Shift+Reloaded tab has no controller and clients.claim() never
        // claims it, so controllerchange will never fire there. Watch the
        // waiting worker's own state transition (with a short fallback timer)
        // so Reload still reloads once the update activates.
        const onStateChange = () => {
            if (isWaitingDone(waiting)) reloadPageOnce();
        };
        waiting.addEventListener("statechange", onStateChange);
        cleanupWaitingListener = () =>
            waiting.removeEventListener("statechange", onStateChange);
        void updateServiceWorker(true);
        if (reloading) return;
        if (isWaitingDone(waiting)) {
            reloadPageOnce();
            return;
        }
        fallbackTimer = setTimeout(reloadPageOnce, fallbackMs);
    }

    return {
        onControllerChange,
        onUpdateAvailable,
        reload,
    };
}

let registration: ServiceWorkerRegistration | undefined;

// A new build waits until the player chooses to reload, so a game is never
// reloaded under them. When a worker takes over from the one this page
// loaded with (an update accepted here or in another tab, or a rollback
// that activates at once), the page reloads, once: the old build's files
// leave the cache and the server. The first install takes over a page that
// had no worker without reloading it; an update it offers later does.
// A tab another tab took the session over from doesn't, unless Reload was
// tapped in it: reloaded, it would take the session back (see
// editSessionHere). Its Use here reloads it.
const reloader = createServiceWorkerReloader({
    hasController: Boolean(navigator.serviceWorker?.controller),
    isEditingInOtherTab: () => editingInOtherTab.get(),
    getWaiting: () => registration?.waiting,
    updateServiceWorker: (reloadPage) => updateServiceWorker(reloadPage),
    reloadPage: () => window.location.reload(),
});

navigator.serviceWorker?.addEventListener(
    "controllerchange",
    reloader.onControllerChange,
);

const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh: showUpdateToast,
    // The listener above reloads. registerSW's own would reload on every
    // takeover, over and over in a second Chromium tab.
    onNeedReload() {},
    onRegisteredSW(_url, registered) {
        registration = registered;
        if (registered) checkForUpdates(registered);
    },
});

function showUpdateToast() {
    reloader.onUpdateAvailable();
    toast(
        () => (
            <div className="flex w-full items-center justify-between gap-3">
                <span>A new version of Searchlight is available</span>
                <button
                    className="shrink-0 rounded-md border border-current px-3 py-1 text-sm font-semibold"
                    onClick={reloader.reload}
                >
                    Reload
                </button>
            </div>
        ),
        {
            toastId: UPDATE_TOAST_ID,
            autoClose: false,
            closeOnClick: false,
        },
    );
}

// The browser looks for a new service worker only on navigations, and an
// installed app can stay open for days. A check that finds one waiting
// offers it again, so a dismissed toast comes back.
function checkForUpdates(registered: ServiceWorkerRegistration) {
    let lastCheck = Date.now();
    const check = async () => {
        if (!navigator.onLine) return;
        lastCheck = Date.now();
        try {
            await registered.update();
        } catch {
            // Offline or a bad connection: the next check tries again.
            return;
        }
        await installed(registered.installing);
        if (registered.waiting) showUpdateToast();
    };
    setInterval(() => void check(), UPDATE_CHECK_INTERVAL);
    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState === "visible" &&
            Date.now() - lastCheck >= MIN_UPDATE_CHECK_GAP
        ) {
            void check();
        }
    });
}

/** Resolves once `worker` has finished installing, or failed to. */
function installed(worker: ServiceWorker | null): Promise<void> {
    return new Promise((resolve) => {
        if (worker?.state !== "installing") return resolve();
        worker.addEventListener("statechange", () => {
            if (worker.state !== "installing") resolve();
        });
    });
}
