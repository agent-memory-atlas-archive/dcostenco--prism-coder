/**
 * The second-read exclusion policy: served by Synalux, pinned by hash, held in
 * memory. Anything but the pinned, well-formed artifact is no policy (the
 * second read then does not run). A synthetic artifact stands in for the real
 * one, which is not public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const { PORTAL, mockGetSynaluxJwt, mockInvalidateSynaluxJwt } = vi.hoisted(() => ({
    PORTAL: "https://portal.test",
    mockGetSynaluxJwt: vi.fn<() => Promise<string | null>>(),
    mockInvalidateSynaluxJwt: vi.fn(),
}));
vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/config.js")>();
    return { ...actual, PRISM_SYNALUX_BASE_URL: PORTAL, SYNALUX_CONFIGURED: true };
});
vi.mock("../../src/utils/synaluxJwt.js", () => ({ getSynaluxJwt: mockGetSynaluxJwt, invalidateSynaluxJwt: mockInvalidateSynaluxJwt }));

import { parseSecondReadPolicy, getSecondReadPolicy, parseAnswerCheckPolicy, getAnswerCheckPolicy, _resetSecondReadPolicyForTest, SECOND_READ_POLICY_SHA256, ANSWER_CHECK_POLICY_SHA256 } from "../../src/utils/inferencePolicy.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ARTIFACT = JSON.parse(readFileSync(new URL("../fixtures/second-read-policy.synthetic.json", import.meta.url), "utf8"));
const BYTES = JSON.stringify(ARTIFACT);
const SHA = sha(BYTES);
/** The artifact with one change, and bytes and hash that match the change. */
const variant = (edit: (a: typeof ARTIFACT) => void) => {
    const a = JSON.parse(BYTES); edit(a);
    const b = JSON.stringify(a);
    return { b, h: sha(b) };
};

describe("parseSecondReadPolicy", () => {
    it("compiles exactly the pinned artifact, with the flags the client sets", () => {
        const p = parseSecondReadPolicy(BYTES, SHA)!;
        expect(p).not.toBeNull();
        expect(p.operational.flags).toBe("i");
        expect(p.classifierLabels.flags).toBe("");
        expect(p.deployScriptNoun.flags).toBe("gi");
        expect(p.operational.test("WHERE IS THE VAULT")).toBe(true);
        expect(p.classifierLabels.test("obvious_reserved")).toBe(false);
    });
    it("another hash is no policy: one changed byte, or a well-formed artifact that is not the pinned one", () => {
        expect(parseSecondReadPolicy(BYTES.replace("vault", "vaulx"), SHA)).toBeNull();
        expect(parseSecondReadPolicy(BYTES, SECOND_READ_POLICY_SHA256)).toBeNull();
    });
    it("a wrong schema or evaluator, a list below its floor, a missing, oversized or uncompilable pattern is no policy", () => {
        for (const [name, edit] of [
            ["schema", (a: typeof ARTIFACT) => { a.schema = 2; }],
            ["evaluator", (a: typeof ARTIFACT) => { a.evaluator = "second-read-exclusion/2"; }],
            ["few terms", (a: typeof ARTIFACT) => { a.second_read.operational_terms = a.second_read.operational_terms.slice(0, 7); }],
            ["empty list", (a: typeof ARTIFACT) => { a.second_read.operational_terms = []; }],
            ["one decision", (a: typeof ARTIFACT) => { a.second_read.deploy_decision = ["\\bnow\\b"]; }],
            ["empty pattern", (a: typeof ARTIFACT) => { a.second_read.operational_terms[0] = ""; }],
            ["missing field", (a: typeof ARTIFACT) => { delete a.second_read.classifier_directed; }],
            ["oversize pattern", (a: typeof ARTIFACT) => { a.second_read.deploy_term = "x".repeat(1_025); }],
            ["not a string", (a: typeof ARTIFACT) => { a.second_read.operational_terms[0] = 7; }],
            ["uncompilable", (a: typeof ARTIFACT) => { a.second_read.classifier_directed = "(unclosed"; }],
        ] as const) {
            const { b, h } = variant(edit as (a: typeof ARTIFACT) => void);
            expect(parseSecondReadPolicy(b, h), name).toBeNull();
        }
        const huge = JSON.stringify({ ...ARTIFACT, pad: "x".repeat(70_000) });
        expect(parseSecondReadPolicy(huge, sha(huge))).toBeNull();
        expect(parseSecondReadPolicy("not json", sha("not json"))).toBeNull();
    });
});

