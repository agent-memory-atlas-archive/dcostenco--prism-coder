/**
 * The synthetic answer-check policy (answer-check-policy.synthetic.json),
 * parsed by the client's own parser. It stands in for the pinned artifact,
 * which is not public; tests that route around the check use it so the size
 * bound and the check read real policy text.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { parseAnswerCheckPolicy } from "../../src/utils/inferencePolicy.js";
import type { AnswerCheckPolicy } from "../../src/utils/answerGrounding.js";

export const SYNTHETIC_ANSWER_CHECK_BYTES = JSON.stringify(JSON.parse(readFileSync(new URL("./answer-check-policy.synthetic.json", import.meta.url), "utf8")));
export const SYNTHETIC_ANSWER_CHECK_SHA256 = createHash("sha256").update(SYNTHETIC_ANSWER_CHECK_BYTES).digest("hex");
const parsed = parseAnswerCheckPolicy(SYNTHETIC_ANSWER_CHECK_BYTES, SYNTHETIC_ANSWER_CHECK_SHA256);
if (!parsed) throw new Error("the synthetic answer-check policy does not parse");
export const SYNTHETIC_ANSWER_CHECK_POLICY: AnswerCheckPolicy = parsed;
/** The InferDeps that pass a conversation's answer check without a model: the
 *  local check says PASS and so does its confirmation. */
export const passingAnswerCheck = {
    answerCheckPolicy: async () => SYNTHETIC_ANSWER_CHECK_POLICY,
    probeLoadedContext: async () => 32_768,   // a loaded 9b as Ollama runs it on a 24-48 GB machine
    groundAnswer: async () => ({ verdict: "GROUNDED" as const }),
    checkAnswer: async () => ({ verdict: "PASS" as const }),
};
