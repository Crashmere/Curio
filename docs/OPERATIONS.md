# Operations

Curio's application target is `nas`, at `/curio/` with loopback listener `127.0.0.1:18088`. `vps` provides primary public HTTPS 8443 and `ali` provides compatibility HTTPS 443; both gateways reach the same NAS instance. NAS LAN access uses its existing local-CA HTTPS entrance. ServerPortal device authentication protects business pages, APIs and media.

The runtime identity is `curio`; restricted local releases use `curio-deploy`. Source repository: `Crashmere/Curio` (public). Keep real addresses, credentials, originals, catalogs and backups outside Git. Shared current-state owns actual activation.

## Runtime and Data

| Path | Responsibility |
| --- | --- |
| `/opt/curio/bin/curio` | Locally built Go program with embedded frontend and image worker |
| `/opt/curio/bin/deploy-{ssh,release}.sh` | Root-maintained restricted publication entry points |
| `/opt/curio/config/` | Curio systemd unit, Nginx location, Portal declaration and source receipt |
| `/opt/curio/data/curio.sqlite` | Catalog, tags, collections, memberships, source observations, upload hints, jobs and deletion intent |
| `/opt/curio/data/assets/` | Immutable SHA-256 originals until confirmed permanent deletion |
| `/opt/curio/data/derived/` | Rebuildable still thumbnails, image previews and compatible playback derivatives |
| `/opt/curio/data/incoming/` | Durable acknowledged incomplete originals |
| `/opt/curio/data/work/` | Persistent media processing workspace |
| `/opt/curio/releases/` | Programs, hashes, publication results and rollback records |
| `/opt/curio/docs/` | Controlled documentation copies and provenance |

Go and Node are build dependencies on the maintenance computer only. Production reuses NAS's official Ubuntu libvips, ExifTool, FFmpeg and FFprobe tools. The service writes only to its private `data` directory, uses two processing jobs and one GPU slot, and applies bounded native thread pools with `TasksMax=1024`.

`CURIO_IMAGE_PYTHON=/opt/aura/bin/image-gpu/bin/python` selects Aura's existing root-owned, read-only, hash-pinned NVIDIA image environment. Curio embeds its own worker; it does not import Aura's catalog or original store. This runtime is a dependency of both applications and must remain available while either unit selects it. Follow Aura's `deploy/install-image-gpu.sh` and pinned `deploy/image-gpu-requirements.txt` to reconstruct it on a compatible Linux CPython 3.14 host, using the python-environment and software-installation skills. Never install its packages globally. A changed lock requires a new runtime directory and independent validation before updating both applications' selections.

Video work prefers FFmpeg CUDA/NVENC, with documented codec and CPU fallbacks. `CURIO_GPU=cpu` disables GPU work; changing the environment or worker limits requires only Curio's unit reload/restart. Verify representative GPU operations as `curio`, not only as root. The shared [NAS media policy](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/nas-host.md#media-processing-policy) owns driver/kernel alignment and host GPU limits.

## Upload and Browser Contract

Chunks contain at most 128 MiB of raw bytes. Curio flushes accepted bytes before acknowledging an offset and verifies complete server-side SHA-256 before committing an original. The Nginx location allows 129 MiB, disables request buffering and uses 660-second upstream idle timeouts. The client and server's absolute body deadlines remain defined by the upload API.

