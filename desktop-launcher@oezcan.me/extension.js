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
// Each layer holds the Shell's own app grid (AppDisplay), so icons, folders,
// menus, drag and drop and the saved order are exactly the overview's.
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
import Shell from 'gi://Shell';
import St from 'gi://St';

import Gio from 'gi://Gio';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {SHELL_KEYBINDINGS_SCHEMA} from 'resource:///org/gnome/shell/ui/windowManager.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

const SEARCH_FADE_TIME = 150;     // the grid fading out for search results
const FOCUS_FADE_TIME = 250;      // the overview's animation time

// Blur my Shell has no API for other extensions. Its popup blur scans the
// direct children of the Shell's top-level groups, including the window
// group's background group, for actors with one of its target style
// classes, and blurs what is behind them with the user's popup settings,
// following their visibility, opacity and size. This one is its own marker
// class (no theme styles it), so the full-screen search and the open
// folder dialog get the background blurred behind them. Both must be
// direct children of the background group, above the launcher layer.
const BLUR_MY_SHELL_TARGET = 'bms-keyboard-surface';

/**
 * The desktop grid's saved layout: the overview's PageManager
 * (appDisplay.js), stored in this extension's app-layout key instead of
 * the overview's app-picker-layout. The overview's pages hold 24 apps or
 * so; sharing them would leave the desktop's bigger pages half empty, as
 * the grid keeps every app on the page it was saved on.
 */
const DesktopPageManager = GObject.registerClass({
    Signals: {'layout-changed': {}},
}, class DesktopPageManager extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._updatingPages = false;
        this._loadPages();
        settings.connectObject('changed::app-layout', () => this._loadPages(), this);
    }

    destroy() {
        this._settings.disconnectObject(this);
    }

    _loadPages() {
        this._pages = this._settings.get_value('app-layout').recursiveUnpack();
        if (!this._updatingPages)
            this.emit('layout-changed');
    }

    getAppPosition(appId) {
        const page = this._pages.findIndex(pageData => appId in pageData);
        return page === -1 ? [-1, -1] : [page, this._pages[page][appId].position];
    }

    set pages(pages) {
        const packed = pages.map(page => Object.fromEntries(
            Object.entries(page).map(([appId, properties]) =>
                [appId, new GLib.Variant('a{sv}', properties)])));
        this._updatingPages = true;
        this._settings.set_value('app-layout', new GLib.Variant('aa{sv}', packed));
        this._updatingPages = false;
    }

    get pages() {
        return this._pages;
    }
});

/**
 * The launcher for one monitor: the Shell's own app grid (AppDisplay, the
 * overview's "Show Apps" page) hosted on the desktop. Pages, folders and
 * their dialogs, drag and drop and keyboard navigation are all the Shell's
 * code. The layer places the grid in the monitor's work area, sizes its
 * pages for the desktop, keeps its saved layout apart from the overview's
 * (DesktopPageManager) and brings the folder dialogs, which the grid puts
 * into the overview, to the desktop.
 */
