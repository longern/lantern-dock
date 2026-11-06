#!/bin/sh
set -eu

binary=/usr/local/libexec/lantern-dock
fail() { printf 'lantern-dock: %s\n' "$*" >&2; exit 1; }

if [ "$#" -eq 0 ]; then set -- serve; fi
case "$1" in
  -*) set -- serve "$@" ;;
esac
case "$1" in
  serve|link) ;;
  *) exec "$@" ;;
esac

# Match Go's directory flags without consuming the application's arguments.
data=./data
public=/public
if [ "$1" = serve ]; then public=./public; fi
next=
for argument do
  if [ -n "$next" ]; then
    case "$next" in data) data=$argument ;; public) public=$argument ;; esac
    next=
    continue
  fi
  case "$argument" in
    --data-dir=*) data=${argument#--data-dir=} ;;
    -data-dir=*) data=${argument#-data-dir=} ;;
    --data-dir|-data-dir) next=data ;;
    --public-dir=*|-public-dir=*)
      [ "$1" = serve ] || fail "public-dir is only supported by serve"
      public=${argument#*=}
      ;;
    --public-dir|-public-dir)
      [ "$1" = serve ] || fail "public-dir is only supported by serve"
      next=public
      ;;
  esac
done
[ -z "$next" ] || fail "missing directory after $next-dir"

if [ "$(id -u)" -eq 0 ]; then
  uid=${PUID:-1000}
  gid=${PGID:-1000}
  for name in PUID PGID; do
    case "$name" in PUID) value=$uid ;; PGID) value=$gid ;; esac
    case "$value" in ''|*[!0-9]*) fail "$name must be a decimal ID between 1 and 2147483647" ;; esac
    if [ "${#value}" -gt 10 ] || [ "$value" -eq 0 ] || [ "$value" -gt 2147483647 ]; then
      fail "$name must be a decimal ID between 1 and 2147483647"
    fi
  done
  "$binary" init-data --public-dir="$public" --data-dir="$data" --uid="$uid" --gid="$gid"

  # Keep Docker group_add access, without inheriting the launcher's root group.
  groups=$gid
  for group in $(id -G); do
    case "$group" in 0|"$gid") ;; *) groups="$groups,$group" ;; esac
  done
  exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" \
    --inh-caps=-all --ambient-caps=-all --no-new-privs "$0" "$@"
fi

# Docker --user is authoritative. It bypasses root-only ownership migration,
# including image-default PUID/PGID values that do not describe this user.
uid=$(id -u)
gid=$(id -g)
if [ "$1" = serve ] && { [ ! -r "$public" ] || [ ! -x "$public" ]; }; then
  fail "public directory $public is not readable/traversable by UID=$uid GID=$gid; grant this NAS account read/search permission"
fi
mkdir -p "$data"
if [ ! -w "$data" ] || [ ! -x "$data" ]; then
  fail "data directory $data is not writable by UID=$uid GID=$gid; prepare permissions when using Docker user:"
fi
printf 'LanternDock runtime UID=%s GID=%s; private data %s\n' "$uid" "$gid" "$data" >&2
exec setpriv --no-new-privs "$binary" "$@"
