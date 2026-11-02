// vite-plugin-pwa's `virtual:pwa-register`. Its own declarations
// (vite-plugin-pwa/client) can't be referenced from here: the plugin is a
// dependency of @vite-pwa/astro, not of this package.
declare module "virtual:pwa-register" {
    export interface RegisterSWOptions {
        immediate?: boolean;
        onNeedRefresh?: () => void;
        onOfflineReady?: () => void;
        onRegisteredSW?: (
            swScriptUrl: string,
            registration: ServiceWorkerRegistration | undefined,
        ) => void;
        onRegisterError?: (error: unknown) => void;
    }

    /** Returns a function that activates the waiting update. */
    export function registerSW(
        options?: RegisterSWOptions,
    ): (reloadPage?: boolean) => Promise<void>;
}
