import { toast } from "react-toastify";
import { registerSW } from "virtual:pwa-register";

// Registers the service worker (src/sw.ts); Layout.astro runs this on every
// page. In `astro dev` the plugin swaps in a registerSW that does nothing.

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
// Phones switch apps often; coming back checks at most this often.
const MIN_UPDATE_CHECK_GAP = 10 * 60 * 1000;

const UPDATE_TOAST_ID = "service-worker-update";

let registration: ServiceWorkerRegistration | undefined;
let reloadsOnTakeOver = false;

// A new build waits until the player chooses to reload, so a game is never
// reloaded under them. Reloading activates it, and every open page that
// offered it reloads into it: the old build's files leave the cache and the
// server, so pages left on it couldn't load the rest of it.
const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh: showUpdateToast,
    onRegisteredSW(_url, registered) {
        registration = registered;
        if (registered) checkForUpdates(registered);
    },
});

function showUpdateToast() {
    // registerSW reloads only a page that had a service worker when it
    // loaded, not one opened before the first install. Only a waiting update
    // offers this, so the first install, which takes over open pages too,
    // never reloads one.
    if (!reloadsOnTakeOver) {
        reloadsOnTakeOver = true;
        navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => window.location.reload(),
            { once: true },
        );
    }
    toast(
        () => (
            <div className="flex w-full items-center justify-between gap-3">
                <span>A new version of Searchlight is available</span>
                <button
                    className="shrink-0 rounded-md border border-current px-3 py-1 text-sm font-semibold"
                    onClick={reload}
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

function reload() {
    // Another page may have activated it already.
    if (registration?.waiting) void updateServiceWorker(true);
    else window.location.reload();
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
