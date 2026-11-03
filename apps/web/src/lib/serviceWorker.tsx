import { toast } from "react-toastify";
import { registerSW } from "virtual:pwa-register";

// Registers the service worker (src/sw.ts); Layout.astro runs this on every
// page. In `astro dev` the plugin swaps in a registerSW that does nothing.

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
// Phones switch apps often; coming back checks at most this often.
const MIN_UPDATE_CHECK_GAP = 10 * 60 * 1000;

const UPDATE_TOAST_ID = "service-worker-update";

let registration: ServiceWorkerRegistration | undefined;

// A new build waits until the player chooses to reload, so a game is never
// reloaded under them. When a worker takes over from the one this page
// loaded with (an update accepted here or in another tab, or a rollback
// that activates at once), the page reloads, once: the old build's files
// leave the cache and the server. The first install takes over a page that
// had no worker without reloading it; an update it offers later does.
let reloadsOnTakeOver = Boolean(navigator.serviceWorker?.controller);
let reloading = false;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
    if (reloading) return;
    if (!reloadsOnTakeOver) {
        reloadsOnTakeOver = true;
        return;
    }
    reloading = true;
    window.location.reload();
});

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
    // A page opened without a worker reloads into the update it offers.
    reloadsOnTakeOver = true;
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
