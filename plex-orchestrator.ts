import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Section } from "@ctrl/plex";
import {
  deleteItemByPath,
  refreshItemByPath,
  triggerScan,
  type TriggerTarget,
} from "./plex-scan-trigger.ts";
import {
  SCRIPT_DIRECTORY,
  configureFileLogging,
  getPlexServer,
  log as baseLog,
  logError as baseLogError,
  makeDebug,
} from "./plex-client.ts";

const TAG = "plex-orchestrator";
const log = (msg: string) => baseLog(TAG, msg);
const logError = (msg: string) => baseLogError(TAG, msg);

interface ParsedCliArgs {
  verbose: number;
  logFile: string | null;
  noLog: boolean;
  unknown: string[];
  errors: string[];
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const out: ParsedCliArgs = { verbose: 0, logFile: null, noLog: false, unknown: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-v" || arg === "--verbose") out.verbose += 1;
    else if (arg === "-vv") out.verbose += 2;
    else if (arg === "--no-log") out.noLog = true;
    else if (arg === "--log-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        out.errors.push("--log-file requires a path value");
      } else {
        out.logFile = value;
        i++;
      }
    } else if (arg.startsWith("--log-file=")) {
      out.logFile = arg.slice("--log-file=".length);
    } else {
      out.unknown.push(arg);
    }
  }
  out.verbose = Math.min(2, out.verbose);
  return out;
}

type PathMap = Record<string, string>;

type ChangeEvent = "add" | "change" | "unlink";
const KNOWN_EVENTS: ReadonlySet<string> = new Set<ChangeEvent>(["add", "change", "unlink"]);

interface FileEvent {
  event: ChangeEvent;
  path: string;
  timestamp: string;
}

interface MappedEvent extends FileEvent {
  /** Plex container-side path equivalent of `path` (host → container rewritten). */
  containerPath: string;
  /** Parent directory of `containerPath`. */
  parent: string;
}

const PATH_MAP_FILE = process.env["PLEX_PATH_MAP_FILE"]?.trim()
  ?? resolve(SCRIPT_DIRECTORY, "plex-path-map.json");
const CHANGED_EVENTS = process.env["CHANGED_EVENTS"]?.trim();
const SCOPED_SCAN_AFTER_CHANGE = parseBool(process.env["SCOPED_SCAN_AFTER_CHANGE"]);
const SCOPED_SCAN_AFTER_UNLINK = parseBool(process.env["SCOPED_SCAN_AFTER_UNLINK"]);

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldScanParentFor(event: ChangeEvent): boolean {
  if (event === "add") return true;
  if (event === "change") return SCOPED_SCAN_AFTER_CHANGE;
  return SCOPED_SCAN_AFTER_UNLINK;
}

function pathStartsWith(p: string, prefix: string): boolean {
  if (!p.startsWith(prefix)) return false;
  const next = p.charAt(prefix.length);
  return next === "" || next === "/";
}

function parseEvents(raw: string): FileEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`CHANGED_EVENTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("CHANGED_EVENTS must be a JSON array");
  }
  const out: FileEvent[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object") {
      throw new Error(`CHANGED_EVENTS[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["event"] !== "string" || typeof e["path"] !== "string" || typeof e["timestamp"] !== "string") {
      throw new Error(`CHANGED_EVENTS[${i}] is missing required string fields {event, path, timestamp}`);
    }
    if (!KNOWN_EVENTS.has(e["event"])) {
      log(`Skipping CHANGED_EVENTS[${i}] — unknown event type "${e["event"]}"`);
      continue;
    }
    out.push({
      event: e["event"] as ChangeEvent,
      path: e["path"],
      timestamp: e["timestamp"],
    });
  }
  return out;
}

function sectionsContaining(path: string, sections: Section[], trace: (msg: string) => void): Section[] {
  const matches: Section[] = [];
  for (const section of sections) {
    for (const location of section.locations) {
      const m = pathStartsWith(path, location.path);
      trace(`  test "${path}" against section ${section.key} (${section.title}) location "${location.path}" = ${m}`);
      if (m) {
        matches.push(section);
        break;
      }
    }
  }
  return matches;
}

