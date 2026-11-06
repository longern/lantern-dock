#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-nas-image.sh IMAGE}
helper=busybox:1.37.0
prefix="lantern-dock-smoke-${RANDOM}"
test_dir=$(mktemp -d)
containers=()
cleanup() {
  for container in "${containers[@]}"; do
    if docker inspect "$container" >/dev/null 2>&1; then
      docker logs "$container" || true
      docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  done
  docker run --rm --mount "type=bind,src=$test_dir,dst=/fixture" "$helper" \
    sh -c 'rm -rf /fixture/*' >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

fixture() {
  docker run --rm --mount "type=bind,src=$test_dir,dst=/fixture" "$helper" sh -ec "$1"
}
mounts=(--mount "type=bind,src=$test_dir/data,dst=/data" --mount "type=bind,src=$test_dir/public,dst=/public,readonly")
start() {
  local suffix=$1 uid=$2 gid=$3
  shift 3
  container="$prefix-$suffix"
  containers+=("$container")
  docker run -d --name "$container" --read-only \
    "${mounts[@]}" -p 127.0.0.1::8080 "$@" "$image" >/dev/null
  address=$(docker port "$container" 8080/tcp)
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 2 "http://$address/healthz"; then break; fi
    sleep 1
  done
  curl --fail --silent --show-error --max-time 5 "http://$address/healthz"
  docker top "$container" -eo pid,uid,gid,args | awk -v uid="$uid" -v gid="$gid" \
    'NR > 1 { count++; if ($2 != uid || $3 != gid) exit 1 } END { if (count != 1) exit 1 }'
  docker run --rm --pid="container:$container" --cap-drop ALL "$helper" \
    cat /proc/1/status > "$test_dir/process-status"
  grep -Eq '^NoNewPrivs:[[:space:]]+1$' "$test_dir/process-status"
  for capability in CapInh CapPrm CapEff CapAmb; do
    grep -Eq "^$capability:[[:space:]]+0+$" "$test_dir/process-status"
  done
  if grep -Eq '^Groups:.*[[:space:]]0([[:space:]]|$)' "$test_dir/process-status"; then
    echo "Runtime retained the supplementary root group" >&2
    exit 1
  fi
  curl --fail --silent --show-error --max-time 5 -X PROPFIND -H 'Depth: 1' \
    "http://$address/dav/" > "$test_dir/dav.xml"
  grep -q multistatus "$test_dir/dav.xml"
  test "$(curl --fail --silent --show-error "http://$address/dav/hello.txt")" = "public fixture"
  test "$(curl --silent --output /dev/null --write-out '%{http_code}' -X PUT \
    --data 'denied' "http://$address/dav/blocked.txt")" = 405
}
stop() {
  docker logs "$container"
  docker rm -f "$container" >/dev/null
}
list_link() {
  docker exec "$container" /lantern-dock link list --data-dir /data > "$test_dir/links.json"
  jq -e --arg id "$(jq -r .link.id "$test_dir/drop.json")" \
    'length == 1 and .[0].id == $id' "$test_dir/links.json" >/dev/null
}
expect_failure() {
  local expected=$1
  shift
  if docker run --rm --read-only "${mounts[@]}" "$@" "$image" > "$test_dir/error.log" 2>&1; then
    echo "Expected startup to fail: $expected" >&2
    exit 1
  fi
  grep -q "$expected" "$test_dir/error.log"
}

# Root-owned bind mounts reproduce NAS GUI-created folders. The service must
# initialize private state, then run entirely as the default unprivileged user.
fixture 'mkdir -p /fixture/data /fixture/public; chmod 700 /fixture/data; chmod 755 /fixture/public; printf "public fixture" > /fixture/public/hello.txt; chmod 644 /fixture/public/hello.txt'
start default 1000 1000 --security-opt no-new-privileges:true
docker exec "$container" /lantern-dock link create --data-dir=/data \
  --site=https://files.example.com > "$test_dir/drop.json"
jq -e '.link.id and (.url | startswith("https://files.example.com/#/upload/"))' "$test_dir/drop.json" >/dev/null
list_link
test "$(fixture 'stat -c %u:%g /fixture/data/lantern-dock.sqlite')" = 1000:1000
test "$(fixture 'stat -c %u:%g:%a /fixture/public/hello.txt')" = 0:0:644
stop

# Migrate existing SQLite state and inbox files while preserving link IDs and
# public ownership/permissions. Unrelated files in the data mount stay untouched.
fixture 'mkdir -p /fixture/data/inbox/legacy; printf "private fixture" > /fixture/data/inbox/legacy/photo.txt; chmod 400 /fixture/data/inbox/legacy/photo.txt; chown -R 65532:65532 /fixture/data; printf "unrelated" > /fixture/data/notes.txt; chmod 400 /fixture/data/notes.txt; chown -R 1001:100 /fixture/public; chmod 700 /fixture/public; chmod 600 /fixture/public/hello.txt'
start nas-user 1001 100 -e PUID=1001 -e PGID=100
list_link
test "$(fixture 'stat -c %u:%g:%a /fixture/data/inbox/legacy/photo.txt')" = 1001:100:600
test "$(fixture 'stat -c %u:%g:%a /fixture/data/notes.txt')" = 0:0:400
test "$(fixture 'stat -c %u:%g:%a /fixture/public/hello.txt')" = 1001:100:600
stop

# Docker user: wins over PUID/PGID and needs no initialization capabilities.
start native-user 1001 100 --cap-drop ALL --user 1001:100 -e PUID=9999 -e PGID=9999
list_link
stop

# Supplementary groups explicitly granted by Docker survive the root handoff.
fixture 'chown -R 2000:2222 /fixture/public; chmod 750 /fixture/public; chmod 640 /fixture/public/hello.txt'
start group-access 1001 100 -e PUID=1001 -e PGID=100 --group-add 2222
grep -Eq '^Groups:.*[[:space:]]2222([[:space:]]|$)' "$test_dir/process-status"
list_link
test "$(fixture 'stat -c %u:%g:%a /fixture/public/hello.txt')" = 2000:2222:640
stop

# Root-launch PUID/PGID values are validated before listening.
for value in 0 -1 admin 4294967295; do
  expect_failure PUID -e "PUID=$value"
done
expect_failure PGID -e PGID=0
expect_failure 'public directory /public.*UID=3000 GID=3000' --cap-drop ALL --user 3000:3000
expect_failure 'nested mount.*private data' \
  --mount "type=bind,src=$test_dir/public,dst=/data/inbox/mounted-public"
test "$(fixture 'stat -c %u:%g:%a /fixture/public/hello.txt')" = 2000:2222:640

echo "NAS image smoke test passed: $image (default user, PUID/PGID, migration, user:, groups, rejected configurations)"
