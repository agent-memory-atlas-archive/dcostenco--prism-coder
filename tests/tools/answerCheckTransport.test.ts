/**
 * The Synalux answer check transport (POST /api/v1/prism/verify-answer).
 * Only a well-formed PASS or FAIL is a verdict; everything else is ERROR, which
 * the handler treats as unchecked (cloud, else withheld). It never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { PORTAL, mockGetSynaluxJwt, mockInvalidateSynaluxJwt } = vi.hoisted(() => ({
    PORTAL: "https://portal.test",
    mockGetSynaluxJwt: vi.fn<() => Promise<string | null>>(),
    mockInvalidateSynaluxJwt: vi.fn(),
}));

vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/config.js")>();
    return { ...actual, PRISM_SYNALUX_BASE_URL: PORTAL, SYNALUX_CONFIGURED: true };
});
vi.mock("../../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: mockGetSynaluxJwt,
    invalidateSynaluxJwt: mockInvalidateSynaluxJwt,
}));

import { callSynaluxAnswerCheck, ANSWER_CHECK_MAX_BODY_BYTES } from "../../src/tools/prismInferHandler.js";

const REQUEST = {
    messages: [
        { role: "user" as const, content: "We have 240 units." },
        { role: "assistant" as const, content: "Noted." },
    ],
    prompt: "How many after selling 40?",
    answer: "200 units.",
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.clearAllMocks();
    mockGetSynaluxJwt.mockResolvedValue("jwt-current");
    fetchMock = vi.fn(async () => json(200, { verdict: "PASS", policy_version: "p1" }));
});
const check = (extra: Record<string, unknown> = {}) =>
    callSynaluxAnswerCheck({ ...REQUEST, fetchImpl: fetchMock as unknown as typeof fetch, ...extra });

describe("callSynaluxAnswerCheck", () => {
    it("posts the conversation, the request and the answer with bearer auth, no redirects, and a bounded time", async () => {
        await expect(check()).resolves.toEqual({ verdict: "PASS", policy_version: "p1" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
        expect(url).toBe(`${PORTAL}/api/v1/prism/verify-answer`);
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-current", "Content-Type": "application/json" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(init.body)).toEqual({ messages: REQUEST.messages, prompt: REQUEST.prompt, answer: REQUEST.answer });
    });
    it("sends each turn's role and text only", async () => {
        await check({ messages: [{ role: "user", content: "hi", images: ["aGk="], extra: 1 }] });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    });
    it("FAIL passes through; the policy version is bounded", async () => {
        fetchMock.mockResolvedValueOnce(json(200, { verdict: "FAIL", policy_version: "v".repeat(500) }));
        const r = await check();
        expect(r.verdict).toBe("FAIL");
        expect(r.policy_version).toHaveLength(64);
    });
    it("anything but an exact PASS or FAIL is ERROR: other words, case, missing, malformed JSON", async () => {
        for (const body of [{ verdict: "pass" }, { verdict: "YES" }, { verdict: "PASS " }, {}, "not json", { verdict: ["PASS"] }]) {
            fetchMock.mockResolvedValueOnce(json(200, body));
            expect((await check()).verdict, JSON.stringify(body)).toBe("ERROR");
        }
    });
    it("HTTP errors are ERROR, and only a 401 is retried, once, with a fresh token", async () => {
        for (const status of [403, 404, 429, 500, 503]) {
            fetchMock.mockResolvedValueOnce(json(status, { verdict: "PASS" }));
            await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: `http_${status}` });
        }
        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(mockInvalidateSynaluxJwt).not.toHaveBeenCalled();

        fetchMock.mockReset();
        mockGetSynaluxJwt.mockResolvedValueOnce("jwt-stale").mockResolvedValueOnce("jwt-fresh");
        fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { verdict: "FAIL" }));
        await expect(check()).resolves.toMatchObject({ verdict: "FAIL" });
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(c => (c[1] as { headers: Record<string, string> }).headers.Authorization)).toEqual(["Bearer jwt-stale", "Bearer jwt-fresh"]);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(json(401, {}));
        await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: "http_401" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("no token, no request: nothing leaves the device", async () => {
        mockGetSynaluxJwt.mockResolvedValue(null);
        await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: "jwt_unavailable" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("a request over the size cap is not sent", async () => {
        const huge = "x".repeat(ANSWER_CHECK_MAX_BODY_BYTES);
        await expect(check({ answer: huge })).resolves.toMatchObject({ verdict: "ERROR", reason: "request_too_large" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("an oversized reply is ERROR, whether declared or not", async () => {
        fetchMock.mockResolvedValueOnce(json(200, { verdict: "PASS" }, { "content-length": "999999" }));
        await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: "reply_too_large" });
        fetchMock.mockResolvedValueOnce(json(200, JSON.stringify({ verdict: "PASS", pad: "x".repeat(10_000) })));
        await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: "reply_too_large" });
    });
    it("network failure and timeout are ERROR, never thrown", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
        await expect(check()).resolves.toMatchObject({ verdict: "ERROR", reason: "network" });
        const hang = vi.fn((_u: unknown, init: { signal: AbortSignal }) => new Promise((_ok, fail) =>
            init.signal.addEventListener("abort", () => fail(Object.assign(new Error("t"), { name: "TimeoutError" })))));
        await expect(callSynaluxAnswerCheck({ ...REQUEST, fetchImpl: hang as unknown as typeof fetch, timeoutMs: 30 }))
            .resolves.toMatchObject({ verdict: "ERROR", reason: "timeout" });
    });
    it("the deadline bounds the JWT exchange too: a token that never arrives ends the check", async () => {
        mockGetSynaluxJwt.mockReturnValue(new Promise(() => { /* never */ }));
        const t0 = Date.now();
        await expect(check({ deadlineMs: 50 })).resolves.toMatchObject({ verdict: "ERROR", reason: "jwt_unavailable" });
        expect(Date.now() - t0).toBeLessThan(1_000);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