async function main(): Promise<void> {
  const { verbose, logFile, noLog, unknown, errors } = parseCliArgs(process.argv.slice(2));
  if (errors.length > 0) {
    for (const e of errors) logError(e);
    process.exit(2);
  }
  if (unknown.length > 0) {
    logError(`Unknown argument(s): ${unknown.join(", ")} — accepted: -v/-vv, --log-file PATH, --no-log`);
    process.exit(2);
  }
  if (logFile !== null) configureFileLogging({ filePath: logFile });
  if (noLog) configureFileLogging({ enabled: false });
  const { debug, trace } = makeDebug(verbose, TAG);

  if (!CHANGED_EVENTS) {
    log("No CHANGED_EVENTS set, nothing to do");
    return;
  }

  let events: FileEvent[];
  try {
    events = parseEvents(CHANGED_EVENTS);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (events.length === 0) {
    log("CHANGED_EVENTS contained no actionable events — nothing to do");
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

  const mapEntries = Object.entries(pathMap);
  debug(`Loaded ${mapEntries.length} mapping(s) from ${PATH_MAP_FILE}`);
  for (const [host, container] of mapEntries) trace(`  map: ${host} -> ${container}`);

  log(`Processing ${events.length} event(s)`);
  const mapped: MappedEvent[] = [];
  for (const ev of events) {
    let containerPath: string | null = null;
    for (const [host, container] of mapEntries) {
      const matches = pathStartsWith(ev.path, host);
      trace(`  test "${ev.path}" startsWith "${host}" = ${matches}`);
      if (matches) {
        containerPath = container + ev.path.slice(host.length);
        trace(`  mapped via "${host}" -> "${container}" -> ${containerPath}`);
        break;
      }
    }
    if (containerPath === null) {
      log(`  [${ev.event}] ${ev.path} — no host→container mapping, skipping`);
      continue;
    }
    const parent = dirname(containerPath);
    log(`  [${ev.event}] ${ev.path} -> ${containerPath} (parent: ${parent})`);
    mapped.push({ ...ev, containerPath, parent });
  }

  if (mapped.length === 0) {
    log("No events matched any host→container mapping — nothing to do");
    return;
  }

  log("Fetching library sections from Plex...");
  const server = getPlexServer();
  const library = await server.library();
  const sections = await library.sections();
  debug(`Plex returned ${sections.length} section(s)`);

  // Process unlinks first: try to API-delete the matching Plex item(s).
  // Failures (or no match) are non-fatal — the parent scoped scan below
  // will reconcile by marking items missing.
  const unlinks = mapped.filter((e) => e.event === "unlink");
  if (unlinks.length > 0) {
    log(`Processing ${unlinks.length} unlink event(s) via Plex API delete`);
    for (const ev of unlinks) {
      const matching = sectionsContaining(ev.containerPath, sections, trace);
      if (matching.length === 0) {
        log(`  ${ev.containerPath} — no section owns this path, skipping delete`);
        continue;
      }
      for (const section of matching) {
        debug(`Attempting delete in section ${section.key} (${section.title}) for ${ev.containerPath}`);
        const result = await deleteItemByPath({ section, containerPath: ev.containerPath, verbose });
        log(`  section ${section.key}: found=${result.found} deleted=${result.deleted} (${ev.containerPath})`);
      }
    }
  }

  // Process changes: force a per-file metadata refresh so in-place tag edits
  // (e.g., OneTagger ID3 updates) are re-read by Plex. A normal section scan
  // skips files whose size/mtime didn't change, so the parent scoped scan
  // below would not pick these up on its own.
  const changes = mapped.filter((e) => e.event === "change");
  if (changes.length > 0) {
    log(`Processing ${changes.length} change event(s) via Plex API metadata refresh`);
    const alreadyRefreshed = new Set<string>();
    for (const ev of changes) {
      const matching = sectionsContaining(ev.containerPath, sections, trace);
      if (matching.length === 0) {
        log(`  ${ev.containerPath} — no section owns this path, skipping refresh`);
        continue;
      }
      for (const section of matching) {
        debug(`Attempting metadata refresh in section ${section.key} (${section.title}) for ${ev.containerPath}`);
        const result = await refreshItemByPath({ section, containerPath: ev.containerPath, verbose, alreadyRefreshed });
        log(`  section ${section.key}: found=${result.found} refreshed=${result.refreshed} skipped=${result.skipped} (${ev.containerPath})`);
      }
    }
  }

  // Build deduped (sectionId, parentDir) targets. `add` events always
  // contribute their parent dir (no precise API call exists for them).
  // `change` contributes only when SCOPED_SCAN_AFTER_CHANGE is on, and
  // `unlink` only when SCOPED_SCAN_AFTER_UNLINK is on — in those cases
  // the scan acts as a safety net for the precise API call (catching
  // files Plex hasn't indexed yet on a refresh, or reconciling empty
  // Albums/Shows/Seasons after a delete).
  const eventsForScan = mapped.filter((e) => shouldScanParentFor(e.event));
  if (eventsForScan.length < mapped.length) {
    debug(`Skipping parent scan for ${mapped.length - eventsForScan.length} event(s) (SCOPED_SCAN_AFTER_CHANGE=${SCOPED_SCAN_AFTER_CHANGE}, SCOPED_SCAN_AFTER_UNLINK=${SCOPED_SCAN_AFTER_UNLINK})`);
  }
  if (eventsForScan.length === 0) {
    log(`All events handled via per-file API calls — no parent scans needed (SCOPED_SCAN_AFTER_CHANGE=${SCOPED_SCAN_AFTER_CHANGE}, SCOPED_SCAN_AFTER_UNLINK=${SCOPED_SCAN_AFTER_UNLINK})`);
    return;
  }
  const seen = new Set<string>();
  const targets: TriggerTarget[] = [];
  const parentDirs = new Set(eventsForScan.map((e) => e.parent));
  for (const parent of parentDirs) {
    let matchedAny = false;
    for (const section of sections) {
      for (const location of section.locations) {
        const matches = pathStartsWith(parent, location.path);
        trace(`  test parent "${parent}" against section ${section.key} (${section.title}) location "${location.path}" = ${matches}`);
        if (!matches) continue;
        matchedAny = true;
        const key = `${section.key}\0${parent}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ sectionId: String(section.key), path: parent });
        log(`  matched section ${section.key} (${section.title}) via location ${location.path} — will scope scan to ${parent}`);
      }
    }
    if (!matchedAny) {
      trace(`  parent "${parent}" did not match any section location`);
    }
  }

  if (targets.length === 0) {
    log("No matching Plex sections found for event parents — no scans to trigger");
    return;
  }

  log(`Triggering ${targets.length} scoped scan(s)`);
  await triggerScan({ targets, verbose });
  log(`Done — triggered ${targets.length} scoped scan(s)`);
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
