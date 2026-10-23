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
// hotplug) it lands on top, and we move it back to the bottom. Everything
// else keeps its place: the search and open folders sit above the layers,
// with Blur my Shell's blur (if any) between them.

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
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

const TILE_PADDING = 24;   // extra room around the icon inside a tile
const GRID_SPACING = 12;   // row/column spacing of the grid

const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SUBICON_FRACTION = 0.4;   // same as the Shell's app grid
const SEARCH_FADE_TIME = 150;     // the grid fading out for search results
const FOCUS_FADE_TIME = 250;      // the overview's animation time
const FOLDER_DIALOG_ANIMATION_TIME = 200;   // as the overview's AppFolderDialog
const DRAG_FADE_TIME = 150;

// Drag and drop follows the overview's app grid (appDisplay.js, iconGrid.js):
// the outer DIVIDER_LEEWAY pixels of a tile are "between" tiles and move
// the dragged item there after DELAYED_MOVE_TIMEOUT; the rest of the tile
// is "on" it: drop an app there to make a folder (the target shrinks into a
// folder preview after FOLDER_PREVIEW_DELAY) or to put it in a folder.
const DragLocation = {
    INVALID: 0,
    START_EDGE: 1,
    END_EDGE: 2,
    ON_ICON: 3,
    EMPTY_SPACE: 4,
};
const DIVIDER_LEEWAY = 20;
const DELAYED_MOVE_TIMEOUT = 200;
const FOLDER_PREVIEW_DELAY = 500;
// Dragging an app out of an open folder closes it after this long.
const POPDOWN_DIALOG_TIMEOUT = 500;
// Not in the overview: holding a dragged app over a folder opens it.
const FOLDER_SPRING_DELAY = 600;

// Blur my Shell has no API for other extensions. Its popup blur scans the
// direct children of the Shell's top-level groups, including the window
// group's background group, for actors with one of its target style
// classes, and blurs what is behind them with the user's popup settings,
// following their visibility, opacity and size. This one is its own marker
// class (no theme styles it), so the full-screen search and the open
// folder's backdrop get the background blurred behind them. Both must be
// direct children of the background group, above the launcher layer.
const BLUR_MY_SHELL_TARGET = 'bms-keyboard-surface';

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
        const folder = getFolder(folderSettings, id);
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
        // Order: 'apps' as stored (dragging inside a folder rewrites it),
        // then category matches by name, as the overview's FolderView.
        folders.push({
            id,
            name: getFolderName(folder),
            apps: [...members.values()],
        });
    }
    return folders;
}

function getFolder(folderSettings, id) {
    return new Gio.Settings({
        schema_id: `${FOLDER_SCHEMA}.folder`,
        path: `${folderSettings.path}folders/${id}/`,
    });
}

/**
 * Name for a new folder: the first category all its apps share that has a
 * translated .directory name, like the overview's _findBestFolderName.
 */
function findBestFolderName(apps) {
    const [first, ...rest] = apps.map(app => getCategories(app.get_app_info()));
    const common = first.filter(c => c.length > 0 && rest.every(cats => cats.includes(c)));
    for (const category of common) {
        const translated = Shell.util_get_translated_folder_name(`${category}.directory`);
        if (translated !== null)
            return translated;
    }
    return _('Unnamed Folder');
}

/**
 * Create a GNOME app folder holding the given apps, as the overview does.
 *
 * @param {Gio.Settings} folderSettings
 * @param {Shell.App[]} apps
 * @returns {string} the new folder id
 */
function createFolder(folderSettings, apps) {
    const id = GLib.uuid_string_random();
    folderSettings.set_strv('folder-children',
        [...folderSettings.get_strv('folder-children'), id]);

    const folder = getFolder(folderSettings, id);
    folder.delay();
    folder.set_string('name', findBestFolderName(apps));
    folder.set_strv('apps', apps.map(app => app.get_id()));
    folder.apply();
    return id;
}

function addAppToFolder(folderSettings, id, appId) {
    const folder = getFolder(folderSettings, id);
    const apps = folder.get_strv('apps');
    if (!apps.includes(appId))
        folder.set_strv('apps', [...apps, appId]);
    // Only categories-based folders have excluded apps.
    const excluded = folder.get_strv('excluded-apps');
    if (excluded.includes(appId))
        folder.set_strv('excluded-apps', excluded.filter(a => a !== appId));
}

/**
 * Store the order of a folder's visible apps. Listed apps the launcher
 * doesn't show (pinned or running ones) keep their entry after them.
 */
function setFolderOrder(folderSettings, id, appIds) {
    const folder = getFolder(folderSettings, id);
    const hidden = folder.get_strv('apps').filter(a => !appIds.includes(a));
    folder.set_strv('apps', [...appIds, ...hidden]);
}

/**
 * Take an app out of a folder. A categories-based folder lists it in
 * 'excluded-apps' so the category match doesn't pull it back in; a folder
 * left with neither apps nor categories is deleted.
 */
function removeAppFromFolder(folderSettings, id, appId) {
    const folder = getFolder(folderSettings, id);
    const apps = folder.get_strv('apps').filter(a => a !== appId);
    const categories = folder.get_strv('categories');

    if (apps.length === 0 && categories.length === 0) {
        // Resetting all keys deletes the relocatable schema's data.
        for (const key of folder.settings_schema.list_keys())
            folder.reset(key);
        folderSettings.set_strv('folder-children',
            folderSettings.get_strv('folder-children').filter(f => f !== id));
        return;
    }

    if (categories.length > 0) {
        const excluded = folder.get_strv('excluded-apps');
        if (!excluded.includes(appId))
            folder.set_strv('excluded-apps', [...excluded, appId]);
    }
    folder.set_strv('apps', apps);
}

/** Whether the stage point (x, y) is inside the actor. */
function isInside(actor, x, y) {
    const [ax, ay] = actor.get_transformed_position();
    const [aw, ah] = actor.get_transformed_size();
    return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
}

/** Side length of a (square) tile for the given settings. */
function tileSide(iconSize, showLabel) {
    return iconSize + TILE_PADDING * 2 + (showLabel ? 24 : 0);
}

/**
 * Drag-source behaviour shared by app and folder tiles. Like the overview's
 * scaleAndFade(), the tile shrinks away and leaves an empty slot while a
 * copy of its icon follows the pointer (Shell DND); grids listen on
 * tile.draggable for drag-begin / drag-end to reorder and persist.
 *
 * @param {St.Button} tile
 */
