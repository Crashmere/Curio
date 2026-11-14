# API

Curio is mounted at `/curio/` on `nas`; `ali` and `vps` forward the same application. The routes below are application-relative: a browser calls `/curio/api/assets`, while a loopback check can call `http://127.0.0.1:18088/api/assets`. Business requests use the existing ServerPortal device cookie; Curio adds no second authentication system.

JSON responses are not cached. Errors use `{"error":"message"}` with an appropriate HTTP status. JSON control requests are limited to 1 MiB. Media IDs are stable complete lowercase SHA-256 upload fingerprints, not necessarily current object hashes after lossless video normalization; tag, collection and group IDs are generated lowercase 32-character hexadecimal identifiers. Source links must be HTTP or HTTPS URLs.

Hashed JavaScript and CSS have locally built identity and gzip representations. Static responses negotiate `Accept-Encoding`, respect explicit `gzip;q=0`, and expose `Vary: Accept-Encoding` with the existing immutable cache policy. Media and brand icons retain their own unchanged response contracts and authentication rules.

## Shared Query Scope

Browsing requests accept `scope=normal` or `scope=hidden`; omitted or unrecognized values use normal scope. Effective hiding is the logical OR of the media's own hidden flag, any associated hidden tag and any associated hidden collection. Normal selects its complement; hidden selects effectively hidden media.

The same endpoints serve both scopes. Counts, search, tags, collection covers, inbox, stars, trash and jobs use the common scope predicate. Hiding is a display rule, not an authorization boundary; already known media and download URLs retain ordinary Portal authentication without a separate scope check.

## Browsing and Metadata

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database connection health, with `status: "ok"` and service name |
| `GET /api/info` | Name, version, chunk maximum, effective `workers`, `gpuSlots`, `cpuOperations` and scoped `total`, `starred`, `unorganized`, `trash`, `queued`, `errors` and `bytes` |
| `GET /api/assets` | `items`, filtered `total` and nullable `nextOffset` |
| `GET /api/assets/{id}` | Scoped asset details, memberships and hidden reasons |
| `GET /api/tags` | Scoped tag `items`, counts and covers |
| `GET /api/collections` | Scoped collection `items`, counts, covers and `pinned` flags |
| `GET /api/games` | Scoped game `items`, screenshot counts, latest capture time and covers |
| `GET /api/jobs` | Scoped processing/deletion tasks as `items`, `total` and nullable `nextOffset`, with stage, engine, progress and error |
| `GET /api/uploads` | Up to 120 incomplete uploads, filtered by upload scope and associated hidden tags/collections, including cleanup state and retained destinations |

Jobs accept `limit` (default 120, maximum 240), `offset` and optional `status=active|error|ready`. Active selects queued, processing and deleting tasks. Error includes failed processing and deletion tasks with a recorded error. Unfinished and failed tasks precede completed history; completed records retain the existing 24-hour window. The browser requests each filter from the server and follows `nextOffset` instead of filtering a truncated history locally.

An asset includes `id`, original `name`, editable `title`, `notes`, `sourceUrl`, `author`, `kind`, `format`, `mime`, `size`, `width`, `height`, `duration`, `hasAlpha`, `hidden`, `effectiveHidden`, `hiddenReasons`, `organized`, `starred`, `trashedAt`, timestamps, processing fields, `tags`, `collections` and media/download URLs. `hidden` is only its own flag; `effectiveHidden` includes membership inheritance. Each hidden reason identifies its `kind`, `id` and `name`. `organized` is read-only and true when the asset has a tag, collection or enabled screenshot classification, including hidden containers and unassigned game media. The `unorganized` filter and count use the opposite predicate within the requested scope.

`contentHash` and `size` describe the current stored object. `normalized:true` indicates a losslessly replaced MP4 container; `id` remains the original upload fingerprint and all references use that stable ID. The original and current hashes both resolve for upload deduplication. Normalization changes byte layout, not encoded video/audio samples or logical movie metadata; downloads no longer promise the discarded original container bytes.

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

