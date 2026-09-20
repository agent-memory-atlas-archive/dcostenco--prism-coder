import { describe, expect, it, vi } from "vitest";
import { createDashboardStorageAccessor } from "../../src/dashboard/storageAccessor.js";

describe("dashboard storage accessor", () => {
  it("observes the canonical backend change after account sign-out", async () => {
    const cloud = { backend: "synalux" };
    const local = { backend: "local" };
    let current = cloud;
    const resolveStorage = vi.fn(async () => current);
    const getStorageSafe = createDashboardStorageAccessor(resolveStorage);

    await expect(getStorageSafe()).resolves.toBe(cloud);

    // Account sign-out closes and replaces the canonical storage singleton.
    // The dashboard must ask the canonical resolver again instead of retaining
    // a private reference to the now-closed cloud backend.
    current = local;
    await expect(getStorageSafe()).resolves.toBe(local);
    expect(resolveStorage).toHaveBeenCalledTimes(2);
  });

  it("retries storage resolution after a transient initialization failure", async () => {
    const local = { backend: "local" };
    const resolveStorage = vi.fn()
      .mockRejectedValueOnce(new Error("initializing"))
      .mockResolvedValueOnce(local);
    const getStorageSafe = createDashboardStorageAccessor(resolveStorage);

    await expect(getStorageSafe()).resolves.toBeNull();
    await expect(getStorageSafe()).resolves.toBe(local);
    expect(resolveStorage).toHaveBeenCalledTimes(2);
  });
});
