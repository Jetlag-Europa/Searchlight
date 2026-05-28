import { defineConfig } from "vitest/config";

export default defineConfig({
    define: {
        "import.meta.env.PUBLIC_API_BASE": JSON.stringify("http://localhost:3001"),
    },
    test: {
        alias: {
            "@/": new URL("./src/", import.meta.url).pathname,
        },
    },
});
