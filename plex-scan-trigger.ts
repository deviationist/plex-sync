import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  getPlexServer,
  fetchActivitySnapshot,
  log as baseLog,
  logError as baseLogError,
  makeDebug,
} from "./plex-client.ts";
import { SEARCHTYPES, type Section } from "@ctrl/plex";

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
    -v, --verbose    Verbose debug output (-v once for milestones,
                     -vv or -v -v for step-by-step trace)
    --path PATH      Scope the scan to PATH (a Plex container-side path under
                     the section's root). Requires exactly one SECTION_ID.

ARGUMENTS:
    SECTION_IDS      Optional comma-separated list of section IDs to trigger.
                     If not provided, all sections will be triggered.

EXAMPLES:
    plex-scan-trigger.ts                                              # All sections
    plex-scan-trigger.ts 1,3,5                                        # Sections 1, 3, 5
    plex-scan-trigger.ts --wait-finish 1,3,5                          # And wait
    plex-scan-trigger.ts -v --wait-finish 1,3,5                       # Verbose + wait
    plex-scan-trigger.ts 25 --path /data/music/main/Synthwave         # Partial scan
    plex-scan-trigger.ts 25 --path /data/music/main/House --wait-finish

REQUIREMENTS:
    .env in the script directory with PLEX_HOST and PLEX_TOKEN.
    Optional POLL_INTERVAL (seconds, default 2) for --wait-finish polling.
`;

export interface TriggerTarget {
  sectionId: string;
  /** Optional Plex container-side path to scope the scan. */
  path?: string;
}

export interface TriggerScanOptions {
  /**
   * Each target is one Plex `/library/sections/{id}/refresh` call.
   * Omit or pass [] to trigger every section (full).
   */
  targets?: TriggerTarget[];
  /** Poll /activities until each started scan completes. */
  waitFinish?: boolean;
  /** Verbosity: 0 silent, 1 milestone debug, 2 step-by-step trace. */
  verbose?: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const MAX_POLLS_BEFORE_INSTANT_FINISH = 5;

interface ParsedArgs {
  help: boolean;
  waitFinish: boolean;
  verbose: number;
  sectionIds: string[];
  path: string | null;
  errors: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    waitFinish: false,
    verbose: 0,
    sectionIds: [],
    path: null,
    errors: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--wait-finish") out.waitFinish = true;
    else if (arg === "-v" || arg === "--verbose") out.verbose += 1;
    else if (arg === "-vv") out.verbose += 2;
    else if (arg === "--path") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        out.errors.push("--path requires a path value");
      } else {
        out.path = value;
        i++;
      }
    } else if (arg.startsWith("--path=")) {
      out.path = arg.slice("--path=".length);
    } else if (arg.startsWith("-")) out.errors.push(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (out.verbose > 2) out.verbose = 2;
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
  if (out.path !== null) {
    if (out.sectionIds.length === 0) {
      out.errors.push("--path requires exactly one SECTION_ID (none given)");
    } else if (out.sectionIds.length > 1) {
      out.errors.push(
        `--path requires exactly one SECTION_ID (got ${out.sectionIds.length}: ${out.sectionIds.join(",")})`,
      );
    }
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

export async function triggerScan(options: TriggerScanOptions = {}): Promise<void> {
  const { targets: requestedTargets, waitFinish = false, verbose = 0 } = options;
  const { debug, trace } = makeDebug(verbose, TAG);

  const server = getPlexServer();
  log(`Using Plex host: ${server.baseurl}`);

  debug("Fetching library sections from Plex");
  const library = await server.library();
  const allSections = await library.sections();
  const byId = new Map<string, Section>();
  for (const section of allSections) {
    byId.set(String(section.key), section);
    trace(`indexed section ${section.key} (${section.title}) — locations: ${section.locations.map((l) => l.path).join(", ")}`);
  }

  interface ResolvedTarget {
    section: Section;
    path?: string;
  }

  let resolved: ResolvedTarget[];
  if (!requestedTargets || requestedTargets.length === 0) {
    log(`No targets provided, triggering all ${allSections.length} sections (full)`);
    resolved = allSections.map((s) => ({ section: s }));
  } else {
    log(`Using ${requestedTargets.length} requested target(s)`);
    resolved = [];
    for (const t of requestedTargets) {
      const section = byId.get(String(t.sectionId));
      if (!section) {
        logError(`Section ID ${t.sectionId} not found in this Plex library — skipping`);
        continue;
      }
      trace(`resolved section ID ${t.sectionId} -> "${section.title}"${t.path ? ` (path: ${t.path})` : ""}`);
      resolved.push({ section, path: t.path });
    }
  }

  resolved.sort((a, b) => {
    const cmp = Number(a.section.key) - Number(b.section.key);
    if (cmp !== 0) return cmp;
    return (a.path ?? "").localeCompare(b.path ?? "");
  });

  const startedIds = new Set<string>();
  for (const { section, path } of resolved) {
    const scope = path ? ` path="${path}"` : "";
    log(`Triggering scan of section ${section.key} (${section.title})${scope}...`);
    debug(
      path
        ? `Calling section.update({ path }) — GET /library/sections/${section.key}/refresh?path=${encodeURIComponent(path)}`
        : `Calling section.update() — GET /library/sections/${section.key}/refresh`,
    );
    try {
      await (path ? section.update({ path }) : section.update());
      console.log(`  ✓ Section ${section.key}${scope} scan triggered successfully`);
      startedIds.add(String(section.key));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Failed to trigger section ${section.key}${scope}: ${msg}`);
    }
  }

  if (!waitFinish || startedIds.size === 0) {
    if (waitFinish && startedIds.size === 0) {
      log("No sections started — nothing to wait on");
    }
    log("Scan trigger completed.");
    return;
  }

  await waitForCompletion([...startedIds], verbose);
  log("Scan trigger completed.");
}

