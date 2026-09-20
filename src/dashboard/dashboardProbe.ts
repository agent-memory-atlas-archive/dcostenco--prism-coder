import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DASHBOARD_PROBE_PATH = "/api/dashboard/probe";

const HEX_256 = /^[a-f0-9]{64}$/;
const PROBE_PROTOCOL = "prism-dashboard-probe:v1";

export function generateDashboardProbeKey(): string {
  return randomBytes(32).toString("hex");
}

export function validateDashboardProbeKey(value: string): string {
  if (!HEX_256.test(value)) throw new Error("Local dashboard probe key is invalid");
  return value;
}

function validateNonce(value: string): string {
  if (!HEX_256.test(value)) throw new Error("Local dashboard probe nonce is invalid");
  return value;
}

function proof(key: string, purpose: "request" | "response", nonce: string): string {
  const validatedKey = validateDashboardProbeKey(key);
  const validatedNonce = validateNonce(nonce);
  return createHmac("sha256", Buffer.from(validatedKey, "hex"))
    .update(`${PROBE_PROTOCOL}:${purpose}:${validatedNonce}`)
    .digest("hex");
}

function proofMatches(expected: string, candidate: string): boolean {
  if (!HEX_256.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"));
}

export function createDashboardProbeRequest(
  key: string,
  nonce = randomBytes(32).toString("hex"),
): { nonce: string; proof: string } {
  const validatedNonce = validateNonce(nonce);
  return { nonce: validatedNonce, proof: proof(key, "request", validatedNonce) };
}

export function verifyDashboardProbeRequest(key: string, nonce: string, candidate: string): boolean {
  try {
    return proofMatches(proof(key, "request", nonce), candidate);
  } catch {
    return false;
  }
}

export function createDashboardProbeResponse(key: string, nonce: string): string {
  return proof(key, "response", nonce);
}

export function verifyDashboardProbeResponse(key: string, nonce: string, candidate: string): boolean {
  try {
    return proofMatches(proof(key, "response", nonce), candidate);
  } catch {
    return false;
  }
}
