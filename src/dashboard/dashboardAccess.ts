import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DASHBOARD_URL_FILE = "dashboard.url";
const MAX_DASHBOARD_URL_BYTES = 4096;

export function dashboardAccessUrlPath(home = homedir()): string {
  return join(home, ".prism-mcp", DASHBOARD_URL_FILE);
}

function dashboardAccessDirectory(home: string): string {
  const directory = join(home, ".prism-mcp");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Local dashboard directory is not a regular directory");
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function validateDashboardUrl(raw: string): string {
  const value = raw.trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_DASHBOARD_URL_BYTES) {
    throw new Error("Local dashboard link is missing or invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local dashboard link is invalid");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const queryKeys = [...parsed.searchParams.keys()];
  if (
    parsed.protocol !== "http:" ||
    !loopbackHosts.has(parsed.hostname) ||
    !/^\d{1,5}$/.test(parsed.port) ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.hash ||
    queryKeys.some((key) => key !== "token") ||
    (parsed.searchParams.has("token") && !parsed.searchParams.get("token"))
  ) {
    throw new Error("Local dashboard link is invalid");
  }

  return parsed.toString();
}

/**
 * Persist the current local dashboard link for the `prism dashboard` command.
 * The token is a localhost capability, so the file is owner-only and symlinks
 * present at validation time are rejected rather than followed. This is not a
 * boundary against another process running as the same OS user: that process
 * can already read or replace owner-only Prism state.
 */
export function writeDashboardAccessUrl(url: string, home = homedir()): string {
  const validated = validateDashboardUrl(url);
  const directory = dashboardAccessDirectory(home);
  const filePath = dashboardAccessUrlPath(home);

  try {
    const existing = lstatSync(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Local dashboard link path is not a regular file");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  // Write a new regular file and atomically replace the directory entry. This
  // never opens an existing target for writing, so a pre-existing target
  // symlink cannot redirect the token write even on platforms without
  // O_NOFOLLOW. The containing directory follows the same-OS-user trust model
  // documented above.
  const tempPath = join(
    directory,
    `.${DASHBOARD_URL_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let tempExists = true;
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, `${validated}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, filePath);
    tempExists = false;
    if (process.platform !== "win32") chmodSync(filePath, 0o600);
  } finally {
    if (tempExists) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
  }
  return filePath;
}

export function readDashboardAccessUrl(home = homedir()): string {
  dashboardAccessDirectory(home);
  const filePath = dashboardAccessUrlPath(home);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No current local dashboard link. Restart your connected MCP host first.");
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Local dashboard link path is not a regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Local dashboard link file permissions are unsafe");
  }
  return validateDashboardUrl(readFileSync(filePath, "utf8"));
}

export async function isLocalDashboardRunning(
  dashboardUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const validated = validateDashboardUrl(dashboardUrl);
  const probe = new URL("/manifest.json", validated);
  try {
    const response = await fetcher(probe, {
      redirect: "error",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const finalUrl = response.url ? new URL(response.url) : probe;
    if (finalUrl.origin !== probe.origin || finalUrl.pathname !== probe.pathname || finalUrl.search) {
      return false;
    }
    const body = await response.json() as { name?: string };
    return body.name === "Prism Mind Palace";
  } catch {
    return false;
  }
}

export interface DashboardOpenCommand {
  command: string;
  args: string[];
}

export function dashboardOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): DashboardOpenCommand {
  const validated = validateDashboardUrl(url);
  if (platform === "darwin") return { command: "open", args: [validated] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", validated] };
  }
  return { command: "xdg-open", args: [validated] };
}

type DashboardOpenRunner = (
  command: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export function openDashboardUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: DashboardOpenRunner = (command, args) => spawnSync(command, args, {
    shell: false,
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  }),
): void {
  const launch = dashboardOpenCommand(url, platform);
  const result = runner(launch.command, launch.args);
  if (result.error || result.status !== 0) {
    throw new Error("Could not open the local dashboard browser");
  }
}
