import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const web = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(web, path), "utf8");

const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    });

const extensionsUnder = (dir: string) =>
    new Set(filesUnder(resolve(web, dir)).map((f) => extname(f).slice(1)));

// nginx.conf's /skills/ location, and the types it gives each extension
const skillsBlock = () => {
    const conf = read("nginx.conf");
    const start = conf.indexOf("location ^~ /skills/ {");
    expect(start).toBeGreaterThan(-1);
    return conf.slice(start, conf.indexOf("\n    }\n", start));
};
const skillsTypes = () => {
    const types = /types \{([^}]*)\}/.exec(skillsBlock())?.[1] ?? "";
    return new Map(
        types
            .split(";")
            .map((line) => line.trim().split(/\s+/))
            .filter((words) => words.length === 2)
            .map(([type, ext]) => [ext, type]),
    );
};

// Extensions nginx's own mime.types gives a type that browsers show or use.
const STOCK_TYPES = new Set([
    "css",
    "html",
    "ico",
    "jpg",
    "js",
    "json",
    "mp3",
    "png",
    "svg",
    "txt",
    "webp",
    "woff2",
]);

// The type each extension under public/skills/ gets: the guide is read as
// text, and browsers load the scripts as modules only with a JavaScript type.
const SKILLS_TYPES = { md: "text/plain", mjs: "text/javascript" };

describe("files in public/", () => {
    test("each have a content type nginx knows", () => {
        const unknown = filesUnder(resolve(web, "public"))
            .map((f) => relative(resolve(web, "public"), f))
            .filter((f) => !f.startsWith("skills/") && f !== "_headers")
            .filter((f) => !STOCK_TYPES.has(extname(f).slice(1)));
        expect(unknown).toEqual([]);
    });

    test("under skills/ open in a tab with nginx", () => {
        expect(Object.fromEntries(skillsTypes())).toEqual(SKILLS_TYPES);
        for (const ext of extensionsUnder("public/skills")) {
            expect(Object.keys(SKILLS_TYPES), `.${ext}`).toContain(ext);
        }
        const block = skillsBlock();
        expect(block).toContain("charset utf-8;");
        expect(block).toContain("include /etc/nginx/security-headers.conf;");
        expect(block).toContain("try_files $uri =404;");
    });

    test("under skills/ get the same types on Cloudflare", () => {
        const headers = read("public/_headers");
        for (const [ext, type] of skillsTypes()) {
            expect(headers).toContain(
                `/skills/*.${ext}\n  Content-Type: ${type}; charset=utf-8\n`,
            );
        }
    });
});
