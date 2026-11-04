import { expect, test, testLogin, waitForTestHook } from "./fixtures";

// Custom tentacle/matching/measuring points and leaflet-draw's marker tool use
// Leaflet's default icon. Its image used to resolve to /map/marker-icon.png,
// which doesn't exist, so those points showed a broken image.
test("the default map marker shows its pin image", async ({ page }) => {
    await testLogin(page);
    await page.goto("/map/");
    await waitForTestHook(page);

    const images = await page.evaluate(async () => {
        const L = (window as unknown as { L: typeof import("leaflet") }).L;
        const icon = new L.Icon.Default();
        const load = (img: HTMLElement) =>
            new Promise<{ src: string; width: number }>((resolve) => {
                const done = () =>
                    resolve({
                        src: (img as HTMLImageElement).src,
                        width: (img as HTMLImageElement).naturalWidth,
                    });
                img.addEventListener("load", done);
                img.addEventListener("error", done);
                document.body.append(img);
            });
        return Promise.all([
            load(icon.createIcon()),
            load(icon.createShadow()!),
        ]);
    });

    for (const image of images) {
        expect(image.width, `${image.src} should load`).toBeGreaterThan(0);
    }
});
