import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {programArgs, programInvocationName} from 'system';

import {ChatGpt} from './auth.js';
import {ClientDirectory} from './clients.js';
import {hostProfile} from './profile.js';
import {ShellClient} from './shell.js';
import {openWindow} from './window.js';

GLib.set_prgname('context-tap');
Adw.init();

const chatgpt = new ChatGpt();
const shell = new ShellClient();
const clients = new ClientDirectory();
const profile = hostProfile();

const application = new Adw.Application({
    application_id: 'org.contexttap.ContextTap',
    flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
});

application.connect('activate', () => {
    const css = new Gtk.CssProvider();
    css.load_from_path(GLib.build_filenamev([
        GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
        'style.css',
    ]));
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        css,
        Gtk.STYLE_PROVIDER_PRIORITY_USER);
    const existing = application.get_active_window();
    if (existing) {
        existing.present();
        return;
    }
    openWindow(application, {chatgpt, shell, clients, profile});
});

application.run([programInvocationName, ...programArgs]);