The shared HTTPS servers on `nas`, `ali` and `vps` keep `http2_body_preread_size 4m`; do not enlarge or replace shared server settings just to add Curio. See [Upload throughput and request limits](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/conventions.md#upload-throughput-and-request-limits) for full-path diagnosis. Relative URLs keep large LAN uploads on NAS instead of redirecting them through a public gateway.

Only exact anonymous GET/HEAD requests for `favicon.svg` and `apple-touch-icon.png` bypass Portal authentication. The opaque 180-by-180 PNG is generated from the retained graphics source by `scripts/icons.sh`. Business JavaScript, pages, APIs and uploaded media remain authenticated; no application `add_header` overrides shared cookie renewal. The UI blocks ordinary Tab/Shift+Tab focus traversal and suppresses focus-only decoration while preserving text input and modifier shortcuts.

Normal and hidden modes use the same data and recovery rules. New page loads default to normal; the current mode is not persisted. Hidden flags are catalog metadata, not a password or encryption boundary.

## Initial Installation

Use server-operations and explicitly read each target's `/opt/AGENTS.md`. Verify the complete application inventory and live port 18088 on `nas`, `ali` and `vps` before adding resources. Installation creates a new empty Curio catalog only; it refuses existing directories, units or identities and does not import user media.

Build from pushed committed source on the maintenance computer, transfer the verified Linux binary, `deploy/` and the existing NAS deployment public key into private NAS staging, then run as administrator:

```sh
bash deploy/install.sh ./curio-linux-amd64 ./nas-deploy-public-key.pub
```

The installer creates only Curio identities, private data, fixed scripts, systemd unit and application Nginx link. It verifies local health and gracefully reloads Nginx; it installs no build environment, backup timer or shared server replacement.

Gateway routing is shared infrastructure. Maintain `18088` in both gateways' `nas-tunnel` PermitListen and authorized-key listener restrictions. Reuse the existing shared `reverse-tunnel@.service` with separate `reverse-tunnel@curio-ali.service` and `reverse-tunnel@curio-vps.service` instances, whose root-managed `/etc/nas-tunnels/curio-{ali,vps}.conf` retain the corresponding existing identity and trusted host settings but forward only `127.0.0.1:18088` to NAS `127.0.0.1:18088`. Apply the existing fixed 30-second VPS retry policy to the Curio VPS instance. Do not restart existing application/management tunnels to add the new listener.

Install Curio's same application-owned Nginx location on `ali` and `vps`, validate syntax and reload gracefully. No new public port or TLS certificate is needed. Register `deploy/portal.json` through the restricted publication protocol, verify its loaded receipt, then synchronize Curio and changed shared documentation. Portal dynamically discovers the new declaration without restarting its processes.

## Release and Rollback

Validate only affected behavior locally with synthetic media and isolated data, commit and push `main`, then run:

```sh
make release
make deploy
```

The shared release driver exports the pushed commit, installs locked web dependencies, builds the static Linux amd64 program locally and records provenance under `.local/releases/<commit>/`. Deployment defaults to `nas` and the maintenance computer's NAS deployment key; public acceptance defaults to `vps` HTTPS 8443. A custom trusted SSH alias needs an explicit `RELEASE_KEY` and `RELEASE_PUBLIC_ORIGIN`; see [Local releases](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/release.md).

NAS releases hold the shared maintenance lock and Curio deployment lock, verify the uploaded binary, stop only Curio, run the candidate's read-only `check`, replace the program atomically and verify direct/proxied health. The default database protection selection is empty. Declare only an affected SQLite database when an authorized change can delete or overwrite its existing data; non-database files are never temporarily backed up. Failed protection is retained for agent review.

`make portal` publishes declaration-only changes without rebuilding or restarting. `make rollback COMMIT=<compatible-full-commit>` reuses a retained verified program through the same health and protection flow. Program, declaration and documentation provenance are separate: `current-commit`, `config/portal-source.json` and `docs/SOURCE` respectively. A program rollback does not restore data or undo permanent deletion.

## Backup, Recovery and Diagnosis

Full `nas` / `vps` backups and restoration are exclusively server-operations agent workflows. Curio's declaration covers all catalog tables, originals, stored derivatives, durable uploads and work. Include recovery-critical private configuration and identities through the shared full external package. Downloadable media runtimes and dependency caches are excluded and reconstructed from pinned sources; keep the live runtime intact. Do not add internal backup schedules or browser backup controls.

Select and verify a recovery point through the [agent backup and recovery runbook](https://github.com/Crashmere/agent-config/blob/main/skills/server-operations/references/backup-recovery.md), restore into an isolated path first and check the complete catalog and originals before confirming production replacement. Interrupted cleanup intents resume when the restored candidate runs; inspect them before accepting an older recovery point or restarting clients.

```sh
bin/curio check --data /path/to/isolated-data --full
ssh nas 'systemctl status curio'
ssh nas 'journalctl -u curio --since today'
ssh nas 'curl --fail http://127.0.0.1:18088/healthz'
```

Use the shared `view-tunnel.sh` for read-only production browsing. Upload, editing, deletion and restore checks use isolated synthetic data, never real user media. After deployment, run the shared icon check against direct HTML and the selected public entrance, and verify unauthorized business/media requests, Portal declaration activation, upload limits and representative Range behavior. Real-device Home Screen installation and Origin login remain separate user-device acceptance.
