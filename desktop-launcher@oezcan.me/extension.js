// SPDX-FileCopyrightText: 2026 Atay Özcan <atay@oezcan.me>
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop Launcher: the empty desktop *is* the app launcher.
//
// One LauncherLayer per monitor is added to the Shell's background group
// (Main.layoutManager._backgroundGroup), the Meta.BackgroundGroup that holds
// the wallpaper actors at the very bottom of global.window_group. That puts
// the grid above the wallpaper and below every window, so it behaves like a
// phone home screen: visible wherever no window is, covered wherever one is,
// and untouched by the overview (which draws its own backgrounds).
//
// Each AppTile is an St.Button wrapping the Shell's own IconGrid.BaseIcon, so
// icons, labels and the hover/focus look come from the running Shell theme.
// Right-click / long-press opens the Shell's AppMenu (new window, actions,
// favourites, quit) exactly as in the overview app grid.
//
// Z-order is kept by listening to 'child-added' on the background group:
// whenever the Shell recreates a wallpaper actor (wallpaper change, monitor
// hotplug) it lands on top, and we move our layers back above it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import Gio from 'gi://Gio';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {SHELL_KEYBINDINGS_SCHEMA} from 'resource:///org/gnome/shell/ui/windowManager.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

const TILE_PADDING = 24;   // extra room around the icon inside a tile
const GRID_SPACING = 12;   // row/column spacing of the grid

const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SUBICON_FRACTION = 0.4;   // same as the Shell's app grid
const FOLDER_ANIMATION_TIME = 150;
const DRAG_FADE_TIME = 150;

function getCategories(info) {
    const str = info.get_categories();
    return str ? str.split(';') : [];
}

function getFolderName(folder) {
    const name = folder.get_string('name');
    if (folder.get_boolean('translate')) {
        const translated = Shell.util_get_translated_folder_name(name);
        if (translated !== null)
            return translated;
    }
    return name;
}

/**
 * Resolve GNOME's app folders (org.gnome.desktop.app-folders) against the
 * list of visible apps, the same way the overview app grid does: explicit
 * 'apps' plus every app whose categories intersect 'categories', minus
 * 'excluded-apps'. Empty folders are skipped.
 *
 * @param {Gio.Settings} folderSettings
 * @param {Shell.App[]} apps - visible apps, sorted
 * @returns {{id: string, name: string, apps: Shell.App[]}[]}
 */
function loadFolders(folderSettings, apps) {
    const byId = new Map(apps.map(app => [app.get_id(), app]));
    const folders = [];

    for (const id of folderSettings.get_strv('folder-children')) {
        const folder = new Gio.Settings({
            schema_id: `${FOLDER_SCHEMA}.folder`,
            path: `${folderSettings.path}folders/${id}/`,
        });
        const excluded = new Set(folder.get_strv('excluded-apps'));
        const members = new Map();

        const add = app => {
            if (app && !excluded.has(app.get_id()))
                members.set(app.get_id(), app);
        };
        folder.get_strv('apps').forEach(appId => add(byId.get(appId)));

        const categories = folder.get_strv('categories');
        if (categories.length > 0) {
            for (const app of apps) {
                const appCategories = getCategories(app.get_app_info());
                if (appCategories.some(c => categories.includes(c)))
                    add(app);
            }
        }

        if (members.size === 0)
            continue;
        folders.push({
            id,
            name: getFolderName(folder),
            apps: [...members.values()]
                .sort((a, b) => a.get_name().localeCompare(b.get_name())),
        });
    }
    return folders;
}

/** Side length of a (square) tile for the given settings. */
function tileSide(iconSize, showLabel) {
    return iconSize + TILE_PADDING * 2 + (showLabel ? 24 : 0);
}

/**
 * Drag-source behaviour shared by app and folder tiles. The tile fades
 * while a copy of its icon follows the pointer (Shell DND); sections listen
 * on tile.draggable for drag-begin / drag-end to reorder and persist.
 *
 * @param {St.Button} tile
 */