describe("getSecondReadPolicy", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.clearAllMocks();
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        fetchMock = vi.fn(async () => new Response(BYTES, { status: 200 }));
    });
    const load = (extra: Record<string, unknown> = {}) =>
        getSecondReadPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: SHA, ...extra });

    it("GETs the pinned artifact by its hash with bearer auth and no redirects, and compiles it", async () => {
        const p = await load();
        expect(p?.operational.test("the control room")).toBe(true);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${PORTAL}/api/v1/prism/inference-policy/${SHA}`);
        expect(init).toMatchObject({ method: "GET", redirect: "error" });
        expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-current" });
    });
    it("loads once per process; concurrent callers share the one request", async () => {
        const [a, b] = await Promise.all([load(), load()]);
        expect(a).toBe(b);
        expect(await load()).toBe(a);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("the real pin is what an unconfigured call fetches", async () => {
        await getSecondReadPolicy({ fetchImpl: fetchMock as unknown as typeof fetch });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${SECOND_READ_POLICY_SHA256}`);
    });
    it("bytes that are not the pinned artifact are no policy", async () => {
        fetchMock.mockResolvedValueOnce(new Response(BYTES.replace("vault", "vaulx"), { status: 200 }));
        expect(await load()).toBeNull();
    });
    it("a denial or failure is no policy, and the next try waits instead of hammering the portal", async () => {
        for (const status of [403, 404, 500]) {
            _resetSecondReadPolicyForTest();
            fetchMock.mockReset();
            fetchMock.mockResolvedValue(new Response("{}", { status }));
            expect(await load(), String(status)).toBeNull();
            expect(await load(), String(status)).toBeNull();
            expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
        }
        _resetSecondReadPolicyForTest();
        fetchMock.mockReset();
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
        expect(await load()).toBeNull();
    });
    it("a 401 is retried once with a fresh token", async () => {
        mockGetSynaluxJwt.mockResolvedValueOnce("jwt-stale").mockResolvedValueOnce("jwt-fresh");
        fetchMock.mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response(BYTES, { status: 200 }));
        expect(await load()).not.toBeNull();
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("no token, no request; a token that never arrives ends at the deadline", async () => {
        mockGetSynaluxJwt.mockResolvedValue(null);
        expect(await load()).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockReturnValue(new Promise(() => { /* never */ }));
        const t0 = Date.now();
        expect(await load({ deadlineMs: 50 })).toBeNull();
        expect(Date.now() - t0).toBeLessThan(1_000);
    });
    it("an oversized reply is not read", async () => {
        fetchMock.mockResolvedValueOnce(new Response(BYTES, { status: 200, headers: { "content-length": "999999" } }));
        expect(await load()).toBeNull();
    });
    it("the pin covers the bytes as received: a byte-order mark in front is another artifact, even though decoding would drop it", async () => {
        const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BYTES, "utf8")]);
        fetchMock.mockResolvedValueOnce(new Response(withBom, { status: 200 }));
        expect(await load()).toBeNull();
        // the same bytes without it load
        _resetSecondReadPolicyForTest();
        fetchMock.mockResolvedValueOnce(new Response(Buffer.from(BYTES, "utf8"), { status: 200 }));
        expect(await load()).not.toBeNull();
    });
});

