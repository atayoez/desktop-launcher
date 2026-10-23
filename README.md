<div align="center">

<img src="docs/icon.svg" width="128" alt="Desktop Launcher icon: app tiles on a blue-green wallpaper with a cursor">

# Desktop Launcher

**Your empty desktop is the app launcher.**

A GNOME Shell extension that draws your apps on the wallpaper, behind every window, like a phone home screen. Click to launch, right-click for GNOME's app menu, open folders, drag to reorder. The overview, the dash and Alt+Tab stay exactly as they are.

[![Latest release](https://img.shields.io/github/v/release/atayoez/desktop-launcher?label=release&color=3b7dd8)](https://github.com/atayoez/desktop-launcher/releases/latest)
![GNOME 48–51](https://img.shields.io/badge/GNOME-48%20%E2%80%93%2051-4a86cf?logo=gnome&logoColor=white)
![Wayland](https://img.shields.io/badge/Wayland-ready-333?logo=wayland&logoColor=white)
![GJS](https://img.shields.io/badge/GJS-ESM-f7df1e?logo=javascript&logoColor=black)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)
[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/atayozc)

<img src="docs/screenshots/desktop.png" width="800" alt="A GNOME desktop whose wallpaper carries a grid of app icons and two folders">

</div>

## Features

| | |
|---|---|
| **Lives on the wallpaper** | The grid sits between the wallpaper and your windows. Wherever there is no window, there is your launcher; windows simply cover it. Nothing changes in the overview. |
| **Click, right-click, long-press** | Click launches or focuses an app, middle-click or Ctrl-click opens a new window. Right-click or long-press opens GNOME's own app menu: open windows, New Window, desktop actions, Pin to Dash, App Details, Quit. |
| **Folders** | Your GNOME app folders show up as folder tiles. Click one and its apps open in a panel over the grid; click outside or launch something to close it. Folders work like in GNOME's app grid: drop an app on another app to make a folder, or on a folder to put it in; rearrange apps inside an open folder by dragging; drag one out of the folder to take it out. Holding an app over a folder also opens it, to drop it at a chosen spot. The pencil next to the folder name renames it. Folders are GNOME's own, so the overview shows the same ones. |
| **Type to search** | Start typing on the desktop and GNOME's own search appears: apps plus every search provider (Files, Settings, Calculator, ...), exactly as in the overview. Enter opens the first result, arrows and Tab move between results, Escape closes it. There is no search button; the desktop has the keyboard whenever no window is focused or after a click on the desktop. |
| **Blur my Shell** | With [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/) installed and its popup blur on, the desktop behind the search and behind an open folder is blurred with your Blur my Shell settings, like the overview. |
| **Drag to reorder** | Press and hold, then drag. The grid keeps your order. |
| **No duplicates with the dock** | Pinned and running apps are already in the dock, so they stay out of the grid and folders until unpinned or closed. |
| **Replace GNOME's app grid** | Optional: the Show Apps button, in the GNOME dash or in Dash to Panel, and Super+A minimize every window with GNOME's animation to reveal the launcher. Press again and the windows come back. |
| **Out of the way** | While a monitor shows any open (not minimised) app window on the current workspace, its icons fade out like they do when the overview opens, and can't be clicked by accident. Minimise or close the windows, or switch to an empty workspace, and they fade back in; with the app grid replacement on, the Show Apps button and Super+A do that for you. |
| **Always there** | The launcher stays visible while you swipe between workspaces, where GNOME otherwise paints its own copies of the wallpaper. Opening the overview, by swiping up or pressing Super, fades it out smoothly. |
| **Theme-native** | Tiles reuse the Shell's own icon and menu classes, so they follow your Shell theme, accent colour and icon theme. Running apps get a dot. |

<div align="center">
<table>
<tr>
<td><img src="docs/screenshots/folder.png" width="400" alt="The Utilities folder open as a dark rounded panel over the grid, showing its five apps"></td>
<td><img src="docs/screenshots/menu.png" width="400" alt="GNOME's app menu opened by right-clicking a tile: New Window, Pin to Dash, App Details"></td>
</tr>
<tr>
<td align="center"><sub>Folders</sub></td>
<td align="center"><sub>Right-click menu</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/drag.png" width="400" alt="A tile being dragged between two folders; the other tiles have moved aside"></td>
<td><img src="docs/screenshots/windows.png" width="400" alt="Calculator and Clocks windows open on top of the launcher grid"></td>
</tr>
<tr>
<td align="center"><sub>Drag to reorder</sub></td>
<td align="center"><sub>Behind every window</sub></td>
</tr>
</table>
</div>

## Install

**From the release zip.** Download `desktop-launcher@oezcan.me.shell-extension.zip` from the [latest release](https://github.com/atayoez/desktop-launcher/releases/latest), then:

```sh
gnome-extensions install desktop-launcher@oezcan.me.shell-extension.zip
gnome-extensions enable desktop-launcher@oezcan.me
```

**From source.** Symlinks the checkout into your extensions folder, handy for hacking on it:

```sh
git clone https://github.com/atayoez/desktop-launcher.git
cd desktop-launcher
make link enable
```

GNOME Shell only picks up a newly installed extension at login, so log out and back in once. Works on GNOME Shell 48 to 51 (developed and tested on 50, Fedora 44, Wayland).

Desktop-icon extensions such as Desktop Icons NG put a full-screen window on the desktop layer that would cover the launcher. Turn them off.

## Settings

Open with `gnome-extensions prefs desktop-launcher@oezcan.me` or from the Extensions app.

| Setting | Default | What it does |
|---|---|---|
| Icon size | 64 px | Size of the app icons |
| Show app names | on | Labels under the icons |
| Replace GNOME's app grid | off | Show Apps button and Super+A reveal the desktop instead of opening the overview grid |
| Outer margin | 48 px | Space between the grid and the edge of the work area |
| Maximum grid width | unlimited | Cap the grid width; the grid is centred |
| Show on every monitor | off | One launcher per monitor instead of the primary only |

The drag order of the grid is stored in the `app-order` key and never needs touching by hand.

## How it works

The Shell keeps its wallpaper actors in a `Meta.BackgroundGroup` at the bottom of `global.window_group`. The extension adds one `LauncherLayer` per monitor to that group, sized to the monitor's work area. Being inside the window group puts the layer above the wallpaper and below all windows, and the overview, which draws its own backgrounds, never shows it. When the Shell recreates a wallpaper actor (wallpaper change, monitor hot-plug) it lands on top of the layer, so the extension listens for `child-added` on the group and moves the new wallpaper back to the bottom.

Tiles are `St.Button`s around the Shell's `IconGrid.BaseIcon`; the context menu is the Shell's `AppMenu`. Folders are read from `org.gnome.desktop.app-folders` and resolved like the overview does: explicit `apps`, plus apps whose categories intersect the folder's `categories`, minus `excluded-apps`.

**Workspace switch and overview.** During a workspace switch and in the overview, the Shell paints its own wallpaper copies above the window layer (`workspaceAnimation.js` and `workspace.js`), which would hide the launcher. The extension adds a live `Clutter.Clone` of the monitor's layer to each of those: into every switch-animation background group, and into each overview `Workspace` between its background and its window previews. The overview squeezes the work area into a box of a different aspect, so the clone is scaled uniformly to fit and centred; at full size this is an exact 1:1 mapping, so the swipe-up transition starts seamlessly. The clone lives beside the overview background rather than inside it, because the overview derives the workspace box from that actor's preferred size. The overview clones take their opacity from the overview's state adjustment (hidden 0 → window picker 1), which the swipe gesture and the Super key animation both drive, so the launcher fades out as the overview opens.

**Reordering.** Tiles are Shell DND sources and the grid is a drop target, working like the overview's `BaseAppView` and `IconGrid.getDropTarget`. The dragged tile shrinks away and leaves an empty slot. Hovering the outer 20 px of a tile (or the space after the last one) moves the slot there after 200 ms, aimed at whichever neighbour the move can push aside; hovering the middle of a tile never moves anything. The drop writes `app-order`.

**Folder editing.** Folders follow the overview's `AppFolderDialog`, `FolderView` and `AppIcon`, and are written to `org.gnome.desktop.app-folders` the same way. The open folder is built like the overview's dialog and uses the theme's own classes (`app-folder-dialog`, `folder-name-container`, `folder-name-label`, `folder-name-entry`, `icon-button`, plain `overview-tile`s), so it follows the Shell theme; only the dialog's fixed 720 px size is overridden so it fits the folder's apps. Like `AppFolderDialog` it zooms out of its folder tile and back into it, and the tile hides while the folder is open. Tiles also take the rest from the overview: the theme's `:drop` highlight for a merge target, its `app-grid-running-dot`, and the bare app icon (or a copy of the folder tile) as the drag image. An app from the grid dropped on the middle of another app creates a folder (after 0.5 s of hovering the target shrinks into a folder preview); on a folder it joins it. Inside an open folder apps reorder like the grid, and the drop stores the order in the folder's `apps` key. Dragging an app out of the folder panel closes it after 0.5 s and an empty slot appears in the grid where it will land; dropping on the backdrop before that puts it at the end. Removing an app from a categories-based folder adds it to `excluded-apps`, and a folder left with no apps and no categories is deleted. One addition the overview doesn't have: holding a dragged app over a folder for 0.6 s opens it, with an empty slot already reserved, so the app can be dropped at a chosen spot. Renaming takes a modal grab (`Main.pushModal`), because the launcher sits below the windows, which otherwise own the keyboard; Enter saves, and Escape or a click outside saves and closes, as in the overview.

**Type to search.** The search is the Shell's own `Search.SearchResultsView` behind a search entry, with the key handling of `searchController.js`. The keyboard normally belongs to the focused window, so a tiny reactive actor in the launcher takes the stage key focus whenever no window is focused, or when a press lands on the desktop (watched on the stage, since Clutter only emits events on reactive actors and the background group isn't one). A stage key focus makes the Shell unfocus the window, and focusing a window clears it again. Activating a remote result ends in `Main.overview.toggle()`, which would open the overview; while the search is showing, a toggle caused by its own events closes the search instead (the Super key still opens the overview). The view connects to global objects for good, because the overview never destroys its own; the extension records those connections and removes them when it is disabled, which happens on every screen lock.

**Blur my Shell.** Blur my Shell has no API for other extensions. Its popup blur scans the direct children of the Shell's top-level groups (the background group is one, as a child of the window group) for actors with one of its target style classes, and blurs what is behind them with the user's popup pipeline, following their visibility, opacity and size. The search and the open folder's backdrop carry its own marker class `bms-keyboard-surface`, which no theme styles, and are direct children of the background group above the launcher layer, so the blur lands between the launcher and them. To keep that order, the extension moves only re-created wallpaper actors to the bottom of the group instead of raising its layers to the top. This relies on Blur my Shell internals and may need updating if they change.

**Replacing the app grid.** Every way into the overview's app grid is redirected to `toggleDesktop()`: `Overview.show(APP_GRID)` (which is also what Dash to Panel calls), `Overview.showApps()`, the `toggle-application-view` keybinding and the dash's Show Apps toggle. The overview state is clamped to the window picker so the swipe gesture can't reach the grid either. `toggleDesktop()` minimizes the windows of the active workspace in stacking order, or restores the ones it minimized. Everything is undone when the option or the extension is turned off.

## Develop and test

Wayland can't restart the Shell, so test in a throw-away headless Shell:

```sh
make nested                             # headless Shell with a 1600x900 virtual monitor
./scripts/nested.sh 1920x1080 devkit    # or a visible window
```

The script uses its own settings file and enables a tiny helper extension that puts *that* Shell in unsafe mode, which unlocks `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` on its bus:

```sh
export DBUS_SESSION_BUS_ADDRESS=$(cat $XDG_RUNTIME_DIR/desktop-launcher-nested/bus)
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval "import('resource:///org/gnome/shell/ui/main.js').then(Main => Main.overview.hide())"
gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot false false /tmp/shot.png
```

Top-level `await` is not allowed in Eval; return a promise instead. Real clicks can be injected with a virtual pointer created from Eval (`seat.create_virtual_device`), which is how the screenshots above were taken. `make zip` builds the release archive with `gnome-extensions pack`.

Two Clutter gotchas if you touch the tiles: a right-click gesture on an `St.Button` must set `recognize_on_press`, because the button's own click gesture claims the release; and a signal handler that returns `EVENT_STOP` for a press makes Clutter cancel every gesture still deciding, so the folder backdrop checks the pointer position instead of stopping events.

## Support

Desktop Launcher is free and always will be. If it makes your desktop feel like home, you can support its development:

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white&style=for-the-badge)](https://paypal.me/atayozc)

Bug reports and ideas are welcome in [Issues](https://github.com/atayoez/desktop-launcher/issues).

## License

GPL-2.0-or-later. See [`LICENSE`](LICENSE).
