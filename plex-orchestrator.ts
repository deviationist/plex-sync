import { config as loadDotenv } from "dotenv";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(SCRIPT_DIR, ".env") });

type PathMap = Record<string, string>;

const PLEX_HOST = process.env["PLEX_HOST"]?.trim();
const PLEX_TOKEN = process.env["PLEX_TOKEN"]?.trim();
const PATH_MAP_FILE = process.env["PLEX_PATH_MAP_FILE"]?.trim()
  ?? resolve(SCRIPT_DIR, "plex-path-map.json");
const CHANGED_PATHS = process.env["CHANGED_PATHS"]?.trim();
const PLEX_SCAN_SCRIPT = resolve(SCRIPT_DIR, "plex-scan.sh");

function log(message: string): void {
  console.log(`${new Date().toISOString()} [plex-orchestrator] ${message}`);
}

function logError(message: string): void {
  console.error(`${new Date().toISOString()} [plex-orchestrator] ERROR: ${message}`);
}

interface PlexSection {
  key: string;
  title: string;
  Location: { path: string }[];
}

interface PlexSectionsResponse {
  MediaContainer: {
    Directory: PlexSection[];
  };
}

async function main(): Promise<void> {
  if (!CHANGED_PATHS) {
    log("No CHANGED_PATHS set, nothing to do");
    return;
  }

  if (!PLEX_HOST) {
    logError("PLEX_HOST is required — set it in /home/xavi/scripts/plex-scan/.env");
    process.exit(1);
  }

  if (!PLEX_TOKEN) {
    logError("PLEX_TOKEN is required — set it in /home/xavi/scripts/plex-scan/.env");
    process.exit(1);
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
      if (hostPath.startsWith(host)) {
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
  const response = await fetch(
    `${PLEX_HOST}/library/sections?X-Plex-Token=${PLEX_TOKEN}`,
    { headers: { Accept: "application/json" } },
  );

  if (!response.ok) {
    logError(`Plex API returned ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const data = (await response.json()) as PlexSectionsResponse;
  const sections = data.MediaContainer.Directory;

  const sectionIds = new Set<string>();
  for (const parent of mappedParentDirs) {
    for (const section of sections) {
      for (const location of section.Location) {
        if (parent.startsWith(location.path)) {
          sectionIds.add(section.key);
          log(`  matched section ${section.key} (${section.title}) via location ${location.path}`);
        }
      }
    }
  }

  if (sectionIds.size === 0) {
    log("No matching Plex sections found for changed paths");
    return;
  }

  const idsArg = [...sectionIds].sort().join(",");
  log(`Invoking ${PLEX_SCAN_SCRIPT} ${idsArg}`);

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(PLEX_SCAN_SCRIPT, [idsArg], { stdio: "inherit" });
    child.on("error", rejectSpawn);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveSpawn();
      } else {
        rejectSpawn(new Error(`plex-scan.sh exited with code ${code}`));
      }
    });
  });

  log(`Done — refreshed ${sectionIds.size} section(s)`);
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
