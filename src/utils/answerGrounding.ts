/**
 * The local answer check: the mechanism. A local answer to a conversation is
 * read against the conversation by the model that answered (the HTTP call is
 * groundAnswer in prismInferHandler.ts), and served only on PASS. The rules
 * it checks with (the policy text, the reminders, the correction wording and
 * the arithmetic reader's patterns) come from a pinned artifact that Synalux
 * serves (inferencePolicy.ts); this file holds none of them.
 *
 * The policy goes in the system message; the conversation, final request and
 * candidate answer go as one JSON object in the user message: data to check,
 * never instructions. Three outcomes for the caller:
 *   GROUNDED    served (after the Synalux confirmation when cloud is allowed);
 *   UNGROUNDED  cloud when allowed, else withheld;
 *   ERROR/UNFIT unchecked: the same.
 */

export type AnswerGroundingVerdict = "GROUNDED" | "UNGROUNDED" | "ERROR";
export interface GroundingTurn { role: "user" | "assistant"; content: string }

/** The compiled answer-check policy (inferencePolicy.ts parses and checks it). */
export interface AnswerCheckPolicy {
    systemPrompt: string;
    /** Closing turn of the one retry, after a reply that held no verdict. */
    reminder: string;
    /** Closing turn after reasoning that ended without the word, shown back. */
    verdictOnly: string;
    correction: { lead: string; line: string; join: string; tail: string };
    arithmetic: {
        /** One number; no capturing groups (the reader adds its own). */
        number: string;
        /** Where an expression may start (lookbehinds). */
        start: string;
        /** A plus or minus between terms. */
        minusOrPlus: string;
        /** What may follow a result (lookahead). */
        end: string;
        /** Quoted text, which is not the checker's own arithmetic. */
        quoted: RegExp;
        /** A result off by one of these powers of ten is a conversion, not a slip. */
        scalePowers: readonly number[];
    };
}

/** The user message: JSON, so every field is escaped data (a forged heading or
 *  role label inside a turn stays inside its string). */
export function answerGroundingContent(messages: readonly GroundingTurn[], prompt: string, answer: string): string {
    return JSON.stringify({
        conversation: messages.map(m => ({ role: m.role, text: m.content })),
        final_request: prompt,
        candidate_answer: answer,
    }, null, 1);
}

/** Strict: the reply, with whitespace, emphasis and trailing punctuation
 *  removed, must BE one of the two words. "NOT PASS", "PASS because ..." or
 *  both words match neither. */
export function parseGroundingVerdict(reply: string): AnswerGroundingVerdict {
    const joined = reply.replace(/\s+/g, "").replace(/^[*`"'_]+/, "").replace(/[.!,:;"'*`_]+$/, "").toUpperCase();
    return joined === "PASS" ? "GROUNDED" : joined === "FAIL" ? "UNGROUNDED" : "ERROR";
}

/** The check reasons before its verdict. */
export const ANSWER_GROUNDING_THINK = true;
/** Reasoning plus the one-word reply. */
export const ANSWER_GROUNDING_THINK_TOKENS = 1_024;
/** Past this the answer is unchecked: cloud, or withheld. */
export const ANSWER_GROUNDING_TIMEOUT_MS = 10_000;
/** The one-word reply alone: a longer reply ends on "length" and is an ERROR. */
export const ANSWER_GROUNDING_OUTPUT_TOKENS = 8;
export const ANSWER_GROUNDING_RETRY_TIMEOUT_MS = 8_000;
/** Room the size bound keeps for the one follow-up turn: the arithmetic
 *  correction, or the retry's closing turns around the reasoning it replays
 *  (that reasoning is already counted in ANSWER_GROUNDING_THINK_TOKENS). */
export const ANSWER_GROUNDING_FOLLOW_UP_TOKENS = 512;

/**
 * The request's size as a bound on its tokens: its UTF-8 bytes. A byte-level
 * BPE token decodes to at least one byte, so text tokens never exceed bytes;
 * the chat template's own tokens are the measured overhead the caller adds. An
 * undercounted request is truncated by Ollama, and the checker would pass an
 * answer against a conversation it only partly read.
 */
export function answerGroundingBytes(policy: AnswerCheckPolicy, messages: readonly GroundingTurn[], prompt: string, answer: string): number {
    return Buffer.byteLength(policy.systemPrompt, "utf8") + Buffer.byteLength(answerGroundingContent(messages, prompt, answer), "utf8");
}

/**
 * Arithmetic the checker wrote in its reasoning, recomputed; the model still
 * gives the verdict. A false slip would argue a right verdict wrong, so the
 * reader abstains wherever the policy's patterns do not see one plain
 * calculation: a chain of + and − ending in "= n", or one × or ÷ ending in
 * "= n" (a trailing % makes the result a percentage). Quoted text, and any
 * equation the conversation or the candidate answer itself contains, is not
 * the checker's. A result matches when it rounds to the precision it was
 * written with, or, marked "...", is the value cut there. Numbers past 15
 * significant digits are not judged.
 */