export interface DeleteByPathOptions {
  section: Section;
  /** Plex container-side file path. Must match `Media.Part.file` exactly. */
  containerPath: string;
  verbose?: number;
}

export interface DeleteByPathResult {
  /** Candidate items returned by Plex whose Part.file exactly matched containerPath. */
  found: number;
  /** Of `found`, how many DELETE calls returned 2xx. */
  deleted: number;
}

const FILE_LIBTYPE_BY_SECTION_TYPE: Record<string, keyof typeof SEARCHTYPES> = {
  movie: "movie",
  show: "episode",
  artist: "track",
  photo: "photo",
};

interface RawMetadataPart {
  file?: string;
}
interface RawMetadataMedia {
  Part?: RawMetadataPart[];
}
interface RawMetadata {
  ratingKey?: string | number;
  title?: string;
  Media?: RawMetadataMedia[];
}

interface ItemMatch {
  ratingKey: string;
  title: string;
}

/**
 * Bypasses `@ctrl/plex`'s typed filter API (which rejects unknown filter keys
 * like `file`) and queries `/library/sections/{id}/all?type=N&file=<path>`
 * directly. Plex's `file` filter is a substring match, so each candidate is
 * verified against `Media.Part.file === containerPath` before being returned.
 */
async function findItemsByExactPath(opts: {
  section: Section;
  containerPath: string;
  verbose: number;
}): Promise<ItemMatch[]> {
  const { section, containerPath, verbose } = opts;
  const { debug, trace } = makeDebug(verbose, TAG);

  const fileLibtype = FILE_LIBTYPE_BY_SECTION_TYPE[section.type];
  if (!fileLibtype) {
    trace(`section ${section.key} type="${section.type}" has no file-level items — skipping lookup`);
    return [];
  }
  const typeNum = SEARCHTYPES[fileLibtype];

  const params = new URLSearchParams({
    type: String(typeNum),
    file: containerPath,
    includeGuids: "0",
  });
  const lookupPath = `/library/sections/${section.key}/all?${params.toString()}`;
  debug(`Looking up items by file path in section ${section.key} — GET ${lookupPath}`);

  let response: { MediaContainer?: { Metadata?: RawMetadata[] } };
  try {
    response = await section.server.query({ path: lookupPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Lookup failed for "${containerPath}" in section ${section.key}: ${msg}`);
    return [];
  }

  const candidates = response.MediaContainer?.Metadata ?? [];
  trace(`section ${section.key} returned ${candidates.length} candidate(s) for "${containerPath}"`);

  const matches: ItemMatch[] = [];
  for (const elem of candidates) {
    const partFiles: string[] = [];
    for (const media of elem.Media ?? []) {
      for (const part of media.Part ?? []) {
        if (typeof part.file === "string") partFiles.push(part.file);
      }
    }
    if (!partFiles.includes(containerPath)) {
      trace(`  ratingKey=${elem.ratingKey} title="${elem.title}" — substring match only (parts: ${JSON.stringify(partFiles)}), skipping`);
      continue;
    }
    if (elem.ratingKey === undefined || elem.ratingKey === null) {
      trace(`  candidate matched but has no ratingKey — skipping`);
      continue;
    }
    matches.push({ ratingKey: String(elem.ratingKey), title: elem.title ?? "?" });
  }
  return matches;
}

/**
 * Look up Plex items by exact file path within `section` and delete each match.
 *
 * Requires "Allow media deletion" in the Plex server's library settings.
 */
export async function deleteItemByPath(opts: DeleteByPathOptions): Promise<DeleteByPathResult> {
  const { section, containerPath, verbose = 0 } = opts;
  const { debug } = makeDebug(verbose, TAG);

  const matches = await findItemsByExactPath({ section, containerPath, verbose });
  let deleted = 0;
  for (const match of matches) {
    debug(`Deleting ratingKey=${match.ratingKey} title="${match.title}" file="${containerPath}"`);
    try {
      await section.server.query({ path: `/library/metadata/${match.ratingKey}`, method: "delete" });
      console.log(`  ✓ Deleted ratingKey=${match.ratingKey} (${match.title})`);
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Failed to delete ratingKey=${match.ratingKey}: ${msg}`);
    }
  }
  return { found: matches.length, deleted };
}

