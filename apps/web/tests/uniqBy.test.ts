import { expect, test } from "vitest";

import { uniqBy } from "@/lib/utils";

test("uniqBy keeps the first item for each key, in order", () => {
    const items = [
        { id: 1, n: "a" },
        { id: 2, n: "b" },
        { id: 1, n: "c" },
        { id: "1", n: "d" },
    ];
    expect(uniqBy(items, (x) => x.id).map((x) => x.n)).toEqual(["a", "b", "d"]);
});