Optional `preserveCollectionGroups: {"collectionId":"<source-collection-id>","groupIds":["<source-group-id>"]}` copies selected source groups into `addCollectionIds` in the same transaction. It requires at least one added collection, disallows `collectionIds` replacement and rejects collections present in both additions and removals. The browser supplies groups whose displayed members are all selected. Only selected live members in the request scope are copied; other members and groups remain unchanged. Each source group must have at least one such member. Names and saved covers among selected members are captured before source membership removals. Destination groups get independent IDs. An existing group containing only copied members can be completed or reused without changing its name or cover; groups containing unrelated members or splitting the selection return HTTP 400 and roll back all changes. Repeated additions reuse compatible groups while the source remains available. Omitting this field retains ordinary membership-only behavior.

Both container types use the same contract:

| Method and path | Behavior |
| --- | --- |
| `POST /api/tags` or `/api/collections` | Create using required `name` and optional `hidden`; omission defaults to the request scope |
| `PATCH /api/tags/{id}` or `/api/collections/{id}` | Change `name`, `hidden`, or both |
| `DELETE /api/tags/{id}` or `/api/collections/{id}` | Delete only the container and membership links, preserving assets and originals |

Tag names are globally case-insensitive unique. Creating an existing same-visibility tag can reuse its ID; visibility is not changed by that reuse. Collection names do not identify physical storage or duplicate originals.

Collections additionally accept optional boolean `pinned` in POST and PATCH and return it in container responses and asset memberships. POST defaults to false; omitting it from PATCH preserves the existing value. `PATCH /api/collections/{id}` with `{"pinned":true}` pins the sidebar shortcut, and false removes that shortcut without deleting the collection. Pinning is shared across devices and scopes and does not change names, hidden flags, counts, media or memberships. Collection lists include both pinned and unpinned items; the browser filters only individual sidebar shortcuts. Tags return `pinned:false` and reject pin input.

Collection creation additionally accepts optional `groupId` to place the new collection into an existing collection-index group. Group validation, collection creation, membership, appended global order and the layout revision commit together. A deleted target returns HTTP 409 with `code: "collection_group_missing"` without creating a collection. The new collection's default hidden flag still follows the request scope, independently of the group's presentation scope. Tags and container PATCH requests reject `groupId`; move existing collections through the layout API.

`POST /api/assets/retry` takes `{"ids":["<asset-sha256>"]}` and requeues media processing, including eligible lossless normalization. `POST /api/assets/purge` takes the same selection plus `confirm:true`, accepts only trash assets and returns HTTP 202 after persisting the selected cleanup intent. Cleanup resumes after interruption and retains objects referenced by another asset; it does not affect unrelated media or existing backups.

### Collection Index Groups

Collection-index groups organize collection cards, separately from the media groups inside individual collections. Their layout is shared across devices and both visibility scopes:

```json
{
  "revision": 1,
  "groups": [{"id": "<group-id>", "name": "Wallpapers", "scope": "normal", "collectionIds": ["<collection-id>"]}],
  "collectionOrder": ["<every-live-collection-id>"]
}
```

`GET /api/collection-groups` returns this global layout without filtering out hidden collections. The browser projects membership and order against its scoped collection list, preserving the complete backing configuration on writes. A group appears when its creation `scope` matches the active scope or it contains an available collection. Group scope does not hide collections or media. With no saved layout, GET returns revision zero, empty groups and alphabetical collection order without writing settings.

`PUT /api/collection-groups` requires `baseRevision` and the complete `groups` array. Optional `collectionOrder` must contain every live collection ID exactly once, including hidden, grouped and ungrouped collections; omission preserves the current effective order. Group IDs are 32 lowercase hexadecimal characters. Names are trimmed, case-sensitive unique, limited to 80 Unicode characters and cannot be empty or use the reserved name `未分组`. At most 200 groups are allowed. Every group declares `scope: "normal" | "hidden"`; each collection can belong to only one group. Group-array order controls section order, and `collectionOrder` controls card order within each section.

