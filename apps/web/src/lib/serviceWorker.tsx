import { toast } from "react-toastify";
import { registerSW } from "virtual:pwa-register";

// Registers the service worker (src/sw.ts); Layout.astro runs this on every
// page. In `astro dev` the plugin swaps in a registerSW that does nothing.

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
// Phones switch apps often; coming back checks at most this often.
const MIN_UPDATE_CHECK_GAP = 10 * 60 * 1000;

const UPDATE_TOAST_ID = "service-worker-update";

// A new build waits until the player chooses to reload, so a game is never
// reloaded under them. Reloading activates it, and every open page of the
// app reloads into it (registerSW's doing): the old build's files leave the
// cache and the server, so pages left on it couldn't load the rest of it.
const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh: showUpdateToast,
    onRegisteredSW(_url, registration) {
        if (registration) checkForUpdates(registration);
    },
});

function showUpdateToast() {
    toast(
        () => (
            <div className="flex w-full items-center justify-between gap-3">
                <span>A new version of Searchlight is available</span>
                <button
                    className="shrink-0 rounded-md border border-current px-3 py-1 text-sm font-semibold"
                    onClick={() => void updateServiceWorker(true)}
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
// installed app can stay open for days.
function checkForUpdates(registration: ServiceWorkerRegistration) {
    let lastCheck = Date.now();
    const check = () => {
        if (!navigator.onLine || registration.installing) return;
        lastCheck = Date.now();
        registration.update().catch(() => {
            // Offline or a bad connection: the next check tries again.
        });
    };
    setInterval(check, UPDATE_CHECK_INTERVAL);
    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState === "visible" &&
            Date.now() - lastCheck >= MIN_UPDATE_CHECK_GAP
        ) {
            check();
        }
    });
}
