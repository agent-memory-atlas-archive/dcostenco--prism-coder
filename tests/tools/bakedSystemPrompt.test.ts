/**
 * A Modelfile SYSTEM prompt must not reach prism's own local requests.
 *
 * Ollama applies a model's baked SYSTEM whenever a /api/chat request carries no
 * system message. prism-coder:2b and :4b bake a tool-routing prompt for apps that
 * call them directly; prism_infer and the Layer 1 screener are not those apps.
 * Measured 2026-09-27 on the published 4b:
 *   - prism_infer, no caller system: "Summarize these decisions … for the session
 *     ledger" came back as a session_save_ledger tool call instead of the summary;
 *   - Layer 1: the eval gate failed 5/5 runs (2 of 8 hard negatives refused on
 *     every run); the same weights without the SYSTEM passed 5/5.
 * An empty system message replaces the baked one. It must be sent ONLY to a model
 * that bakes one: on a model without (9b) it renders an empty system block, which
 * would change the prompt of the tier that serves most requests.
 *
 * Every model name below is unique per test because the probes cache per model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callOllamaGenerate, probeTemplateOverhead, probeClassifierLimits } from "../../src/tools/prismInferHandler.js";
import { callLayer1 } from "../../src/utils/layer1.js";

const URL_ = "http://ollama.test";
const ROUTER = "CRITICAL: You have EXACTLY 6 tools. When a tool is needed, respond ONLY with <|tool_call|>…";
// Passes the deterministic floor as undecided, so the model is consulted.
const UNDECIDED = "Load context for project billing and then summarize the open TODOs.";

type ChatBody = { model: string; messages: Array<{ role: string; content: string; images?: string[] }>; options?: { num_predict?: number } };

function ollama(baked: "system-field" | "modelfile-only" | "none" | "show-fails") {
    const chats: ChatBody[] = [];
    const shows: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith("/api/show")) {
            shows.push(String(init?.body ?? ""));
            if (baked === "show-fails") return new Response("boom", { status: 500 });
            const body = baked === "system-field"
                ? { system: ROUTER, modelfile: `FROM /blob\nSYSTEM """${ROUTER}"""\n`, template: "{{ .Prompt }}" }
                : baked === "modelfile-only"
                    ? { modelfile: `FROM /blob\nSYSTEM """${ROUTER}"""\n`, template: "{{ .Prompt }}" }
                    : { modelfile: "FROM /blob\nTEMPLATE {{ .Prompt }}\n", template: "{{ .Prompt }}" };
            return new Response(JSON.stringify(body), { status: 200 });
        }
        if (u.endsWith("/api/chat")) {
            const body = JSON.parse(String(init?.body)) as ChatBody;
            chats.push(body);
            // 16 tokens = the Layer 1 verdict, 8 = the image screen, else a generation.
            const n = body.options?.num_predict;
            const content = n === 16 ? "OBVIOUS_NOT_RESERVED" : n === 8 ? "no" : "An answer.";
            return new Response(JSON.stringify({
                message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 3,
            }), { status: 200 });
        }
        if (u.endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
        return new Response("{}", { status: 404 });
    });
    return { fn, chats, shows };
}

const EMPTY_SYSTEM = { role: "system", content: "" };

afterEach(() => { vi.unstubAllGlobals(); });

describe("prism_infer generation (callOllamaGenerate)", () => {
    it("replaces a baked SYSTEM with an empty system message when the caller gave none", async () => {
        const o = ollama("system-field");
        vi.stubGlobal("fetch", o.fn);
        const r = await callOllamaGenerate(URL_, "gen-baked-1", "Summarize these decisions for the session ledger.", undefined, 64, 0, 5_000);
        expect(r.ok).toBe(true);
        expect(o.chats).toHaveLength(1);
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
        expect(o.chats[0].messages[1]).toMatchObject({ role: "user", content: "Summarize these decisions for the session ledger." });
    });

    it("treats an explicit empty system the same way (the caller asked for none)", async () => {
        const o = ollama("system-field");
        vi.stubGlobal("fetch", o.fn);
        await callOllamaGenerate(URL_, "gen-baked-2", "hi", "", 64, 0, 5_000);
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("detects a SYSTEM line in the modelfile when /api/show has no system field", async () => {
        const o = ollama("modelfile-only");
        vi.stubGlobal("fetch", o.fn);
        await callOllamaGenerate(URL_, "gen-baked-3", "hi", undefined, 64, 0, 5_000);
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("suppresses when the model cannot be inspected (an empty system block is harmless)", async () => {
        const o = ollama("show-fails");
        vi.stubGlobal("fetch", o.fn);
        await callOllamaGenerate(URL_, "gen-unknown-1", "hi", undefined, 64, 0, 5_000);
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("keeps the caller's own system message, and sends exactly one", async () => {
        const o = ollama("system-field");
        vi.stubGlobal("fetch", o.fn);
        await callOllamaGenerate(URL_, "gen-baked-4", "hi", "Be brief.", 64, 0, 5_000);
        expect(o.chats[0].messages.filter(m => m.role === "system")).toEqual([{ role: "system", content: "Be brief." }]);
    });

    it("leaves a model without a baked SYSTEM exactly as before: no system message", async () => {
        const o = ollama("none");
        vi.stubGlobal("fetch", o.fn);
        await callOllamaGenerate(URL_, "gen-plain-1", "hi", undefined, 64, 0, 5_000);
        expect(o.chats[0].messages.map(m => m.role)).toEqual(["user"]);
    });
});

describe("Layer 1 screener (callLayer1)", () => {
    it("the classifier request replaces a baked SYSTEM", async () => {
        const o = ollama("system-field");
        const v = await callLayer1(UNDECIDED, URL_, "l1-baked-1", o.fn as unknown as typeof fetch);
        expect(v).toBe("OBVIOUS_NOT_RESERVED");
        expect(o.chats.length).toBeGreaterThan(0);
        for (const c of o.chats) expect(c.messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("the image content screen replaces it too", async () => {
        const o = ollama("system-field");
        await callLayer1(UNDECIDED, URL_, "l1-baked-2", o.fn as unknown as typeof fetch, ["aGVsbG8="]);
        const screens = o.chats.filter(c => c.options?.num_predict === 8);
        expect(screens.length).toBeGreaterThan(0);
        for (const c of screens) expect(c.messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("a model without a baked SYSTEM gets the unchanged request", async () => {
        const o = ollama("none");
        await callLayer1(UNDECIDED, URL_, "l1-plain-1", o.fn as unknown as typeof fetch);
        for (const c of o.chats) expect(c.messages.map(m => m.role)).toEqual(["user"]);
    });

    it("a decision by the deterministic floor makes no model request at all", async () => {
        const o = ollama("system-field");
        await callLayer1("Write JWT validation middleware for Express.", URL_, "l1-floor-1", o.fn as unknown as typeof fetch);
        expect(o.chats).toHaveLength(0);
        expect(o.shows).toHaveLength(0);
    });
});

describe("the probes measure the request that is actually sent", () => {
    it("probeTemplateOverhead without a caller system sends the empty system to a baked model", async () => {
        const o = ollama("system-field");
        vi.stubGlobal("fetch", o.fn);
        await probeTemplateOverhead(URL_, "ovh-baked-1", false);
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
    });

    it("probeTemplateOverhead leaves a plain model's no-system probe unchanged", async () => {
        const o = ollama("none");
        vi.stubGlobal("fetch", o.fn);
        await probeTemplateOverhead(URL_, "ovh-plain-1", false);
        expect(o.chats[0].messages.map(m => m.role)).toEqual(["user"]);
    });

    it("probeClassifierLimits refuses redirects on its own requests", async () => {
        const seen: Array<[string, RequestInit | undefined]> = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const u = String(input);
            seen.push([u, init]);
            if (u.endsWith("/api/show")) return new Response(JSON.stringify({ modelfile: "FROM /blob\n" }), { status: 200 });
            if (u.endsWith("/api/chat")) return new Response(JSON.stringify({ prompt_eval_count: 13 }), { status: 200 });
            if (u.endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
            return new Response("{}", { status: 404 });
        }));
        await probeClassifierLimits(URL_, "cls-redirect-1");
        const probes = seen.filter(([u]) => /\/api\/(chat|ps)$/.test(u));
        expect(probes.length).toBe(2);
        for (const [u, init] of probes) expect(init?.redirect, u).toBe("error");
    });

    it("probeClassifierLimits measures what callLayer1 sends", async () => {
        const o = ollama("system-field");
        vi.stubGlobal("fetch", o.fn);
        await probeClassifierLimits(URL_, "cls-baked-1");
        expect(o.chats[0].messages[0]).toEqual(EMPTY_SYSTEM);
    });
});