Membership, order and the incremented revision commit atomically as JSON under the `collection_groups` key in `catalog_settings`. A stale revision returns HTTP 409 with `code: "collection_groups_changed"` and the current `revision`; invalid membership or order returns HTTP 400 without changing the layout. Removing a group only ungroups its collections. Collection creation appends to a saved order; collection deletion removes its layout membership and order entry. Both changes advance an existing layout's revision in the same collection transaction. Readers omit IDs deleted by an older program and append previously unknown collection IDs alphabetically without writing.

### Collection Media Groups

Groups have optional names and are local to one collection. Each media item can belong to one group in that collection, independently of its grouping in other collections.

| Method and path | Behavior |
| --- | --- |
| `GET /api/collections/{id}/groups` | `items` containing group `id`, `name` and ordered `assetIds`; applies the media list's scope, search, filters and sorting before forming groups, without pagination |
| `POST /api/collections/{id}/groups` | Create with `{"ids":["<asset-sha256>","<asset-sha256>"],"name":"optional name"}`; ignores media already grouped in this collection, requires at least two remaining distinct media and returns `{"id":"<group-id>"}` |
| `PATCH /api/collections/{id}/groups/{group}` | Edit `name` and/or incrementally change members using `addIds` and `removeIds` |
| `PATCH /api/collections/{id}/groups` | Remove selected media from any groups in this collection using `removeIds` |
| `DELETE /api/collections/{id}/groups/{group}` | Dissolve the entire group, preserving media, collection memberships, metadata and originals |

Group edits accept up to 2000 media per request and validate live membership in the collection and requested scope atomically. Creation checks existing group links in that same transaction and returns HTTP 400 without changing groups when fewer than two distinct ungrouped media remain. Adding media to an existing group with `PATCH` moves only those selected media from other groups in the same collection. A group's matched subset can contain one media after filtering or visibility changes. Groups with no matching live members are omitted from browsing; groups with no remaining membership links are removed during group edits.

Names are trimmed and limited to 80 Unicode characters. An omitted creation name defaults to empty; an omitted patch name preserves the existing name, while an empty name clears it. Name-only edits preserve members and do not clean up other groups. A group's name is shared across its scoped subsets and does not change member search or visibility.

Fetch a group's media through `GET /api/assets?collection=<id>&group=<group-id>` with the same scope and filters. Group membership survives trash and restore, but removing a collection membership removes its group link. Replacing `collectionIds` retains group links for collections that remain present.

### Selected Container Covers

The media viewer's `设为封面` menu offers `分组封面` and `收藏集封面`. A category is disabled when the live media has no corresponding membership. One target saves immediately; multiple targets open a compact target list. Groups are the media groups within collections, and their choices include the owning collection name.

`GET /api/assets/{id}/cover-targets?scope=normal|hidden` returns `groups` and `collections` arrays for one live media in the requested scope. Each target includes `id`, `name` and `selected`, indicating whether this media is its saved cover. Group targets also include `collectionId` and `collectionName`. Trash and unavailable media return HTTP 404.

`PATCH /api/assets/{id}/container-cover?scope=normal|hidden` accepts `{"kind":"group|collection","targetId":"<target-id>"}`. It validates live scoped media and membership and saves the reference atomically; an invalid or removed target returns HTTP 400. Images, animations and videos use the same contract. A video reference resolves to its current selected frame, or its default thumbnail when no frame is selected, with the current cover revision in the URL.

Collection responses prefer the saved member when it has a thumbnail and is live in the requested scope, otherwise retain the newest available thumbnail. Media group responses add `coverAssetId` and `coverUrl`, selecting the saved member when it matches the current scope and filters, otherwise the first matching member in the requested sort order. This does not reorder `assetIds` or alter gallery anchors. Moving a selected member to trash or another scope temporarily uses the fallback; restoring it makes its selection eligible again. Removing its membership, moving it to another group, dissolving its group or deleting its container clears that reference. Other memberships, media and originals are preserved.

### Game Screenshots

