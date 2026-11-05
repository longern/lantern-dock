#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-nas-image.sh IMAGE}
container="lantern-dock-smoke-${RANDOM}"
test_dir=$(mktemp -d)
cleanup() {
  docker logs "$container" || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

docker run -d --name "$container" --read-only \
  --tmpfs /data:uid=65532,gid=65532,mode=0700 \
  -p 127.0.0.1::8080 "$image" >/dev/null
address=$(docker port "$container" 8080/tcp)
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "http://$address/healthz"; then break; fi
  sleep 1
done
curl --fail --silent --show-error --max-time 5 "http://$address/healthz"
curl --fail --silent --show-error --max-time 5 -X PROPFIND -H 'Depth: 1' \
  "http://$address/dav/" > "$test_dir/dav.xml"
grep -q multistatus "$test_dir/dav.xml"
docker exec "$container" /lantern-dock link create --data-dir=/data \
  --site=https://files.example.com > "$test_dir/drop.json"
docker exec "$container" /lantern-dock link list --data-dir=/data > "$test_dir/links.json"
jq -e '.link.id and (.url | startswith("https://files.example.com/#/upload/"))' "$test_dir/drop.json" >/dev/null
jq -e 'length == 1' "$test_dir/links.json" >/dev/null
echo "NAS image smoke test passed: $image"
