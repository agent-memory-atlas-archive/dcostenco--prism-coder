import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadingSystemMessages, modelHasBakedSystem, _resetBakedSystemCacheForTest } from "../../src/utils/ollamaSystemPrompt.js";

const URL_ = "http://ollama.test";

function show(body: unknown, status = 200) {
    return vi.fn(async (_input: string, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

beforeEach(() => { _resetBakedSystemCacheForTest(); });
afterEach(() => { vi.useRealTimers(); });

describe("modelHasBakedSystem", () => {
    it("reads the system field", async () => {
        expect(await modelHasBakedSystem(URL_, "a", show({ system: "route me" }))).toBe(true);
        expect(await modelHasBakedSystem(URL_, "b", show({ template: "{{ .Prompt }}" , modelfile: "FROM /x\n" }))).toBe(false);
    });

    it("a blank system field is no system", async () => {
        expect(await modelHasBakedSystem(URL_, "c", show({ system: "  \n " }))).toBe(false);
    });

    it("falls back to a SYSTEM line in the modelfile", async () => {
        expect(await modelHasBakedSystem(URL_, "d", show({ modelfile: 'FROM /x\nSYSTEM """route me"""\n' }))).toBe(true);
        expect(await modelHasBakedSystem(URL_, "e", show({ modelfile: "FROM /x\n# SYSTEM is mentioned in a comment\n" }))).toBe(false);
    });

    it("an error, a non-JSON body or an unexpected shape is unknown", async () => {
        expect(await modelHasBakedSystem(URL_, "f", show("nope", 500))).toBeNull();
        expect(await modelHasBakedSystem(URL_, "g", show("not json"))).toBeNull();
        expect(await modelHasBakedSystem(URL_, "h", show({}))).toBeNull();
        const thrower = vi.fn(async () => { throw new TypeError("fetch failed"); });
        expect(await modelHasBakedSystem(URL_, "i", thrower)).toBeNull();
    });

    it("asks /api/show for the model, refusing redirects", async () => {
        const f = show({ system: "x" });
        await modelHasBakedSystem(URL_, "j", f);
        const [url, init] = f.mock.calls[0];
        expect(url).toBe(`${URL_}/api/show`);
        expect(JSON.parse(String(init?.body))).toEqual({ model: "j" });
        expect(init?.redirect).toBe("error");
    });

    it("caches per server and model; a known answer for ten minutes, an unknown one for a minute", async () => {
        vi.useFakeTimers({ now: 1_000_000 });
        const known = show({ system: "x" });
        await modelHasBakedSystem(URL_, "k", known);
        await modelHasBakedSystem(URL_, "k", known);
        expect(known).toHaveBeenCalledTimes(1);
        await modelHasBakedSystem("http://other.test", "k", known);
        expect(known).toHaveBeenCalledTimes(2);
        vi.setSystemTime(1_000_000 + 9 * 60_000);
        await modelHasBakedSystem(URL_, "k", known);
        expect(known).toHaveBeenCalledTimes(2);
        vi.setSystemTime(1_000_000 + 10 * 60_000 + 1);
        await modelHasBakedSystem(URL_, "k", known);
        expect(known).toHaveBeenCalledTimes(3);

        const failing = show("x", 500);
        await modelHasBakedSystem(URL_, "u", failing);
        vi.setSystemTime(Date.now() + 30_000);
        await modelHasBakedSystem(URL_, "u", failing);
        expect(failing).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 31_000);
        await modelHasBakedSystem(URL_, "u", failing);
        expect(failing).toHaveBeenCalledTimes(2);
    });
});

describe("leadingSystemMessages", () => {
    it("a caller's system message is used as-is, without inspecting the model", async () => {
        const f = show({ system: "x" });
        expect(await leadingSystemMessages(URL_, "m", "Be brief.", f)).toEqual([{ role: "system", content: "Be brief." }]);
        expect(f).not.toHaveBeenCalled();
    });

    it("no caller system: empty for a baked or uninspectable model, nothing for a plain one", async () => {
        expect(await leadingSystemMessages(URL_, "n1", undefined, show({ system: "x" }))).toEqual([{ role: "system", content: "" }]);
        expect(await leadingSystemMessages(URL_, "n2", "", show({ system: "x" }))).toEqual([{ role: "system", content: "" }]);
        expect(await leadingSystemMessages(URL_, "n3", undefined, show("x", 500))).toEqual([{ role: "system", content: "" }]);
        expect(await leadingSystemMessages(URL_, "n4", undefined, show({ modelfile: "FROM /x\n" }))).toEqual([]);
    });
});
