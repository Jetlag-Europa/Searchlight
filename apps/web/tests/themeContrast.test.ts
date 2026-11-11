import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

// Every page renders with `dark` on <body>, so the `.dark` tokens are the ones
// players see. Error messages are `text-destructive`.

const globals = readFileSync(
    resolve(__dirname, "../src/styles/globals.css"),
    "utf8",
);

function tokens(selector: string): Record<string, string> {
    const block = globals.match(
        new RegExp(
            `(?:^|\\n)\\s*${selector.replace(".", "\\.")}[\\s,][^{]*\\{([^}]*)\\}`,
        ),
    );
    if (!block) throw new Error(`no ${selector} block in globals.css`);
    return Object.fromEntries(
        [...block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [
            m[1],
            m[2].trim(),
        ]),
    );
}

function rgb(hslToken: string): number[] {
    const [h, s, l] = hslToken.split(/\s+/).map((v) => parseFloat(v));
    const sat = s / 100;
    const light = l / 100;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
}

// WCAG 2 relative luminance and contrast ratio.
function contrast(a: string, b: string): number {
    const lum = (c: number[]) =>
        c
            .map((v) =>
                v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe("red error text", () => {
    test("text-destructive uses the text token, fills keep --destructive", async () => {
        const { default: config } = await import("../tailwind.config.mjs");
        type Colors = Record<string, { DEFAULT: string }>;
        const { colors, textColor } = config.theme!.extend as {
            colors: Colors;
            textColor: Colors;
        };
        expect(textColor.destructive.DEFAULT).toBe(
            "hsl(var(--destructive-text))",
        );
        expect(colors.destructive.DEFAULT).toBe("hsl(var(--destructive))");
    });

    test.each([".dark", ":root"])(
        "is readable on the %s background (WCAG AA, 4.5:1)",
        (selector) => {
            const t = tokens(selector);
            expect(
                contrast(t["destructive-text"], t.background),
            ).toBeGreaterThanOrEqual(4.5);
        },
    );

    test("red buttons keep their light text readable", () => {
        const t = tokens(".dark");
        expect(
            contrast(t["destructive-foreground"], t.destructive),
        ).toBeGreaterThanOrEqual(4.5);
    });
});