export interface RefreshByPathOptions {
  section: Section;
  /** Plex container-side file path. Must match `Media.Part.file` exactly. */
  containerPath: string;
  verbose?: number;
}

export interface RefreshByPathResult {
  /** Candidate items returned by Plex whose Part.file exactly matched containerPath. */
  found: number;
  /** Of `found`, how many PUT /refresh calls returned 2xx. */
  refreshed: number;
}

/**
 * Look up Plex items by exact file path within `section` and issue
 * `PUT /library/metadata/{ratingKey}/refresh` for each match. Forces Plex
 * to re-read tags/metadata from disk (a normal section scan skips files
 * whose size and mtime suggest no change, so this is the only way to
 * propagate in-place ID3/tag edits).
 */
export async function refreshItemByPath(opts: RefreshByPathOptions): Promise<RefreshByPathResult> {
  const { section, containerPath, verbose = 0 } = opts;
  const { debug } = makeDebug(verbose, TAG);

  const matches = await findItemsByExactPath({ section, containerPath, verbose });
  let refreshed = 0;
  for (const match of matches) {
    debug(`Refreshing metadata for ratingKey=${match.ratingKey} title="${match.title}" file="${containerPath}"`);
    try {
      await section.server.query({ path: `/library/metadata/${match.ratingKey}/refresh`, method: "put" });
      console.log(`  ✓ Refreshed ratingKey=${match.ratingKey} (${match.title})`);
      refreshed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Failed to refresh ratingKey=${match.ratingKey}: ${msg}`);
    }
  }
  return { found: matches.length, refreshed };
}

async function waitForCompletion(startedIds: string[], verbose: number): Promise<void> {
  const { debug, trace } = makeDebug(verbose, TAG);
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
      if (!tracker) {
        trace(`activity for untracked section ${entry.sectionId} — ignoring`);
        continue;
      }
      const wasState = tracker.state;
      tracker.state = "scanning";
      tracker.progress = entry.progress;
      tracker.subtitle = entry.subtitle;
      tracker.observedScanning = true;
      tracker.pollsWithoutObservation = 0;
      if (wasState !== "scanning") {
        trace(`section ${entry.sectionId}: ${wasState} -> scanning (${entry.progress}% ${entry.subtitle})`);
      }
    }

    for (const [id, tracker] of trackers) {
      if (tracker.state === "completed") continue;
      if (activeIds.has(id)) continue;
      if (tracker.observedScanning) {
        trace(`section ${id}: scanning -> completed (no longer in activities)`);
        tracker.state = "completed";
      } else {
        tracker.pollsWithoutObservation += 1;
        trace(`section ${id}: still pending (${tracker.pollsWithoutObservation}/${MAX_POLLS_BEFORE_INSTANT_FINISH} polls)`);
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
  const targets: TriggerTarget[] = args.sectionIds.map((id) => {
    const t: TriggerTarget = { sectionId: id };
    if (args.path !== null) t.path = args.path;
    return t;
  });
  await triggerScan({
    targets: targets.length > 0 ? targets : undefined,
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
