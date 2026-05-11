import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Section } from "@ctrl/plex";
import { deleteItemByPath, triggerScan, type TriggerTarget } from "./plex-scan-trigger.ts";
import {
  SCRIPT_DIRECTORY,
  getPlexServer,
  log as baseLog,
  logError as baseLogError,
  makeDebug,
} from "./plex-client.ts";

const TAG = "plex-orchestrator";
const log = (msg: string) => baseLog(TAG, msg);
const logError = (msg: string) => baseLogError(TAG, msg);

function parseVerbosity(argv: string[]): { verbose: number; unknown: string[] } {
  let verbose = 0;
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === "-v" || arg === "--verbose") verbose += 1;
    else if (arg === "-vv") verbose += 2;
    else unknown.push(arg);
  }
  return { verbose: Math.min(2, verbose), unknown };
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
  const { verbose, unknown } = parseVerbosity(process.argv.slice(2));
  if (unknown.length > 0) {
    logError(`Unknown argument(s): ${unknown.join(", ")} — only -v/-vv are accepted`);
    process.exit(2);
  }
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

  // Build deduped (sectionId, parentDir) targets from EVERY event's parent —
  // add, change, and unlink alike. Unlink parents are included so Plex
  // reconciles empty Albums/Shows/Seasons after the API delete.
  const seen = new Set<string>();
  const targets: TriggerTarget[] = [];
  const parentDirs = new Set(mapped.map((e) => e.parent));
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
