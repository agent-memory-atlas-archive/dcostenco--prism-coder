/**
 * Keep a Modelfile's baked SYSTEM prompt out of prism's own local requests.
 *
 * Ollama applies a model's SYSTEM (from its Modelfile) whenever a /api/chat
 * request carries no system message. prism-coder:2b and :4b bake a ~4.3 KB
 * tool-routing prompt — six Prism tools, the `<|tool_call|>` format, "respond
 * directly" rules — for apps that call them directly (Claude Code, Codex and
 * other hosts that sideload the model). prism_infer and the Layer 1 screener are
 * not those apps: they send their own instructions, and the routing prompt
 * silently rode along whenever they sent no system message. Measured 2026-09-27
 * on the published 4b:
 *   - prism_infer with no caller system: "Summarize these decisions … for the
 *     session ledger" came back as a session_save_ledger tool call, served to
 *     the host as the answer;
 *   - Layer 1: its eval gate failed 5/5 runs (two hard negatives refused on
 *     every run, p95 up to 725 ms); the same weights without the SYSTEM passed
 *     5/5 (0 refused, p95 369–395 ms) with reserved recall unchanged (23/23).
 *
 * An empty system message replaces the baked one (4b classifier prompt: 1,519 →
 * 426 tokens). It is sent ONLY to a model that bakes one: on a model without
 * (prism-coder:9b) an empty system message still renders an empty system block
 * (+5 tokens), which would change the prompt of the tier that serves most
 * requests. When the model cannot be inspected, the empty message is sent — an
 * empty system block is harmless; a routing prompt answering in its place is not.
 *
 * A caller's own non-empty system message is always used as-is; Ollama then
 * ignores the baked one by itself.
 */

type ShowFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How long a model's answer is trusted. A re-pull (`prism update`) can change a
 *  Modelfile under a running server; ten minutes bounds that without a request
 *  per call. */
const KNOWN_TTL_MS = 10 * 60_000;
/** A failed inspection is retried sooner: until then the empty message is sent,
 *  which is safe but changes a plain model's prompt by one empty block. */
const UNKNOWN_TTL_MS = 60_000;
/** Same bound as the template-overhead probe: this must never gate a request. */
const SHOW_TIMEOUT_MS = 1_500;

const bakedCache = new Map<string, { baked: boolean | null; at: number }>();

/** Test hook: forget every cached inspection. */
export function _resetBakedSystemCacheForTest(): void {
    bakedCache.clear();
}

/**
 * Does this model's Modelfile bake a SYSTEM prompt?
 * true / false from /api/show; null when it could not be inspected.
 */
export async function modelHasBakedSystem(
    ollamaUrl: string,
    model: string,
    fetchImpl: ShowFetch = fetch,
): Promise<boolean | null> {
    const key = `${ollamaUrl}::${model}`;
    const hit = bakedCache.get(key);
    if (hit && Date.now() - hit.at < (hit.baked === null ? UNKNOWN_TTL_MS : KNOWN_TTL_MS)) return hit.baked;

    let baked: boolean | null = null;
    try {
        const res = await fetchImpl(`${ollamaUrl}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
            // Same posture as the chat request it precedes: never follow a
            // redirect off this machine.
            redirect: "error",
        });
        if (res.ok) {
            const data = (await res.json()) as { system?: unknown; modelfile?: unknown };
            if (typeof data.system === "string") {
                baked = data.system.trim().length > 0;
            } else if (typeof data.modelfile === "string") {
                // Older servers may omit the field; the Modelfile text is authoritative.
                baked = /^SYSTEM\s+\S/m.test(data.modelfile);
            }
        }
    } catch {
        baked = null;
    }
    bakedCache.set(key, { baked, at: Date.now() });
    return baked;
}

/**
 * The system message a local /api/chat request should start with.
 *
 * - A non-empty caller system → that message, unchanged.
 * - No caller system (undefined or "") → an empty system message when the model
 *   bakes a SYSTEM or cannot be inspected; nothing at all when it bakes none, so
 *   that model's request is byte-for-byte what it was.
 */
export async function leadingSystemMessages(
    ollamaUrl: string,
    model: string,
    system: string | undefined,
    fetchImpl: ShowFetch = fetch,
): Promise<Array<{ role: "system"; content: string }>> {
    if (system) return [{ role: "system", content: system }];
    const baked = await modelHasBakedSystem(ollamaUrl, model, fetchImpl);
    return baked === false ? [] : [{ role: "system", content: "" }];
}
