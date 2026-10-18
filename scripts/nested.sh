#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atay Özcan <atay@oezcan.me>
# SPDX-License-Identifier: GPL-2.0-or-later
# Start a headless GNOME Shell (virtual monitor, no window) with only Desktop
# Launcher enabled, for testing over D-Bus (org.gnome.Shell.Eval and
# org.gnome.Shell.Screenshot). Pass "devkit" as $2 for a visible window.
#
# Settings go to a throw-away keyfile backend (no dconf), so nothing in your
# real session changes. A tiny helper extension turns on the Shell's unsafe
# mode inside that session only, which is what unlocks Eval/Screenshot.
set -euo pipefail
UUID=desktop-launcher@oezcan.me
SIZE=${1:-1600x900}
MODE=${2:-headless}
STATE=${XDG_RUNTIME_DIR:-/tmp}/desktop-launcher-nested
DEV=unsafe-mode-dev@local
mkdir -p "$STATE/config" "$STATE/data/gnome-shell/extensions/$DEV"
cat > "$STATE/data/gnome-shell/extensions/$DEV/metadata.json" <<JSON
{"uuid": "$DEV", "name": "Unsafe mode (dev)", "description": "Enables Eval/Screenshot over D-Bus for testing.", "shell-version": ["48", "49", "50", "51"], "version": 1}
JSON
cat > "$STATE/data/gnome-shell/extensions/$DEV/extension.js" <<'JS'
export default class { enable() { global.context.unsafe_mode = true; } disable() { global.context.unsafe_mode = false; } }
JS
export XDG_CONFIG_HOME="$STATE/config"
export XDG_DATA_DIRS="$STATE/data:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell enabled-extensions "['$UUID', '$DEV']"
gsettings set org.gnome.shell disabled-extensions "[]"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
exec dbus-run-session -- sh -c "
  echo \"\$DBUS_SESSION_BUS_ADDRESS\" > '$STATE/bus'
  if [ '$MODE' = devkit ]; then
    exec gnome-shell --devkit --wayland --no-x11
  else
    exec gnome-shell --headless --wayland --no-x11 --virtual-monitor '$SIZE'
  fi
"