const LauncherLayer = GObject.registerClass(
class LauncherLayer extends St.Widget {
    _init(monitorIndex, settings) {
        super._init({
            name: `desktop-launcher-${monitorIndex}`,
            style_class: 'desktop-launcher-layer',
            layout_manager: new Clutter.BinLayout(),
            // Not reactive itself: clicks between icons fall through to the
            // wallpaper actor, which keeps the Shell's right-click
            // background menu working.
            reactive: false,
        });

        this.monitorIndex = monitorIndex;
        this._settings = settings;
        this._faded = false;
        this._fitId = 0;
        this._reflowPending = false;

        // The grid connects to these for good (the overview never destroys
        // its own); keep the ids to disconnect on destroy.
        [this._appDisplay, this._globalHandlers] = trackConnections(
            [Shell.AppSystem.get_default(), global.settings],
            () => new AppDisplay.AppDisplay());

        // Folder dialogs go to the overview's group, which is hidden
        // outside the overview; move them to the desktop, above the layer.
        const addFolderDialog = this._appDisplay.addFolderDialog.bind(this._appDisplay);
        this._appDisplay.addFolderDialog = dialog => {
            addFolderDialog(dialog);
            dialog.get_parent()?.remove_child(dialog);
            dialog.add_style_class_name(BLUR_MY_SHELL_TARGET);
            this.get_parent().add_child(dialog);
        };

        // Its own saved layout instead of the overview's (see above).
        this._pageManager = new DesktopPageManager(settings);
        this._appDisplay._pageManager = this._pageManager;
        this._pageManager.connect('layout-changed', () => this._appDisplay._redisplay());

        // The grid keeps a fifth of its width free at the sides for
        // previews of the neighbouring pages, an overview design; on the
        // desktop only the page arrows need room there.
        const gridLayout = this._appDisplay._appGridLayout;
        gridLayout._getIndicatorsWidth = box => {
            const [, height] = box.get_size();
            return Math.max(...[gridLayout._nextPageArrow, gridLayout._previousPageArrow]
                .map(arrow => arrow.get_preferred_width(height)[0]));
        };

        // Fading (open windows) and search hide the grid separately.
        this._content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._appDisplay);
        this.add_child(this._content);

        // The grid picks one of a few fixed page layouts (8x3, 6x4, ...)
        // and grows its icons to fill it, leaving empty sides on a wide
        // desktop. Instead keep the icons at the icon-size setting and give
        // it as many columns and rows as fit, through its own setGridModes.
        this._grid = this._appDisplay._grid;
        this._grid.layout_manager.fixed_icon_size = settings.get_int('icon-size');
        this._appDisplay._scrollView.connectObject('notify::allocation',
            () => this._queueFitGrid(), this);
        // A new page size only takes effect at the grid's next allocation;
        // refit (and reflow) once it has.
        this._grid.layout_manager.connectObject(
            'notify::columns-per-page', () => this._queueFitGrid(),
            'notify::rows-per-page', () => this._queueFitGrid(),
            this);
        settings.connectObject('changed::icon-size', () => {
            this._grid.layout_manager.fixed_icon_size = settings.get_int('icon-size');
            this._queueFitGrid();
        }, this);

        // An icon hovered by a drag keeps its folder preview after the drop
        // until the pointer moves over it again (the overview's grid does
        // too, but the overview closes); clear it when a drag ends.
        const clearDropHover = () => this._appDisplay._orderedItems
            .forEach(item => item._setHoveringByDnd?.(false));
        Main.overview.connectObject(
            'item-drag-end', clearDropHover,
            'item-drag-cancelled', clearDropHover,
            this);

        // In the overview, launching an app hides the overview and with it
        // the folder dialog; here the dialog closes itself.
        Shell.AppSystem.get_default().connectObject('app-state-changed', (_sys, app) => {
            if (app.state === Shell.AppState.STARTING)
                this.closeFolder();
        }, this);
        global.display.connectObject('notify::focus-window', () => {
            if (global.display.focus_window)
                this.closeFolder();
        }, this);

        this.connect('destroy', () => {
            if (this._fitId)
                GLib.source_remove(this._fitId);
            this._pageManager.destroy();
            for (const [obj, id] of this._globalHandlers)
                obj.disconnect(id);
            if (this._appDisplay._overviewHiddenId)
                Main.overview.disconnect(this._appDisplay._overviewHiddenId);
        });

        this.relayout();
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

        const margin = this._settings.get_int('margin');
        const maxWidth = this._settings.get_int('max-width');
        const side = maxWidth > 0
            ? Math.max(margin, (area.width - maxWidth) / 2) : margin;
        this.set_style(`padding: ${margin}px ${side}px;`);
        this.show();
    }

    closeFolder() {
        this._appDisplay._currentDialog?.popdown();
    }

    /** After the allocation that triggered it, not inside it. */
    _queueFitGrid() {
        if (this._fitId)
            return;
        this._fitId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._fitId = 0;
            this._fitGrid();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * As many columns and rows of icons as fit one page. The grid applies
     * a new page size at its next allocation, so the pages are reflowed
     * on the fit after that.
     */
    _fitGrid() {
        const item = this._appDisplay._orderedItems[0];
        const [width, height] = this._appDisplay._scrollView.allocation.get_size();
        if (!item || width === 0 || height === 0)
            return;
        const layout = this._grid.layout_manager;
        const padding = layout.page_padding;
        const [, itemWidth] = item.get_preferred_width(-1);
        const [, itemHeight] = item.get_preferred_height(-1);
        const fit = (space, size, spacing) =>
            Math.max(1, Math.floor((space + spacing) / (size + spacing)));
        const columns = fit(width - padding.left - padding.right,
            itemWidth, layout.column_spacing);
        const rows = fit(height - padding.top - padding.bottom,
            itemHeight, layout.row_spacing);
        if (layout.columns_per_page === columns && layout.rows_per_page === rows) {
            if (this._reflowPending)
                this._reflowPages();
            return;
        }
        this._reflowPending = true;
        this._grid.setGridModes([{columns, rows}]);
    }

    /**
     * The grid starts with its default page size and was filled with it;
     * apps it pushed onto later pages don't move back when pages grow.
     * Put them where the saved layout has them, or, with nothing saved
     * yet, fill the pages in order and save that.
     */
    _reflowPages() {
        this._reflowPending = false;
        if (this._pageManager.pages.length > 0) {
            this._appDisplay._redisplay();
            return;
        }
        // The grid's own refill pulls from the next page only; repeat
        // until each page is full or nothing follows it.
        const layout = this._grid.layout_manager;
        const perPage = layout.columns_per_page * layout.rows_per_page;
        for (let page = 0; page < this._grid.nPages - 1; page++) {
            let count;
            do {
                count = this._grid.getItemsAtPage(page).filter(c => c.visible).length;
                layout._fillItemVacancies(page);
            } while (count < perPage && page < this._grid.nPages - 1 &&
                this._grid.getItemsAtPage(page).filter(c => c.visible).length > count);
        }
        this._appDisplay._savePages();
    }

    /**
     * Fade the grid out while app windows are open on this monitor.
     * Faded, it is hidden too, so a click beside the windows can't launch
     * anything unseen.
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
            this.closeFolder();
        this._appDisplay.ease({
            opacity: active ? 0 : 255,
            duration: SEARCH_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._appDisplay.visible = !active),
        });
        if (!active)
            this._appDisplay.visible = true;
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
 *  - shifting up from the window picker (pressing Super twice, Super+Up)
 *    calls toggleDesktop() too, and the overview state is clamped so the
 *    swipe gesture stops at the window picker.
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
        // Shifting up past the window picker would open the app grid: a
        // second Super press while the overview is still opening, or
        // shift-overview-up (Super+Up) in it. Show the desktop instead,
        // judged by where the overview is heading, not where it is.
        this._patch(controls, '_shiftState', orig => direction => {
            const {finalState} = adjustment.getStateTransitionParams();
            if (direction === Meta.MotionDirection.UP &&
                finalState >= ControlsState.WINDOW_PICKER) {
                this.toggleDesktop();
                return;
            }
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

        // The switch animation's group is the whole monitor, so the layer
        // sits at its offset in it. An overview workspace's box is the work
        // area, which the layer covers exactly: the box starts out the work
        // area's size and shrinks into a preview of a different aspect, so
        // the layer is scaled uniformly (icons must not be distorted) and
        // centred. At full size both are exact 1:1 mappings, so the copy
        // lines up with the real launcher as the transitions start and end.
        const area = sizeFrom === 'holder' ? layer : monitor;
        const fit = () => {
            if (!holder.get_parent() || !layer.get_parent())
                return;
            const [w, h] = [ref.width, ref.height];
            if (w <= 0 || h <= 0)
                return;
            const s = Math.min(w / area.width, h / area.height);
            clone.set_size(layer.width, layer.height);
            clone.set_scale(s, s);
            clone.set_position(
                (w - area.width * s) / 2 + (layer.x - area.x) * s,
                (h - area.height * s) / 2 + (layer.y - area.y) * s);
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
        this._windowSyncId = 0;
        this._watchedWindows = new Set();

        this._bgGroup = Main.layoutManager._backgroundGroup;

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

        // Settings. Content changes (apps, folders, favourites, order) are
        // the Shell's app grid's own business.
        for (const key of ['margin', 'max-width']) {
            this._settings.connectObject(`changed::${key}`,
                () => this._layers.forEach(l => l.relayout()), this);
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
        this._settings?.disconnectObject(this);

        if (this._raiseLaterId) {
            global.compositor.get_laters().remove(this._raiseLaterId);
            this._raiseLaterId = 0;
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
            const layer = new LauncherLayer(index, this._settings);
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
}
