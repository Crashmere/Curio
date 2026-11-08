# API

Curio is mounted at `/curio/` on `nas`; `ali` and `vps` forward the same application. The routes below are application-relative: a browser calls `/curio/api/assets`, while a loopback check can call `http://127.0.0.1:18088/api/assets`. Business requests use the existing ServerPortal device cookie; Curio adds no second authentication system.

JSON responses are not cached. Errors use `{"error":"message"}` with an appropriate HTTP status. JSON control requests are limited to 1 MiB. Media IDs are complete lowercase SHA-256 hashes; tag, collection and group IDs are generated lowercase 32-character hexadecimal identifiers. Source links must be HTTP or HTTPS URLs.

## Shared Query Scope

Browsing requests accept `scope=normal` or `scope=hidden`; omitted or unrecognized values use normal scope. Effective hiding is the logical OR of the media's own hidden flag, any associated hidden tag and any associated hidden collection. Normal selects its complement; hidden selects effectively hidden media.

The same endpoints serve both scopes. Counts, search, tags, collection covers, inbox, stars, trash and jobs use the common scope predicate. Hiding is a display rule, not an authorization boundary; already known media and download URLs retain ordinary Portal authentication without a separate scope check.

## Browsing and Metadata

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database connection health, with `status: "ok"` and service name |
| `GET /api/info` | Name, version, chunk maximum, workers/GPU slots and scoped `total`, `starred`, `unorganized`, `trash`, `queued`, `errors` and `bytes` |
| `GET /api/assets` | `items`, filtered `total` and nullable `nextOffset` |
| `GET /api/assets/{id}` | Scoped asset details, memberships and hidden reasons |
| `GET /api/tags` | Scoped tag `items`, counts and covers |
| `GET /api/collections` | Scoped collection `items`, counts and covers |
| `GET /api/games` | Scoped game `items`, screenshot counts, latest capture time and covers |
| `GET /api/jobs` | Up to 120 current/recent scoped processing or deletion tasks, with stage, engine, progress and error |
| `GET /api/uploads` | Up to 120 incomplete uploads, filtered by their upload scope and associated hidden tags/collections before pagination |

An asset includes `id`, original `name`, editable `title`, `notes`, `sourceUrl`, `author`, `kind`, `format`, `mime`, `size`, `width`, `height`, `duration`, `hasAlpha`, `hidden`, `effectiveHidden`, `hiddenReasons`, `organized`, `starred`, `trashedAt`, timestamps, processing fields, `tags`, `collections` and media/download URLs. `hidden` is only its own flag; `effectiveHidden` includes membership inheritance. Each hidden reason identifies its `kind`, `id` and `name`. `organized` is read-only and true when the asset has a tag, collection or enabled screenshot classification, including hidden containers and unassigned game media. The `unorganized` filter and count use the opposite predicate within the requested scope.

`GET /api/info` returns `total` for live non-screenshot assets and `screenshots` for live classified game media. Their sum is the live catalog count in that scope. Stars, trash, jobs and `bytes` still span both categories. The browser's All Materials view uses `screenshot=0`; an asset list with neither screenshot nor game filters spans both categories.

Asset list filters are parallel query parameters:

| Parameter | Values or units |
| --- | --- |
| `q` | Name, title, notes, source, author, tag, collection, game name or Steam App ID |
| `ids` | Optional comma-separated selection of up to 2000 media IDs for scoped status refresh |
| `kind` | `image`, `animation`, `video` |
| `tag`, `collection` | One container ID each |
| `group` | One collection group ID; all other media filters still apply |
| `grouped` | `1` with `collection` pages by ungrouped media and one anchor per matching group; ignored with `group` or `ids` |
| `screenshot` | `1` selects game media (images and recordings); `0` excludes it; omitted includes both categories |
| `game` | Game registry ID, or `unassigned` for screenshots without a game |
| `format` | Lowercase original extension, such as `png` or `mp4` |
| `starred`, `unorganized`, `trash` | `1` enables the corresponding selection; ordinary lists exclude trash |
| `aspect` | `square`, `landscape`, `portrait` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Pixels |
| `minDuration`, `maxDuration` | Seconds |
| `minSize`, `maxSize` | Bytes |
| `sort` | `newest` (default), `oldest`, `name`, `size`, `capturedNewest`, `capturedOldest`; capture sorts place unknown times last |
| `limit`, `offset` | Default limit 120, maximum 240 (2000 with `ids`); next request uses `nextOffset` |

