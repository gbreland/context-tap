import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME = 'org.contexttap.ContextTap.Shell';
const PATH = '/org/contexttap/ContextTap/Shell';
const IFACE = 'org.contexttap.ContextTap.Shell1';

export class ShellClient {
    constructor() {
        this._proxy = null;
        this._state = 'unknown';
        this.onFocus = null;
        this.onReady = null;
        this._watchId = 0;
    }

    start() {
        if (this._watchId)
            return;
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => {
                this._state = 'up';
                this._connect();
                this.onReady?.();
            },
            () => {
                this._state = 'down';
                this._proxy = null;
                this.onReady?.();
            });
    }

    close() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._proxy = null;
    }

    available() {
        return this._proxy != null;
    }

    missing() {
        return this._state === 'down';
    }

    _connect() {
        this._proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            NAME,
            PATH,
            IFACE,
            null);
        this._proxy.connect('g-signal', (proxy, sender, name, params) => {
            if (name !== 'FocusChanged' || !this.onFocus)
                return;
            const [appId, title, previous] = params.deepUnpack();
            this.onFocus(appId, title, previous);
        });
    }

    listWindows() {
        if (!this._proxy)
            return [];
        const result = this._proxy.call_sync(
            'ListWindows', null, Gio.DBusCallFlags.NONE, -1, null);
        return result.deepUnpack()[0].map(row => ({
            appId: row[0],
            name: row[1],
            title: row[2],
            focused: row[3],
            pid: row[4] || 0,
        }));
    }

    getCapture(appId) {
        return this._capture('GetCapture', appId);
    }

    captureNow(appId) {
        return this._capture('CaptureNow', appId);
    }

    _capture(method, appId) {
        if (!this._proxy)
            return null;
        try {
            const result = this._proxy.call_sync(
                method,
                new GLib.Variant('(s)', [appId]),
                Gio.DBusCallFlags.NONE,
                -1,
                null);
            const [png, title, timestamp] = result.deepUnpack();
            if (!png?.length)
                return null;
            return {png: Uint8Array.from(png), title, timestamp};
        } catch {
            return null;
        }
    }

    focusApp(appId) {
        if (!this._proxy || !appId)
            return;
        this._proxy.call_sync(
            'FocusApp',
            new GLib.Variant('(s)', [appId]),
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    }

    setPlacement(mode, above) {
        if (!this._proxy)
            return;
        this._proxy.call_sync(
            'SetPlacement',
            new GLib.Variant('(sb)', [mode, above]),
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    }

    getPlacement() {
        if (!this._proxy)
            return null;
        const result = this._proxy.call_sync(
            'GetPlacement', null, Gio.DBusCallFlags.NONE, -1, null);
        const [mode, above] = result.deepUnpack();
        return {mode, above};
    }
}
