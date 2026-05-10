import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  getPlexServer,
  fetchActivitySnapshot,
  log as baseLog,
  logError as baseLogError,
} from "./plex-client.ts";
import type { Section } from "@ctrl/plex";

const TAG = "plex-scan-trigger";
const log = (msg: string) => baseLog(TAG, msg);
const logError = (msg: string) => baseLogError(TAG, msg);

const HELP_TEXT = `Plex Library Scan Trigger (TS)

DESCRIPTION:
    Triggers a scan of one or more Plex library sections (Plex performs the
    actual scan). With no arguments, every section is triggered.

USAGE:
    plex-scan-trigger.ts [OPTIONS] [SECTION_IDS]

OPTIONS:
    -h, --help       Show this help message and exit
    --wait-finish    Wait for all library scans to complete before exiting
    -v, --verbose    Enable verbose debug output

ARGUMENTS:
    SECTION_IDS      Optional comma-separated list of section IDs to trigger.
                     If not provided, all sections will be triggered.

EXAMPLES:
    plex-scan-trigger.ts                          # Trigger all library sections
    plex-scan-trigger.ts 1,3,5                    # Trigger sections 1, 3, and 5
    plex-scan-trigger.ts --wait-finish            # Trigger all and wait
    plex-scan-trigger.ts --wait-finish 1,3,5      # Trigger specific and wait
    plex-scan-trigger.ts -v --wait-finish 1,3,5   # Verbose + wait

REQUIREMENTS:
    .env in the script directory with PLEX_HOST and PLEX_TOKEN.
    Optional POLL_INTERVAL (seconds, default 2) for --wait-finish polling.
`;

export interface TriggerScanOptions {
  /** Section IDs to trigger. If omitted/empty, trigger all sections. */
  sectionIds?: string[];
  /** Poll /activities until each started scan completes. */
  waitFinish?: boolean;
  /** Print debug logs. */
  verbose?: boolean;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const MAX_POLLS_BEFORE_INSTANT_FINISH = 5;

interface ParsedArgs {
  help: boolean;
  waitFinish: boolean;
  verbose: boolean;
  sectionIds: string[];
  errors: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    waitFinish: false,
    verbose: false,
    sectionIds: [],
    errors: [],
  };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--wait-finish") out.waitFinish = true;
    else if (arg === "-v" || arg === "--verbose") out.verbose = true;
    else if (arg.startsWith("-")) out.errors.push(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) {
    out.errors.push(
      `Expected at most one positional arg (comma-separated IDs); got ${positional.length}: ${positional.join(" ")}`,
    );
  }
  if (positional.length === 1) {
    const ids = positional[0]!.split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        out.errors.push(`Invalid section ID (must be numeric): ${id}`);
      }
    }
    out.sectionIds = ids;
  }
  return out;
}

function getPollIntervalSeconds(): number {
  const raw = process.env["POLL_INTERVAL"]?.trim();
  if (!raw) return DEFAULT_POLL_INTERVAL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_POLL_INTERVAL_SECONDS;
  return parsed;
}

type SectionState = "pending" | "scanning" | "completed";

interface SectionTracker {
  state: SectionState;
  progress: number;
  subtitle: string;
  observedScanning: boolean;
  pollsWithoutObservation: number;
}

function makeDebug(verbose: boolean) {
  return (msg: string) => {
    if (verbose) console.log(`[DEBUG] ${msg}`);
  };
}

