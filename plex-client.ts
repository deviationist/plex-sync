import { config as loadDotenv } from "dotenv";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { format as utilFormat } from "node:util";
import { PlexServer } from "@ctrl/plex";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(SCRIPT_DIR, ".env") });

export const SCRIPT_DIRECTORY = SCRIPT_DIR;

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

interface LogState {
  filePath: string | null;
  maxBytes: number;
  enabled: boolean;
  /** Set once a write fails, to suppress subsequent attempts. */
  failed: boolean;
}

const logState: LogState = {
  filePath: null,
  maxBytes: DEFAULT_LOG_MAX_BYTES,
  enabled: false,
  failed: false,
};

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function resolveLogPath(raw: string): string {
  return isAbsolute(raw) ? raw : resolve(SCRIPT_DIR, raw);
}

function writeLogLine(line: string): void {
  if (!logState.enabled || !logState.filePath || logState.failed) return;
  const path = logState.filePath;
  const payload = line.endsWith("\n") ? line : line + "\n";
  try {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size + payload.length > logState.maxBytes) {
        const rolled = `${path}.1`;
        if (existsSync(rolled)) unlinkSync(rolled);
        renameSync(path, rolled);
      }
    }
    appendFileSync(path, payload);
  } catch (err) {
    logState.failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    originalConsoleError(`${new Date().toISOString()} [plex-client] ERROR: file logging disabled — ${msg}`);
  }
}

console.log = ((...args: unknown[]) => {
  originalConsoleLog(...args);
  if (logState.enabled && logState.filePath && !logState.failed) {
    writeLogLine(utilFormat(...args));
  }
}) as typeof console.log;

console.error = ((...args: unknown[]) => {
  originalConsoleError(...args);
  if (logState.enabled && logState.filePath && !logState.failed) {
    writeLogLine(utilFormat(...args));
  }
}) as typeof console.error;

export interface FileLoggingOptions {
  /** Absolute path, or relative to the script directory. Pass null to clear. */
  filePath?: string | null;
  /** Force on/off. Omitted: auto-enable when filePath is provided, auto-disable when null. */
  enabled?: boolean;
  /** Rollover threshold in bytes. Must be > 0. */
  maxBytes?: number;
}

export function configureFileLogging(opts: FileLoggingOptions): void {
  if (opts.filePath !== undefined) {
    logState.filePath = opts.filePath ? resolveLogPath(opts.filePath) : null;
    logState.failed = false;
    if (opts.enabled === undefined) logState.enabled = Boolean(opts.filePath);
  }
  if (opts.enabled !== undefined) logState.enabled = opts.enabled;
  if (opts.maxBytes !== undefined && opts.maxBytes > 0) logState.maxBytes = opts.maxBytes;
}

function parseEnabledEnv(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

(function initLoggingFromEnv(): void {
  const path = process.env["LOG_FILE"]?.trim();
  if (path) configureFileLogging({ filePath: path });
  const enabledRaw = process.env["LOG_ENABLED"];
  if (enabledRaw !== undefined) {
    const enabled = parseEnabledEnv(enabledRaw);
    if (enabled !== undefined) configureFileLogging({ enabled });
  }
  const maxRaw = process.env["LOG_MAX_BYTES"]?.trim();
  if (maxRaw) {
    const n = Number(maxRaw);
    if (Number.isFinite(n) && n > 0) configureFileLogging({ maxBytes: n });
  }
})();

export function log(tag: string, message: string): void {
  console.log(`${new Date().toISOString()} [${tag}] ${message}`);
}

export function logError(tag: string, message: string): void {
  console.error(`${new Date().toISOString()} [${tag}] ERROR: ${message}`);
}

export type Verbosity = 0 | 1 | 2;

export function makeDebug(level: number, tag: string) {
  const lvl = Math.max(0, Math.min(2, level)) as Verbosity;
  return {
    /** Level 1 — high-level milestones beyond the default `log` lines. */
    debug: (message: string) => {
      if (lvl >= 1) console.log(`[DEBUG ${tag}] ${message}`);
    },
    /** Level 2 — step-by-step internals (path tests, section matching, polls). */
    trace: (message: string) => {
      if (lvl >= 2) console.log(`[TRACE ${tag}] ${message}`);
    },
  };
}

interface PlexConfig {
  host: string;
  token: string;
}

function readConfig(): PlexConfig {
  const host = process.env["PLEX_HOST"]?.trim();
  const token = process.env["PLEX_TOKEN"]?.trim();
  if (!host) {
    throw new Error(`PLEX_HOST is required — set it in ${resolve(SCRIPT_DIR, ".env")}`);
  }
  if (!token) {
    throw new Error(`PLEX_TOKEN is required — set it in ${resolve(SCRIPT_DIR, ".env")}`);
  }
  return { host, token };
}

let cachedServer: PlexServer | null = null;

export function getPlexServer(): PlexServer {
  if (cachedServer) return cachedServer;
  const { host, token } = readConfig();
  cachedServer = new PlexServer(host, token);
  return cachedServer;
}

export interface ActivitySnapshotEntry {
  sectionId: string;
  progress: number;
  subtitle: string;
}

export async function fetchActivitySnapshot(): Promise<ActivitySnapshotEntry[]> {
  const { host, token } = readConfig();
  const url = `${host}/activities?X-Plex-Token=${encodeURIComponent(token)}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Plex /activities returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as {
    MediaContainer?: { Activity?: PlexActivityJson[] };
  };
  const activities = data.MediaContainer?.Activity ?? [];
  const entries: ActivitySnapshotEntry[] = [];
  for (const activity of activities) {
    if (activity.type !== "library.update.section") continue;
    const sectionId = activity.Context?.librarySectionID;
    if (sectionId === undefined || sectionId === null) continue;
    entries.push({
      sectionId: String(sectionId),
      progress: typeof activity.progress === "number" ? activity.progress : Number(activity.progress ?? 0),
      subtitle: activity.subtitle ?? "",
    });
  }
  return entries;
}

interface PlexActivityJson {
  type?: string;
  progress?: number | string;
  subtitle?: string;
  Context?: { librarySectionID?: string | number };
}
