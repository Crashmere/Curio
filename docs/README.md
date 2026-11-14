# Curio Documentation

Curio owns its visual collection, SHA-256 objects, tag and collection membership, upload state, lossless video normalization, media processing and browser interface. Images and unnormalized media retain uploaded bytes; eligible videos may retain an equivalent normalized container instead. ServerPortal owns shared device authentication, application discovery and read-only resource inspection. Full `nas` / `vps` backup and recovery belong to the server-operations agent.

Read [Architecture](ARCHITECTURE.md) for visibility, upload and processing data flow; [API](API.md) for browser and integration contracts; and [Operations](OPERATIONS.md) for runtime, installation, release and recovery.

The shared operational source is [server-operations](https://github.com/Crashmere/agent-config/tree/main/skills/server-operations). Remote entry points are `/opt/AGENTS.md`, `/opt/curio/AGENTS.md`, `/opt/curio/docs/README.md` and `/opt/server-context/`. Shared current-state owns activation and host roles; deployment files alone do not establish production activation.