With `grouped=1`, `total` remains the number of matching media, while `limit`, `offset` and `nextOffset` count gallery entries. Each group's anchor is its first matching media in the selected sort order. Requests selecting every media item must omit `grouped`.

## Editing and Organization

`PATCH /api/assets/{id}` changes one asset. `PATCH /api/assets` uses the same fields plus `ids` for an atomic batch of 1-2000 assets:

```json
{
  "ids": ["<asset-sha256>"],
  "starred": true,
  "hidden": false,
  "addTagIds": ["<tag-id>"],
  "addCollectionIds": ["<collection-id>"]
}
```

Optional text fields are `title`, `notes`, `sourceUrl` and `author`. `hidden` and `starred` are independent booleans. Legacy `organized` input is ignored; organization status follows tag and collection memberships automatically. `trash:true` moves the selection to trash; `trash:false` restores it. A tag or collection marked hidden can still keep an asset effectively hidden after its own flag is cleared.

`tagIds` and `collectionIds` replace complete membership sets when present. `addTagIds`, `removeTagIds`, `addCollectionIds` and `removeCollectionIds` apply incremental membership changes. An empty replacement list removes all memberships of that kind. Batches fail atomically when selected assets or required containers are unavailable.

Both container types use the same contract:

| Method and path | Behavior |
| --- | --- |
| `POST /api/tags` or `/api/collections` | Create using required `name` and optional `hidden`; omission defaults to the request scope |
| `PATCH /api/tags/{id}` or `/api/collections/{id}` | Change `name`, `hidden`, or both |
| `DELETE /api/tags/{id}` or `/api/collections/{id}` | Delete only the container and membership links, preserving assets and originals |

Tag names are globally case-insensitive unique. Creating an existing same-visibility tag can reuse its ID; visibility is not changed by that reuse. Collection names do not identify physical storage or duplicate originals.

`POST /api/assets/retry` takes `{"ids":["<asset-sha256>"]}` and requeues derived processing without changing originals. `POST /api/assets/purge` takes the same selection plus `confirm:true`, accepts only trash assets and returns HTTP 202 after persisting the selected cleanup intent. Cleanup resumes after interruption; it does not affect unrelated originals or existing backups.

### Collection Groups

Groups are unnamed and local to one collection. Each media item can belong to one group in that collection, independently of its grouping in other collections.

| Method and path | Behavior |
| --- | --- |
| `GET /api/collections/{id}/groups` | `items` containing group `id` and ordered `assetIds`; applies the media list's scope, search, filters and sorting before forming groups, without pagination |
| `POST /api/collections/{id}/groups` | Create with `{"ids":["<asset-sha256>","<asset-sha256>"]}`; requires at least two distinct media and returns `{"id":"<group-id>"}` |
| `PATCH /api/collections/{id}/groups/{group}` | Incrementally change members using `addIds` and/or `removeIds` |
| `PATCH /api/collections/{id}/groups` | Remove selected media from any groups in this collection using `removeIds` |
| `DELETE /api/collections/{id}/groups/{group}` | Dissolve the entire group, preserving media, collection memberships, metadata and originals |

Group edits accept up to 2000 media per request and validate live membership in the collection and requested scope atomically. Adding media already grouped elsewhere in the same collection moves only those selected media. A group's matched subset can contain one media after filtering or visibility changes. Groups with no matching live members are omitted from browsing; groups with no remaining membership links are removed during group edits.

Fetch a group's media through `GET /api/assets?collection=<id>&group=<group-id>` with the same scope and filters. Group membership survives trash and restore, but removing a collection membership removes its group link. Replacing `collectionIds` retains group links for collections that remain present.

### Game Screenshots

Assets additionally expose `screenshot`, `capturedAt`, optional `screenshotSource` (`steam` or `manual`) and optional `game` with `id`, `name` and `steamAppId`. `capturedAt` is either empty or a timezone-free `YYYY-MM-DDTHH:mm:ss` local time; it is not a UTC instant. `GET /api/info` adds the scoped live `screenshots` count. Keyword searches also match associated game names and Steam App IDs.

