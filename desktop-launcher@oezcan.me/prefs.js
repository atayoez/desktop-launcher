// SPDX-FileCopyrightText: 2026 Atay Özcan <atay@oezcan.me>
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop Launcher preferences window.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DesktopLauncherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Desktop Launcher'),
            icon_name: 'view-app-grid-symbolic',
        });
        window.add(page);

        // --- Appearance -----------------------------------------------------
        const look = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(look);

        look.add(this._spinRow(settings, 'icon-size', {
            title: _('Icon size'),
            subtitle: _('Pixels'),
            lower: 32, upper: 160, step: 8,
        }));

        look.add(this._switchRow(settings, 'show-labels', {
            title: _('Show app names'),
        }));

        look.add(this._switchRow(settings, 'show-section-titles', {
            title: _('Show section titles'),
            subtitle: _('“Favourites” and “All Apps” headings'),
        }));

        // --- Content --------------------------------------------------------
        const content = new Adw.PreferencesGroup({title: _('Content')});
        page.add(content);

        content.add(this._switchRow(settings, 'show-favorites', {
            title: _('Favourites row'),
            subtitle: _('Show the dash favourites as a separate row above all apps'),
        }));

        content.add(this._switchRow(settings, 'replace-app-grid', {
            title: _('Replace GNOME’s app grid'),
            subtitle: _('Show Apps button and Super+A minimize all windows to reveal the desktop launcher; press again to restore'),
        }));

        // --- Layout ---------------------------------------------------------
        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        page.add(layout);

        layout.add(this._spinRow(settings, 'margin', {
            title: _('Outer margin'),
            subtitle: _('Space between the grid and the edge of the screen, in pixels'),
            lower: 0, upper: 400, step: 8,
        }));

        layout.add(this._spinRow(settings, 'max-width', {
            title: _('Maximum grid width'),
            subtitle: _('Pixels; 0 means no limit. The grid is centred when limited.'),
            lower: 0, upper: 6000, step: 50,
        }));

        layout.add(this._switchRow(settings, 'all-monitors', {
            title: _('Show on every monitor'),
            subtitle: _('Otherwise only the primary monitor gets a launcher'),
        }));
    }

    _switchRow(settings, key, props) {
        const row = new Adw.SwitchRow(props);
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, {title, subtitle, lower, upper, step}) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower, upper,
                step_increment: step,
                page_increment: step * 4,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