Assets additionally expose `screenshot`, `capturedAt`, optional `screenshotSource` (`steam` or `manual`) and optional `game` with `id`, `name` and `steamAppId`. `capturedAt` is either empty or a timezone-free `YYYY-MM-DDTHH:mm:ss` local time; it is not a UTC instant. `GET /api/info` adds the scoped live `screenshots` count. Keyword searches also match associated game names and Steam App IDs.

`GET /api/games` returns `items` with `id`, `name`, `steamAppId`, `count`, optional `coverUrl`, optional `lastCapturedAt` and optional `pinyin`, ordered by `lastCapturedAt` descending. `pinyin` supplies space-separated matching units for the name and Steam ID: each Han character has slash-separated alternate toneless readings, and each ASCII word is one unit. The browser supports full pinyin, initials and mixed syllable prefixes. Games without a known capture time appear last; ties use the case-insensitive game name or Steam App ID, then game ID. Games with live screenshots exclusively outside the requested scope are omitted; empty games appear in their creation scope. Counts, capture time and covers exclude trash and follow effective hiding.

`POST /api/games` creates a game from `name` and optional `steamAppId`. At least one must be nonempty; Steam IDs are canonical positive unsigned 32-bit decimal strings and globally unique. An already registered Steam ID returns HTTP 409 rather than changing its name. `PATCH /api/games/{id}` edits `name` for a game available in the request scope. Its Steam identity remains unchanged; non-Steam games require a nonempty name.

`DELETE /api/games/{id}` requires `{"confirm":true}` and a game available in the request scope. It atomically deletes the shared game registry entry and clears all of its screenshot associations across both scopes, including trash. Media retain their screenshot classification, capture times, hidden state, originals and other memberships; detached associations have manual provenance. Live members appear in unassigned game media in their existing scope. A later new Steam upload may recreate the game, while exact-byte reimports preserve existing unassigned metadata.

Single and batch asset patches accept `screenshot`, `gameId` and `capturedAt` for static images and videos, applied atomically with the existing metadata patch. `screenshot:true` without `gameId` automatically classifies new or explicitly re-enabled members from original/source filenames; names without a recognized game identity remain unassigned. Capture time prefers valid Steam filenames, then generic filename timestamps, then the earliest valid embedded capture, creation or modification timestamp, then the source modification time retained at upload. Generic recognition accepts a fourteen-digit `YYYYMMDDHHmmss` token preceded by `_` and followed by `_` or the filename stem's end, or a non-digit-bounded `YYYY-MM-DD HH-mm-ss` / `YYYY-MM-DD-HH-mm-ss` token. It supplies time without inferring a game and checks original/source names in their existing order, trying compact tokens before separated tokens within each name. Invalid dates and partial or longer digit runs are rejected; time remains unknown when no valid source exists. Already enabled members preserve their game, time and source. An accompanying `capturedAt` overrides only the time after classification.

Setting `gameId` or `capturedAt` explicitly enables classification. An empty `gameId` removes only the game association, and an empty `capturedAt` marks time unknown. `screenshot:false` disables classification and clears game/time while retaining a manual opt-out. With omitted `capturedAt`, explicit single/batch game assignment preserves time for already enabled members and infers it for new or explicitly re-enabled members. Reimporting identical bytes never overwrites existing screenshot metadata or a manual opt-out. Classification makes an asset organized and excludes it from `screenshot=0`; disabling it returns the asset to ordinary material and, when it has no tags or collections, to the inbox.

