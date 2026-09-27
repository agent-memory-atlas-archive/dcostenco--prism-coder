/**
 * The You.com key as configured: missing, blank, or malformed. A malformed key
 * is rejected by name before any request, so Fetch's header validation (whose
 * error message carries the value) never sees it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg = vi.hoisted(() => ({ key: undefined as string | undefined }));
vi.mock("../../src/config.js", () => ({
    get YDC_API_KEY() { return cfg.key; },
    PRISM_DEBUG_LOGGING: false,
}));
vi.mock("../../src/utils/logger.js", () => ({ debugLog: vi.fn(), sanitizeForLog: (s: string) => s }));

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;
beforeEach(() => { mockFetch.mockReset(); globalThis.fetch = mockFetch as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

import { performYouComSearch, youcomSearchAvailable } from "../../src/utils/youcomApi.js";

describe("the configured key", () => {
    it("missing or blank: unavailable, and a call is refused before any request", async () => {
        for (const k of [undefined, "", "   \n"]) {
            cfg.key = k;
            expect(youcomSearchAvailable(), JSON.stringify(k)).toBe(false);
            await expect(performYouComSearch("q")).rejects.toThrow("YDC_API_KEY is not configured");
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it("malformed (inner whitespace or control characters): refused by name, never echoed, no request", async () => {
        for (const k of ["abc\nsecret-XYZ", "abc secret-XYZ", "abc\u0000secret-XYZ", "abc\tsecret-XYZ"]) {
            cfg.key = k;
            const err = await performYouComSearch("q").then(() => null, e => e as Error);
            expect(err?.message, JSON.stringify(k)).toMatch(/YDC_API_KEY is set but is not a valid key/);
            expect(err?.message, JSON.stringify(k)).not.toContain("secret-XYZ");
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it("surrounding whitespace is trimmed, and the trimmed key is what is sent", async () => {
        cfg.key = "  good-key-123 \n";
        expect(youcomSearchAvailable()).toBe(true);
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: { web: [] } }), { status: 200 }));
        await performYouComSearch("q");
        expect(mockFetch.mock.calls[0][1].headers["X-API-Key"]).toBe("good-key-123");
    });
});
