# Curio Maintenance Entry Point

Curio is a personal visual collection library for images, animations, icons, wallpapers, screenshots and recordings. Personal photos remain in Aura; movie organization is outside this application. The application target is `nas`, at `/curio/` on loopback port 18088. ServerPortal owns shared device authentication and discovery; `ali` and `vps` are gateways to the same NAS state.

Read `docs/README.md`, then the relevant architecture, API and operations documents. Use server-operations and explicitly read each target's remote `/opt/AGENTS.md` before maintenance. Current activation is owned by server-operations current-state, not by the presence of deployment sources.

- Preserve uploaded bytes. Original SHA-256 addressed objects are immutable until explicitly confirmed permanent deletion of selected trash items. Metadata, thumbnails and playback derivatives are separate.
- Use one catalog and shared UI/API implementations for both modes. Normal scope excludes effectively hidden media; hidden scope contains effectively hidden media. Effective hiding is the logical OR of the media's own flag, any associated hidden tag and any associated hidden collection. Compute inheritance instead of writing it into the media flag.
- Apply scope consistently to lists, search, container memberships, counts, covers, metadata choices and trash. Hiding is presentation, not an additional authentication or encryption boundary. Storage, processing, deduplication and recovery treat both scopes identically.
- New page loads and reloads start in normal mode. SPA navigation retains the in-memory mode. Two consecutive `q` presses within 1.5 seconds toggle scope globally, including text fields; do not swallow text. Ignore repeated keydown events, IME composition and Ctrl/Command/Alt combinations.
- Long-press the sidebar Curio brand for 800 ms to toggle scope on touch, pen or mouse. A short press opens the home view; movement over 10 px or pointer cancellation cancels the hold. Suppress the click after a hold or drag and prevent native image dragging, selection and touch callouts on the brand.
- Block ordinary Tab/Shift+Tab focus traversal and remove focus-only decoration. Preserve composition, text input, modifier shortcuts, selections and carets.
- Keep upload and processing state durable. Accept at most 128 MiB per chunk, flush acknowledged bytes, recover from authoritative server offsets and verify the complete server SHA-256 before publishing an original. Total file size is not limited to one chunk.
- Global exact-byte deduplication must not silently change an existing item's manual hidden flag or discard its metadata and memberships.
- Preserve alpha and animation. Never execute uploaded SVG scripts; use safe generated previews and serve SVG originals as downloads. Prefer browser-playable video originals; compatibility playback uses bounded, request-generated segments, never eager whole-video copies.
- Prefer GPU processing where practical on `nas`, with bounded concurrency and explicit CPU fallbacks for unsupported codecs or fidelity-sensitive steps. Reuse installed media tools; do not introduce unneeded shared runtimes.
- Keep normal removal reversible. Confirm permanent deletion, persist exact cleanup intent and resume interrupted cleanup without touching unrelated originals, real backups or Aura data.
- Validate changed behavior locally with synthetic media and isolated data. Do not accumulate permanent tests or run a full historical regression suite by default.
- Build locally and use the shared restricted release, resource declaration, icon and documentation synchronization contracts. GitHub hosts source and configuration only, never runtime data, credentials or backups.
- Full NAS/VPS backup and recovery belong exclusively to the server-operations agent; do not add web backup controls or backup timers.
- Maintenance documents are English; product UI is Chinese. Keep comments concise and explain non-obvious constraints.

Remote entry points: `/opt/curio/AGENTS.md`, `/opt/curio/docs/README.md`, and `/opt/server-context/`.
