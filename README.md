# Curio

Curio is a personal visual collection library for icons, avatars, wallpapers, game screenshots and recordings, animation, memes and other collected images or videos. Personal photos remain in Aura, and movie organization stays in the user's existing movie library.

The collection workflow is upload, review the inbox, organize with tags and collections, browse or search, then download the original for reuse. One file can belong to several collections without storing extra copies.

Normal and hidden modes use the same interface and catalog. A media item is effectively hidden when it has its own hidden flag, any associated hidden tag, or any associated hidden collection. New page loads start in normal mode; three consecutive `k` presses within 1.5 seconds switch modes. Hiding changes presentation, not storage or authentication.

The server is a locally built Go program with an embedded React frontend and an independent SQLite catalog. It preserves original bytes, supports durable resumable uploads, and generates separate thumbnails and playback previews. The application target is `nas`, protected by ServerPortal at `/curio/`; `ali` and `vps` are gateways to the same NAS data.

## Development

Use the Go version in `go.mod` and install locked frontend dependencies:

```sh
npm --prefix web ci
make build
bin/curio init --data .local/dev-data
bin/curio serve --data .local/dev-data --listen 127.0.0.1:18088
```

`init` creates a new empty library and refuses an existing catalog. `serve` and `check` require an existing catalog. Media processing uses libvips, ExifTool and FFmpeg; JPEG and video GPU acceleration is selected where available, with CPU compatibility fallbacks.

## Maintenance

Read [AGENTS.md](AGENTS.md) and [the documentation index](docs/README.md). [Operations](docs/OPERATIONS.md) owns runtime, deployment and recovery contracts; [Architecture](docs/ARCHITECTURE.md) explains media and visibility data flow; [API](docs/API.md) documents integrations.

GitHub stores source and configuration only. Real media, catalogs, credentials and backups are never committed. Builds and server releases run locally; no GitHub deployment workflow is required.
