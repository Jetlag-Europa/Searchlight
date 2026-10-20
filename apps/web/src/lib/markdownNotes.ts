// The small part of GitHub markdown that docs/releases/*.md use: paragraphs,
// headings, bullet lists, and inline bold, code and links. Everything else
// stays text, so the notes never add HTML to the page.

export type Inline =
    | { type: "text"; text: string }
    | { type: "strong"; text: string }
    | { type: "code"; text: string }
    | { type: "link"; text: string; href: string };

export type Block =
    | { type: "heading"; content: Inline[] }
    | { type: "paragraph"; content: Inline[] }
    | { type: "list"; items: Inline[][] };

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let last = 0;
    for (const match of text.matchAll(INLINE)) {
        if (match.index > last) {
            out.push({ type: "text", text: text.slice(last, match.index) });
        }
        const [whole, strong, code, linkText, href] = match;
        if (strong !== undefined) out.push({ type: "strong", text: strong });
        else if (code !== undefined) out.push({ type: "code", text: code });
        else if (/^https?:\/\//.test(href)) {
            out.push({ type: "link", text: linkText, href });
        } else out.push({ type: "text", text: whole });
        last = match.index + whole.length;
    }
    if (last < text.length) out.push({ type: "text", text: text.slice(last) });
    return out;
}

export function parseNotes(markdown: string): Block[] {
    const blocks: Block[] = [];
    let paragraph: string[] = [];
    let list: string[] | null = null;
    const flush = () => {
        if (paragraph.length) {
            blocks.push({
                type: "paragraph",
                content: parseInline(paragraph.join(" ")),
            });
        }
        if (list) blocks.push({ type: "list", items: list.map(parseInline) });
        paragraph = [];
        list = null;
    };
    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trim();
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const item = /^[-*]\s+(.*)$/.exec(line);
        if (!line) flush();
        else if (heading) {
            flush();
            blocks.push({ type: "heading", content: parseInline(heading[1]) });
        } else if (item) {
            if (paragraph.length) flush();
            (list ??= []).push(item[1]);
        } else if (list) {
            // A wrapped list item continues on the next line.
            list[list.length - 1] += ` ${line}`;
        } else paragraph.push(line);
    }
    flush();
    return blocks;
}