`GET /api/games` returns `items` with `id`, `name`, `steamAppId`, `count`, optional `coverUrl` and optional `lastCapturedAt`. Games with live screenshots exclusively outside the requested scope are omitted; empty games appear in their creation scope. Counts, capture time and covers exclude trash and follow effective hiding.

`POST /api/games` creates a game from `name` and optional `steamAppId`. At least one must be nonempty; Steam IDs are canonical positive unsigned 32-bit decimal strings and globally unique. An already registered Steam ID returns HTTP 409 rather than changing its name. `PATCH /api/games/{id}` edits `name` for a game available in the request scope. Its Steam identity remains unchanged; non-Steam games require a nonempty name.

Single and batch asset patches accept `screenshot`, `gameId` and `capturedAt` for static images and videos, applied atomically with the existing metadata patch. `screenshot:true` without `gameId` automatically classifies new or explicitly re-enabled members from original/source filenames; unrecognized names remain unassigned. Capture time prefers valid Steam filenames, then the earliest valid embedded capture, creation or modification timestamp, and remains unknown when neither supplies a valid timestamp. Already enabled members preserve their game, time and source. An accompanying `capturedAt` overrides only the time after classification.

Setting `gameId` or `capturedAt` explicitly enables classification. An empty `gameId` removes only the game association, and an empty `capturedAt` marks time unknown. `screenshot:false` disables classification and clears game/time while retaining a manual opt-out. With omitted `capturedAt`, explicit single/batch game assignment preserves time for already enabled members and infers it for new or explicitly re-enabled members. Reimporting identical bytes never overwrites existing screenshot metadata or a manual opt-out. Classification makes an asset organized and excludes it from `screenshot=0`; disabling it returns the asset to ordinary material and, when it has no tags or collections, to the inbox.

## Resumable Uploads

Uploads use raw bytes, not base64 or multipart encoding. A session is identified by the complete file SHA-256 and accepts a positive file size up to 1 TiB. Accepted extensions cover common still images, SVG/ICO, animated GIF/WebP/APNG and common video containers; preview support depends on installed decoders. Upload acceptance does not promise that every original codec is browser-playable.

1. Incrementally calculate the file SHA-256 without loading the whole original into browser memory.
2. Prepare or resume using `POST /api/uploads` with the complete expected size and source hints.
3. Send bounded chunks from the server's acknowledged offset.
4. Complete with `POST /api/uploads/{id}/complete`; the server verifies the complete file before publishing it.

Preparation body:

```json
{
  "hash": "<complete-lowercase-sha256>",
  "name": "wallpaper.png",
  "size": 123456,
  "mime": "image/png",
  "scope": "normal",
  "tagIds": [],
  "collectionIds": []
}
```

The filename is treated as a basename. `scope` defaults to the request query scope when omitted; it determines only the default hidden flag for a newly committed asset. Optional memberships are applied to the collected asset. Preparation returns `id`, `offset`, `size`, `complete` and `chunkSize`; complete results also include `assetId`. An existing byte-identical asset with its original present returns `complete:true` and `duplicate:true`, records new source observations/memberships and preserves its existing manual flags, metadata and trash state.

Optional `gameId` or `screenshot:true` explicitly targets game screenshots, including video recordings. Only uploads with that target recognize PNG/JPEG or supported video basenames matching `<Steam-app-id>_<YYYYMMDDHHmmss>_<numeric-suffix>.<extension>` and supply a game plus valid local capture time. Matching IDs reuse existing games or create a game for a new ID; unmatched names enter unassigned game media and use the earliest valid embedded capture, creation or modification timestamp for time. Metadata never overrides a valid Steam timestamp; unavailable or invalid metadata leaves time unknown. Capture timestamps retain their recorded wall clock without timezone conversion; server filesystem and collection dates are not fallbacks. An explicit game target takes precedence for game assignment, not time inference. Uploads without either target remain ordinary material even with matching Steam names; without tags/collections they enter the inbox. Existing screenshot metadata remains unchanged on duplicate preparation or original repair.

