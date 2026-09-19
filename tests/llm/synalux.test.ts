import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStorage: vi.fn(),
  getSynaluxJwt: vi.fn(),
  invalidateSynaluxJwt: vi.fn(),
  resolvePortalBaseUrl: vi.fn(),
}));

vi.mock("../../src/storage/index.js", () => ({
  getStorage: mocks.getStorage,
  activeStorageBackend: "synalux",
}));
vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {},
}));
vi.mock("../../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: mocks.getSynaluxJwt,
  invalidateSynaluxJwt: mocks.invalidateSynaluxJwt,
}));
vi.mock("../../src/utils/synaluxSearch.js", () => ({
  resolvePortalBaseUrl: mocks.resolvePortalBaseUrl,
}));
vi.mock("../../src/server.js", () => ({ notifyResourceUpdate: vi.fn() }));

import { SynaluxStorage } from "../../src/storage/synalux.js";
import { backfillEmbeddingsHandler } from "../../src/tools/hygieneHandlers.js";
import {
  _resetLLMProvider,
} from "../../src/utils/llm/factory.js";
import { SynaluxEmbeddingAdapter } from "../../src/utils/llm/adapters/synalux.js";

const MODEL = "gemini-embedding-001";
const TASK_TYPE = "SEMANTIC_SIMILARITY";
const vector = Array.from({ length: 768 }, () => 0.01);

function embeddingResponse(patch: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: MODEL,
    dimensions: 768,
    task_type: TASK_TYPE,
    embedding: vector,
    ...patch,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Synalux embedding client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolvePortalBaseUrl.mockReturnValue("https://portal.test");
    mocks.getSynaluxJwt.mockResolvedValue("jwt-fixture");
    fetchMock.mockResolvedValue(embeddingResponse());
    _resetLLMProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a JWT to Portal, not a provider key or caller tier", async () => {
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).resolves.toEqual(vector);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.test/api/v1/prism/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-fixture" }),
        body: JSON.stringify({ text: "pos" }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("GOOGLE_API_KEY");
  });

  it.each([
    ["model", { model: "nomic" }],
    ["dimensions", { dimensions: 767 }],
    ["task type", { task_type: "RETRIEVAL_DOCUMENT" }],
    ["missing task type", { task_type: undefined }],
    ["vector length", { embedding: Array(767).fill(1) }],
    ["all-zero vector", { embedding: Array(768).fill(0) }],
    ["non-numeric vector", { embedding: Array(768).fill("1") }],
  ])("rejects an incompatible %s", async (_name, patch) => {
    fetchMock.mockResolvedValue(embeddingResponse(patch));
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow("incompatible");
  });

  it("fails clearly when Synalux credentials cannot produce a JWT", async () => {
    mocks.getSynaluxJwt.mockResolvedValue(null);
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow(
      "authentication unavailable",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes once on 401 and resumes the same embedding request", async () => {
    mocks.getSynaluxJwt.mockResolvedValueOnce("expired-jwt").mockResolvedValueOnce("fresh-jwt");
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(embeddingResponse());

    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).resolves.toEqual(vector);
    expect(mocks.invalidateSynaluxJwt).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fresh-jwt",
    });
  });

  it("paces one 429 retry using Retry-After, then resumes the same request", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(embeddingResponse());

    await expect(new SynaluxEmbeddingAdapter(sleep).generateEmbedding("pos")).resolves.toEqual(vector);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe((fetchMock.mock.calls[1][1] as RequestInit).body);
  });

  it("bounds Retry-After and never loops on repeated 429 responses", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "999999" } }),
    );

    await expect(new SynaluxEmbeddingAdapter(sleep).generateEmbedding("pos")).rejects.toThrow("HTTP 429");
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not silently switch embedding models when Portal is absent", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow("not deployed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("truncates text above 8,000 characters at a word boundary", async () => {
    await new SynaluxEmbeddingAdapter().generateEmbedding(`${"word ".repeat(1600)}partial`);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text.length).toBeLessThanOrEqual(8_000);
    expect(body.text).toMatch(/word$/);
    expect(body.text).not.toContain("partial");
  });

  it("repairs through the handler with no Google key and preserves only-if-missing to Portal", async () => {
    if (process.env.PRISM_ASSERT_NO_GOOGLE_KEYS === "1") {
      // This assertion runs after tests/setup.ts has called dotenv.config().
      // The isolated child acceptance command must fail if .env restored either key.
      expect(process.env.GOOGLE_API_KEY).toBeUndefined();
      expect(process.env.GEMINI_API_KEY).toBeUndefined();
    }

    vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
    vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
    const storage = new SynaluxStorage();
    mocks.getStorage.mockResolvedValue(storage);
    mocks.getSynaluxJwt.mockResolvedValue("embedding-jwt");
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v1/auth/jwt")) {
        return new Response(JSON.stringify({ status: "success", jwt: "storage-jwt", expires_in: 900 }));
      }
      if (url.endsWith("/api/v1/prism/embeddings")) return embeddingResponse();
      if (url.endsWith("/api/v1/prism/memory")) {
        const body = JSON.parse(init.body as string);
        if (body.action === "list_missing_embeddings") {
          return new Response(JSON.stringify({
            status: "success",
            entries: [{ id: "entry-fixture", project: "prism", summary: "repair me", decisions: [] }],
          }));
        }
        if (body.action === "save_embedding") {
          return new Response(JSON.stringify({ status: "success" }));
        }
      }
      throw new Error(`Unexpected test request: ${url}`);
    });

    const result = await backfillEmbeddingsHandler({ project: "prism", limit: 1 });

    expect(result.isError).toBe(false);
    expect((result as any)._stats).toMatchObject({ repaired: 1, failed: 0 });
    const saveCall = fetchMock.mock.calls.find(([, init]) => {
      if (typeof (init as RequestInit).body !== "string") return false;
      return JSON.parse((init as RequestInit).body as string).action === "save_embedding";
    });
    expect(saveCall).toBeDefined();
    expect(JSON.parse((saveCall![1] as RequestInit).body as string)).toMatchObject({
      action: "save_embedding",
      memory_id: "entry-fixture",
      only_if_missing: true,
    });
  });
});