export async function triggerScan(options: TriggerScanOptions = {}): Promise<void> {
  const { sectionIds: requestedIds = [], waitFinish = false, verbose = false } = options;
  const debug = makeDebug(verbose);

  const server = getPlexServer();
  log(`Using Plex host: ${server.baseurl}`);

  debug("Fetching library sections from Plex");
  const library = await server.library();
  const allSections = await library.sections();
  const byId = new Map<string, Section>();
  for (const section of allSections) {
    byId.set(String(section.key), section);
  }

  let targets: Section[];
  if (requestedIds.length === 0) {
    log(`No section IDs provided, triggering all ${allSections.length} sections`);
    targets = [...allSections];
  } else {
    log(`Using provided section IDs: ${requestedIds.join(",")}`);
    targets = [];
    for (const id of requestedIds) {
      const section = byId.get(String(id));
      if (!section) {
        logError(`Section ID ${id} not found in this Plex library — skipping`);
        continue;
      }
      targets.push(section);
    }
  }

  targets.sort((a, b) => Number(a.key) - Number(b.key));

  const startedIds: string[] = [];
  for (const section of targets) {
    log(`Triggering scan of section ${section.key} (${section.title})...`);
    debug(`Calling section.update() — GET /library/sections/${section.key}/refresh`);
    try {
      await section.update();
      console.log(`  ✓ Section ${section.key} scan triggered successfully`);
      startedIds.push(String(section.key));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Failed to trigger section ${section.key}: ${msg}`);
    }
  }

  if (!waitFinish || startedIds.length === 0) {
    if (waitFinish && startedIds.length === 0) {
      log("No sections started — nothing to wait on");
    }
    log("Scan trigger completed.");
    return;
  }

  await waitForCompletion(startedIds, verbose);
  log("Scan trigger completed.");
}

async function waitForCompletion(startedIds: string[], verbose: boolean): Promise<void> {
  const debug = makeDebug(verbose);
  const trackers = new Map<string, SectionTracker>();
  for (const id of startedIds) {
    trackers.set(id, {
      state: "pending",
      progress: 0,
      subtitle: "",
      observedScanning: false,
      pollsWithoutObservation: 0,
    });
  }

  const pollInterval = getPollIntervalSeconds();
  debug(`Polling /activities every ${pollInterval}s (POLL_INTERVAL env to override)`);

  console.log("");
  console.log("Waiting for all library scans to complete...");

  let progressDisplayed = false;

  const renderProgress = () => {
    if (progressDisplayed) {
      for (let i = 0; i < trackers.size; i++) process.stdout.write("\x1b[1A\x1b[2K");
    }
    const ids = [...trackers.keys()].sort((a, b) => Number(a) - Number(b));
    for (const id of ids) {
      const t = trackers.get(id)!;
      if (t.state === "scanning") {
        const sub = t.subtitle ? ` (${t.subtitle})` : "";
        console.log(`  Section ${id}: ${t.progress}% complete${sub}`);
      } else if (t.state === "completed") {
        console.log(`  Section ${id}: ✓ Completed`);
      } else {
        console.log(`  Section ${id}: Pending...`);
      }
    }
    progressDisplayed = true;
  };

  while (true) {
    let snapshot: { sectionId: string; progress: number; subtitle: string }[] = [];
    try {
      snapshot = await fetchActivitySnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Activity poll failed: ${msg}`);
    }
    debug(`Activities snapshot: ${snapshot.length} active scan(s)`);

    const activeIds = new Set(snapshot.map((a) => a.sectionId));
    for (const entry of snapshot) {
      const tracker = trackers.get(entry.sectionId);
      if (!tracker) continue;
      tracker.state = "scanning";
      tracker.progress = entry.progress;
      tracker.subtitle = entry.subtitle;
      tracker.observedScanning = true;
      tracker.pollsWithoutObservation = 0;
    }

    for (const [id, tracker] of trackers) {
      if (tracker.state === "completed") continue;
      if (activeIds.has(id)) continue;
      if (tracker.observedScanning) {
        tracker.state = "completed";
      } else {
        tracker.pollsWithoutObservation += 1;
        if (tracker.pollsWithoutObservation >= MAX_POLLS_BEFORE_INSTANT_FINISH) {
          debug(`Section ${id} never observed scanning after ${MAX_POLLS_BEFORE_INSTANT_FINISH} polls — treating as instant finish`);
          tracker.state = "completed";
        }
      }
    }

    renderProgress();

    let allDone = true;
    for (const tracker of trackers.values()) {
      if (tracker.state !== "completed") {
        allDone = false;
        break;
      }
    }
    if (allDone) {
      console.log("  ✓ All library scans completed!");
      return;
    }

    if (pollInterval > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) console.error(`Error: ${e}`);
    console.error("");
    console.error("Run with --help for usage.");
    process.exit(2);
  }
  await triggerScan({
    sectionIds: args.sectionIds,
    waitFinish: args.waitFinish,
    verbose: args.verbose,
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
