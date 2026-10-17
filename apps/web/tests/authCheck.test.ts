import { describe, expect, test } from "vitest";

import { authCheckOutcome, authRetryDelay } from "@/lib/authCheck";

describe("/me outcome", () => {
    test("only a 401 signs the visitor out", () => {
        expect(authCheckOutcome(401)).toBe("signed-out");
    });

    test("a 2xx signs them in", () => {
        expect(authCheckOutcome(200)).toBe("signed-in");
    });

    test.each([undefined, 403, 404, 429, 500, 502, 503, 504])(
        "%s is a blip to retry, not a logout",
        (status) => {
            expect(authCheckOutcome(status)).toBe("unreachable");
        },
    );
});

describe("/me retry delay", () => {
    test("doubles from 2 seconds up to 30", () => {
        expect([1, 2, 3, 4, 5, 6, 20].map(authRetryDelay)).toEqual([
            2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
        ]);
    });
});
