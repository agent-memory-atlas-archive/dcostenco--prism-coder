/**
 * The classifier sees the user's words as written. A string replacement
 * expands `$``, `$'`, `$&` and `$$`; the request is built literally.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { callLayer1, layer1ClassifierContent, LAYER1_PROMPT } from "../../src/utils/layer1.js";
import { _resetBakedSystemCacheForTest } from "../../src/utils/ollamaSystemPrompt.js";

beforeEach(() => { _resetBakedSystemCacheForTest(); });

const SPECIALS = ["$`", "$'", "$&", "$$", "$1", "$<name>"];

describe("layer1ClassifierContent", () => {
    it("puts the input in place of {prompt} verbatim, replacement patterns included", () => {
        for (const sp of SPECIALS) {
            const input = `Colors: ${sp} and ${sp} end`;
            const [head, tail] = LAYER1_PROMPT.split("{prompt}");
            expect(layer1ClassifierContent(input), sp).toBe(head + input + tail);
        }
    });
    it("callLayer1 sends exactly that request", async () => {
        const sent: Array<Array<{ role: string; content: string }>> = [];
        const fetchImpl = (async (u: unknown, init?: { body?: unknown }) => {
            // The published prism-coder:4b bakes a SYSTEM; the request replaces it
            // with an empty one (utils/ollamaSystemPrompt.ts).
            if (String(u).endsWith("/api/show")) return new Response(JSON.stringify({ system: "baked" }), { status: 200 });
            sent.push(JSON.parse(String(init?.body)).messages);
            return new Response(JSON.stringify({ message: { content: "OBVIOUS_NOT_RESERVED" } }), { status: 200 });
        }) as unknown as typeof fetch;
        const input = "Which of these is darker: $` or $'?";
        await callLayer1(input, "http://x", "prism-coder:4b", fetchImpl, undefined, { deterministic: false });
        expect(sent).toEqual([[{ role: "system", content: "" }, { role: "user", content: layer1ClassifierContent(input) }]]);
        expect(sent[0][1].content.length).toBe(LAYER1_PROMPT.length - "{prompt}".length + input.length);
    });
});
