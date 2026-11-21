import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-toastify", () => ({
    toast: vi.fn(),
}));

vi.mock("virtual:pwa-register", () => ({
    registerSW: vi.fn(() => vi.fn()),
}));

import {
    createServiceWorkerReloader,
    RELOAD_FALLBACK_MS,
    type WaitingWorker,
} from "@/lib/serviceWorker";

interface FakeWaitingWorker extends WaitingWorker {
    setState(state: ServiceWorkerState): void;
}

function createWaitingWorker(
    initialState: ServiceWorkerState = "installed",
): FakeWaitingWorker {
    let state = initialState;
    const listeners = new Set<() => void>();
    return {
        get state() {
            return state;
        },
        addEventListener(_type, listener) {
            listeners.add(listener);
        },
        removeEventListener(_type, listener) {
            listeners.delete(listener);
        },
        setState(next) {
            state = next;
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
}

describe("serviceWorker update reload", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reloads a controlled tab once on controllerchange without double reloading when waiting activates", () => {
        const waiting = createWaitingWorker("installed");
        const updateServiceWorker = vi.fn();
        const reloadPage = vi.fn();
        const reloader = createServiceWorkerReloader({
            hasController: true,
            isEditingInOtherTab: () => false,
            getWaiting: () => waiting,
            updateServiceWorker,
            reloadPage,
        });

        reloader.onUpdateAvailable();
        reloader.reload();
        expect(updateServiceWorker).toHaveBeenCalledTimes(1);
        expect(updateServiceWorker).toHaveBeenCalledWith(true);
        expect(reloadPage).not.toHaveBeenCalled();

        reloader.onControllerChange();
        expect(reloadPage).toHaveBeenCalledTimes(1);

        // Waiting worker finishing activation and timer elapsing must not reload again.
        waiting.setState("activated");
        vi.advanceTimersByTime(RELOAD_FALLBACK_MS * 2);
        expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    it("reloads an uncontrolled (Shift+Reloaded) tab once waiting activates even if controllerchange never fires", () => {
        const waiting = createWaitingWorker("installed");
        const updateServiceWorker = vi.fn();
        const reloadPage = vi.fn();
        const reloader = createServiceWorkerReloader({
            hasController: false,
            isEditingInOtherTab: () => false,
            getWaiting: () => waiting,
            updateServiceWorker,
            reloadPage,
        });

        reloader.onUpdateAvailable();
        reloader.reload();
        expect(updateServiceWorker).toHaveBeenCalledTimes(1);
        expect(updateServiceWorker).toHaveBeenCalledWith(true);
        expect(reloadPage).not.toHaveBeenCalled();

        waiting.setState("activating");
        expect(reloadPage).not.toHaveBeenCalled();

        waiting.setState("activated");
        expect(reloadPage).toHaveBeenCalledTimes(1);

        // Fallback timer should be cleared and never trigger a second reload.
        vi.advanceTimersByTime(RELOAD_FALLBACK_MS * 2);
        expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    it("reloads an uncontrolled tab via fallback timeout if waiting stays stuck", () => {
        const waiting = createWaitingWorker("installed");
        const updateServiceWorker = vi.fn();
        const reloadPage = vi.fn();
        const reloader = createServiceWorkerReloader({
            hasController: false,
            isEditingInOtherTab: () => false,
            getWaiting: () => waiting,
            updateServiceWorker,
            reloadPage,
        });

        reloader.onUpdateAvailable();
        reloader.reload();
        expect(updateServiceWorker).toHaveBeenCalledWith(true);

        vi.advanceTimersByTime(RELOAD_FALLBACK_MS - 1);
        expect(reloadPage).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(reloadPage).toHaveBeenCalledTimes(1);

        // Late activation must not reload a second time.
        waiting.setState("activated");
        expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    it("reloads immediately if waiting already transitioned to activated or redundant", () => {
        const waiting = createWaitingWorker("activated");
        const updateServiceWorker = vi.fn();
        const reloadPage = vi.fn();
        const reloader = createServiceWorkerReloader({
            hasController: false,
            isEditingInOtherTab: () => false,
            getWaiting: () => waiting,
            updateServiceWorker,
            reloadPage,
        });

        reloader.reload();
        expect(updateServiceWorker).toHaveBeenCalledWith(true);
        expect(reloadPage).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("reloads immediately without calling updateServiceWorker when no waiting worker exists", () => {
        const updateServiceWorker = vi.fn();
        const reloadPage = vi.fn();
        const reloader = createServiceWorkerReloader({
            hasController: false,
            isEditingInOtherTab: () => false,
            getWaiting: () => null,
            updateServiceWorker,
            reloadPage,
        });

        reloader.reload();
        expect(updateServiceWorker).not.toHaveBeenCalled();
        expect(reloadPage).toHaveBeenCalledTimes(1);

        reloader.reload();
        expect(reloadPage).toHaveBeenCalledTimes(1);
    });

    it("preserves existing controllerchange guards for first install and editingInOtherTab", () => {
        const reloadFirstInstall = vi.fn();
        const firstInstall = createServiceWorkerReloader({
            hasController: false,
            isEditingInOtherTab: () => false,
            getWaiting: () => null,
            updateServiceWorker: vi.fn(),
            reloadPage: reloadFirstInstall,
        });

        // First install claims an uncontrolled page without reloading it.
        firstInstall.onControllerChange();
        expect(reloadFirstInstall).not.toHaveBeenCalled();
        // A subsequent update takeover reloads once.
        firstInstall.onControllerChange();
        expect(reloadFirstInstall).toHaveBeenCalledTimes(1);

        const reloadOtherTab = vi.fn();
        const otherTab = createServiceWorkerReloader({
            hasController: true,
            isEditingInOtherTab: () => true,
            getWaiting: () => createWaitingWorker("installed"),
            updateServiceWorker: vi.fn(),
            reloadPage: reloadOtherTab,
        });

        // Another tab taking over does not reload a tab that lost edit ownership.
        otherTab.onControllerChange();
        expect(reloadOtherTab).not.toHaveBeenCalled();

        // Tapping Reload in this tab overrides editingInOtherTab.
        otherTab.reload();
        otherTab.onControllerChange();
        expect(reloadOtherTab).toHaveBeenCalledTimes(1);
    });
});