`GET /api/uploads/{id}` is the authoritative upload status. `PUT /api/uploads/{id}` sends `Content-Type: application/octet-stream` and an integer `Upload-Offset` header; an `offset` query parameter is accepted when the header is absent. Each body must fit both the advertised 128 MiB maximum and the remaining original length.

After flushing accepted bytes and committing the durable offset, PUT returns `{"offset":<next-byte>}` and the same value in `Upload-Offset`. An offset conflict returns HTTP 409 with the accepted offset. Only successfully received and flushed chunks advance that offset; unacknowledged tails are truncated before continuation. Read status after any uncertain response and resume from its offset. Do not advance solely from a browser's transmitted-byte counter.

Chunk body reads have a 600-second absolute deadline. The browser allows 660 seconds per PUT; Curio's Nginx upstream read/send timeouts are 660-second idle timeouts. The shared HTTP/2 receive window remains 4 MiB and the application request limit is 129 MiB. These values control different stages and do not impose a byte-per-second cap.

Completion verifies both total size and server-computed SHA-256. HTTP 422 indicates a hash mismatch and resets the partial upload for a fresh transfer. A successful commit leaves the immutable original available and queues derived processing; preview completion is separate. Repeating completion of an already committed original is safe. A cataloged but missing original can be repaired by reselecting and uploading the matching source while preserving its existing catalog identity and flags; malformed existing objects are never overwritten.

## Media and Downloads

`GET /media/{id}/{kind}` serves `thumbnail`, `preview`, `original` or the video-only `source`, with ordinary HEAD and Range support. Thumbnails are static; animations use their original playback resources. A video's legacy `preview` URL redirects to its HLS playlist rather than reading a persistent MP4. The `source` route serves unchanged video bytes with the descriptor's probed MP4 or WebM MIME type. SVG originals are attachment downloads, never executable inline views. `GET /api/assets/{id}/download` downloads the exact original bytes with the stored original filename.

`GET /api/playback/{id}` returns `{source?:{url,mime,codecs?},stream:{url,mime},duration,frameRate?,fallbackError?}` for an immutable video original. Native `source` eligibility requires an absolute start timestamp at most 1 ms. MP4/MOV video must be H.264 tagged `avc1`/`avc3` with Baseline, Constrained Baseline, Main or High profile and 8-bit 4:2:0 pixels (`yuv420p` or full-range `yuvj420p`), or HEVC tagged `hvc1`/`hev1` with Main or Main 10 profile. Its first audio stream, if present, must be AAC-LC or signed 16-bit little-endian PCM (`pcm_s16le`); only AAC sources advertise `mp4a.40.2`. Declared and probed WebM can use VP8, VP9 or AV1 video with no audio or Opus/Vorbis audio. Other sources retain the normalized compatibility timeline.

The browser tries `source` if either its MIME/codec hint or its container MIME is accepted. It falls back after an actual playback failure or loaded metadata with zero video width, which can otherwise leave only audio playing. These hints do not guarantee video or audio support on every device. `fallbackError` explains when detected alpha prevents an opaque compatibility fallback. Known media URLs keep the ordinary Portal authentication contract; normal/hidden modes do not create separate storage or access boundaries.

`GET` and `HEAD /media/{id}/stream/index.m3u8` describe the finite timeline without encoding it. `/media/{id}/stream/{segment}.ts` serves only the requested four-second H.264/AAC window, with a shorter final segment. Source orientation is applied to pixels, source frame rates are retained, and HDR uses the bounded BT.709 SDR conversion described in [Architecture](ARCHITECTURE.md#on-demand-video-playback). That fallback does not render Dolby Vision dynamic adjustments. A distant seek does not encode all preceding footage; native HLS may also request opening segments for metadata. Cold segment HEAD does not generate media. Successful cached responses expose `X-Curio-Playback-Engine`. Failures do not requeue whole-video processing or change accepted-original readiness.

`GET /api/download?ids=<comma-separated-asset-hashes>` streams an uncompressed ZIP containing 1-2000 selected originals without creating a server archive file. Duplicate filenames are disambiguated within the ZIP. These downloads do not export a complete recoverable catalog; full `nas` / `vps` backup and recovery remain server-operations agent responsibilities.
