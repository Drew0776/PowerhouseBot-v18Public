#!/bin/sh
# Runs the server as the unprivileged "node" user. The container starts as
# root only to hand /data (the SQLite volume) to that user: volumes mounted
# by Docker or Railway are usually root-owned. If /data still isn't writable
# afterwards, the server runs as root rather than failing to save its data.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data 2>/dev/null || true
  if su-exec node test -w /data; then
    exec su-exec node "$@"
  fi
  echo "warning: /data is not writable by the node user; running as root" >&2
fi
exec "$@"
