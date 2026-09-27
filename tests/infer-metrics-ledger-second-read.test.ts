/**
 * The ledger records what the 9b's second read did, on a fresh ledger and on
 * one created before the column existed. Writes to a TEMP DB via
 * PRISM_INFER_LEDGER_DB_PATH — never the real config store.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createClient } from "@libsql/client";
import { appendInferMetric, queryInferMetrics, _resetInferLedgerForTest } from "../src/storage/inferMetricsLedger.js";
import { recordInference } from "../src/utils/inferenceMetrics.js";

let dir: string;
let dbPath: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "infer-ledger-2r-"));
    dbPath = join(dir, "test.db");
    process.env.PRISM_INFER_LEDGER_DB_PATH = dbPath;
    _resetInferLedgerForTest();
});
afterEach(async () => {
    delete process.env.PRISM_INFER_LEDGER_DB_PATH;
    _resetInferLedgerForTest();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});
async function rows(expect: number): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const agg = await queryInferMetrics();
        if (agg && agg.total >= expect) break;
        await new Promise(r => setTimeout(r, 100));
    }
    const c = createClient({ url: `file:${dbPath}` });
    try {
        const res = await c.execute("SELECT backend, layer1_second_read FROM infer_metrics ORDER BY id");
        return res.rows as unknown as Array<Record<string, unknown>>;
    } finally { c.close(); }
}

describe("layer1_second_read in the ledger", () => {
    it("is stored when given and null otherwise", async () => {
        appendInferMetric({ backend: "ollama-9b", model: "prism-coder:9b", used_cloud: false, history_turns: 2, layer1_second_read: "cleared_9b" });
        appendInferMetric({ backend: "ollama-9b", model: "prism-coder:9b", used_cloud: false, history_turns: 0 });
        const r = await rows(2);
        expect(r.map(x => x.layer1_second_read)).toEqual(["cleared_9b", null]);
    });
    it("reaches the ledger from a recorded prism_infer result", async () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 900, history_turns: 2, layer1_second_read: "cleared_9b" });
        const r = await rows(1);
        expect(r.map(x => x.layer1_second_read)).toEqual(["cleared_9b"]);
    });
    it("is added to a ledger created before the column existed", async () => {
        const c = createClient({ url: `file:${dbPath}` });
        await c.execute(`CREATE TABLE infer_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, caller TEXT, mode TEXT,
            backend TEXT NOT NULL, model TEXT, used_cloud INTEGER NOT NULL, gate_outcome TEXT,
            refusal_reason TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER,
            ram_free_mb INTEGER, source_event_id TEXT, history_turns INTEGER, refusal_layer TEXT)`);
        await c.execute("INSERT INTO infer_metrics (ts, backend, used_cloud) VALUES (1, 'old', 0)");
        c.close();
        appendInferMetric({ backend: "refused", model: null, used_cloud: false, refusal_reason: "layer1_reserved", layer1_second_read: "confirmed_9b" });
        const r = await rows(2);
        expect(r).toEqual([{ backend: "old", layer1_second_read: null }, { backend: "refused", layer1_second_read: "confirmed_9b" }]);
    });
});