Disabling classification remains permitted for an animation that was previously classified as a screenshot. Enabling classification or assigning game/time still requires a static image or video. When processing detects that an extension-classified image is actually animated, it clears its screenshot classification in the same transaction as the kind correction; existing already-animated rows are not rewritten at startup.

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
  "fileModifiedAt": "2025-11-22T22:42:05",
  "scope": "normal",
  "tagIds": [],
  "collectionIds": []
}
```

The filename is treated as a basename. `scope` defaults to the request query scope when omitted; it determines only the default hidden flag for a newly committed asset. Optional memberships are applied to the collected asset. Preparation returns `id`, `offset`, `size`, `complete` and `chunkSize`; complete results also include stable `assetId` and current `effectiveHidden`. `id` remains the requested upload fingerprint and `size` remains that fingerprint's expected file length, even when canonical storage has a different size. An existing source or canonical fingerprint with its current object present returns `complete:true` and `duplicate:true`, records new source observations/memberships and preserves manual flags, metadata and trash state. A separately cataloged exact-byte asset takes precedence over a canonical alias. Duplicate responses expose `existingHidden`, `existingManualHidden` and `trashed`. Repeated completion reports the same current diagnostics.

Optional `fileModifiedAt` retains the source device's modification time as a valid, timezone-free `YYYY-MM-DDTHH:mm:ss` value. Browser file/folder selection and external drops derive it from `File.lastModified`; clipboard uploads omit it. It is retained in upload hints, including after completion, and an existing session's value survives resume. Browser file APIs do not expose filesystem creation time. Invalid supplied modification times return HTTP 400.

Optional `gameId` or `screenshot:true` explicitly targets game screenshots, including video recordings. Only uploads with that target recognize PNG/JPEG or supported video basenames matching `<Steam-app-id>_<YYYYMMDDHHmmss>_<numeric-suffix>.<extension>` and supply a game plus valid local capture time. Matching IDs reuse existing games or create a game for a new ID; unmatched names enter unassigned game media. Capture-time inference follows the same filename, embedded metadata and retained source modification-time precedence as asset classification. Capture timestamps retain their recorded wall clock without server/browser timezone conversion; server filesystem and collection dates are not fallbacks. An explicit game target takes precedence for game assignment, not time inference. Uploads without either target remain ordinary material even with matching Steam names; without tags/collections they enter the inbox. Existing screenshot metadata remains unchanged on duplicate preparation or original repair.

`GET /api/uploads/{id}` is the authoritative upload status. `PUT /api/uploads/{id}` sends `Content-Type: application/octet-stream` and an integer `Upload-Offset` header; an `offset` query parameter is accepted when the header is absent. Each body must fit both the advertised 128 MiB maximum and the remaining original length.

After flushing accepted bytes and committing the durable offset, PUT returns `{"offset":<next-byte>}` and the same value in `Upload-Offset`. An offset conflict returns HTTP 409 with the accepted offset. Only successfully received and flushed chunks advance that offset; unacknowledged tails are truncated before continuation. Read status after any uncertain response and resume from its offset. Do not advance solely from a browser's transmitted-byte counter.

Chunk body reads have a 600-second absolute deadline. The browser allows 660 seconds per PUT; Curio's Nginx upstream read/send timeouts are 660-second idle timeouts. The shared HTTP/2 receive window remains 4 MiB and the application request limit is 129 MiB. These values control different stages and do not impose a byte-per-second cap.

Completion verifies total size and server-computed SHA-256. HTTP 422 indicates a hash mismatch and resets the partial upload. A successful commit stores the source and queues media processing; processing completion is separate. Eligible MP4s normalize before thumbnails and readiness, publishing a new hash-addressed object and deleting the obsolete source after validation and mapping commit. Failure retains the source and a retryable error. Repeating completion is safe. Missing canonical storage can be repaired by uploading either matching source bytes or matching canonical bytes while preserving catalog identity and flags; malformed existing objects are never overwritten.

Incomplete upload rows include `state` (`uploading` or `discarding`), `tagIds`, `collectionIds`, `gameId` and `screenshot`. These hints retain the original upload scope even if a container later makes the upload effectively hidden. Resuming uses that stored scope and destinations, checks the selected file's SHA-256 before preparation, and keeps the queue row in the panel's presentation scope without changing the new asset's manual hidden default.

`DELETE /api/uploads/{id}?scope=normal|hidden` requires `{"confirm":true}` and discards only the selected incomplete upload. HTTP 200 returns `{"ok":true,"id":"<hash>"}`; repeating deletion of an absent session is safe. A completed session or cataloged original still present returns HTTP 409. A missing-original repair session may discard its partial bytes and upload record while retaining all catalog metadata and derivatives.

Cleanup persists `state:"discarding"` before removing bytes under the same per-hash lock as transfer and publication. Preparation, chunk writes and completion reject that pending state. If cleanup cannot finish immediately, HTTP 202 returns `{"ok":true,"id":"<hash>","pending":true,"error":"message"}`; the list retains the row and the worker resumes cleanup after interruption. An uncataloged object left by publication before a failed catalog transaction is removed only for that selected hash. No cataloged original, unrelated object or backup is removed by this endpoint. Clients stop active transfers for the selected hash before submitting it.

## Media and Downloads

`GET /media/{id}/{kind}` serves `thumbnail`, `preview` and `original`, plus video-only `source`, repaired `native` and selected `cover` resources, with HEAD and Range support. Thumbnails are static; animations retain original resources. A video's legacy `preview` redirects to HLS. `source`, `original` and downloads resolve current storage; normalized videos use the canonical MP4, while other media retain uploaded bytes. Canonical source URLs carry `revision=<contentHash>` and stale revisions return 404. Source/original/download ETags identify actual content bytes. A ready legacy `native` URL serves a separate verified repair with its own revision and ETag; HEAD/GET never creates it synchronously. SVG originals are attachment downloads. `GET /api/assets/{id}/download` retains the source filename but returns current stored bytes.

`GET /api/playback/{id}` returns `{source?:{url,mime,codecs?,audio?:{start,duration?}},stream:{url,mime},duration,frameRate?,fallbackError?}` for an immutable video original. Native `source` eligibility requires a movie/format start within 1 ms of zero and a video-track start relative to it between -1 ms and 250 ms. When the video-track duration is available, `duration` ends at that track's boundary relative to the movie origin; otherwise it uses the format duration. `audio.start`, exact-frame times and compatibility seeks use that same origin. The browser does not add the video-track lead to its native clock. MP4/MOV video must be H.264 tagged `avc1`/`avc3` with Baseline, Constrained Baseline, Main or High profile and 8-bit 4:2:0 pixels (`yuv420p` or full-range `yuvj420p`), or HEVC tagged `hvc1`/`hev1` with Main or Main 10 profile. Its first audio stream, if present, must be AAC-LC or signed 16-bit little-endian PCM (`pcm_s16le`); only AAC sources advertise `mp4a.40.2`. Declared and probed WebM can use VP8, VP9 or AV1 video with no audio or Opus/Vorbis audio. Other sources retain the normalized compatibility timeline.

Eligible MP4 uploads normalize before processing readiness, and explicitly selected existing videos can use the same module. Their descriptor supplies a revisioned canonical `source` with unchanged movie-relative timing and codec information. Playback discovery for older unnormalized inefficient layouts still queues a separate bounded repair and omits the costly source until ready, without deleting it. Normal layouts remain unchanged; no whole-catalog startup conversion occurs. [Operations](OPERATIONS.md#playback-and-runtime-cache) defines admission and persistence.

The browser tries an eligible `source` and lets the native decoder establish actual support. It falls back after an actual playback failure, loaded metadata with zero video width, or evidence that an expected audio track is not decoded during unmuted playback. Initial play or paused-frame loading without a first frame falls back after five foreground seconds when compatible fallback is available; preparation without a load request, explicit suspension, background time and rejected autoplay do not trigger it. Buffered, started playback with a source clock unchanged for three seconds retains a separate clock check; loading, seeking, pauses and background playback outside picture-in-picture do not trigger that check. Failed native URLs are remembered independently, so a new repaired revision remains eligible. The last 30 media events, native source URL and startup budget remain in browser memory for the viewer's `播放诊断` panel. These hints do not guarantee video or audio support on every device. `fallbackError` explains when detected alpha prevents an opaque compatibility fallback. Known media URLs keep the ordinary Portal authentication contract; normal/hidden modes do not create separate storage or access boundaries.

`GET` and `HEAD /media/{id}/stream/index.m3u8?timeline=s2` describe the finite timeline without encoding it. The descriptor selects this two-second timeline, and `/media/{id}/stream/{segment}.ts?timeline=s2` serves each requested H.264/AAC window, with a shorter final segment. Descriptor and generated segment URLs also carry a `recipe` cache-version parameter so revised encoding timestamps do not reuse previous browser-cached segments. Omitting `timeline` retains the legacy four-second timeline and distinct cache keys for older cached playlists. Unknown or repeated timeline values return 400. Source orientation is applied to pixels, source frame rates are retained, and HDR uses the bounded BT.709 SDR conversion described in [Architecture](ARCHITECTURE.md#on-demand-video-playback). That fallback does not render Dolby Vision dynamic adjustments. A distant seek does not encode all preceding footage; native HLS may also request opening segments for metadata. Cold segment HEAD does not generate media. Successful cached responses expose `X-Curio-Playback-Engine`. Failures do not requeue whole-video processing or change accepted-original readiness.

### Video Covers

`PATCH /api/assets/{id}/cover?scope=normal|hidden` saves `{"time":<seconds>,"expectedCover":"<current-revision-or-empty>"}`; `time:null` restores the default thumbnail. The response is the scoped updated asset. The asset's optional `cover` contains the actual original-frame `time`, generated `revision`, oriented `width` and `height`, and image `format` (`jpg` or `png`). A stale expected revision returns 409 `cover_changed`; invalid times return 400, and unavailable or wrong-scope assets return 404. Source timestamps resolve the frame containing the requested moment, including variable-frame-rate recordings.

`GET /api/assets/{id}/frame?time=<seconds>&size=thumb|preview` reads an exact original-frame image bounded to 640 or 2560 pixels; omitted size selects preview. These read-only requests retain ordinary media authentication and are not scope restricted. Native display orientation and SDR conversion are applied; detected alpha is retained in PNG rather than flattened to JPEG. Exact frames have an 8 MiB output bound and a five-minute deadline, with two active extractors and priority for large previews.

`GET /api/assets/{id}/frames` returns `{revision,duration,width,height,frames:[{time,x,y,width,height}]}` for 5-15 candidate frames. The matching `?image=<revision>` serves the PNG atlas; a changed atlas revision returns 409. Videos up to 60 seconds use one selected-frame decoding pass. Longer SDR GPU jobs batch up to three seek-local inputs per FFmpeg process, bounded by one 4K frame's aggregate source pixels; CPU and HDR extraction remain single-input. Completed imports warm this rebuildable atlas independently of original acceptance. One atlas generator runs at a time, with at most two admitted atlas jobs. When its last waiter disconnects, an unfinished atlas job remains joinable for three seconds before cancellation; deletion and shutdown bypass this grace. Browser leases bound decoded atlas memory to six unused entries or 24 MiB.

The selected thumbnail URL includes `?cover=<revision>`; `GET /media/{id}/cover` serves its larger still preview. Cards, game folders, tags and collections use the selected thumbnail. Video thumbnail and cover responses are not cached, and old explicit revisions are rejected after replacement or reset. Missing selected images regenerate from the catalog selection and unchanged original. Resetting never removes the canonical default thumbnail; ordinary media retries preserve the selection. Confirmed permanent deletion cancels and drains all selected frame/publication work and removes that asset's catalog selection and derivatives.

### Original Downloads

`POST /api/download` streams an uncompressed ZIP containing 1-2000 selected originals. It accepts JSON `{"ids":["<hash>"]}` or an `application/x-www-form-urlencoded` body with `ids=<comma-separated-hashes>`, both limited to 1 MiB. The browser uses a native POST download targeted at a hidden response frame, avoiding request-line limits and a whole-ZIP browser Blob; errors remain visible without navigating away from the gallery. `GET /api/download?ids=<comma-separated-hashes>` remains compatible. Duplicate filenames are disambiguated within the ZIP, and no server archive file is created. These downloads do not export a complete recoverable catalog; full `nas` / `vps` backup and recovery remain server-operations agent responsibilities.
