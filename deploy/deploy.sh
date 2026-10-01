#!/usr/bin/env bash
# Staging deploy (deploy/README.md). Installed root-owned as
# /usr/local/bin/jiwar-community-deploy and bound to the CI key in
# ~jiwar-deploy/.ssh/authorized_keys with command="...",restrict, so that key
# runs this script and nothing else:
#
#   ssh jiwar-deploy@host "deploy <40-hex sha>"   registry token on stdin
#   ssh jiwar-deploy@host "rollback"              previous image, no migrate
#   ssh jiwar-deploy@host "status"
#
# The README's deploy order: migrate, access:sync, and only then the server.
set -Eeuo pipefail

APP_DIR=/srv/jiwar-community
IMAGE_REPO=ghcr.io/juwayryiamuhammad/jiwar-communt
REGISTRY=ghcr.io
WAIT=(--wait --wait-timeout 180)
export COMPOSE_PROJECT_NAME=jiwar-community

log() { echo "deploy: $*" >&2; }
die() { log "$*"; exit 1; }

cd "$APP_DIR"
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || die "another deploy is running"

APP_IMAGE=
compose() { APP_IMAGE="$APP_IMAGE" docker compose -f "$APP_DIR/compose.yml" "$@"; }

# compose.yml comes from the release's own image.
use_release() {
  APP_IMAGE="$IMAGE_REPO:$1"
  docker run --rm --entrypoint cat "$APP_IMAGE" deploy/compose.yml >compose.yml.new
  mv compose.yml.new compose.yml
}

# The token lives for this call only, in a throwaway config directory.
pull() {
  local image="$IMAGE_REPO:$1" token cfg rc=0
  if docker image inspect "$image" >/dev/null 2>&1; then return 0; fi
  IFS= read -r token || true
  [[ -n "$token" ]] || die "$image is not on this host and no registry token came on stdin"
  cfg=$(mktemp -d)
  {
    DOCKER_CONFIG="$cfg" docker login "$REGISTRY" -u x-access-token --password-stdin <<<"$token" >/dev/null &&
      DOCKER_CONFIG="$cfg" docker pull -q "$image" >/dev/null
  } || rc=$?
  rm -rf "$cfg"
  return "$rc"
}

release() {
  use_release "$1"
  compose up -d "${WAIT[@]}" postgres redis minio mailpit
  log "migrate"
  compose run --rm migrate
  log "access:sync"
  compose run --rm --no-deps app node dist/core/platform/access-sync.cli.js
  compose run --rm --no-deps app node deploy/ensure-bucket.js
  log "start $1"
  compose up -d "${WAIT[@]}" --no-deps app
}

# Keep the running and the previous image; drop older releases.
prune() {
  local keep_a=$1 keep_b=${2:-$1}
  local tag
  for tag in $(docker image ls "$IMAGE_REPO" --format '{{.Tag}}'); do
    [[ "$tag" == "$keep_a" || "$tag" == "$keep_b" ]] && continue
    docker image rm "$IMAGE_REPO:$tag" >/dev/null || true
  done
}

deploy() {
  local sha=$1 prev rc=0
  prev=$(cat current 2>/dev/null || true)
  pull "$sha"

  # A function in `if` or `||` runs without errexit; a subshell with its own
  # `set -e` stops at the first failing step.
  set +e
  (set -e; release "$sha")
  rc=$?
  set -e

  if ((rc == 0)); then
    if [[ -n "$prev" && "$prev" != "$sha" ]]; then echo "$prev" >previous; fi
    echo "$sha" >current
    prune "$sha" "$prev"
    log "live: $sha"
    return 0
  fi

  log "release $sha failed (exit $rc)"
  if [[ -n "$prev" ]]; then
    # Migrations are not undone: the previous code runs on the new schema.
    log "back to $prev"
    use_release "$prev"
    compose up -d "${WAIT[@]}" --no-deps app || log "the previous release did not come back healthy either"
  fi
  exit 1
}

rollback() {
  local cur prev
  cur=$(cat current 2>/dev/null || true)
  prev=$(cat previous 2>/dev/null || true)
  [[ -n "$prev" ]] || die "no previous release"
  log "rollback $cur -> $prev (no migrate, no access:sync)"
  use_release "$prev"
  compose up -d "${WAIT[@]}" --no-deps app
  echo "$prev" >current
  echo "$cur" >previous
  log "live: $prev"
}

status() {
  echo "current:  $(cat current 2>/dev/null || echo -)"
  echo "previous: $(cat previous 2>/dev/null || echo -)"
  if [[ -f compose.yml ]]; then
    APP_IMAGE="$IMAGE_REPO:$(cat current 2>/dev/null || echo none)" \
      docker compose -f compose.yml ps --format 'table {{.Service}}\t{{.Status}}'
  fi
}

usage() { die "usage: deploy <40-hex sha> | rollback | status"; }

read -r cmd arg rest <<<"${SSH_ORIGINAL_COMMAND:-$*}" || true
case "${cmd:-}" in
  deploy)
    [[ "${arg:-}" =~ ^[0-9a-f]{40}$ && -z "${rest:-}" ]] || usage
    deploy "$arg"
    ;;
  rollback) [[ -z "${arg:-}" ]] || usage; rollback ;;
  status) [[ -z "${arg:-}" ]] || usage; status ;;
  *) usage ;;
esac
