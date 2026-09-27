/**
 * YDC_API_KEY as read from the environment: trimmed, and blank means unset,
 * so the optional youcom_web_search tool is registered only for a real key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const saved = process.env.YDC_API_KEY;
afterEach(() => {
    if (saved === undefined) delete process.env.YDC_API_KEY; else process.env.YDC_API_KEY = saved;
    vi.resetModules();
});
async function keyFor(value: string | undefined): Promise<string | undefined> {
    if (value === undefined) delete process.env.YDC_API_KEY; else process.env.YDC_API_KEY = value;
    vi.resetModules();
    return (await import("../src/config.js")).YDC_API_KEY;
}

describe("YDC_API_KEY", () => {
    it("is unset when absent, empty, or whitespace only", async () => {
        for (const v of [undefined, "", "   ", " \n\t "]) expect(await keyFor(v), JSON.stringify(v)).toBeUndefined();
    });
    it("is the trimmed value otherwise", async () => {
        expect(await keyFor("  ydc-key-123 \n")).toBe("ydc-key-123");
        expect(await keyFor("ydc-key-123")).toBe("ydc-key-123");
    });
});
