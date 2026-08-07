#!/usr/bin/env bash
# Manages the disposable rehearsal Postgres on the VPS. No hosts or paths are hardcoded: provide
#   VPS_SSH_TARGET  user@host        VPS_SSH_PORT  port        VPS_SSH_KEY  identity file
#   REMOTE_ENV_FILE path on the VPS whose DATABASE_URL points at production (read there, never printed)
# The container binds to the VPS loopback only; reach it from here through the tunnel this script prints.
# Remote commands are fed to `sh -s` over stdin: the VPS login shell is fish, and nested quoting through it
# is exactly the kind of bug a migration tool must not have.
set -euo pipefail
: "${VPS_SSH_TARGET:?}" "${VPS_SSH_PORT:?}" "${VPS_SSH_KEY:?}"
remote() { ssh -i "$VPS_SSH_KEY" -p "$VPS_SSH_PORT" "$VPS_SSH_TARGET" sh -s; }

case "${1:-}" in
  start)
    remote <<'EOF'
docker run -d --name jobseeker-rehearsal -e POSTGRES_PASSWORD=rehearsal \
  -p 127.0.0.1:15432:5432 postgres:17-alpine >/dev/null
EOF
    echo "started. tunnel with:"
    echo "  ssh -i \$VPS_SSH_KEY -p \$VPS_SSH_PORT -N -L 15432:127.0.0.1:15432 \$VPS_SSH_TARGET"
    echo "then: SCRATCH_DATABASE_URL=postgres://postgres:rehearsal@127.0.0.1:15432/postgres?sslmode=disable"
    ;;
  restore)
    : "${REMOTE_ENV_FILE:?}"
    # The dump carries CREATE SCHEMA public, so the scratch must not have one when it arrives.
    remote <<'EOF'
docker exec jobseeker-rehearsal psql -q -U postgres -d postgres \
  -c 'drop schema if exists public cascade; drop schema if exists legacy cascade'
EOF
    remote <<EOF
docker run --rm --network host --env-file $REMOTE_ENV_FILE postgres:17-alpine \
  sh -c 'pg_dump --schema=public --no-owner --no-privileges "\$DATABASE_URL"' \
  | docker exec -i jobseeker-rehearsal psql -q -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null
EOF
    echo "restored"
    ;;
  reset)
    remote <<'EOF'
docker exec jobseeker-rehearsal psql -q -U postgres -d postgres \
  -c 'drop schema if exists public cascade; drop schema if exists legacy cascade; create schema public'
EOF
    echo "reset"
    ;;
  destroy)
    remote <<'EOF'
docker rm -f jobseeker-rehearsal >/dev/null
EOF
    echo "destroyed"
    ;;
  *)
    echo "usage: scratch-vps.sh start|restore|reset|destroy" >&2; exit 2 ;;
esac