function makeTileDraggable(tile) {
    tile._delegate = tile;
    tile.draggable = DND.makeDraggable(tile, {timeoutThreshold: 200});
    tile.draggable.connect('drag-begin', () => {
        tile.set_pivot_point(0.5, 0.5);
        tile.ease({
            opacity: 80,
            scale_x: 0.9,
            scale_y: 0.9,
            duration: DRAG_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
    tile.draggable.connect('drag-end', () => {
        tile.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: DRAG_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
}

/** The actor that follows the pointer: a fresh copy of the tile's icon. */
function makeDragActor(tile, label, createIcon, extraClass = '') {
    const icon = new IconGrid.BaseIcon(label, {
        createIcon,
        showLabel: tile.icon.label !== null,
        setSizeManually: true,
    });
    icon.setIconSize(tile.icon.iconSize);
    icon.style_class = `desktop-launcher-drag-actor overview-icon ${extraClass}`;
    return icon;
}

/**
 * One app icon on the desktop.
 */
const AppTile = GObject.registerClass(
class AppTile extends St.Button {
    _init(app, {iconSize, showLabel, draggable = false}) {
        super._init({
            style_class: 'desktop-launcher-tile overview-tile',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            can_focus: true,
            reactive: true,
            accessible_name: app.get_name(),
        });

        this.app = app;
        this.key = app.get_id();

        // St.Button is a bin, so stack icon and running-dot in a box.
        this._box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.set_child(this._box);

        this.icon = new IconGrid.BaseIcon(app.get_name(), {
            createIcon: size => this.app.create_icon_texture(size),
            setSizeManually: true,
            showLabel,
        });
        this.icon.setIconSize(iconSize);
        if (this.icon.label) {
            this.icon.label.clutter_text.set({
                ellipsize: Pango.EllipsizeMode.END,
                line_wrap: false,
            });
        }
        this._box.add_child(this.icon);

        const side = tileSide(iconSize, showLabel);
        this.set_size(side, side);

        // Running indicator, same idea as the overview's app-grid dot.
        this._dot = new St.Widget({
            style_class: 'desktop-launcher-running-dot',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._box.add_child(this._dot);
        this.app.connectObject('notify::state', () => this._updateDot(), this);
        this._updateDot();

        // Context menu on right-click / long-press (touch).
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = null;

        const longPress = new Clutter.LongPressGesture();
        longPress.connect('recognize', () => this.popupMenu());
        this.add_action(longPress);

        // recognize_on_press: St.Button's own click gesture claims the
        // release, so a release-based gesture would never fire (same setup
        // as the Shell's AppIcon).
        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this.popupMenu());
        this.add_action(rightClick);

        this.connect('popup-menu', () => this.popupMenu());
        this.connect('destroy', () => this._onDestroy());

        if (draggable)
            makeTileDraggable(this);
    }

    _onDestroy() {
        this._menu?.destroy();
        this._menu = null;
    }

    getDragActor() {
        return makeDragActor(this, this.app.get_name(),
            size => this.app.create_icon_texture(size));
    }

    getDragActorSource() {
        return this;
    }

    _updateDot() {
        this._dot.visible = this.app.state === Shell.AppState.RUNNING;
    }

    vfunc_clicked(button) {
        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const isMiddle = button === Clutter.BUTTON_MIDDLE;
        const isCtrl = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const openNewWindow = this.app.can_open_new_window() &&
            this.app.state === Shell.AppState.RUNNING && (isCtrl || isMiddle);

        if (this.app.state === Shell.AppState.STOPPED || openNewWindow)
            this.icon.animateZoomOut();

        if (openNewWindow)
            this.app.open_new_window(-1);
        else
            this.app.activate();
    }

    popupMenu() {
        if (!this._menu) {
            this._menu = new AppMenu(this, St.Side.TOP, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }
        this._menu.open(BoxPointer.PopupAnimation.FULL);
        return Clutter.EVENT_STOP;
    }
});

/**
 * A folder on the desktop: a tile showing up to four member icons. Clicking
 * emits 'open-folder'; the owning LauncherLayer shows the folder popup.
 */
const FolderTile = GObject.registerClass({
    Signals: {'open-folder': {}},
}, class FolderTile extends St.Button {
    _init(folder, {iconSize, showLabel, draggable = false}) {
        super._init({
            style_class: 'desktop-launcher-tile overview-tile app-folder',
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            reactive: true,
            accessible_name: folder.name,
        });

        this.folder = folder;
        this.key = `folder:${folder.id}`;

        this.icon = new IconGrid.BaseIcon(folder.name, {
            createIcon: size => this._createFolderIcon(size),
            setSizeManually: true,
            showLabel,
        });
        this.icon.setIconSize(iconSize);
        if (this.icon.label) {
            this.icon.label.clutter_text.set({
                ellipsize: Pango.EllipsizeMode.END,
                line_wrap: false,
            });
        }
        this.set_child(this.icon);

        const side = tileSide(iconSize, showLabel);
        this.set_size(side, side);

        if (draggable)
            makeTileDraggable(this);
    }

    getDragActor() {
        return makeDragActor(this, this.folder.name,
            size => this._createFolderIcon(size), 'app-folder');
    }

    getDragActorSource() {
        return this;
    }

    _createFolderIcon(size) {
        const layout = new Clutter.GridLayout({
            row_homogeneous: true,
            column_homogeneous: true,
        });
        const icon = new St.Widget({
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
            style: `width: ${size}px; height: ${size}px;`,
        });
        const subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);
        const rtl = icon.get_text_direction() === Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            const bin = new St.Bin({style: `width: ${subSize}px; height: ${subSize}px;`});
            if (i < this.folder.apps.length)
                bin.child = this.folder.apps[i].create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }
        return icon;
    }

    vfunc_clicked() {
        this.emit('open-folder');
    }
});

/**
 * The opened folder: an invisible backdrop over the launcher (so a click
 * outside closes it) with a centred panel holding the folder's apps.
 * Launching an app closes it too.
 */
const FolderPopup = GObject.registerClass({
    Signals: {'closed': {}},
}, class FolderPopup extends St.Widget {
    _init(folder, tileParams, columns) {
        super._init({
            style_class: 'desktop-launcher-folder-backdrop',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
            y_expand: true,
        });

        this.folder = folder;
        this._closing = false;

        this._panel = new St.BoxLayout({
            style_class: 'desktop-launcher-folder-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panel);

        this._panel.add_child(new St.Label({
            style_class: 'desktop-launcher-folder-title',
            text: folder.name,
        }));

        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._panel.add_child(scroll);

        const tiles = folder.apps.map(app => {
            const tile = new AppTile(app, tileParams);
            tile.connect('clicked', () => this.close());
            return tile;
        });
        const grid = new Section(null, tiles, false, Math.min(columns, tiles.length));
        scroll.set_child(grid);

        // Clicks outside the panel close the popup. Don't stop propagation
        // on the panel itself: a signal handler that consumes a press makes
        // Clutter cancel every gesture still deciding, including the
        // St.Button click gesture of the tile underneath.
        this.connect('button-release-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const [px, py] = this._panel.get_transformed_position();
            const [pw, ph] = this._panel.get_transformed_size();
            if (x >= px && x < px + pw && y >= py && y < py + ph)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });

        // Animate in.
        this.opacity = 0;
        this._panel.set_pivot_point(0.5, 0.5);
        this._panel.set_scale(0.9, 0.9);
        this.ease({
            opacity: 255,
            duration: FOLDER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._panel.ease({
            scale_x: 1,
            scale_y: 1,
            duration: FOLDER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Keep the panel from growing taller than the launcher. */
    setMaxHeight(height) {
        this._panel.set_style(`max-height: ${Math.max(200, height)}px;`);
    }

    close() {
        if (this._closing)
            return;
        this._closing = true;
        this.reactive = false;
        this._panel.ease({
            scale_x: 0.9,
            scale_y: 0.9,
            duration: FOLDER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this.ease({
            opacity: 0,
            duration: FOLDER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this.emit('closed');
                this.destroy();
            },
        });
    }
});

/**
 * A titled section (e.g. "Favourites") holding a grid of tiles.
 *
 * The column count is passed in rather than derived from the allocation:
 * Clutter.FlowLayout cannot report a reliable height inside a scroll view,
 * so the owning LauncherLayer computes the columns from its own width.
 *
 * The grid is a Shell DND drop target. Dragging one of its own tiles
 * reorders live (the faded source tile acts as the placeholder) and emits
 * 'reordered' on drop; a drop of a tile from another section emits
 * 'external-drop' with the source tile and the target index.
 */
const Section = GObject.registerClass({
    Signals: {
        'reordered': {},
        'external-drop': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_INT]},
    },
}, class Section extends St.BoxLayout {
    _init(title, tiles, showTitle, columns, acceptsExternal = () => false) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._columns = Math.max(1, columns);
        this._tiles = [];
        this._acceptsExternal = acceptsExternal;
        this._orderBeforeDrag = null;

        if (showTitle && title) {
            this.add_child(new St.Label({
                style_class: 'desktop-launcher-section-title',
                text: title,
            }));
        }

        this._layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: GRID_SPACING,
            row_spacing: GRID_SPACING,
        });
        this._grid = new St.Widget({
            style_class: 'desktop-launcher-grid',
            layout_manager: this._layout,
            x_align: Clutter.ActorAlign.START,
        });
        // DND walks up from the picked actor looking for a _delegate with
        // handleDragOver/acceptDrop; coordinates arrive relative to the
        // delegate's actor. The grid maps directly; the rest of the row
        // (title, space right of the last tile) is mapped into grid space
        // so a drop anywhere on the row lands on the nearest slot.
        this._grid._delegate = this;
        this._delegate = {
            handleDragOver: (source, actor, x, y) =>
                this.handleDragOver(source, actor, x - this._grid.x, y - this._grid.y),
            acceptDrop: (source, actor, x, y) =>
                this.acceptDrop(source, actor, x - this._grid.x, y - this._grid.y),
        };
        this.add_child(this._grid);

        tiles.forEach((tile, i) => {
            this._tiles.push(tile);
            this._layout.attach(tile, i % this._columns, Math.floor(i / this._columns), 1, 1);
            if (tile.draggable) {
                tile.draggable.connect('drag-begin', () => {
                    this._orderBeforeDrag = [...this._tiles];
                });
                tile.draggable.connect('drag-end', (_d, _time, success) => {
                    if (!success && this._orderBeforeDrag)
                        this._setOrder(this._orderBeforeDrag);
                    this._orderBeforeDrag = null;
                });
            }
        });
    }

    /** Keys (app ids / folder:ID) in current display order. */
    getKeys() {
        return this._tiles.map(t => t.key);
    }

    _setOrder(tiles) {
        if (tiles.every((t, i) => t === this._tiles[i]))
            return;
        this._tiles = tiles;
        // GridLayout has no public "move child"; re-attach in order.
        for (const tile of tiles)
            this._grid.remove_child(tile);
        tiles.forEach((tile, i) => {
            this._layout.attach(tile, i % this._columns, Math.floor(i / this._columns), 1, 1);
        });
    }

    /** Grid-relative point -> tile index (clamped). */
    _indexAt(x, y, count) {
        const side = this._tiles[0]?.width ?? tileSide(64, true);
        const step = side + GRID_SPACING;
        const col = Math.min(this._columns - 1, Math.max(0, Math.floor(x / step)));
        const row = Math.max(0, Math.floor(y / step));
        return Math.min(count - 1, row * this._columns + col);
    }

    handleDragOver(source, _actor, x, y) {
        if (this._tiles.includes(source)) {
            const from = this._tiles.indexOf(source);
            const to = this._indexAt(x, y, this._tiles.length);
            if (to !== from) {
                const tiles = [...this._tiles];
                tiles.splice(from, 1);
                tiles.splice(to, 0, source);
                this._setOrder(tiles);
            }
            return DND.DragMotionResult.MOVE_DROP;
        }
        if (this._acceptsExternal(source))
            return DND.DragMotionResult.COPY_DROP;
        return DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, x, y) {
        if (this._tiles.includes(source)) {
            this._orderBeforeDrag = null;
            this.emit('reordered');
            return true;
        }
        if (this._acceptsExternal(source)) {
            this.emit('external-drop', source, this._indexAt(x, y, this._tiles.length + 1));
            return true;
        }
        return false;
    }
});

/**
 * The full-work-area launcher for one monitor.
 */
const LauncherLayer = GObject.registerClass(
class LauncherLayer extends St.Widget {
    _init(monitorIndex, settings, folderSettings) {
        super._init({
            name: `desktop-launcher-${monitorIndex}`,
            style_class: 'desktop-launcher-layer',
            layout_manager: new Clutter.BinLayout(),
            // Not reactive itself: clicks between tiles fall through to the
            // wallpaper actor, which keeps the Shell's right-click
            // background menu working.
            reactive: false,
        });

        this.monitorIndex = monitorIndex;
        this._settings = settings;
        this._folderSettings = folderSettings;
        this._columns = 0;
        this._popup = null;
        this._appsSection = null;

        this._scroll = new St.ScrollView({
            style_class: 'desktop-launcher-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._scroll);

        this._content = new St.BoxLayout({
            style_class: 'desktop-launcher-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._scroll.set_child(this._content);

        this.relayout();
        this.rebuild();
    }

    /** Fit the work area of our monitor and apply margin / max-width. */
    relayout() {
        const monitors = Main.layoutManager.monitors;
        if (this.monitorIndex >= monitors.length) {
            this.hide();
            return;
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex);
        this.set_position(area.x, area.y);
        this.set_size(area.width, area.height);
        this._popup?.setMaxHeight(area.height - 2 * this._settings.get_int('margin') - 48);

        const margin = this._settings.get_int('margin');
        this.set_style(`padding: ${margin}px;`);

        // Width available to the grid: work area minus margins, capped by
        // the max-width setting. Leave room for the scrollbar.
        const maxWidth = this._settings.get_int('max-width');
        let width = area.width - 2 * margin - 24;
        if (maxWidth > 0)
            width = Math.min(width, maxWidth);

        const side = tileSide(
            this._settings.get_int('icon-size'),
            this._settings.get_boolean('show-labels'));
        const columns = Math.max(1,
            Math.floor((width + GRID_SPACING) / (side + GRID_SPACING)));
        if (columns !== this._columns) {
            this._columns = columns;
            if (this._content.get_n_children() > 0)
                this.rebuild();
        }
        this.show();
    }

    /** Recreate all tiles from the current app list and settings. */
    rebuild() {
        this._popup?.destroy();
        this._popup = null;
        this._appsSection = null;
        this._content.destroy_all_children();

        const tileParams = {
            iconSize: this._settings.get_int('icon-size'),
            showLabel: this._settings.get_boolean('show-labels'),
        };
        // Section titles only make sense when there is more than one
        // section; a lone "All Apps" heading is noise.
        let showTitles = this._settings.get_boolean('show-section-titles');

        const appSystem = Shell.AppSystem.get_default();
        const parental = ParentalControlsManager.getDefault();

        const all = appSystem.get_installed()
            .filter(info => info.should_show() && parental.shouldShowApp(info))
            .map(info => appSystem.lookup_app(info.get_id()))
            .filter(app => app !== null)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        let favorites = [];
        if (this._settings.get_boolean('show-favorites')) {
            favorites = AppFavorites.getAppFavorites().getFavorites()
                .filter(app => parental.shouldShowApp(app.get_app_info()));
        }
        if (favorites.length === 0)
            showTitles = false;

        const dragParams = {...tileParams, draggable: true};
        const appFavorites = AppFavorites.getAppFavorites();

        if (favorites.length > 0) {
            const tiles = favorites.map(app => new AppTile(app, dragParams));
            const section = new Section(_('Favourites'), tiles, showTitles,
                this._columns, source => source instanceof AppTile &&
                    !appFavorites.isFavorite(source.key));
            section.connect('reordered', () => {
                // Favourites order lives in GNOME's favorite-apps list.
                section.getKeys().forEach((id, pos) => {
                    if (appFavorites.getFavorites()[pos]?.get_id() !== id)
                        appFavorites.moveFavoriteToPos(id, pos);
                });
            });
            section.connect('external-drop', (_s, source, index) => {
                appFavorites.addFavoriteAtPos(source.key, index);
            });
            this._content.add_child(section);
        }

        // Whatever the dock already shows (pinned favourites and running
        // apps) stays out of All Apps and folders.
        const inDock = new Set([
            ...appFavorites.getFavorites().map(a => a.get_id()),
            ...appSystem.get_running().map(a => a.get_id()),
        ]);
        const gridApps = all.filter(app => !inDock.has(app.get_id()));

        // Folders first, then the apps that are not inside any folder;
        // then apply the user's saved drag order on top.
        const folders = loadFolders(this._folderSettings, gridApps);
        const inFolders = new Set(folders.flatMap(f => f.apps.map(a => a.get_id())));
        let tiles = [
            ...folders.map(folder => {
                const tile = new FolderTile(folder, dragParams);
                tile.connect('open-folder', () => this._openFolder(folder, tileParams));
                return tile;
            }),
            ...gridApps.filter(app => !inFolders.has(app.get_id()))
                .map(app => new AppTile(app, dragParams)),
        ];
        const order = new Map(this._settings.get_strv('app-order').map((k, i) => [k, i]));
        if (order.size > 0) {
            const known = tiles.filter(t => order.has(t.key))
                .sort((a, b) => order.get(a.key) - order.get(b.key));
            tiles = [...known, ...tiles.filter(t => !order.has(t.key))];
        }
        this._appsSection = new Section(_('All Apps'), tiles, showTitles, this._columns);
        this._appsSection.connect('reordered', () => {
            this._settings.set_strv('app-order', this._appsSection.getKeys());
        });
        this._content.add_child(this._appsSection);
    }

    /** True when the All Apps grid already shows the saved order. */
    matchesSavedOrder() {
        const saved = this._settings.get_strv('app-order');
        const keys = this._appsSection?.getKeys() ?? [];
        const known = keys.filter(k => saved.includes(k));
        return known.length === saved.filter(k => keys.includes(k)).length &&
            known.every((k, i) => k === saved.filter(x => keys.includes(x))[i]);
    }

    _openFolder(folder, tileParams) {
        if (this._popup)
            return;
        const columns = Math.max(1, Math.min(this._columns - 2, 6));
        this._popup = new FolderPopup(folder, tileParams, columns);
        this._popup.connect('closed', () => {
            this._popup = null;
        });
        this._popup.setMaxHeight(
            this.height - 2 * this._settings.get_int('margin') - 48);
        this.add_child(this._popup);
    }
});

/**
 * Makes the desktop launcher take over GNOME's app grid while active:
 *  - the Show Apps button (GNOME dash, and Dash to Panel which routes through
 *    Overview.show(APP_GRID)), Super+A and Overview.showApps() all call
 *    toggleDesktop() instead of opening the overview app grid;
 *  - toggleDesktop() minimizes every window on the current workspace using
 *    the Shell's own minimize animation, revealing the launcher; a second
 *    call restores the windows it minimized;
 *  - the overview state is clamped so shift-overview-up and the swipe
 *    gesture stop at the window picker.
 * Everything is restored in disable().
 */
class AppGridTakeover {
    constructor() {
        this._patches = [];
        this._active = false;
        this._minimized = [];
        this._lastToggle = 0;
    }

    /** Replace an instance method, remembering how to put it back. */
    _patch(obj, name, replacement) {
        const original = obj[name];
        obj[name] = replacement(original.bind(obj));
        this._patches.push(() => {
            delete obj[name];
        });
    }

    enable() {
        if (this._active)
            return;
        this._active = true;

        const overview = Main.overview;
        const controls = overview._overview.controls;
        const dash = overview.dash;
        const adjustment = controls._stateAdjustment;

        // 1. Overview state can't go past the window picker.
        if (adjustment.value > ControlsState.WINDOW_PICKER)
            adjustment.value = ControlsState.WINDOW_PICKER;
        adjustment.upper = ControlsState.WINDOW_PICKER;
        this._patches.push(() => {
            adjustment.upper = ControlsState.APP_GRID;
        });

        // 2. Every way into the app grid becomes toggleDesktop().
        this._patch(overview, 'show', orig => state => {
            if (state === ControlsState.APP_GRID)
                this.toggleDesktop();
            else
                orig(state);
        });
        this._patch(overview, 'showApps', () => () => this.toggleDesktop());
        this._patch(controls, '_toggleAppsPage', () => () => this.toggleDesktop());
        this._patch(controls, '_shiftState', orig => direction => {
            if (direction === Meta.MotionDirection.UP &&
                adjustment.value >= ControlsState.WINDOW_PICKER)
                return;
            orig(direction);
        });
        // Swipe gesture: offer only hidden <-> window picker as snap points.
        this._patch(controls, 'gestureBegin', () => tracker => {
            const baseDistance = global.screen_height;
            const progress = adjustment.value;
            const points = [ControlsState.HIDDEN, ControlsState.WINDOW_PICKER];
            const transition = adjustment.get_transition('value');
            const cancelProgress = transition
                ? transition.get_interval().peek_final_value()
                : Math.round(progress);
            adjustment.remove_transition('value');
            tracker.confirmSwipe(baseDistance, points, progress, cancelProgress);
            controls.prepareToEnterOverview();
            adjustment.gestureInProgress = true;
        });

        // 3. Super+A: re-register the keybinding with our handler.
        const keySettings = new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA});
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.removeKeybinding('toggle-application-view');
        Main.wm.addKeybinding('toggle-application-view', keySettings, flags, modes,
            () => this.toggleDesktop());
        this._patches.push(() => {
            Main.wm.removeKeybinding('toggle-application-view');
            Main.wm.addKeybinding('toggle-application-view', keySettings, flags, modes,
                controls._toggleAppsPage.bind(controls));
        });

        // 4. The dash's Show Apps toggle: swap the controls' handler for ours.
        const button = dash.showAppsButton;
        button.disconnectObject(controls);
        button.connectObject('notify::checked', () => {
            if (!button.checked)
                return;
            // Keep it a momentary button; the desktop is the "page".
            button.checked = false;
            this.toggleDesktop();
        }, this);
        if (button.checked)
            button.checked = false;
        this._patches.push(() => {
            button.disconnectObject(this);
            button.connectObject('notify::checked',
                () => controls._onShowAppsButtonToggled(), controls);
        });
    }

    disable() {
        if (!this._active)
            return;
        this._active = false;
        while (this._patches.length)
            this._patches.pop()();
        this._minimized = [];
    }

    /** Windows that currently count as "on the desktop". */
    _visibleWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(win => win &&
                win.showing_on_its_workspace() &&
                win.located_on_workspace(workspace) &&
                win.can_minimize() &&
                !win.skip_taskbar &&
                [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                    Meta.WindowType.MODAL_DIALOG].includes(win.window_type));
    }

    /**
     * Reveal the desktop by minimizing all windows, or restore the windows
     * minimized by the previous call.
     */
    toggleDesktop() {
        // Dash to Panel checks the dash button *and* calls Overview.show
        // (APP_GRID) for one click; treat triggers in quick succession as one.
        const now = GLib.get_monotonic_time();
        if (now - this._lastToggle < 300 * 1000)
            return;
        this._lastToggle = now;

        if (Main.overview.visible)
            Main.overview.hide();

        const alive = new Set(global.get_window_actors().map(a => a.meta_window));
        const toRestore = this._minimized.filter(win => alive.has(win) && win.minimized);
        this._minimized = [];

        if (toRestore.length > 0) {
            for (const win of toRestore)
                win.unminimize();
            const top = toRestore[toRestore.length - 1];
            top.activate(global.get_current_time());
            return;
        }

        const windows = this._visibleWindows();
        if (windows.length === 0)
            return;
        // Minimize bottom-to-top so restoring (same order) keeps stacking.
        const sorted = global.display.sort_windows_by_stacking(windows);
        for (const win of sorted)
            win.minimize();
        this._minimized = sorted;
    }
}

export default class DesktopLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._layers = [];
        this._raiseLaterId = 0;
        this._rebuildIdleId = 0;

        this._bgGroup = Main.layoutManager._backgroundGroup;

        // GNOME's app folders: rebuild when folders or their contents change.
        this._folderSettings = new Gio.Settings({schema_id: FOLDER_SCHEMA});
        this._folderSettings.connectObject('changed::folder-children', () => {
            this._watchFolders();
            this._queueRebuild();
        }, this);
        this._watchedFolders = [];
        this._watchFolders();

        // Recreate layers when monitors come and go.
        Main.layoutManager.connectObject('monitors-changed',
            () => this._createLayers(), this);
        // Panel/dock struts moved: fit the new work area.
        global.display.connectObject('workareas-changed',
            () => this._layers.forEach(l => l.relayout()), this);
        // The Shell added a new wallpaper actor above us: move back on top.
        this._bgGroup.connectObject('child-added',
            (_group, child) => {
                if (!(child instanceof LauncherLayer))
                    this._queueRaise();
            }, this);

        // Content changes.
        Shell.AppSystem.get_default().connectObject(
            'installed-changed', () => this._queueRebuild(),
            // Running apps are shown by the dock, so they leave/enter the grid.
            'app-state-changed', (_sys, app) => {
                if (app.state !== Shell.AppState.STARTING)
                    this._queueRebuild();
            },
            this);
        AppFavorites.getAppFavorites().connectObject('changed',
            () => this._queueRebuild(), this);
        ParentalControlsManager.getDefault().connectObject('app-filter-changed',
            () => this._queueRebuild(), this);

        // Settings.
        for (const key of ['show-favorites', 'show-section-titles'])
            this._settings.connectObject(`changed::${key}`, () => this._queueRebuild(), this);
        // A drag on one monitor's grid saves app-order; the layer that did
        // the drag already shows it, other layers rebuild.
        this._settings.connectObject('changed::app-order', () => {
            this._layers.filter(l => !l.matchesSavedOrder()).forEach(l => l.rebuild());
        }, this);
        for (const key of ['icon-size', 'show-labels', 'margin', 'max-width']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._layers.forEach(l => l.relayout());
                this._queueRebuild();
            }, this);
        }
        this._settings.connectObject('changed::all-monitors',
            () => this._createLayers(), this);

        this._appGridTakeover = new AppGridTakeover();
        this._settings.connectObject('changed::replace-app-grid',
            () => this._syncAppGridTakeover(), this);
        this._syncAppGridTakeover();

        this._createLayers();
    }

    _syncAppGridTakeover() {
        if (this._settings.get_boolean('replace-app-grid'))
            this._appGridTakeover.enable();
        else
            this._appGridTakeover.disable();
    }

    disable() {
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._bgGroup?.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        ParentalControlsManager.getDefault().disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._folderSettings?.disconnectObject(this);
        this._unwatchFolders();
        this._folderSettings = null;

        if (this._raiseLaterId) {
            global.compositor.get_laters().remove(this._raiseLaterId);
            this._raiseLaterId = 0;
        }
        if (this._rebuildIdleId) {
            GLib.Source.remove(this._rebuildIdleId);
            this._rebuildIdleId = 0;
        }

        this._destroyLayers();
        this._appGridTakeover?.disable();
        this._appGridTakeover = null;
        this._bgGroup = null;
        this._settings = null;
    }

    _watchFolders() {
        this._unwatchFolders();
        for (const id of this._folderSettings.get_strv('folder-children')) {
            const folder = new Gio.Settings({
                schema_id: `${FOLDER_SCHEMA}.folder`,
                path: `${this._folderSettings.path}folders/${id}/`,
            });
            folder.connectObject('changed', () => this._queueRebuild(), this);
            this._watchedFolders.push(folder);
        }
    }

    _unwatchFolders() {
        this._watchedFolders?.forEach(f => f.disconnectObject(this));
        this._watchedFolders = [];
    }

    _destroyLayers() {
        this._layers?.forEach(l => l.destroy());
        this._layers = [];
    }

    _createLayers() {
        this._destroyLayers();

        const {monitors, primaryIndex} = Main.layoutManager;
        if (monitors.length === 0 || primaryIndex < 0)
            return;

        const indices = this._settings.get_boolean('all-monitors')
            ? monitors.map(m => m.index)
            : [primaryIndex];

        for (const index of indices) {
            const layer = new LauncherLayer(index, this._settings, this._folderSettings);
            this._bgGroup.add_child(layer);
            this._layers.push(layer);
        }
        this._raise();
    }

    _raise() {
        for (const layer of this._layers)
            this._bgGroup.set_child_above_sibling(layer, null);
    }

    _queueRaise() {
        if (this._raiseLaterId)
            return;
        this._raiseLaterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._raiseLaterId = 0;
                this._raise();
                return GLib.SOURCE_REMOVE;
            });
    }

    _queueRebuild() {
        if (this._rebuildIdleId)
            return;
        this._rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildIdleId = 0;
            this._layers.forEach(l => l.rebuild());
            return GLib.SOURCE_REMOVE;
        });
    }
}
