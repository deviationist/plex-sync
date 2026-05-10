import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlexServer } from "@ctrl/plex";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(SCRIPT_DIR, ".env") });

export const SCRIPT_DIRECTORY = SCRIPT_DIR;

export function log(tag: string, message: string): void {
  console.log(`${new Date().toISOString()} [${tag}] ${message}`);
}

export function logError(tag: string, message: string): void {
  console.error(`${new Date().toISOString()} [${tag}] ERROR: ${message}`);
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
