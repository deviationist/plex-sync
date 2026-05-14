# plex-sync

Tools for refreshing Plex libraries — usable on their own, or wired into any system that emits filesystem-change events.

## Concept

Two layers, separated by responsibility:

```
plex-orchestrator.ts      ← takes a list of filesystem events (add/change/unlink),
                            figures out which Plex section(s) own them,
                            API-deletes items on unlink, refreshes metadata on
                            change, then triggers scoped scans
        │
        ▼
plex-scan-trigger.ts      ← dumb trigger: hits Plex with the given section IDs;
                            also exports `deleteItemByPath` (for unlinks) and
                            `refreshItemByPath` (for in-place tag edits)
        │
        ▼
Plex Media Server         ← /library/sections/{id}/refresh, DELETE /library/metadata/{key},
                            PUT /library/metadata/{key}/refresh
```

The orchestrator owns all the smarts (host→container path mapping, Plex section discovery, event routing). The trigger is intentionally dumb — call it with section IDs and it tells Plex to scan them, nothing else. You can also run the trigger by hand for ad-hoc rescans.

The orchestrator is meant to be invoked from any change-notification system. It reads a JSON event array from the `CHANGED_EVENTS` environment variable. `add` events trigger a deduped parent-dir scoped scan. `change` events trigger a per-file `PUT /library/metadata/{ratingKey}/refresh` so in-place tag edits are re-read (a normal scan skips files whose size/mtime didn't change). `unlink` events trigger an immediate Plex API delete. By default the precise API calls for `change`/`unlink` are the *only* action — set `SCOPED_SCAN_AFTER_CHANGE=true` and/or `SCOPED_SCAN_AFTER_UNLINK=true` (independently) to also include those events' parent dirs in the scoped-scan set as a safety net.

> **Plex setup**: API delete requires "Allow media deletion" enabled in *Settings → Library*. Without it, the DELETE call fails; the orchestrator logs the failure and the parent scoped scan still runs (so reconciliation falls back to mark-missing semantics).

## Files

- **`plex-orchestrator.ts`** — Orchestrator. Reads `CHANGED_EVENTS`, maps each event's host path to its container path via `plex-path-map.json`, queries Plex's `/library/sections` to find which section owns each path, API-deletes unlink targets via `deleteItemByPath`, then calls `triggerScan()` from `plex-scan-trigger.ts` with the deduped `(sectionId, parentDir)` set covering every event.
- **`plex-scan-trigger.ts`** — Trigger. Uses `@ctrl/plex` to call `/library/sections/{id}/refresh` for each ID, optionally scoped to a `path`. Also exports `deleteItemByPath` and `refreshItemByPath`, which look up Plex items by exact file path via `/library/sections/{id}/all?type=N&file=<path>` and issue `DELETE /library/metadata/{ratingKey}` or `PUT /library/metadata/{ratingKey}/refresh` respectively. Standalone CLI: `--wait-finish` polls `/activities` until scans complete, `-v`/`-vv` for debug output, `--path` for partial scans. Run with no args to trigger *every* section.
- **`plex-client.ts`** — Shared module: loads `.env`, validates `PLEX_HOST`/`PLEX_TOKEN`, returns a cached `PlexServer`, and exposes a typed `/activities` snapshot helper (the `@ctrl/plex` `Activity` type omits `librarySectionID`, so this fills the gap).
- **`plex-path-map.json`** / **`plex-path-map.example.json`** — Host-path → container-path mapping. Required by the orchestrator only; format is a flat JSON object. The real file is gitignored — copy the example and fill in your own paths.
- **`.env` / `.env.example`** — `PLEX_HOST` and `PLEX_TOKEN`. Shared by all entry points.
- **`package.json`** — Declares `tsx`, `dotenv`, and `@ctrl/plex` so the orchestrator runs without depending on any other project's `node_modules`. Also pulls in `typescript` + `@types/node` (devDeps) so `npm run typecheck` works.
- **`tsconfig.json`** — Strict TypeScript config used by `npm run typecheck` (`tsc --noEmit`). Doesn't affect runtime — `tsx` runs the `.ts` files directly.

## Setup

```bash
cd /home/xavi/scripts/plex-sync
cp .env.example .env                                   # then fill in PLEX_HOST and PLEX_TOKEN
cp plex-path-map.example.json plex-path-map.json       # then edit for your host/container paths
npm install                                            # for tsx + dotenv
```

Edit `plex-path-map.json` to match your host mounts and Plex container paths. To discover container paths:

```bash
source .env
curl -s "$PLEX_HOST/library/sections?X-Plex-Token=$PLEX_TOKEN" \
  -H "Accept: application/json" \
  | jq '.MediaContainer.Directory[] | {key, title, locations: [.Location[].path]}'
```

## Usage

**Trigger directly:**
```bash
npx tsx ./plex-scan-trigger.ts 25                                 # trigger section 25
npx tsx ./plex-scan-trigger.ts 1,3,5                              # trigger multiple
npx tsx ./plex-scan-trigger.ts --wait-finish 25                   # block until scan completes
npx tsx ./plex-scan-trigger.ts 25 --path /data/music/main/Synth   # scoped/partial scan
npx tsx ./plex-scan-trigger.ts                                    # trigger all sections
```

**Orchestrator from a change notifier** — set `CHANGED_EVENTS` (JSON array of `{event, path, timestamp}`) and invoke:
```bash
CHANGED_EVENTS='[
  {"event":"add",   "path":"/mnt/music/main/Artist/Album/01.mp3", "timestamp":"2026-05-11T07:50:03.180Z"},
  {"event":"change","path":"/mnt/music/main/Artist/Album/02.mp3", "timestamp":"2026-05-11T07:50:04.500Z"},
  {"event":"unlink","path":"/mnt/music/main/Artist/Album/03.mp3", "timestamp":"2026-05-11T07:50:05.020Z"}
]' npx tsx ./plex-orchestrator.ts
```
Events with paths that don't match any entry in `plex-path-map.json` are silently skipped, so it's safe to feed the orchestrator any event stream — it only acts when it finds a real mapping. Unknown event types (anything other than `add`/`change`/`unlink`) are logged and skipped.

The orchestrator routes events by type:
- `add` → scoped scan of the parent dir (deduped — many files in one folder produce one scan).
- `change` → look up the Plex item by exact file path and `PUT /library/metadata/{ratingKey}/refresh` (so in-place ID3/tag edits are re-read).
- `unlink` → look up the Plex item by exact file path and `DELETE /library/metadata/{ratingKey}`.

The parent-dir scan after `change`/`unlink` is opt-in via two independent env vars (both default off):
- `SCOPED_SCAN_AFTER_CHANGE=true` — useful as a fallback when a refreshed file isn't yet indexed in Plex.
- `SCOPED_SCAN_AFTER_UNLINK=true` — useful when you want Plex to reconcile empty Albums/Shows/Seasons after a delete.

Accepted truthy values: `true`, `1`, `yes`, `on` (case-insensitive). Anything else (including unset) is treated as off.

## `plex-path-map.json` format

```json
{
  "/host/path/to/media": "/container/path/to/media",
  "/host/path/to/another": "/container/path/to/another"
}
```

Keys are host paths (what your filesystem watcher sees). Values are the corresponding paths *inside the Plex container* (what Plex stores in `Location.path`). Each changed host path is rewritten using the first-matching key (iteration order), then matched against section locations — list more specific keys first if you have nested mounts.
