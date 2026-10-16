# Desktop Launcher

A GNOME Shell extension that turns the empty desktop into a permanent app
launcher. A grid of your favourite and installed apps lives on the wallpaper,
behind every window, like a phone home screen. Nothing changes about the
overview, the dash or Alt+Tab; the launcher simply fills the space that an
empty desktop would otherwise waste.

- Click an icon to launch (or focus) the app. Middle-click / Ctrl-click opens
  a new window.
- Right-click or long-press for the Shell's own app menu, identical to the
  overview app grid: Open Windows, New Window, the app's desktop actions,
  Launch using Discrete Graphics (where applicable), Pin to / Unpin from Dash,
  App Details, Quit.
- Apps the dock already shows, pinned favourites and running apps, stay out
  of All Apps and folders; they come back when unpinned or closed.
- Drag tiles to reorder. All Apps keeps its own order (new apps are appended);
  dragging in the Favourites row reorders GNOME's favourites, and dragging an
  app from All Apps onto the Favourites row pins it at that spot.
- GNOME's app folders (the ones you make in the overview) appear as folder
  tiles ahead of the loose apps. Clicking one opens a panel over the grid with
  its apps (the rest of the grid stays undimmed); click outside or launch an app to close it. Folder changes made in
  the overview show up immediately.
- A dot under an icon marks a running app.
- Scroll to reach apps that don't fit on screen.
- Right-click on empty wallpaper still opens GNOME's background menu.
- Optional: **Replace GNOME's app grid.** The Show Apps button (GNOME dash or
  Dash to Panel) and Super+A then minimize every window on the current
  workspace with GNOME's own minimize animation, revealing the launcher.
  Pressing again restores exactly those windows. The overview can no longer
  swipe or scroll to the app grid page.

Tested on GNOME Shell 50 (Fedora 44, Wayland).

## How it works

The Shell keeps its wallpaper actors in a `Meta.BackgroundGroup` at the very
bottom of `global.window_group`. The extension adds one `LauncherLayer` per
monitor to that group, sized to the monitor's work area. Being inside the
window group means the layer is above the wallpaper and below all windows,
and the overview (which draws its own backgrounds) never shows it.

Tiles are `St.Button`s around the Shell's own `IconGrid.BaseIcon`, so icons
and the hover/focus look come from the running Shell theme; the context menu
is the Shell's `AppMenu`. When the Shell recreates a wallpaper actor (wallpaper
change, monitor hot-plug) it lands on top of the layer, so the extension
listens to `child-added` on the group and moves itself back up.

### Replacing the app grid

With `replace-app-grid` on, every path into the overview's app grid is
redirected to `toggleDesktop()`: `Overview.show(APP_GRID)` (which is also
what Dash to Panel calls), `Overview.showApps()`, the `toggle-application-view`
keybinding, and the dash's Show Apps toggle (its handler is swapped for ours,
so the button acts as a momentary button). The overview state adjustment is
clamped to the window picker so `shift-overview-up` and the swipe gesture
can't reach the grid either. `toggleDesktop()` minimizes the normal and dialog
windows of the active workspace in stacking order, or, if the previous call
minimized windows that are still minimized, unminimizes them and focuses the
topmost. Dash to Panel triggers both the dash button and `show(APP_GRID)` for
a single click, so triggers within 300 ms are treated as one.

### Reordering

Tiles are Shell DND sources (`DND.makeDraggable`, press-and-hold or move)
and each section's grid is a drop target. While a tile is dragged over its
own section the faded source tile acts as the placeholder and the grid
re-attaches its children live; the drop writes the order to `app-order`
(desktop ids and `folder:ID`), or for the Favourites row calls
`AppFavorites.moveFavoriteToPos`. A drop of an All Apps tile on the
Favourites row calls `addFavoriteAtPos`. The whole section row, not just the
grid, maps drops to the nearest slot so dropping after the last tile works.

### Folders

Folders are read from `org.gnome.desktop.app-folders`, resolved like the
overview does (explicit `apps`, plus apps whose categories intersect the
folder's `categories`, minus `excluded-apps`; empty folders are skipped) and
the extension watches each folder's settings for changes. The folder popup
lives inside the launcher layer, so it stays behind windows like the rest.

Two Clutter gotchas worth knowing if you touch the tiles: a right-click
gesture on an `St.Button` must set `recognize_on_press`, because the button's
own click gesture claims the release; and a plain signal handler that returns
`EVENT_STOP` for a press makes Clutter cancel every gesture still deciding,
so the folder backdrop checks the pointer position instead of stopping events
on the panel.

## Settings

Open with `gnome-extensions prefs desktop-launcher@oezcan.me` or from the
Extensions app.

| Key | Default | Meaning |
| --- | --- | --- |
| `icon-size` | 64 | Icon size in pixels |
| `show-labels` | true | App names under the icons |
| `show-section-titles` | true | "Favourites" / "All Apps" headings (hidden automatically when only one section is shown) |
| `show-favorites` | true | Dash favourites as their own row |
| `margin` | 48 | Space between grid and work-area edge |
| `max-width` | 0 | Cap the grid width (0 = none); grid is centred |
| `all-monitors` | false | One launcher per monitor instead of primary only |
| `app-order` | [] | Saved drag order of All Apps (written by the extension) |
| `replace-app-grid` | false | Show Apps button / Super+A reveal the desktop instead of the overview app grid |

## Install

```bash
make link      # symlink the source into ~/.local/share/gnome-shell/extensions
make enable
```

A freshly installed extension is only picked up by GNOME Shell on login, so
log out and back in the first time. `make zip` builds an installable
`desktop-launcher@oezcan.me.shell-extension.zip`.

Desktop-icon extensions such as Desktop Icons NG (DING) put a full-screen
window on the desktop layer that would cover the launcher. Disable them.

## Develop and test

Wayland can't restart the Shell, so test in a throw-away headless Shell:

```bash
make nested          # headless Shell with a 1600x900 virtual monitor
./scripts/nested.sh 1920x1080 devkit   # or a visible window
```

The script uses its own settings file and enables a tiny helper extension
that puts *that* Shell in unsafe mode, which unlocks `org.gnome.Shell.Eval`
and `org.gnome.Shell.Screenshot` on its bus (`$XDG_RUNTIME_DIR/desktop-launcher-nested/bus`):

```bash
export DBUS_SESSION_BUS_ADDRESS=$(cat $XDG_RUNTIME_DIR/desktop-launcher-nested/bus)
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval "import('resource:///org/gnome/shell/ui/main.js').then(Main => Main.overview.hide())"
gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot false false /tmp/shot.png
```

Top-level `await` is not allowed in Eval; return a promise instead.
