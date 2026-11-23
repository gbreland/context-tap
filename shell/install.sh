#!/bin/sh
# Usage:
#   install.sh            Copy Context Tap and its extension into your home folder.
#   install.sh --dev      Link the extension to this repo and run the app from it.
#   install.sh --system   Install for all users (run as root). Honors PREFIX and DESTDIR.
set -eu

mode=user
case "${1:-}" in
  "") ;;
  --dev) mode=dev ;;
  --system) mode=system ;;
  *) echo "Usage: $0 [--dev | --system]" >&2; exit 2 ;;
esac

shell_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$shell_dir/.." && pwd)
uuid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$shell_dir/metadata.json")

if [ "$mode" = system ]; then
  prefix="${PREFIX:-/usr}"
  root="${DESTDIR:-}"
  share="$root$prefix/share"
  app="$share/context-tap"
  ext="$share/gnome-shell/extensions/$uuid"
  apps="$share/applications"
  services="$share/dbus-1/services"
  autostart="$root/etc/xdg/autostart"
  launch="$prefix/share/context-tap/bin/context-tap"
else
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  config="${XDG_CONFIG_HOME:-$HOME/.config}"
  ext="$data/gnome-shell/extensions/$uuid"
  apps="$data/applications"
  services="$data/dbus-1/services"
  autostart="$config/autostart"
  if [ "$mode" = dev ]; then
    app="$repo"
  else
    app="$HOME/.local/lib/context-tap"
  fi
  launch="$app/bin/context-tap"
fi

# Remove the old extension. A link is removed by itself so the target stays safe.
replace_dir() {
  if [ -L "$1" ]; then
    rm -f "$1"
  elif [ -d "$1" ]; then
    rm -rf "$1"
  fi
}

mkdir -p "$(dirname "$ext")" "$apps" "$services" "$autostart"

replace_dir "$ext"
if [ "$mode" = dev ]; then
  ln -s "$shell_dir" "$ext"
else
  mkdir -p "$ext"
  cp "$shell_dir/extension.js" "$shell_dir/metadata.json" "$ext/"
  replace_dir "$app"
  mkdir -p "$app/data"
  cp -R "$repo/bin" "$repo/src" "$app/"
  cp -R "$repo/data/icons" "$app/data/"
fi
chmod +x "$app/bin/context-tap"

if [ "$mode" = system ]; then
  icons="$share/icons/hicolor"
else
  icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
fi
python3 - "$repo/data/icons/hicolor" "$icons" "$mode" <<'PY'
import pathlib, shutil, sys
source, dest, mode = sys.argv[1:]
source, dest = pathlib.Path(source), pathlib.Path(dest)
for png in source.glob('*x*/apps/*.png'):
    target = dest / png.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(png, target)
if mode == 'system':
    raise SystemExit
text = (source / 'index.theme').read_text()
# Keep a fuller index. Add only the Context Tap directories that are missing.
current = (dest / 'index.theme').read_text() if (dest / 'index.theme').exists() else ''
if 'Directories=' not in current or len(current) < len(text):
    (dest / 'index.theme').write_text(text)
    raise SystemExit
header, _, body = text.partition('\n\n')
wanted = header.split('Directories=', 1)[1].split('\n', 1)[0].split(',')
have = current.split('Directories=', 1)[1].split('\n', 1)[0].split(',')
missing = [name for name in wanted if name not in have]
if not missing:
    raise SystemExit
sections = body.split('\n\n')
extra = [part for part in sections if part.startswith('[') and part.split(']', 1)[0][1:] in missing]
updated = current.replace('Directories=' + ','.join(have), 'Directories=' + ','.join(have + missing), 1)
(dest / 'index.theme').write_text(updated.rstrip() + '\n\n' + '\n\n'.join(extra) + '\n')
PY
if [ "$mode" != system ] && command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f "$icons" >/dev/null || true
fi

write_entry() {
  awk -v exec="$1" '
    /^Exec=/ { print "Exec=" exec; next }
    { print }
  ' "$2" > "$3"
}
write_entry "$launch" "$repo/data/org.contexttap.ContextTap.desktop" "$apps/org.contexttap.ContextTap.desktop"
write_entry "$launch" "$repo/data/org.contexttap.ContextTap.service" "$services/org.contexttap.ContextTap.service"
write_entry "$launch --autostart" "$repo/data/autostart.desktop" "$autostart/org.contexttap.ContextTap.desktop"

if [ "$mode" = system ]; then
  printf 'Installed %s for all users.\n' "$uuid"
  printf 'Each user turns it on in Extensions, then logs out and logs in.\n'
  exit 0
fi

python3 - "$uuid" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
def get(key):
    raw = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True).strip()
    return [] if raw.startswith('@as') else ast.literal_eval(raw)
def put(key, items):
    value = '[' + ', '.join("'" + i.replace('\\', '\\\\').replace("'", "\\'") + "'" for i in items) + ']'
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, value])
enabled = get('enabled-extensions')
if uuid not in enabled:
    put('enabled-extensions', enabled + [uuid])
disabled = get('disabled-extensions')
if uuid in disabled:
    put('disabled-extensions', [i for i in disabled if i != uuid])
PY

printf 'Installed %s (%s mode).\n' "$uuid" "$mode"
printf 'Log out, then log in. GNOME loads the extension and starts Context Tap.\n'
