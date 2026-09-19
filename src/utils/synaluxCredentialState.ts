/**
 * Runtime account state shared by every Synalux client.
 *
 * The API key can be captured in config.ts before the settings database is
 * available. A persisted sign-out therefore needs an in-memory veto as well as
 * clearing process.env, or the module-load constant would silently sign the
 * next request back in.
 */
let signedOut = false;

export function isSynaluxSignedOut(): boolean {
  return signedOut;
}

export function setSynaluxSignedOut(value: boolean): void {
  signedOut = value;
}

/** Test-only reset. */
export function _resetSynaluxCredentialStateForTest(): void {
  signedOut = false;
}
