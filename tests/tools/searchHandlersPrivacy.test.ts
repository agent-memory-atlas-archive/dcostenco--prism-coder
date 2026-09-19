import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDebugLog,
  mockPerformWebSearchRaw,
  mockPerformLocalSearchRaw,
  mockRunInSandbox,
} = vi.hoisted(() => ({
  mockDebugLog: vi.fn(),
  mockPerformWebSearchRaw: vi.fn(),
  mockPerformLocalSearchRaw: vi.fn(),
  mockRunInSandbox: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: mockDebugLog,
}));
vi.mock("../../src/utils/braveApi.js", () => ({
  performWebSearch: vi.fn(),
  performWebSearchRaw: mockPerformWebSearchRaw,
  performLocalSearch: vi.fn(),
  performLocalSearchRaw: mockPerformLocalSearchRaw,
  performBraveAnswers: vi.fn(),
}));
vi.mock("../../src/utils/executor.js", () => ({
  runInSandbox: mockRunInSandbox,
}));
vi.mock("../../src/utils/llm/factory.js", () => {
  const provider = vi.fn();
  return { getLLMProvider: provider, getEmbeddingProvider: provider };
});
vi.mock("../../src/scholar/webScholar.js", () => ({
  runWebScholar: vi.fn(),
}));

import {
  braveLocalSearchCodeModeHandler,
  braveWebSearchCodeModeHandler,
} from "../../src/tools/handlers.js";

describe("search handler debug-log privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPerformWebSearchRaw.mockResolvedValue('{"web":{"results":[]}}');
    mockPerformLocalSearchRaw.mockResolvedValue('{"poisData":{"results":[]}}');
    mockRunInSandbox.mockResolvedValue({
      stdout: "ok",
      executionTimeMs: 1,
    });
  });

  it("does not write a web-search query to debug logs", async () => {
    await braveWebSearchCodeModeHandler({
      query: "Patient Jane Doe private search",
      count: 5,
      code: "console.log('ok')",
    });

    const logs = mockDebugLog.mock.calls.flat().join("\n");
    expect(logs).toContain("query_chars=");
    expect(logs).not.toContain("Patient Jane Doe private search");
  });

  it("does not write a local-search query to debug logs", async () => {
    await braveLocalSearchCodeModeHandler({
      query: "Patient Jane Doe nearby clinic",
      count: 5,
      code: "console.log('ok')",
    });

    const logs = mockDebugLog.mock.calls.flat().join("\n");
    expect(logs).toContain("query_chars=");
    expect(logs).not.toContain("Patient Jane Doe nearby clinic");
  });
});
