#!/bin/sh
set -eu

shell_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$shell_dir/.." && pwd)
uuid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$shell_dir/metadata.json")
data="${XDG_DATA_HOME:-$HOME/.local/share}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
ext="$data/gnome-shell/extensions/$uuid"

mkdir -p "$(dirname "$ext")" "$data/applications" "$data/dbus-1/services" "$config/autostart"
ln -sfn "$shell_dir" "$ext"
chmod +x "$repo/bin/context-tap"

awk -v exec="gjs -m \"$repo/src/main.js\"" '
  /^Exec=/ { print "Exec=" exec; next }
  { print }
' "$repo/data/org.contexttap.ContextTap.desktop" > "$data/applications/org.contexttap.ContextTap.desktop"

awk -v exec="$repo/bin/context-tap" '
  /^Exec=/ { print "Exec=" exec; next }
  { print }
' "$repo/data/org.contexttap.ContextTap.service" > "$data/dbus-1/services/org.contexttap.ContextTap.service"

awk -v exec="gjs -m \"$repo/src/main.js\"" '
  /^Exec=/ { print "Exec=" exec; next }
  { print }
' "$repo/data/autostart.desktop" > "$config/autostart/org.contexttap.ContextTap.desktop"

python3 - "$uuid" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
    text=True).strip()
items = [] if raw == '@as []' else ast.literal_eval(raw)
if uuid not in items:
    items.append(uuid)
    value = '[' + ', '.join("'" + item.replace('\\', '\\\\').replace("'", "\\'") + "'" for item in items) + ']'
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', value])
PY

if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "$runtime/wayland-0" ]; then
  WAYLAND_DISPLAY=wayland-0
  export WAYLAND_DISPLAY
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$runtime/bus" ]; then
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus"
  export DBUS_SESSION_BUS_ADDRESS
fi

started=0
if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; then
  if systemd-run --user --quiet --collect \
      --setenv="WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}" \
      --setenv="DISPLAY=${DISPLAY:-}" \
      --setenv="XDG_RUNTIME_DIR=$runtime" \
      --setenv="XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-GNOME}" \
      --setenv="DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}" \
      gjs -m "$repo/src/main.js"; then
    started=1
  fi
fi

printf 'Enabled %s\n' "$uuid"
if [ "$started" -eq 1 ]; then
  printf 'Context Tap is open. It also starts on the next login.\n'
else
  printf 'Context Tap starts on the next login. Log out, then log in.\n'
fi
