/**
 * Policies the on-device multi-turn features run with, served by Synalux to
 * plans with multi-turn: the second read's exclusion policy (the conversations
 * the 9b may not re-read after a 4b hedge) and the answer check's rules. Each
 * release accepts exactly one artifact of each, pinned by its SHA-256, so the
 * policy a client runs is the one it was released and validated with.
 *
 * They are held in memory only, never in settings (session exports copy
 * settings). Anything but the pinned, well-formed artifact is no policy: with
 * no second-read policy the second read does not run (the hedge stands); with
 * no answer-check policy a local answer to a conversation is unchecked (cloud,
 * else withheld).
 */
import { createHash } from "node:crypto";
import { PRISM_SYNALUX_BASE_URL } from "../config.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "./synaluxJwt.js";
import type { SecondReadExclusionPolicy } from "./layer1.js";
import { arithmeticExpressions, type AnswerCheckPolicy } from "./answerGrounding.js";

/** The artifact this release runs. Changing it is a release, with its gates. */
export const SECOND_READ_POLICY_SHA256 = "1b04eb3153b14bb13bff40e142c76eda0d61d21eccfd86c9ff03dd004e107985";
/** The evaluator this client implements (layer1.ts secondReadExclusion). */
export const SECOND_READ_POLICY_EVALUATOR = "second-read-exclusion/1";
/** The answer-check artifact this release runs. */
export const ANSWER_CHECK_POLICY_SHA256 = "ba12ab1f6858b68ed36b7c0551aa3381ffb45b6123eb0aacd09c9316efd27993";
/** The mechanism this client implements (answerGrounding.ts, groundAnswer). */
export const ANSWER_CHECK_POLICY_EVALUATOR = "answer-check/1";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_PATTERN_CHARS = 1_024;
const MIN_OPERATIONAL_TERMS = 8;
const MIN_DEPLOY_DECISION = 2;
/** The whole load, JWT exchange included. */
const LOAD_DEADLINE_MS = 8_000;
/** After a failed load, conversations run without the second read this long before the next try. */
const RETRY_AFTER_MS = 30_000;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The compiled policy from the artifact's exact bytes, or null for anything
 *  but the expected artifact: another hash, another schema or evaluator, a
 *  list below its floor, an oversized field, a pattern that does not compile. */
export function parseSecondReadPolicy(bytes: string, expectSha256: string = SECOND_READ_POLICY_SHA256): SecondReadExclusionPolicy | null {
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_BYTES) return null;
    if (sha256(bytes) !== expectSha256) return null;
    let a: unknown;
    try { a = JSON.parse(bytes); } catch { return null; }
    const art = a as { schema?: unknown; evaluator?: unknown; second_read?: Record<string, unknown> };
    if (art?.schema !== 1 || art.evaluator !== SECOND_READ_POLICY_EVALUATOR || typeof art.second_read !== "object" || art.second_read === null) return null;
    const s = art.second_read;
    const pattern = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_PATTERN_CHARS;
    const list = (v: unknown, min: number): v is string[] => Array.isArray(v) && v.length >= min && v.every(pattern);
    if (!list(s.operational_terms, MIN_OPERATIONAL_TERMS) || !list(s.deploy_decision, MIN_DEPLOY_DECISION)) return null;
    if (![s.classifier_labels, s.classifier_directed, s.deploy_term, s.deploy_script_noun].every(pattern)) return null;
    try {
        // The client sets every flag; the artifact supplies sources only.
        return {
            operational: new RegExp(s.operational_terms.join("|"), "i"),
            classifierLabels: new RegExp(s.classifier_labels as string),
            classifierDirected: new RegExp(s.classifier_directed as string, "i"),
            deployTerm: new RegExp(s.deploy_term as string, "i"),
            deployScriptNoun: new RegExp(s.deploy_script_noun as string, "gi"),
            deployDecision: new RegExp(s.deploy_decision.join("|"), "i"),
        };
    } catch {
        return null;
    }
}

/** Capturing groups in a pattern fragment (the reader numbers its own). */
const groups = (src: string) => new RegExp(`${src}|`).exec("")!.length - 1;

/** The compiled answer-check policy from the artifact's exact bytes, or null
 *  for anything but the expected artifact: another hash, schema or evaluator,
 *  a missing or oversized text, a correction line without its three slots, a
 *  pattern that does not compile or captures, a bad scale list. */
