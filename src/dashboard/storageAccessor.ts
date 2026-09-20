import { getStorage } from "../storage/index.js";

type DashboardStorage = Awaited<ReturnType<typeof getStorage>>;
type ResolveStorage = () => Promise<DashboardStorage>;

/**
 * Resolve dashboard storage through the canonical storage singleton on every
 * request. Account connect/sign-out closes that singleton so the next request
 * can select the newly active cloud or local backend. Keeping a second cache
 * here would retain a closed backend across that transition.
 */
export function createDashboardStorageAccessor(
  resolveStorage: ResolveStorage = getStorage,
): () => Promise<DashboardStorage | null> {
  return async () => {
    try {
      return await resolveStorage();
    } catch {
      return null;
    }
  };
}
