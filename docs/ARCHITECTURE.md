# Architecture

Curio keeps a single catalog and immutable original store. Tags and collections organize the same media rather than moving files between physical libraries. Normal and hidden modes differ only in query scope, so both modes share every browsing and editing feature.

## Collection and Visibility

An asset is identified by the SHA-256 of its uploaded bytes. The catalog records the original name, editable title and notes, source URL, author, media properties, organization status, star, trash state and processing progress. Many-to-many memberships associate an asset with tags and collections. Global byte-identical deduplication reuses the asset and preserves new source observations without changing its existing manual hidden flag.

Effective hiding is the logical OR of an asset's own flag, any associated hidden tag and any associated hidden collection. Membership inheritance is computed at query time instead of being copied into the asset flag. Removing one hidden source reveals an asset only when no other hidden source remains. Asset details expose those sources as hidden reasons.

Normal scope contains only effectively non-hidden assets; hidden scope contains only effectively hidden assets. Lists, keyword search, inbox, stars, trash, jobs, membership counts and collection covers use the same scope predicate. Non-hidden containers can mix both kinds of assets and display the corresponding subset in each mode. A hidden container never appears in normal container choices.

The browser stores the selected mode only in memory. New loads and reloads start in normal mode; in-application navigation retains the mode. Three non-repeated consecutive `k` key presses within 1.5 seconds toggle it globally, including text fields. Composition and Ctrl/Command/Alt combinations do not count, and the shortcut does not swallow normal text input. Mode switches invalidate old view state and selection. Uploaded originals and known media URLs keep the ordinary shared device-authentication contract; hidden mode adds no access-control layer.

## Durable Uploads

The browser uses at most two file lanes, each with an independent cancellation controller and a hash worker reused for that batch. Each file is hashed incrementally before preparing a session with its SHA-256 and expected size. Files with the same hash serialize preparation and transfer so a later duplicate can reuse the first committed original. Different files can upload concurrently; each file sends its chunks in order, bounded by the advertised server maximum of 128 MiB.

Each chunk includes its intended offset; the server serializes work per hash and reports the authoritative durable offset after flushing accepted bytes. Sent-byte events animate the browser's progress bar but never advance its resume offset. An interrupted or uncertain request is recovered by reading server status and resuming from that offset. Pause cancels both lanes, including hashing, status requests and retry delays; resume reacquires authoritative offsets. The browser shows a separate complete-file verification phase and reaches 100 percent only after the server confirms publication. Workers are terminated when a batch stops. Upload-triggered gallery refreshes are coalesced to once per second and flushed at batch completion; the unfinished-upload list refreshes on panel opening and batch lifecycle changes.

Final completion checks the entire uploaded size and server-computed SHA-256 before publishing the immutable original and catalog entry. Upload acceptance is separate from preview readiness: the original can be stored while a durable media task is still queued or running. Preparation detects global exact duplicates; it does not silently move an existing asset between visibility modes.

New assets default to the upload scope's hidden flag. Original objects live under hash prefixes, incoming files retain acknowledged partial content, and preview derivatives use separate paths. Total original size is independent of the per-request chunk ceiling.

The shared `nas`, `ali` and `vps` Nginx servers retain the existing 4 MiB HTTP/2 receive window. Curio's location disables request buffering and allows a 129 MiB request body. The window, chunk maximum and request deadline control different stages; none is a configured throughput cap. Large home imports should use the direct NAS LAN entrance.

## Media Processing

Durable asset status drives a bounded background queue. NAS runs two processing jobs and permits one Curio GPU operation at a time, below ordinary service priority. CPU media operations share a two-slot budget, with one slot reserved from background processing for online playback. Metadata extraction, native decoding, resizing and encoding write only Curio derivatives and work files. Worker failure records an error for retry rather than invalidating the accepted original; interrupted processing is requeued on restart.

