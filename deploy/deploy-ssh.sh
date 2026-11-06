#!/usr/bin/env bash
set -euo pipefail
# The forced command accepts only Curio's fixed publication protocol.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  exec sudo -n /opt/curio/bin/deploy-release.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})\ ([A-Za-z0-9_-]+)$ ]]; then
  if [[ ${#BASH_REMATCH[3]} -gt 4096 ]]; then echo 'Database plan exceeds protocol limit.' >&2; exit 64; fi
  exec sudo -n /opt/curio/bin/deploy-release.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^(portal|portal-check)\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  exec sudo -n /opt/curio/bin/deploy-release.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
fi
printf 'Only deploy, portal-check or portal with a commit and SHA-256 are allowed.\n' >&2
exit 64