export interface ArithmeticSlip { expression: string; stated: string; correct: string }
const num = (s: string) => Number(s.replace(/[$€£¥,]/g, "").replace(/^[−–]/, "-"));
const digits = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "").length;
const decimals = (s: string) => (s.split(".")[1] ?? "").length;
const matches = (value: number, stated: string, cut: string | undefined) => {
    const d = decimals(stated), diff = Math.abs(value - num(stated));
    return diff <= 0.5 * 10 ** -d + 1e-9 || (cut !== undefined && diff < 10 ** -d && Math.abs(value) >= Math.abs(num(stated)));
};
const tidy = (n: number) => String(Number(n.toPrecision(12)));
const compact = (s: string) => s.replace(/\s+/g, "");
/** The reader's three expressions, built from the policy's fragments. Each
 *  fragment is wrapped, so an alternation inside one never reaches across the
 *  expression it is spliced into. Throws when they do not compile (the policy
 *  parser calls this, so a policy the reader cannot run is no policy). */
export function arithmeticExpressions(a: AnswerCheckPolicy["arithmetic"]): { chain: RegExp; term: RegExp; prod: RegExp } {
    const wrap = (f: string) => `(?:${f})`;
    const NUM = wrap(a.number), START = wrap(a.start), PLUS_MINUS = wrap(a.minusOrPlus), END = wrap(a.end);
    return {
        chain: new RegExp(String.raw`${START}([-−]?${NUM})((?:${PLUS_MINUS}${NUM})+)\s*=\s*([-−]?${NUM})(\.\.\.|…)?(\s*%)?${END}`, "g"),
        term: new RegExp(String.raw`(${PLUS_MINUS})(${NUM})`, "g"),
        prod: new RegExp(String.raw`${START}([-−]?${NUM})\s*([×x*\/÷])\s*(${NUM})\s*=\s*([-−]?${NUM})(\.\.\.|…)?(\s*%)?${END}`, "g"),
    };
}
export function arithmeticSlips(policy: AnswerCheckPolicy, text: string, sources: readonly string[] = []): ArithmeticSlip[] {
    const { quoted, scalePowers } = policy.arithmetic;
    const { chain, term, prod } = arithmeticExpressions(policy.arithmetic);
    const scaled = (value: number, stated: string) => scalePowers.some(k => matches(value * 10 ** k, stated, undefined));
    const own = text.replace(new RegExp(quoted.source, "g"), " ");
    const inSources = sources.map(compact);
    const judged = (whole: string, parts: string[]) =>
        parts.every(p => digits(p) <= 15) && !inSources.some(q => q.includes(compact(whole)));
    const slips: ArithmeticSlip[] = [];
    for (const m of own.matchAll(chain)) {
        if (m[5]) continue;   // a percentage from a sum or difference is not this rule's to judge
        const terms = [...m[2].matchAll(term)];
        if (!judged(m[0], [m[1], m[3], ...terms.map(t => t[2])])) continue;
        let total = num(m[1]);
        for (const t of terms) total += (t[1].includes("+") ? 1 : -1) * num(t[2]);
        if (!matches(total, m[3], m[4]) && !scaled(total, m[3])) slips.push({ expression: `${m[1]}${m[2]}`.replace(/\s+/g, " ").trim(), stated: m[3], correct: tidy(total) });
    }
    for (const m of own.matchAll(prod)) {
        if (!judged(m[0], [m[1], m[3], m[4]])) continue;
        const [a, b] = [num(m[1]), num(m[3])];
        if (/[\/÷]/.test(m[2]) && b === 0) continue;
        let value = /[\/÷]/.test(m[2]) ? a / b : a * b;
        if (m[6]) value *= 100;
        if (!matches(value, m[4], m[5]) && !scaled(value, m[4])) slips.push({ expression: `${m[1]} ${m[2]} ${m[3]}`, stated: m[4] + (m[6] ? "%" : ""), correct: tidy(value) + (m[6] ? "%" : "") });
    }
    // the same slip written twice is one slip
    return slips.filter((s, i) => slips.findIndex(t => t.expression === s.expression && t.stated === s.stated) === i);
}
/** Most bytes of correction text: bytes bound tokens, so with the one-word
 *  first reply and the turn markup it stays inside ANSWER_GROUNDING_FOLLOW_UP_TOKENS. */
export const ARITHMETIC_CORRECTION_MAX_BYTES = 400;
/** The one re-ask after an arithmetic slip, stating the correct figures: as
 *  many slips as fit ARITHMETIC_CORRECTION_MAX_BYTES, or null when not even
 *  one does (then no re-ask is sent). */
export function arithmeticCorrection(policy: AnswerCheckPolicy, slips: readonly ArithmeticSlip[]): string | null {
    const c = policy.correction;
    const wrap = (lines: string[]) => c.lead + lines.join(c.join) + c.tail;
    const lines: string[] = [];
    for (const s of slips) {
        // Functions, not strings: "$&", "$'", "$`" or "$$" in a replacement string is a pattern, not text.
        const line = c.line.replace("{expression}", () => s.expression).replace("{correct}", () => s.correct).replace("{stated}", () => s.stated);
        if (Buffer.byteLength(wrap([...lines, line]), "utf8") > ARITHMETIC_CORRECTION_MAX_BYTES) break;
        lines.push(line);
    }
    return lines.length ? wrap(lines) : null;
}