Still-image previews preserve transparency. Animated GIF, WebP and APNG retain original animation for playback while the gallery uses a still thumbnail. SVGs use safe raster previews rendered at the thumbnail and viewer sizes while retaining their original logical dimensions; originals are downloads rather than executable inline documents. ICO decoding selects one frame before the ordinary image pipeline, avoiding repeated generic decoder delegation. Video imports generate metadata and a thumbnail, not a complete playback MP4; video readiness does not depend on an online cache.

On `nas`, JPEG processing uses Curio's embedded worker with the existing pinned NVIDIA image runtime selected by `CURIO_IMAGE_PYTHON`. Video processing probes FFmpeg CUDA/NVENC support, with software-decoded GPU and full CPU fallbacks. Transparent, animated, vector and fidelity-sensitive image paths retain explicit CPU fallbacks. Originals are never recompressed or rewritten by preview generation.

### On-Demand Video Playback

The viewer retains native controls, autoplay and posters, while selecting suitable MP4/MOV and WebM originals through a capability descriptor. Native eligibility includes full-range 8-bit H.264 and H.264/HEVC with PCM16 audio, while retaining the near-zero source-timestamp requirement. The browser tries an original when its codec hint or container MIME is supported; incomplete hints alone do not force transcoding. An actual playback failure, or metadata with no video dimensions, switches to HLS. Start timestamps outside the 1 ms native tolerance retain a normalized compatibility timeline. Supported transparent WebM uses its original; detected alpha streams are not flattened into opaque H.264 when native playback is unavailable. [API](API.md#media-and-downloads) defines native eligibility.

Compatibility playback uses a finite HLS playlist and request-triggered four-second H.264/AAC MPEG-TS segments. Native HLS browsers use their own pipeline; other supported browsers lazily load hls.js. A distant seek requests the target neighborhood rather than encoding all preceding footage; native HLS may request opening segments to discover metadata. Source orientation is applied to decoded pixels and source frame rates are retained. GPU-supported stages prefer CUDA/NVENC; software decoding and color normalization use bounded CPU fallbacks.

HDR compatibility output is BT.709 limited-range SDR. A bounded source-frame probe uses valid MaxCLL, falling back to mastering-display maximum luminance, before linearization removes that metadata. The explicit tone-map peak uses units of 100 nits, with fallback values of 100 for PQ and 10 for HLG. After full-resolution linearization, decoded frames are downsized to at most 1920 pixels per dimension before CPU float Mobius tone mapping; even dimensions and sample-aspect-ratio adjustment retain display proportions without enlarging smaller videos. This generic SDR conversion does not apply Dolby Vision RPU dynamic adjustments. Native playback can retain HDR on a capable browser and device instead. Shared diagnosis is documented in [Video playback and HDR tone mapping](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/common-issues.md#unnecessary-video-transcoding-and-hdr-tone-mapping).

Identical fragment requests share a cancellable job. Two generators and eight total queued/running playback jobs share a 256 MiB cache/reservation limit, with an 8 MiB segment output bound and a 75-second generation deadline. Idle entries expire after twenty minutes or are evicted under cache pressure. Pausing and leaving stop unnecessary MSE requests; native HLS controls its own look-ahead. Selected permanent deletion cancels, drains and evicts its playback work before unlinking; shutdown drains jobs before closing the catalog. NAS scratch uses private tmpfs under `/run/curio/playback`, separate from stored derivatives and recovery material.

## Deletion and Recovery

Moving to trash changes catalog state and is reversible. Permanent deletion accepts only explicitly confirmed selected trash assets. It persists cleanup intent before canceling selected processing and removing their live original, derivatives, work and catalog relationships. Interrupted cleanup resumes from that intent; unrelated assets and existing backups are not changed.

Recovery requires the complete independent catalog, originals, stored derivatives, durable partial uploads and work state. The server-operations full external workflow captures that state through Curio's Portal resource declaration. Downloadable runtimes remain reconstructable program dependencies outside the data recovery scope. Program rollback changes the executable, not the catalog or deleted media.