function makeTileDraggable(tile) {
    tile._delegate = tile;
    tile.draggable = DND.makeDraggable(tile, {timeoutThreshold: 200});
    tile.draggable.connect('drag-begin', () => {
        tile.reactive = false;
        tile.set_pivot_point(0.5, 0.5);
        tile.ease({
            opacity: 0,
            scale_x: 0.5,
            scale_y: 0.5,
            duration: DRAG_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
    tile.draggable.connect('drag-end', () => {
        tile.reactive = true;
        tile.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: DRAG_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });
}

/**
 * One app icon on the desktop.
 */
const AppTile = GObject.registerClass(
class AppTile extends St.Button {
    _init(app, {iconSize, showLabel, draggable = false, inDialog = false}) {
        // In a folder dialog the tile is a plain overview tile, styled by
        // the theme's .app-folder-dialog rules rather than for the wallpaper.
        super._init({
            style_class: inDialog ? 'overview-tile' : 'desktop-launcher-tile overview-tile',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            can_focus: true,
            reactive: true,
            accessible_name: app.get_name(),
        });

        this.app = app;
        this.key = app.get_id();
        // Set on tiles inside an open folder: the folder they come from.
        this.folderId = null;

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

        // Running indicator: the overview's app-grid dot, placed by the
        // theme's offset-y as AppIcon._updateDotStyle does.
        this._dot = new St.Widget({
            style_class: 'app-grid-running-dot',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._dot.connect('style-changed', () => {
            this._dot.translation_y = this._dot.get_theme_node().get_length('offset-y');
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

    // As the overview's AppIcon: the bare icon follows the pointer.
    getDragActor() {
        return this.app.create_icon_texture(
            Main.overview.dash?.iconSize ?? this.icon.iconSize);
    }

    getDragActorSource() {
        return this.icon.icon;
    }

    _updateDot() {
        this._dot.visible = this.app.state !== Shell.AppState.STOPPED;
    }

    /** An app hovered by another app shrinks to show it becomes a folder. */
    showFolderPreview() {
        if (this.icon.label)
            this.icon.label.opacity = 0;
        this.icon.icon.set_pivot_point(0.5, 0.5);
        this.icon.icon.ease({
            scale_x: FOLDER_SUBICON_FRACTION,
            scale_y: FOLDER_SUBICON_FRACTION,
        });
    }

    hideFolderPreview() {
        if (this.icon.label)
            this.icon.label.opacity = 255;
        this.icon.icon.ease({
            scale_x: 1,
            scale_y: 1,
        });
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

    // As the overview's FolderIcon: a copy of the tile follows the pointer.
    getDragActor() {
        const icon = new IconGrid.BaseIcon(this.folder.name, {
            createIcon: size => this._createFolderIcon(size),
            showLabel: this.icon.label !== null,
            setSizeManually: true,
        });
        icon.setIconSize(this.icon.iconSize);
        icon.style_class = this.style_class;
        return icon;
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
 * The opened folder, after the overview's AppFolderDialog: an invisible
 * backdrop over the launcher (a click outside closes it) with a centred
 * panel holding the folder's apps. Launching an app closes it too.
 *
 * Apps inside are reordered by dragging, like any grid ('reordered' with
 * the new order). Dragging one out of the panel closes the folder after
 * POPDOWN_DIALOG_TIMEOUT so it can be dropped on the grid behind; dropping
 * it on the backdrop before that emits 'app-removed'. The popup only hides
 * meanwhile: the dragged tile lives in it until the drag ends.
 *
 * The pencil next to the title renames the folder. The launcher lives
 * below the windows, which own the keyboard, so the entry takes a modal
 * grab while editing. Enter saves; Escape or a click outside saves and
 * closes, as in the overview. 'rename-finished' carries the new name.
 *
 * Opened by holding a dragged app over the folder (dragSource), the panel
 * takes the drop ('app-added' with the position), and so does the
 * backdrop until the pointer has been inside the panel.
 */
const FolderPopup = GObject.registerClass({
    Signals: {
        'closed': {},
        'rename-finished': {param_types: [GObject.TYPE_STRING]},
        'reordered': {param_types: [GObject.TYPE_JSOBJECT]},
        'app-added': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_INT]},
        'app-removed': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class FolderPopup extends St.Widget {
    _init(folder, tileParams, columns, {source = null, animate = true, dragSource = null} = {}) {
        super._init({
            style_class: `desktop-launcher-folder-backdrop ${BLUR_MY_SHELL_TARGET}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
            y_expand: true,
        });

        this.folder = folder;
        this._closing = false;
        this._hiddenForDrag = false;
        // The folder tile it opened from: hidden while open, and where the
        // dialog zooms from and back to.
        this._source = source;
        source?.connectObject('destroy', () => (this._source = null), this);
        this._grab = null;
        this._entry = null;
        this._dragMonitor = null;
        this._popdownId = 0;

        // The overview's AppFolderDialog structure and theme classes:
        // container > .app-folder-dialog > .folder-name-container + grid.
        // Only the dialog's fixed 720px size is overridden (stylesheet), so
        // it fits the folder's apps.
        this._panel = new St.BoxLayout({
            style_class: 'app-folder-dialog desktop-launcher-folder-dialog',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(new St.Bin({
            style_class: 'app-folder-dialog-container',
            child: this._panel,
            x_expand: true,
            y_expand: true,
        }));

        this._header = new St.BoxLayout({
            style_class: 'folder-name-container',
            x_expand: true,
        });
        this._panel.add_child(this._header);

        // Empty actor the size of the edit button, to centre the title.
        const ghost = new Clutter.Actor();
        this._header.add_child(ghost);

        this._title = new St.Label({
            style_class: 'folder-name-label',
            text: folder.name,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._title);

        this._renameButton = new St.Button({
            style_class: 'icon-button',
            icon_name: 'document-edit-symbolic',
            accessible_name: _('Rename'),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ghost.add_constraint(new Clutter.BindConstraint({
            source: this._renameButton,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._renameButton.connect('clicked', () => {
            if (this._entry)
                this._finishRename();
            else
                this._startRename();
        });
        this._header.add_child(this._renameButton);

        const scroll = new St.ScrollView({
            style_class: 'desktop-launcher-folder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._panel.add_child(scroll);

        const tiles = folder.apps.map(app => {
            const tile = new AppTile(app, {...tileParams, draggable: true, inDialog: true});
            tile.folderId = folder.id;
            tile.connect('clicked', () => this.close());
            return tile;
        });
        const accepts = source => source === dragSource;
        const slots = tiles.length + (dragSource ? 1 : 0);
        const grid = new TileGrid(tiles, Math.min(columns, slots), {
            acceptsExternal: accepts,
        });
        grid.connect('reordered', () => this.emit('reordered', grid.getKeys()));
        grid.connect('external-drop', (_s, source, index) => this._addApp(source, index));
        if (dragSource)
            grid.reserveExternalSlot();
        scroll.set_child(grid);

        // Outside the grid: the panel (title, padding) keeps an app in the
        // folder, the backdrop takes it out (or, for an app brought in by
        // holding it over the folder, still puts it in).
        const isOwn = source => tiles.includes(source);
        this._panel._delegate = {
            handleDragOver: source => (isOwn(source) || accepts(source)
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP),
            acceptDrop: source => {
                if (accepts(source))
                    return this._addApp(source, -1);
                return isOwn(source);
            },
        };
        this._delegate = {
            handleDragOver: source => (isOwn(source) || accepts(source)
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP),
            acceptDrop: source => {
                if (accepts(source))
                    return this._addApp(source, -1);
                if (!isOwn(source))
                    return false;
                this.emit('app-removed', source);
                this.close();
                return true;
            },
        };

        // Connected after the grid's own drag handlers, which still
        // touch the grid on drag-end.
        for (const tile of tiles) {
            tile.draggable.connect('drag-begin', () => this._trackDrag(tile, false));
            tile.draggable.connect('drag-end', () => {
                this._stopTrackingDrag();
                if (this._hiddenForDrag) {
                    this.emit('closed');
                    this.destroy();
                }
            });
        }
        this._dropped = false;
        if (dragSource)
            this._trackDrag(dragSource, true);
        this.connect('destroy', () => this._stopTrackingDrag());

        // Clicks outside the panel close the popup. Don't stop propagation
        // on the panel itself: a signal handler that consumes a press makes
        // Clutter cancel every gesture still deciding, including the
        // St.Button click gesture of the tile underneath.
        this.connect('button-release-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            if (isInside(this._panel, x, y))
                return Clutter.EVENT_PROPAGATE;
            this._finishRename();
            this.close();
            return Clutter.EVENT_STOP;
        });
        // Escape closes the folder, as in the overview. Without keyboard
        // focus inside, the desktop's key catcher handles it.
        this.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._finishRename();
            this.close();
            return Clutter.EVENT_STOP;
        });

        this.connect('destroy', () => {
            if (this._source)
                this._source.opacity = 255;
        });
        this._setSourceHidden(true, animate);
        if (!animate)
            return;

        // Zoom in from the folder tile once the dialog has its place, as
        // AppFolderDialog._zoomAndFadeIn.
        this.opacity = 0;
        this._panel.connectObject('notify::allocation', () => {
            if (this._panel.width === 0)
                return;
            this._panel.disconnectObject(this);
            this._zoomAndFadeIn();
        }, this);
    }

    /** Hide or show the folder tile, timed as the overview's FolderIcon. */
    _setSourceHidden(hidden, animate = true) {
        if (!this._source)
            return;
        const duration = FOLDER_DIALOG_ANIMATION_TIME / 2;
        this._source.ease({
            opacity: hidden ? 0 : 255,
            duration: animate ? duration : 0,
            delay: hidden || !animate ? 0 : FOLDER_DIALOG_ANIMATION_TIME - duration,
            mode: hidden
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    /** Panel transform that puts it over the folder tile, or null. */
    _sourceTransform() {
        if (!this._source?.mapped || this._panel.width === 0)
            return null;
        const [sx, sy] = this._source.get_transformed_position();
        const [px, py] = this._panel.get_transformed_position();
        return {
            translation_x: sx - (px - this._panel.translation_x),
            translation_y: sy - (py - this._panel.translation_y),
            scale_x: this._source.width / this._panel.width,
            scale_y: this._source.height / this._panel.height,
        };
    }

    _zoomAndFadeIn() {
        this._panel.set_pivot_point(0, 0);
        const from = this._sourceTransform();
        if (from)
            this._panel.set({...from, opacity: 0});
        this.ease({
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._panel.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
    }

    /** AppFolderDialog._zoomAndFadeOut: back into the folder tile. */
    _zoomAndFadeOut(onComplete) {
        this._panel.set_pivot_point(0, 0);
        const to = this._sourceTransform();
        this._setSourceHidden(false);
        this._panel.ease({
            ...to ?? {},
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        this.ease({
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete,
        });
    }

    /** Keep the panel from growing taller than the launcher. */
    setMaxHeight(height) {
        this._panel.set_style(`max-height: ${Math.max(200, height)}px;`);
    }

    get renaming() {
        return this._entry !== null;
    }

    get closing() {
        return this._closing;
    }

    _addApp(source, index) {
        this._dropped = true;
        this.emit('app-added', source, index);
        return true;
    }

    /**
     * While a drag is on, leaving the panel closes the folder after
     * POPDOWN_DIALOG_TIMEOUT and coming back cancels that. A popup opened
     * by holding an app over the folder opens away from the pointer, so for
     * it the countdown only starts once the pointer has been inside.
     */
    _trackDrag(source, external) {
        let entered = !external;
        this._dragMonitor = {
            dragMotion: event => {
                if (isInside(this._panel, event.x, event.y)) {
                    entered = true;
                    this._removePopdownTimeout();
                } else if (entered && !this._popdownId) {
                    this._popdownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                        POPDOWN_DIALOG_TIMEOUT, () => {
                            this._popdownId = 0;
                            this._popdownForDrag(external);
                            return GLib.SOURCE_REMOVE;
                        });
                }
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        if (external) {
            source.draggable.connectObject('drag-end', () => {
                this._stopTrackingDrag();
                if (!this._dropped)
                    this.close();
            }, this);
        }
    }

    _removePopdownTimeout() {
        if (this._popdownId)
            GLib.source_remove(this._popdownId);
        this._popdownId = 0;
    }

    _stopTrackingDrag() {
        this._removePopdownTimeout();
        if (!this._dragMonitor)
            return;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    /**
     * Close under a drag. A drag that started inside must keep its tile
     * alive until it ends, so hide rather than destroy (hidden actors are
     * not picked as drop targets); drag-end destroys the popup.
     */
    _popdownForDrag(external) {
        this._stopTrackingDrag();
        this._finishRename();
        if (external) {
            this.close();
            return;
        }
        this._closing = true;
        this._hiddenForDrag = true;
        this.reactive = false;
        this._zoomAndFadeOut(() => this.hide());
    }

    _startRename() {
        if (this._entry || this._closing)
            return;
        this._entry = new St.Entry({
            style_class: 'folder-name-entry',
            text: this.folder.name,
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._entry.clutter_text.connect('activate', () => this._finishRename());
        this._entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._finishRename();
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._title.hide();
        this._header.insert_child_above(this._entry, this._title);
        this._renameButton.checked = true;

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._entry.clutter_text.grab_key_focus();
        this._entry.clutter_text.set_selection(0, -1);
    }

    /** Leave the entry, keeping a non-empty new name. */
    _finishRename() {
        if (!this._entry)
            return;
        const name = this._entry.text.trim();
        this._entry.destroy();
        this._entry = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (name)
            this._title.text = name;
        this._title.show();
        this._renameButton.checked = false;
        this.emit('rename-finished', name);
    }

    close() {
        if (this._closing)
            return;
        this._stopTrackingDrag();
        this._closing = true;
        this.reactive = false;
        this._zoomAndFadeOut(() => {
            this.emit('closed');
            this.destroy();
        });
    }
});

/**
 * A grid of tiles: the launcher's apps and folders, or an open folder's apps.
 *
 * The column count is passed in rather than derived from the allocation:
 * Clutter.FlowLayout cannot report a reliable height inside a scroll view,
 * so the owning LauncherLayer computes the columns from its own width.
 *
 * The grid is a Shell DND drop target that works like the overview's app
 * grid. Hovering a tile's edge (or the empty space after the last tile)
 * moves the dragged tile there after DELAYED_MOVE_TIMEOUT; its empty slot
 * travels with it. A drop emits 'reordered'. Tiles from elsewhere that
 * acceptsExternal(source) allows drop in with 'external-drop' (source,
 * index); an empty slot shows where, moving the same way. Dropping on the middle of a tile that canMerge(source, tile)
 * allows emits 'merge' instead; holding over a folder tile there emits
 * 'drop-target-held'.
 */
const TileGrid = GObject.registerClass({
    Signals: {
        'reordered': {},
        'external-drop': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_INT]},
        'merge': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_JSOBJECT]},
        'drop-target-held': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_JSOBJECT]},
    },
}, class TileGrid extends St.BoxLayout {
    _init(tiles, columns, {
        acceptsExternal = () => false,
        canMerge = () => false,
    } = {}) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._columns = Math.max(1, columns);
        this._tiles = [];
        this._acceptsExternal = acceptsExternal;
        this._canMerge = canMerge;
        this._orderBeforeDrag = null;
        this._placeholder = null;
        this._delayedMove = null;
        this._hoverTile = null;
        this._previewId = 0;
        this._springId = 0;
        this._dragSource = null;
        this._dragMonitor = null;
        this.connect('destroy', () => this._endDrag());

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
            this._attach(tile, i);
            if (tile.draggable) {
                tile.draggable.connect('drag-begin', () => {
                    this._orderBeforeDrag = [...this._tiles];
                });
                tile.draggable.connect('drag-end', (_d, _time, success) => {
                    this._endDrag();
                    if (!success && this._orderBeforeDrag)
                        this._setOrder(this._orderBeforeDrag);
                    this._orderBeforeDrag = null;
                });
            }
        });
    }

    /** Keys (app ids / folder:ID) in current display order. */
    getKeys() {
        return this._tiles.filter(t => t !== this._placeholder).map(t => t.key);
    }

    _attach(tile, i) {
        this._layout.attach(tile, i % this._columns, Math.floor(i / this._columns), 1, 1);
    }

    _setOrder(tiles) {
        if (tiles.length === this._tiles.length &&
            tiles.every((t, i) => t === this._tiles[i]))
            return;
        // GridLayout has no public "move child"; re-attach in order.
        for (const tile of this._tiles) {
            if (tile.get_parent() === this._grid)
                this._grid.remove_child(tile);
        }
        this._tiles = tiles;
        tiles.forEach((tile, i) => this._attach(tile, i));
    }

    _moveTile(tile, to) {
        const tiles = this._tiles.filter(t => t !== tile);
        tiles.splice(Math.min(to, tiles.length), 0, tile);
        this._setOrder(tiles);
    }

    _metrics() {
        const side = this._tiles.find(t => t !== this._placeholder)?.width ||
            tileSide(64, true);
        return {side, step: side + GRID_SPACING};
    }

    /**
     * IconGrid.getDropTarget for this single-page grid: the tile index
     * under the grid-relative point and where on it, or -1 for the empty
     * space after the last tile.
     */
    _getDropTarget(x, y) {
        const n = this._tiles.length;
        const {side, step} = this._metrics();
        const half = GRID_SPACING / 2;
        const rows = Math.ceil(n / this._columns);
        if (n === 0)
            return [-1, DragLocation.EMPTY_SPACE];
        if (y < -half || y > rows * step - half)
            return [-1, DragLocation.INVALID];

        const row = Math.max(0, Math.floor((y + half) / step));
        const col = Math.min(this._columns - 1, Math.max(0, Math.floor((x + half) / step)));
        const index = row * this._columns + col;
        if (index >= n)
            return [-1, DragLocation.EMPTY_SPACE];

        const x1 = col * step;
        if (x < x1 + DIVIDER_LEEWAY)
            return [index, DragLocation.START_EDGE];
        if (x > x1 + side - DIVIDER_LEEWAY)
            return [index, DragLocation.END_EDGE];
        return [index, DragLocation.ON_ICON];
    }

    /**
     * BaseAppView._getDropTarget: on an edge the drag can't push the
     * hovered tile away from, aim at the neighbour that can be pushed.
     */
    _adjustForReflow(sourceIndex, index, location) {
        if (index === -1 || sourceIndex === index)
            return [index, location];
        const col = index % this._columns;
        const reflowStart = sourceIndex !== -1 && sourceIndex < index;
        if (location === DragLocation.START_EDGE && reflowStart && col > 0)
            return [index - 1, DragLocation.END_EDGE];
        if (location === DragLocation.END_EDGE && !reflowStart && col < this._columns - 1)
            return [index + 1, DragLocation.START_EDGE];
        return [index, location];
    }

    /** The tile the point is on (not between tiles) if source may merge. */
    _mergeTargetAt(source, x, y) {
        const [index, location] = this._getDropTarget(x, y);
        if (location !== DragLocation.ON_ICON)
            return null;
        const {side, step} = this._metrics();
        const y1 = Math.floor(index / this._columns) * step;
        const tile = this._tiles[index];
        if (y < y1 || y > y1 + side || tile === source || tile === this._placeholder ||
            !this._canMerge(source, tile))
            return null;
        return tile;
    }

    /** BaseAppView._maybeMoveItem: schedule moving item to the point. */
    _maybeMoveItem(item, x, y) {
        const from = this._tiles.indexOf(item);
        const [index, location] = this._adjustForReflow(from, ...this._getDropTarget(x, y));
        const to = index === -1 ? this._tiles.length - 1 : index;
        if (location === DragLocation.INVALID || location === DragLocation.ON_ICON ||
            this._tiles[to] === item) {
            this._removeDelayedMove();
            return;
        }
        if (this._delayedMove?.index === to)
            return;
        this._removeDelayedMove();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAYED_MOVE_TIMEOUT, () => {
            this._delayedMove = null;
            this._moveTile(item, to);
            return GLib.SOURCE_REMOVE;
        });
        this._delayedMove = {item, index: to, id};
    }

    _removeDelayedMove() {
        if (this._delayedMove)
            GLib.source_remove(this._delayedMove.id);
        this._delayedMove = null;
    }

    /** A drop before the delayed move fired still lands there. */
    _flushDelayedMove() {
        if (!this._delayedMove)
            return;
        const {item, index} = this._delayedMove;
        this._removeDelayedMove();
        this._moveTile(item, index);
    }

    /**
     * Show the empty slot for an external drop right away, so the grid
     * doesn't grow (and a centred one shift) under the pointer later.
     */
    reserveExternalSlot() {
        this._ensurePlaceholder();
    }

    _ensurePlaceholder() {
        if (this._placeholder)
            return;
        const {side} = this._metrics();
        this._placeholder = new St.Widget({width: side, height: side});
        this._tiles.push(this._placeholder);
        this._attach(this._placeholder, this._tiles.length - 1);
    }

    _removePlaceholder() {
        if (!this._placeholder)
            return;
        const placeholder = this._placeholder;
        this._placeholder = null;
        this._setOrder(this._tiles.filter(t => t !== placeholder));
        placeholder.destroy();
    }

    /**
     * Highlight the tile a drop would merge into, as the overview's icons
     * do: a folder at once, an app after FOLDER_PREVIEW_DELAY with the
     * folder preview.
     */
    _setHover(tile) {
        if (tile === this._hoverTile)
            return;
        if (this._hoverTile) {
            this._hoverTile.remove_style_pseudo_class('drop');
            this._hoverTile.hideFolderPreview?.();
        }
        for (const id of [this._previewId, this._springId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._previewId = this._springId = 0;
        this._hoverTile = tile;
        if (!tile)
            return;

        if (tile instanceof FolderTile) {
            tile.add_style_pseudo_class('drop');
            this._springId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOLDER_SPRING_DELAY, () => {
                this._springId = 0;
                this.emit('drop-target-held', tile, this._dragSource);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._previewId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOLDER_PREVIEW_DELAY, () => {
                this._previewId = 0;
                tile.add_style_pseudo_class('drop');
                tile.showFolderPreview();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * DND has no "drag left" notification for targets: a drag monitor
     * stops hovering and pending moves once the pointer leaves the grid,
     * and the source's drag-end cleans up (also when a drag is cancelled).
     */
    _beginDrag(source) {
        if (this._dragSource === source)
            return;
        if (this._dragSource)
            this._endDrag();
        this._dragSource = source;
        this._dragMonitor = {
            dragMotion: event => {
                if (!this.contains(event.targetActor)) {
                    this._setHover(null);
                    this._removeDelayedMove();
                }
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        source.draggable.connectObject('drag-end', () => this._endDrag(), this);
    }

    _endDrag() {
        this._removeDelayedMove();
        this._setHover(null);
        this._removePlaceholder();
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._dragSource?.draggable.disconnectObject(this);
        this._dragSource = null;
    }

    handleDragOver(source, _actor, x, y) {
        const own = this._tiles.includes(source);
        if (!own && !this._acceptsExternal(source))
            return DND.DragMotionResult.NO_DROP;
        this._beginDrag(source);

        const target = this._mergeTargetAt(source, x, y);
        this._setHover(target);
        if (target) {
            this._removeDelayedMove();
            return DND.DragMotionResult.MOVE_DROP;
        }
        if (!own)
            this._ensurePlaceholder();
        this._maybeMoveItem(own ? source : this._placeholder, x, y);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x, y) {
        const own = this._tiles.includes(source);
        if (!own && !this._acceptsExternal(source))
            return false;

        const target = this._mergeTargetAt(source, x, y);
        this._setHover(null);
        if (target) {
            this._removeDelayedMove();
            this._removePlaceholder();
            this.emit('merge', source, target);
            return true;
        }

        this._flushDelayedMove();
        if (own) {
            this._orderBeforeDrag = null;
            this.emit('reordered');
            return true;
        }

        let index;
        if (this._placeholder) {
            index = this._tiles.indexOf(this._placeholder);
            this._removePlaceholder();
        } else {
            const [i, location] = this._getDropTarget(x, y);
            index = i === -1 ? this._tiles.length
                : i + (location === DragLocation.END_EDGE ? 1 : 0);
        }
        this.emit('external-drop', source, index);
        return true;
    }
});

/**
 * The full-work-area launcher for one monitor.
 */
const LauncherLayer = GObject.registerClass(
class LauncherLayer extends St.Widget {
    _init(monitorIndex, settings, folderSettings, queueRebuild) {
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
        this._queueRebuild = queueRebuild;
        this._faded = false;
        this._columns = 0;
        this._popup = null;
        this._rebuildPending = false;
        this._appGrid = null;

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
        // Don't throw away a name being typed; rebuild when editing ends.
        if (this._popup?.renaming) {
            this._rebuildPending = true;
            return;
        }
        // An open folder stays open across the rebuild.
        const openFolderId = this._popup && !this._popup.closing
            ? this._popup.folder.id : null;
        // A closing popup finishes by itself; one hidden for a drag out of
        // it holds the dragged tile and must live until the drag ends.
        if (!this._popup?.closing)
            this._popup?.destroy();
        this._popup = null;
        this._appGrid = null;
        this._content.destroy_all_children();

        const tileParams = {
            iconSize: this._settings.get_int('icon-size'),
            showLabel: this._settings.get_boolean('show-labels'),
        };
        const appSystem = Shell.AppSystem.get_default();
        const parental = ParentalControlsManager.getDefault();

        const all = appSystem.get_installed()
            .filter(info => info.should_show() && parental.shouldShowApp(info))
            .map(info => appSystem.lookup_app(info.get_id()))
            .filter(app => app !== null)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        const dragParams = {...tileParams, draggable: true};
        const appFavorites = AppFavorites.getAppFavorites();

        // Whatever the dock already shows (pinned favourites and running
        // apps) stays out of the grid and folders.
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
                tile.connect('open-folder', () => this._openFolder(folder, tileParams, {source: tile}));
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
        // As in the overview: apps dragged out of an open folder drop
        // anywhere on the grid (an empty slot shows where); an app from the
        // grid dropped on the middle of an app makes a folder, on a folder
        // goes in. Holding it over a folder also opens the folder.
        this._appGrid = new TileGrid(tiles, this._columns, {
            acceptsExternal: source => source instanceof AppTile && source.folderId !== null,
            canMerge: (source, target) => source instanceof AppTile &&
                this._appGrid._tiles.includes(source) &&
                (target instanceof AppTile || target instanceof FolderTile),
        });
        this._appGrid.connect('reordered', () => {
            this._settings.set_strv('app-order', this._appGrid.getKeys());
        });
        this._appGrid.connect('external-drop', (_s, source, index) => {
            const keys = this._appGrid.getKeys().filter(k => k !== source.key);
            keys.splice(index, 0, source.key);
            this._settings.set_strv('app-order', keys);
            removeAppFromFolder(this._folderSettings, source.folderId, source.key);
        });
        this._appGrid.connect('merge', (_s, source, target) => this._merge(source, target));
        this._appGrid.connect('drop-target-held', (_s, target, source) => {
            if (target instanceof FolderTile)
                this._openFolder(target.folder, tileParams, {source: target, dragSource: source});
        });
        this._content.add_child(this._appGrid);

        const openTile = tiles.find(t => t.key === `folder:${openFolderId}`);
        if (openTile)
            this._openFolder(openTile.folder, tileParams, {source: openTile, animate: false});
    }

    /**
     * Drop of an app tile on the middle of another tile in the grid: into
     * the folder, or a new folder of both apps where the target app was.
     * Settings writes only; the rebuild they trigger runs once the drag has
     * finished.
     */
    _merge(source, target) {
        if (target instanceof FolderTile) {
            this._moveIntoFolder(source, target.folder.id);
            return;
        }
        if (source.folderId)
            removeAppFromFolder(this._folderSettings, source.folderId, source.key);
        const id = createFolder(this._folderSettings, [target.app, source.app]);
        const keys = this._appGrid.getKeys()
            .map(k => (k === target.key ? `folder:${id}` : k));
        this._settings.set_strv('app-order', keys.filter(k => k !== source.key));
    }

    _moveIntoFolder(source, folderId) {
        if (source.folderId === folderId)
            return;
        if (source.folderId)
            removeAppFromFolder(this._folderSettings, source.folderId, source.key);
        addAppToFolder(this._folderSettings, folderId, source.key);
        this._settings.set_strv('app-order',
            this._appGrid.getKeys().filter(k => k !== source.key));
    }

    /** An app dragged out of a folder and dropped beside it: last in the grid. */
    _takeOutOfFolder(source) {
        const keys = this._appGrid.getKeys().filter(k => k !== source.key);
        this._settings.set_strv('app-order', [...keys, source.key]);
        removeAppFromFolder(this._folderSettings, source.folderId, source.key);
    }

    _renameFolder(id, name) {
        const folder = getFolder(this._folderSettings, id);
        if (folder.get_string('name') === name && !folder.get_boolean('translate'))
            return;
        folder.delay();
        folder.set_string('name', name);
        folder.set_boolean('translate', false);
        folder.apply();
    }

    _runPendingRebuild() {
        if (!this._rebuildPending)
            return;
        this._rebuildPending = false;
        this._queueRebuild();
    }

    closeFolder() {
        this._popup?.close();
    }

    /**
     * Fade the icons out while app windows are open on this monitor.
     * Faded, they are hidden too, so a click beside the windows can't
     * launch anything unseen.
     */
    setFaded(faded) {
        if (this._faded === faded)
            return;
        this._faded = faded;
        if (faded)
            this.closeFolder();
        else
            this._content.show();
        this._content.ease({
            opacity: faded ? 0 : 255,
            duration: FOCUS_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._faded)
                    this._content.hide();
            },
        });
    }

    /** Type-to-search replaces the grid while it shows results. */
    setSearchActive(active) {
        if (active)
            this._popup?.close();
        this._scroll.ease({
            opacity: active ? 0 : 255,
            duration: SEARCH_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._scroll.visible = !active),
        });
        if (!active)
            this._scroll.visible = true;
    }

    /** True when the grid already shows the saved order. */
    matchesSavedOrder() {
        const saved = this._settings.get_strv('app-order');
        const keys = this._appGrid?.getKeys() ?? [];
        const known = keys.filter(k => saved.includes(k));
        return known.length === saved.filter(k => keys.includes(k)).length &&
            known.every((k, i) => k === saved.filter(x => keys.includes(x))[i]);
    }

    _openFolder(folder, tileParams, {source = null, animate = true, dragSource = null} = {}) {
        if (this._popup)
            return;
        const columns = Math.max(1, Math.min(this._columns - 2, 6));
        const popup = new FolderPopup(folder, tileParams, columns, {source, animate, dragSource});
        this._popup = popup;
        popup.connect('closed', () => {
            if (this._popup === popup)
                this._popup = null;
            this._runPendingRebuild();
        });
        popup.connect('rename-finished', (_p, name) => {
            if (name)
                this._renameFolder(folder.id, name);
            this._runPendingRebuild();
        });
        popup.connect('reordered', (_p, keys) =>
            setFolderOrder(this._folderSettings, folder.id, keys));
        popup.connect('app-added', (_p, source, index) => {
            const order = folder.apps.map(app => app.get_id());
            order.splice(index < 0 ? order.length : index, 0, source.key);
            this._moveIntoFolder(source, folder.id);
            setFolderOrder(this._folderSettings, folder.id, order);
        });
        popup.connect('app-removed', (_p, source) => this._takeOutOfFolder(source));
        popup.setMaxHeight(
            this.height - 2 * this._settings.get_int('margin') - 48);
        // Beside the layer, not in it, covering the whole work area: see
        // BLUR_MY_SHELL_TARGET. It still belongs to this layer.
        popup.add_constraint(new Clutter.BindConstraint({
            source: this,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this.connectObject('destroy', () => popup.destroy(), popup);
        this.get_parent().add_child(popup);
    }
});

/** searchController.js: the search terms in a string, [] when blank. */
function getTermsForSearchString(searchString) {
    searchString = searchString.trim();
    if (searchString === '')
        return [];
    return searchString.split(/\s+/);
}

/**
 * Run fn, returning it with the ids of the signal handlers it connected on
 * the given objects, so they can be disconnected later.
 */
function trackConnections(objects, fn) {
    const tracked = [];
    for (const obj of objects) {
        obj.connect = (...args) => {
            const id = Object.getPrototypeOf(obj).connect.apply(obj, args);
            tracked.push([obj, id]);
            return id;
        };
    }
    try {
        return [fn(), tracked];
    } finally {
        for (const obj of objects)
            delete obj.connect;
    }
}

/**
 * Type-to-search on the desktop, with the overview's own search: the
 * Shell's SearchResultsView (apps, plus every search provider: Files,
 * Settings, Calculator, ...) behind a search entry that only appears once
 * something is typed. Key handling follows searchController.js.
 *
 * Typing needs the keyboard, which normally belongs to the focused
 * window. keyCatcher, a tiny actor in the launcher, takes the stage key
 * focus whenever the desktop is what the user is looking at: no window
 * focused, or a click on the desktop. Setting a stage key focus makes the
 * Shell unfocus the window (shell-global.c), and focusing a window clears
 * it again. A printable key on keyCatcher starts the search.
 */
const DesktopSearch = GObject.registerClass({
    Properties: {
        'active': GObject.ParamSpec.boolean('active', null, null,
            GObject.ParamFlags.READABLE, false),
    },
    // Escape pressed while the desktop has the keyboard (closes a folder).
    Signals: {'escape': {}},
}, class DesktopSearch extends St.BoxLayout {
    _init() {
        super._init({
            // bms-keyboard-surface: see BLUR_MY_SHELL_TARGET.
            style_class: `desktop-launcher-search ${BLUR_MY_SHELL_TARGET}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        this._active = false;
        this._syncId = 0;

        this.keyCatcher = new Clutter.Actor({reactive: true});
        this.keyCatcher.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.emit('escape');
                return Clutter.EVENT_STOP;
            }
            if (!this._shouldTriggerSearch(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            this._startSearch(event);
            return Clutter.EVENT_STOP;
        });

        this._entry = new St.Entry({
            style_class: 'search-entry',
            hint_text: _('Type to search'),
            track_hover: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.set_primary_icon(new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-find-symbolic',
        }));
        this._clearIcon = new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-clear-symbolic',
        });
        this._entry.connect('secondary-icon-clicked', () => this.reset());
        this.add_child(this._entry);

        this._text = this._entry.clutter_text;
        this._text.connect('text-changed', () => this._onTextChanged());
        this._text.connect('key-press-event', (entry, event) => this._onEntryKeyPress(entry, event));
        this._text.connect('key-focus-in', () => this._results.highlightDefault(true));
        this._text.connect('key-focus-out', () => this._results.highlightDefault(false));

        // The view connects to global objects for good (the overview never
        // destroys its own); keep the ids to disconnect on destroy.
        const appSystem = Shell.AppSystem.get_default();
        const parental = ParentalControlsManager.getDefault();
        [this._results, this._globalHandlers] = trackConnections([appSystem, parental],
            () => new Search.SearchResultsView());
        this.add_child(this._results);
        global.focus_manager.add_group(this._results);

        // Upstream race: when the installed apps change, the view replaces
        // its search providers and destroys their result displays, but a
        // search still running for an old provider then updates its
        // destroyed display. Drop results of providers that are gone.
        const updateResults = this._results._updateResults.bind(this._results);
        this._results._updateResults = (provider, ...args) => {
            if (this._results._providers.includes(provider))
                return updateResults(provider, ...args);
            provider.searchInProgress = false;
            return Promise.resolve();
        };

        // Keys pressed on a focused result: Escape and typing go back to
        // the search, as the overview's stage handler does.
        this.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.reset();
                return Clutter.EVENT_STOP;
            }
            if (this._shouldTriggerSearch(symbol)) {
                this._startSearch(event);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // A click beside the results closes the search.
        this.connect('button-release-event', (_actor, event) => {
            if (global.stage.get_event_actor(event) !== this)
                return Clutter.EVENT_PROPAGATE;
            this.reset();
            return Clutter.EVENT_STOP;
        });

        this.connect('destroy', () => this._onDestroy());
    }

    get active() {
        return this._active;
    }

    enable() {
        // Activating a remote result ends in Main.overview.toggle(), which
        // here would open the overview; close the search instead. Super
        // still opens the overview.
        const overview = Main.overview;
        const toggle = overview.toggle;
        overview.toggle = () => {
            if (!overview.visible && this._active && this._isOwnEvent())
                this.reset();
            else
                toggle.call(overview);
        };
        this._restoreToggle = () => delete overview.toggle;

        global.display.connectObject('notify::focus-window', () => this._queueSync(), this);
        // Clicking a window takes the keyboard away: close the search.
        global.stage.connectObject('notify::key-focus', () => {
            if (this._active && !global.stage.key_focus)
                this.reset();
        }, this);
        Main.overview.connectObject(
            'showing', () => this.reset(),
            'hidden', () => this._queueSync(),
            this);
        this._queueSync();
    }

    disable() {
        this._restoreToggle?.();
        this._restoreToggle = null;
        global.display.disconnectObject(this);
        global.stage.disconnectObject(this);
        Main.overview.disconnectObject(this);
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        this.reset();
        if (global.stage.key_focus === this.keyCatcher)
            global.stage.set_key_focus(null);
    }

    _onDestroy() {
        this.disable();
        this._results._cancellable.cancel();
        this._results._clearSearchTimeout();
        for (const [obj, id] of this._globalHandlers)
            obj.disconnect(id);
        this._globalHandlers = [];
        this.keyCatcher.destroy();
    }

    /** Whether the event being handled comes from the search UI itself. */
    _isOwnEvent() {
        const event = Clutter.get_current_event();
        if (!event)
            return false;
        const type = event.type();
        if ((type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE) &&
            [Clutter.KEY_Super_L, Clutter.KEY_Super_R].includes(event.get_key_symbol()))
            return false;
        const actor = global.stage.get_event_actor(event);
        return actor !== null && this.contains(actor);
    }

    /** Take the keyboard for type-to-search, if nothing else wants it. */
    claimKeyboard() {
        if (!this.keyCatcher.mapped || Main.overview.visible || Main.modalCount > 0)
            return;
        const focus = global.stage.key_focus;
        if (focus && focus !== global.stage && !this.contains(focus))
            return;
        if (!this._active)
            global.stage.set_key_focus(this.keyCatcher);
    }

    /**
     * Focus changes come in steps (the old window loses focus before the
     * next one gets it), so look once they have settled: with no window
     * focused the desktop takes the keyboard; a focused window ends the
     * search.
     */
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            if (global.display.focus_window)
                this.reset();
            else
                this.claimKeyboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setActive(active) {
        if (this._active === active)
            return;
        this._active = active;
        this.visible = active;
        this.notify('active');
    }

    _shouldTriggerSearch(symbol) {
        if (symbol === Clutter.KEY_Multi_key)
            return true;
        if (symbol === Clutter.KEY_BackSpace && this._active)
            return true;
        const unicode = Clutter.keysym_to_unicode(symbol);
        if (unicode === 0)
            return false;
        return getTermsForSearchString(String.fromCharCode(unicode)).length > 0;
    }

    _startSearch(event) {
        this._setActive(true);
        global.stage.set_key_focus(this._text);
        this._text.event(event, false);
    }

    /** Clear and hide the search; the desktop keeps the keyboard. */
    reset() {
        const hadFocus = global.stage.key_focus !== null &&
            this.contains(global.stage.key_focus);
        this._entry.text = '';
        this._text.set_selection(0, 0);
        this._setActive(false);
        if (hadFocus && !global.display.focus_window)
            this.claimKeyboard();
    }

    _onTextChanged() {
        const terms = getTermsForSearchString(this._entry.get_text());
        this._results.setTerms(terms);
        if (terms.length > 0) {
            this._setActive(true);
            this._entry.set_secondary_icon(this._clearIcon);
        } else {
            this._entry.set_secondary_icon(null);
            if (this._entry.text !== '')
                return;
            this._setActive(false);
            if (!global.display.focus_window)
                this.claimKeyboard();
        }
    }

    _onEntryKeyPress(entry, event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.reset();
            return Clutter.EVENT_STOP;
        }
        if (!this._active)
            return Clutter.EVENT_PROPAGATE;

        const rtl = entry.get_text_direction() === Clutter.TextDirection.RTL;
        const arrowNext = rtl ? Clutter.KEY_Left : Clutter.KEY_Right;
        const nextDirection = rtl ? St.DirectionType.LEFT : St.DirectionType.RIGHT;
        if (symbol === Clutter.KEY_Tab) {
            this._results.navigateFocus(St.DirectionType.TAB_FORWARD);
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_ISO_Left_Tab) {
            this._results.navigateFocus(St.DirectionType.TAB_BACKWARD);
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Down) {
            this._results.navigateFocus(St.DirectionType.DOWN);
            return Clutter.EVENT_STOP;
        } else if (symbol === arrowNext && this._text.cursor_position === -1) {
            this._results.navigateFocus(nextDirection);
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._results.activateDefault();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
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

/**
 * A container that asks for no space at all. The overview derives the
 * workspace box from the preferred size of the background's children, so
 * anything we add there must report 0x0, while still being allocated the
 * full box by the parent's BinLayout (x/y_expand).
 */
const ZeroSizeHolder = GObject.registerClass(
class ZeroSizeHolder extends Clutter.Actor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});

/**
 * Keeps the launcher visible where the Shell paints its own wallpaper
 * copies instead of the real background: the workspace-switch animation
 * (one WorkspaceBackground per monitor in workspaceAnimation.js) and the
 * overview's workspace previews (workspace.js WorkspaceBackground, scaled
 * so the work area fits its box). Both get a live Clutter.Clone of the
 * monitor's LauncherLayer, placed where the layer sits on that monitor.
 */
class LauncherMirror {
    constructor(getLayer) {
        this._getLayer = getLayer;
        this._clones = new Set();
        this._patches = [];
    }

    enable() {
        const mirror = this;

        // Workspace switch: a monitor-sized, unscaled group per workspace.
        const animProto = WorkspaceAnimation.WorkspaceBackground.prototype;
        const origCreateBackground = animProto._createBackground;
        animProto._createBackground = function (...args) {
            origCreateBackground.apply(this, args);
            mirror._addClone(this, this._monitor.index);
        };
        this._patches.push(() => (animProto._createBackground = origCreateBackground));

        // Overview preview: Workspace is a BinLayout holding the (scaled,
        // squeezed) WorkspaceBackground and the window previews. The clone
        // goes between them and fits itself to the same box. It must not
        // live inside the background: the overview derives the workspace
        // box from that actor's preferred size.
        const ovProto = Workspace.Workspace.prototype;
        const origInit = ovProto._init;
        ovProto._init = function (metaWorkspace, monitorIndex, ...rest) {
            origInit.call(this, metaWorkspace, monitorIndex, ...rest);
            mirror._addClone(this, monitorIndex, {
                above: this._background,
                sizeFrom: 'holder',
                fadeWithOverview: true,
            });
        };
        this._patches.push(() => (ovProto._init = origInit));

        this.refreshOverview();
    }

    disable() {
        while (this._patches.length)
            this._patches.pop()();
        for (const clone of this._clones)
            clone.destroy();
        this._clones.clear();
        this.refreshOverview();
    }

    /** Rebuild the overview's workspace views so they pick up (or drop) clones. */
    refreshOverview() {
        try {
            Main.overview._overview.controls._workspacesDisplay._updateWorkspacesViews();
        } catch (e) {
            logError(e, 'Desktop Launcher: could not refresh overview workspaces');
        }
    }

    /**
     * @param {Clutter.Actor} container - where the holder goes
     * @param {number} monitorIndex
     * @param {object} [opts]
     * @param {Clutter.Actor} [opts.above] - insert right above this child
     * @param {string} [opts.sizeFrom] - 'holder' when the container's layout
     *   allocates the holder (BinLayout); otherwise the container's own
     *   size is the reference box
     * @param {boolean} [opts.fadeWithOverview] - fade out as the overview
     *   opens, following its state (swipe gesture or Super key animation)
     */
    _addClone(container, monitorIndex, {
        above = null, sizeFrom = 'container', fadeWithOverview = false,
    } = {}) {
        const layer = this._getLayer(monitorIndex);
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!layer || !monitor)
            return;

        // A zero-size holder (see ZeroSizeHolder) parents the clone so the
        // clone can keep fixed geometry whatever layout the container uses.
        const holder = new ZeroSizeHolder({x_expand: true, y_expand: true});
        const clone = new Clutter.Clone({source: layer});
        clone.set_pivot_point(0, 0);
        holder.add_child(clone);
        if (above)
            container.insert_child_above(holder, above);
        else
            container.add_child(holder);
        this._clones.add(holder);
        const ref = sizeFrom === 'holder' ? holder : container;

        // The overview squeezes the work area into a box of a different
        // aspect and crops the wallpaper; icons must not be distorted, so
        // scale uniformly to fit and centre. At full size (switch animation,
        // start of the overview transition) this is an exact 1:1 mapping.
        const fit = () => {
            if (!holder.get_parent() || !layer.get_parent())
                return;
            const [w, h] = [ref.width, ref.height];
            if (w <= 0 || h <= 0)
                return;
            const s = Math.min(w / monitor.width, h / monitor.height);
            clone.set_size(layer.width, layer.height);
            clone.set_scale(s, s);
            clone.set_position(
                (w - monitor.width * s) / 2 + (layer.x - monitor.x) * s,
                (h - monitor.height * s) / 2 + (layer.y - monitor.y) * s);
        };
        fit();
        ref.connectObject('notify::allocation', fit, holder);
        layer.connectObject('notify::allocation', fit, holder);

        // The state goes from HIDDEN (0) to WINDOW_PICKER (1): fully shown
        // at the start of the transition, where the clone must match the
        // real launcher, and gone once the overview is open.
        const adjustment = Main.overview._overview.controls._stateAdjustment;
        if (fadeWithOverview) {
            const fade = () => {
                const progress = Math.min(1, Math.max(0, adjustment.value - ControlsState.HIDDEN));
                clone.opacity = Math.round(255 * (1 - progress));
            };
            fade();
            adjustment.connectObject('notify::value', fade, holder);
        }

        holder.connect('destroy', () => {
            this._clones.delete(holder);
            layer.disconnectObject(holder);
            ref.disconnectObject(holder);
            adjustment.disconnectObject(holder);
        });
        layer.connectObject('destroy', () => holder.destroy(), holder);
    }
}

export default class DesktopLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._layers = [];
        this._raiseLaterId = 0;
        this._rebuildIdleId = 0;
        this._windowSyncId = 0;
        this._watchedWindows = new Set();

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
        // The Shell added a new wallpaper actor above us: move it below.
        this._bgGroup.connectObject('child-added',
            (_group, child) => {
                if (child instanceof Meta.BackgroundActor)
                    this._queueRaise();
            }, this);
        // A press anywhere on the desktop (wallpaper or launcher) gives it
        // the keyboard, for type-to-search. Watched on the stage: Clutter
        // only emits events on reactive actors, and the background group
        // isn't one.
        global.stage.connectObject('captured-event', (_stage, event) => {
            const type = event.type();
            if ((type === Clutter.EventType.BUTTON_PRESS ||
                 type === Clutter.EventType.TOUCH_BEGIN) &&
                this._bgGroup.contains(global.stage.get_event_actor(event)))
                this._search.claimKeyboard();
            return Clutter.EVENT_PROPAGATE;
        }, this);

        // The icons fade out while their monitor has open (not minimised)
        // app windows on the current workspace, and come back once it has
        // none. Watch for windows appearing, going, (un)minimising and
        // moving between workspaces and monitors.
        global.display.connectObject(
            'window-created', (_display, win) => this._watchWindow(win),
            'window-entered-monitor', () => this._queueWindowSync(),
            'window-left-monitor', () => this._queueWindowSync(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._queueWindowSync(), this);
        global.get_window_actors().forEach(actor => this._watchWindow(actor.meta_window));

        // Type-to-search lives on the primary monitor's launcher.
        this._search = new DesktopSearch();
        this._search.connectObject(
            'notify::active', () => this._searchLayer?.setSearchActive(this._search.active),
            'escape', () => this._layers.forEach(l => l.closeFolder()),
            this);

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
        // A drag on one monitor's grid saves app-order; the layer that did
        // the drag already shows it, other layers rebuild. Queued, since the
        // write happens inside a drop and the dragged tile must survive it.
        this._settings.connectObject('changed::app-order', () => {
            const reset = this._settings.get_strv('app-order').length === 0;
            if (reset || this._layers.some(l => !l.matchesSavedOrder()))
                this._queueRebuild();
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

        this._search.enable();

        // Show the launcher inside the workspace-switch animation and the
        // overview's workspace previews too.
        this._mirror = new LauncherMirror(
            index => this._layers.find(l => l.monitorIndex === index));
        this._mirror.enable();
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
        global.stage.disconnectObject(this);
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
        if (this._windowSyncId) {
            GLib.Source.remove(this._windowSyncId);
            this._windowSyncId = 0;
        }
        global.workspace_manager.disconnectObject(this);
        this._watchedWindows.forEach(win => win.disconnectObject(this));
        this._watchedWindows.clear();

        this._mirror?.disable();
        this._mirror = null;
        this._search?.destroy();
        this._search = null;
        this._destroyLayers();
        this._appGridTakeover?.disable();
        this._appGridTakeover = null;
        this._bgGroup = null;
        this._settings = null;
    }

    _watchFolders() {
        this._unwatchFolders();
        for (const id of this._folderSettings.get_strv('folder-children')) {
            const folder = getFolder(this._folderSettings, id);
            folder.connectObject('changed', () => this._queueRebuild(), this);
            this._watchedFolders.push(folder);
        }
    }

    _unwatchFolders() {
        this._watchedFolders?.forEach(f => f.disconnectObject(this));
        this._watchedFolders = [];
    }

    _destroyLayers() {
        // The search outlives the layers (it carries its search providers).
        for (const actor of [this._search, this._search?.keyCatcher])
            actor?.get_parent()?.remove_child(actor);
        this._search?.clear_constraints();
        this._searchLayer = null;
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
            const layer = new LauncherLayer(index, this._settings, this._folderSettings,
                () => this._queueRebuild());
            this._bgGroup.add_child(layer);
            this._layers.push(layer);
            if (index === primaryIndex) {
                // The key catcher must be mapped with the launcher; the
                // search itself covers the whole work area, unpadded, so it
                // sits beside the layer and follows its box.
                layer.add_child(this._search.keyCatcher);
                this._bgGroup.add_child(this._search);
                this._search.add_constraint(new Clutter.BindConstraint({
                    source: layer,
                    coordinate: Clutter.BindCoordinate.ALL,
                }));
                this._searchLayer = layer;
            }
        }
        this._raise();
        this._syncWindowFade();
        this._mirror?.refreshOverview();
    }

    /**
     * Keep the wallpapers at the bottom of the background group. Only they
     * are moved, so whatever sits above the layers (search, folders, and
     * the blur Blur my Shell places right below those) stays in order.
     */
    _raise() {
        for (const child of this._bgGroup.get_children()) {
            if (child instanceof Meta.BackgroundActor)
                this._bgGroup.set_child_below_sibling(child, null);
        }
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

    _watchWindow(win) {
        if (!win || this._watchedWindows.has(win))
            return;
        this._watchedWindows.add(win);
        win.connectObject(
            'notify::minimized', () => this._queueWindowSync(),
            'workspace-changed', () => this._queueWindowSync(),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._watchedWindows.delete(win);
                this._queueWindowSync();
            },
            this);
        this._queueWindowSync();
    }

    /** Window changes come in bursts; look once they have settled. */
    _queueWindowSync() {
        if (this._windowSyncId)
            return;
        this._windowSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._windowSyncId = 0;
            this._syncWindowFade();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Fade each monitor's icons while it shows an app window. */
    _syncWindowFade() {
        const workspace = global.workspace_manager.get_active_workspace();
        const busyMonitors = new Set();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win &&
                win.showing_on_its_workspace() &&
                win.located_on_workspace(workspace) &&
                !win.skip_taskbar &&
                [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                    Meta.WindowType.MODAL_DIALOG].includes(win.window_type))
                busyMonitors.add(win.get_monitor());
        }
        this._layers.forEach(l => l.setFaded(busyMonitors.has(l.monitorIndex)));
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
