import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { triggerScan } from "./plex-scan-trigger.ts";
import {
  SCRIPT_DIRECTORY,
  getPlexServer,
  log as baseLog,
  logError as baseLogError,
} from "./plex-client.ts";

const TAG = "plex-orchestrator";
const log = (msg: string) => baseLog(TAG, msg);
const logError = (msg: string) => baseLogError(TAG, msg);

type PathMap = Record<string, string>;

const PATH_MAP_FILE = process.env["PLEX_PATH_MAP_FILE"]?.trim()
  ?? resolve(SCRIPT_DIRECTORY, "plex-path-map.json");
const CHANGED_PATHS = process.env["CHANGED_PATHS"]?.trim();

function pathStartsWith(p: string, prefix: string): boolean {
  if (!p.startsWith(prefix)) return false;
  const next = p.charAt(prefix.length);
  return next === "" || next === "/";
}

async function main(): Promise<void> {
  if (!CHANGED_PATHS) {
    log("No CHANGED_PATHS set, nothing to do");
    return;
  }

  let pathMap: PathMap;
  try {
    const raw = readFileSync(PATH_MAP_FILE, "utf-8");
    pathMap = JSON.parse(raw) as PathMap;
  } catch (err) {
    logError(`Failed to read path map ${PATH_MAP_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const entries = Object.entries(pathMap);
  const changedPaths = CHANGED_PATHS.split("\n").map((p) => p.trim()).filter(Boolean);
  log(`Processing ${changedPaths.length} changed path(s)`);

  const mappedParentDirs = new Set<string>();
  for (const hostPath of changedPaths) {
    let mapped: string | null = null;
    for (const [host, container] of entries) {
      if (pathStartsWith(hostPath, host)) {
        mapped = container + hostPath.slice(host.length);
        break;
      }
    }
    if (mapped === null) {
      log(`  ${hostPath} — no host→container mapping, skipping`);
      continue;
    }
    const parent = dirname(mapped);
    log(`  ${hostPath} -> ${mapped} (parent: ${parent})`);
    mappedParentDirs.add(parent);
  }

  if (mappedParentDirs.size === 0) {
    log("No paths matched any host→container mapping — nothing to refresh");
    return;
  }

  log("Fetching library sections from Plex...");
  const server = getPlexServer();
  const library = await server.library();
  const sections = await library.sections();

  const sectionIds = new Set<string>();
  for (const parent of mappedParentDirs) {
    for (const section of sections) {
      for (const location of section.locations) {
        if (pathStartsWith(parent, location.path)) {
          sectionIds.add(String(section.key));
          log(`  matched section ${section.key} (${section.title}) via location ${location.path}`);
        }
      }
    }
  }

  if (sectionIds.size === 0) {
    log("No matching Plex sections found for changed paths");
    return;
  }

  const ids = [...sectionIds].sort((a, b) => Number(a) - Number(b));
  log(`Triggering scan for sections: ${ids.join(",")}`);
  await triggerScan({ sectionIds: ids });
  log(`Done — triggered ${sectionIds.size} section(s)`);
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