describe("parseAnswerCheckPolicy", () => {
    const ACBYTES = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
    const ACSHA = sha(ACBYTES);
    const acVariant = (edit: (a: { schema: unknown; evaluator: unknown; answer_check: Record<string, any> }) => void) => {
        const a = JSON.parse(ACBYTES); edit(a);
        const b = JSON.stringify(a);
        return { b, h: sha(b) };
    };
    it("compiles exactly the pinned artifact: texts, correction template, arithmetic fragments and scale list", () => {
        const p = parseAnswerCheckPolicy(ACBYTES, ACSHA)!;
        expect(p).not.toBeNull();
        expect(p.systemPrompt).toMatch(/^SYNTHETIC CHECK RULES/);
        expect(p.correction.line).toContain("{expression}");
        expect(p.arithmetic.quoted).toBeInstanceOf(RegExp);
        expect(p.arithmetic.scalePowers).toEqual([-2, -1, 1, 2]);
    });
    it("another hash is no policy: one changed byte, the second-read artifact, or a well-formed artifact that is not the pinned one", () => {
        expect(parseAnswerCheckPolicy(ACBYTES.replace("SYNTHETIC", "SYNTHETIX"), ACSHA)).toBeNull();
        expect(parseAnswerCheckPolicy(BYTES, SHA)).toBeNull();
        expect(parseAnswerCheckPolicy(ACBYTES)).toBeNull();   // the real pin is not this fixture
    });
    it("a wrong schema or evaluator, a missing or oversized text, a template without its slots, a capturing, back-referencing or uncompilable fragment, or a bad scale list is no policy", () => {
        for (const [name, edit] of [
            ["schema", a => { a.schema = 2; }],
            ["evaluator", a => { a.evaluator = "answer-check/2"; }],
            ["no system prompt", a => { delete a.answer_check.system_prompt; }],
            ["blank reminder", a => { a.answer_check.reminder = "  "; }],
            ["oversize prompt", a => { a.answer_check.system_prompt = "x".repeat(16_385); }],
            ["slot missing", a => { a.answer_check.correction.line = "{expression} is {correct}"; }],
            ["empty join", a => { a.answer_check.correction.join = ""; }],
            ["capturing group", a => { a.answer_check.arithmetic.number = "(\\d+)"; }],
            ["named group", a => { a.answer_check.arithmetic.end = "(?<x>\\s)"; }],
            ["back-reference", a => { a.answer_check.arithmetic.end = "(?!\\1)"; }],
            ["uncompilable", a => { a.answer_check.arithmetic.start = "(?<!"; }],
            // a trailing backslash would escape the reader's own closing parenthesis
            ["trailing backslash", a => { a.answer_check.arithmetic.number = "\\d+\\"; }],
            ["no scale", a => { a.answer_check.arithmetic.scale_powers = []; }],
            ["zero power", a => { a.answer_check.arithmetic.scale_powers = [0]; }],
            ["huge power", a => { a.answer_check.arithmetic.scale_powers = [13]; }],
            ["fractional power", a => { a.answer_check.arithmetic.scale_powers = [1.5]; }],
            ["no arithmetic", a => { delete a.answer_check.arithmetic; }],
        ] as Array<[string, Parameters<typeof acVariant>[0]]>) {
            const { b, h } = acVariant(edit);
            expect(parseAnswerCheckPolicy(b, h), name).toBeNull();
        }
    });
    it("is fetched like the second-read policy: its own pin, memory only, one request per process", async () => {
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        const fetchMock = vi.fn(async () => new Response(ACBYTES, { status: 200 }));
        const load = () => getAnswerCheckPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: ACSHA });
        const [a, b] = await Promise.all([load(), load()]);
        expect(a).not.toBeNull();
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${ACSHA}`);
        _resetSecondReadPolicyForTest();
        fetchMock.mockClear();
        await getAnswerCheckPolicy({ fetchImpl: fetchMock as unknown as typeof fetch });
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${ANSWER_CHECK_POLICY_SHA256}`);
    });
});