export function parseAnswerCheckPolicy(bytes: string, expectSha256: string = ANSWER_CHECK_POLICY_SHA256): AnswerCheckPolicy | null {
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_BYTES) return null;
    if (sha256(bytes) !== expectSha256) return null;
    let a: unknown;
    try { a = JSON.parse(bytes); } catch { return null; }
    const art = a as { schema?: unknown; evaluator?: unknown; answer_check?: Record<string, unknown> };
    if (art?.schema !== 1 || art.evaluator !== ANSWER_CHECK_POLICY_EVALUATOR || typeof art.answer_check !== "object" || art.answer_check === null) return null;
    const s = art.answer_check;
    const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
    if (!text(s.system_prompt, 16_384) || !text(s.reminder, 1_024) || !text(s.verdict_only, 1_024)) return null;
    const c = s.correction as Record<string, unknown> | undefined;
    if (!c || !text(c.lead, 512) || !text(c.tail, 512) || typeof c.join !== "string" || c.join.length === 0 || c.join.length > 16 || !text(c.line, 256)) return null;
    if (!["{expression}", "{correct}", "{stated}"].every(slot => (c.line as string).includes(slot))) return null;
    const ar = s.arithmetic as Record<string, unknown> | undefined;
    if (!ar) return null;
    const fragments = [ar.number, ar.start, ar.minus_or_plus, ar.end, ar.quoted];
    if (!fragments.every(f => text(f, MAX_PATTERN_CHARS))) return null;
    const scale = ar.scale_powers;
    if (!Array.isArray(scale) || scale.length === 0 || scale.length > 16 || !scale.every(k => Number.isInteger(k) && k !== 0 && Math.abs(k) <= 12)) return null;
    // The reader numbers its own groups: a fragment may neither capture nor refer back to one.
    if (fragments.some(f => /\\[1-9]|\\k</.test(f as string))) return null;
    try {
        if (fragments.some(f => groups(f as string) !== 0)) return null;
        const arithmetic = {
            number: ar.number as string, start: ar.start as string, minusOrPlus: ar.minus_or_plus as string, end: ar.end as string,
            quoted: new RegExp(ar.quoted as string), scalePowers: scale as number[],
        };
        arithmeticExpressions(arithmetic);   // the reader's expressions, exactly as it builds them
        return {
            systemPrompt: s.system_prompt,
            reminder: s.reminder,
            verdictOnly: s.verdict_only,
            correction: { lead: c.lead as string, line: c.line as string, join: c.join, tail: c.tail as string },
            arithmetic,
        };
    } catch {
        return null;
    }
}

interface LoadOptions {
    fetchImpl?: typeof fetch;
    deadlineMs?: number;
    /** Tests only: the hash to fetch and accept instead of the pinned one. */
    expectSha256?: string;
}

/** One pinned artifact: loaded once per process (the portal and the credential
 *  are fixed for its life, config.ts), shared by concurrent callers, retried
 *  after RETRY_AFTER_MS when a load fails. Never throws. */
function pinned<T>(pinnedSha: string, parse: (bytes: string, sha: string) => T | null) {
    let cached: T | null = null;
    let inflight: Promise<T | null> | null = null;
    let retryAt = 0;
    const get = async (o: LoadOptions = {}): Promise<T | null> => {
        if (!PRISM_SYNALUX_BASE_URL) return null;
        if (cached) return cached;
        if (inflight) return inflight;
        if (Date.now() < retryAt) return null;
        const promise: Promise<T | null> = load(o, o.expectSha256 ?? pinnedSha, parse).then(policy => {
            if (policy) cached = policy;
            else retryAt = Date.now() + RETRY_AFTER_MS;
            return policy;
        }).catch(() => { retryAt = Date.now() + RETRY_AFTER_MS; return null; })
            .finally(() => { if (inflight === promise) inflight = null; });
        inflight = promise;
        return promise;
    };
    const reset = () => { cached = null; inflight = null; retryAt = 0; };
    return { get, reset };
}

async function load<T>(o: LoadOptions, sha: string, parse: (bytes: string, sha: string) => T | null): Promise<T | null> {
    const f = o.fetchImpl ?? fetch;
    const deadline = Date.now() + (o.deadlineMs ?? LOAD_DEADLINE_MS);
    const left = () => deadline - Date.now();
    const jwtWithin = async (): Promise<string | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, left())); });
        try { return await Promise.race([getSynaluxJwt().catch(() => null), expired]); }
        finally { clearTimeout(timer); }
    };
    const get = (jwt: string) => f(`${PRISM_SYNALUX_BASE_URL}/api/v1/prism/inference-policy/${sha}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" },
        signal: AbortSignal.timeout(Math.max(1, left())),
        redirect: "error",
    });
    let jwt = await jwtWithin();
    if (!jwt) return null;
    let res = await get(jwt);
    if (res.status === 401) {
        invalidateSynaluxJwt();
        jwt = await jwtWithin();
        if (!jwt || left() <= 0) return null;
        res = await get(jwt);
    }
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return null;
    // The pin covers the bytes as received: hash them before any decoding,
    // which would drop a byte-order mark or repair invalid UTF-8 first.
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.byteLength > MAX_ARTIFACT_BYTES) return null;
    if (createHash("sha256").update(raw).digest("hex") !== sha) return null;
    return parse(raw.toString("utf8"), sha);
}

const secondRead = pinned(SECOND_READ_POLICY_SHA256, parseSecondReadPolicy);
const answerCheck = pinned(ANSWER_CHECK_POLICY_SHA256, parseAnswerCheckPolicy);
/** The pinned second-read policy, or null. */
export const getSecondReadPolicy = (o: LoadOptions = {}) => secondRead.get(o);
/** The pinned answer-check policy, or null. */
export const getAnswerCheckPolicy = (o: LoadOptions = {}) => answerCheck.get(o);

/** Tests only. */
export function _resetSecondReadPolicyForTest(): void {
    secondRead.reset();
    answerCheck.reset();
}
