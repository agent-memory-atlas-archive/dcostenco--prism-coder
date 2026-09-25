/**
 * You.com Web Search API Client
 *
 * Thin HTTP client for the You.com Search API. When YDC_API_KEY is set,
 * the `youcom_web_search` tool becomes available as an optional alternative
 * to the built-in Brave search tools.
 *
 * Authentication uses the X-API-Key header with the YDC_API_KEY env var.
 * Get a key at https://you.com/platform/api-keys
 *
 * API docs: https://you.com/docs/api-reference/search/v1-search
 */

import { YDC_API_KEY } from "../config.js";
import { debugLog } from "./logger.js";

const YOUCOM_SEARCH_API = "https://ydc-index.io/v1/search";
const YDC_API_KEY_MISSING_ERROR = "YDC_API_KEY is not configured";

interface YouComSearchWebResult {
  title: string;
  url: string;
  description?: string;
  snippets?: string[];
}

/** The documented API response shape. `results` wraps the web/news arrays. */
interface YouComSearchResponse {
  results?: {
    web?: YouComSearchWebResult[];
    news?: YouComSearchWebResult[];
  };
  metadata?: Record<string, unknown>;
  error?: string;
}

interface YouComApiError {
  error?: string;
  message?: string;
}

/**
 * Formats a single search result as a markdown-like text block,
 * matching the style used by the Brave search results in the codebase.
 */
function formatResult(result: YouComSearchWebResult, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${result.title}`);
  lines.push(`   URL: ${result.url}`);
  if (result.description) {
    let desc = result.description;
    // Append first snippet as extra detail when the description is short
    if (result.snippets?.length && desc.length < 200) {
      desc += ` — ${result.snippets[0]}`;
    }
    lines.push(`   Description: ${desc}`);
  } else if (result.snippets?.length) {
    lines.push(`   Description: ${result.snippets[0]}`);
  }
  return lines.join("\n");
}

/**
 * The API takes an integer `count` (results per section, default 10); this
 * tool allows 1–20. Tool arguments arrive from a host model and are not
 * type-checked, so anything that is not a finite number (NaN, Infinity, a
 * non-numeric string, null, a boolean) becomes the default, a numeric string
 * is read as its number, a fraction is truncated, and the result is clamped.
 */
export function normalizeCount(count: unknown): number {
  const n = typeof count === "number" ? count
    : typeof count === "string" && count.trim() !== "" ? Number(count)
    : NaN;
  if (!Number.isFinite(n)) return 10;
  return Math.min(20, Math.max(1, Math.trunc(n)));
}

/** The configured key, trimmed. Never echoed: a key with whitespace or
 *  control characters is rejected by name only, because Fetch's header
 *  validation error would otherwise carry the value into logs and tool output. */
function apiKey(): string {
  const key = (YDC_API_KEY ?? "").trim();
  if (!key) throw new Error(YDC_API_KEY_MISSING_ERROR);
  if (/[^\x21-\x7e]/.test(key)) {
    throw new Error("YDC_API_KEY is set but is not a valid key (it contains whitespace or control characters)");
  }
  return key;
}

/** Bounded, with the key removed wherever it appears. */
function scrub(text: string, key: string | undefined): string {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[redacted]");
  return out.slice(0, 200);
}

/** A string worth showing from a provider error body: `message`, `error`,
 *  or `error.message`; otherwise the raw text. */
function errorText(raw: string): string {
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: unknown };
    for (const v of [body?.message, body?.error, (body?.error as { message?: unknown })?.message]) {
      if (typeof v === "string" && v.trim()) return v;
    }
  } catch { /* not JSON */ }
  return raw;
}

const isTimeout = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/** A result the formatter can show: a string url is required; the rest is optional and type-checked. */
function toResult(item: unknown): YouComSearchWebResult | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (typeof r.url !== "string" || !r.url) return null;
  return {
    url: r.url,
    title: typeof r.title === "string" && r.title ? r.title : r.url,
    description: typeof r.description === "string" ? r.description : undefined,
    snippets: Array.isArray(r.snippets) ? r.snippets.filter((x): x is string => typeof x === "string") : undefined,
  };
}

/**
 * Performs a web search using the You.com Search API and returns
 * formatted text results (title, URL, description).
 *
 * Gated on YDC_API_KEY being set; callers should check the
 * exported constant before registering the tool.
 */
export async function performYouComSearch(
  query: string,
  count: number = 10,
): Promise<string> {
  const key = apiKey();

  const body = {
    query,
    count: normalizeCount(count),
  };

  debugLog(`[youcomApi] searching: query_chars=${query.length}, count=${body.count}`);

  let response: Response;
  try {
    response = await fetch(YOUCOM_SEARCH_API, {
      method: "POST",
      headers: {
        "X-API-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // A fixed endpoint: a redirect elsewhere would carry the key and the query with it.
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    const why = isTimeout(err) ? "timed out" : scrub((err as Error)?.message ?? "unknown error", key);
    debugLog(`[youcomApi] network error: ${why}`);
    throw new Error(`You.com search failed (network): ${why}`);
  }

  if (!response.ok) {
    // Read the body once: a failed json() consumes it, and a later text() then has nothing.
    const raw = await response.text().catch(() => "");
    const errorInfo = scrub(errorText(raw) || response.statusText, key);
    debugLog(`[youcomApi] HTTP ${response.status}: ${errorInfo}`);
    throw new Error(
      `You.com search returned HTTP ${response.status}${errorInfo ? `: ${errorInfo}` : ""}`
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err: unknown) {
    if (isTimeout(err)) throw new Error("You.com search timed out reading the response");
    debugLog(`[youcomApi] JSON parse error: ${scrub((err as Error)?.message ?? String(err), key)}`);
    throw new Error("You.com search returned invalid JSON");
  }
  if (!data || typeof data !== "object") throw new Error("You.com search returned an unexpected response");

  const envelope = data as YouComSearchResponse;
  if (typeof envelope.error === "string" && envelope.error) {
    debugLog(`[youcomApi] API error: ${scrub(envelope.error, key)}`);
    throw new Error(`You.com search API error: ${scrub(envelope.error, key)}`);
  }
  const sections = envelope.results;
  if (sections != null && typeof sections !== "object") throw new Error("You.com search returned an unexpected response shape");
  for (const part of [sections?.web, sections?.news]) {
    if (part != null && !Array.isArray(part)) throw new Error("You.com search returned an unexpected response shape");
  }

  // The documented response wraps arrays under `results`; web first, news when web is empty.
  const results = (sections?.web ?? []).map(toResult).filter((r): r is YouComSearchWebResult => r !== null);
  if (results.length === 0) {
    const newsResults = (sections?.news ?? []).map(toResult).filter((r): r is YouComSearchWebResult => r !== null);
    if (newsResults.length === 0) {
      return `No results found for "${query}".\n`;
    }
    const formatted = newsResults.map((r, i) => formatResult(r, i));
    const header = `You.com news results for "${query}":\n${"=".repeat(60)}\n\n`;
    return header + formatted.join("\n\n") + "\n";
  }

  const formatted = results.map((r, i) => formatResult(r, i));
  const header = `You.com search results for "${query}":\n${"=".repeat(60)}\n\n`;
  return header + formatted.join("\n\n") + "\n";
}

/**
 * Returns true when YDC_API_KEY is set, so callers can conditionally
 * register the youcom_web_search tool.
 */
export function youcomSearchAvailable(): boolean {
  return !!(YDC_API_KEY ?? "").trim();
}