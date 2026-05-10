# plex-scan

Tools for refreshing Plex libraries — usable on their own, or wired into any system that emits filesystem-change events.

## Concept

Two layers, separated by responsibility:

```
plex-orchestrator.ts      ← takes a list of changed host paths,
                            figures out which Plex section(s) own them
        │
        ▼
plex-scan-trigger.ts      ← dumb trigger: hits Plex with the given section IDs
        │  (or plex-scan.sh, the legacy bash equivalent)
        ▼
Plex Media Server         ← /library/sections/{id}/refresh
```

The orchestrator owns all the smarts (host→container path mapping, Plex section discovery). The trigger is intentionally dumb — call it with section IDs and it tells Plex to scan them, nothing else. You can also run the trigger by hand for ad-hoc rescans.

The orchestrator is meant to be invoked from any change-notification system. It reads a newline-separated list of host paths from the `CHANGED_PATHS` environment variable.

## Files

- **`plex-orchestrator.ts`** — Orchestrator. Reads `CHANGED_PATHS`, maps each host path to its container path via `plex-path-map.json`, queries Plex's `/library/sections` to find which section owns each parent dir, then calls `triggerScan()` from `plex-scan-trigger.ts` in-process with the deduped section IDs.
- **`plex-scan-trigger.ts`** — TypeScript trigger (preferred). Uses `@ctrl/plex` to call `/library/sections/{id}/refresh` for each ID. Standalone CLI: `--wait-finish` polls `/activities` until scans complete and `-v` enables debug output. Also exports `triggerScan()` for in-process use by the orchestrator. Run with no args to trigger *every* section.
- **`plex-client.ts`** — Shared module: loads `.env`, validates `PLEX_HOST`/`PLEX_TOKEN`, returns a cached `PlexServer`, and exposes a typed `/activities` snapshot helper (the `@ctrl/plex` `Activity` type omits `librarySectionID`, so this fills the gap).
- **`plex-scan.sh`** — Legacy bash trigger. Same job as `plex-scan-trigger.ts` but via curl. Kept for ad-hoc shell use; the orchestrator no longer invokes it.
- **`plex-path-map.json`** — Host-path → container-path mapping. Required by the orchestrator only; format is a flat JSON object.
- **`.env` / `.env.example`** — `PLEX_HOST` and `PLEX_TOKEN`. Shared by all entry points.
- **`package.json`** — Declares `tsx`, `dotenv`, and `@ctrl/plex` so the orchestrator runs without depending on any other project's `node_modules`.
- **`plex-scan-old.sh`** — Legacy. Superseded by `plex-scan.sh`; kept for reference.

## Setup

```bash
cd /home/xavi/scripts/plex-scan
cp .env.example .env       # then fill in PLEX_HOST and PLEX_TOKEN
npm install                # for tsx + dotenv
```

Edit `plex-path-map.json` to match your host mounts and Plex container paths. To discover container paths:

```bash
source .env
curl -s "$PLEX_HOST/library/sections?X-Plex-Token=$PLEX_TOKEN" \
  -H "Accept: application/json" \
  | jq '.MediaContainer.Directory[] | {key, title, locations: [.Location[].path]}'
```

## Usage

**Trigger directly with the TypeScript CLI** (preferred):
```bash
./node_modules/.bin/tsx ./plex-scan-trigger.ts 25                 # trigger section 25
./node_modules/.bin/tsx ./plex-scan-trigger.ts 1,3,5              # trigger multiple
./node_modules/.bin/tsx ./plex-scan-trigger.ts --wait-finish 25   # block until scan completes
./node_modules/.bin/tsx ./plex-scan-trigger.ts                    # trigger all sections
```

**Trigger directly with the legacy bash script** (still works):
```bash
./plex-scan.sh 25                 # trigger section 25
./plex-scan.sh 1,3,5              # trigger multiple
./plex-scan.sh --wait-finish 25   # block until scan completes
./plex-scan.sh                    # trigger all sections
```

**Orchestrator from a change notifier** — set `CHANGED_PATHS` (newline-separated absolute host paths) and invoke:
```bash
CHANGED_PATHS="/mnt/music/main/track.mp3" \
  ./node_modules/.bin/tsx ./plex-orchestrator.ts
```
Paths that don't match any entry in `plex-path-map.json` are silently skipped, so it's safe to feed the orchestrator any path stream — it only refreshes when it finds a real mapping.

## `plex-path-map.json` format

```json
{
  "/mnt/music/main": "/data/music/main",
  "/mnt/music/on-hold": "/data/music/on-hold"
}
```

Keys are host paths (what your filesystem watcher sees). Values are the corresponding paths *inside the Plex container* (what Plex stores in `Location.path`). Each changed host path is rewritten using the first-matching key (iteration order), then matched against section locations — list more specific keys first if you have nested mounts.
