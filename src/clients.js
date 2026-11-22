import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const ASSISTANT_ID = 'org.contexttap.ContextTap';
export const SUPPORTED = new Map([
    ['org.gnome.Ptyxis', 'org.gnome.Ptyxis'],
    ['org.gnome.Ptyxis.Devel', 'org.gnome.Ptyxis.Devel'],
]);

const CLIENT_PATH = '/org/contexttap/ContextTap/Client';
const CLIENT_IFACE = 'org.contexttap.ContextTap.Client1';

export class ClientDirectory {
    constructor() {
        this.contexts = new Map();
        this._proxies = new Map();
        this._owners = new Map();
        this.captureHeld = false;
        this.onContext = null;
    }

    holdCapture() {
        this.captureHeld = true;
        this.contexts.clear();
    }

    releaseCapture() {
        this.captureHeld = false;
    }

    isSupported(appId) {
        return SUPPORTED.has(appId);
    }

    isActive(appId) {
        return this._proxies.has(appId);
    }

    contextFor(appId) {
        return this.contexts.get(appId) ?? null;
    }

    refresh() {
        for (const [appId, busName] of SUPPORTED) {
            const owner = nameOwner(busName);
            if (!owner) {
                this._drop(appId);
                continue;
            }
            if (this._owners.get(appId) !== owner || !this._proxies.has(appId)) {
                if (exportsClient(busName))
                    this._watch(appId, busName, owner);
                continue;
            }
            this._pull(appId);
        }
    }

    _drop(appId) {
        this._proxies.delete(appId);
        this._owners.delete(appId);
        this.contexts.delete(appId);
    }

    _watch(appId, busName, owner) {
        const proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            CLIENT_PATH,
            CLIENT_IFACE,
            null);
        proxy.connect('g-signal', (obj, sender, name, params) => {
            if (name !== 'ContextChanged')
                return;
            try {
                const [text, state] = params.deepUnpack();
                this._store(appId, text ?? '', state);
            } catch {
                /* The next pull fills this in. */
            }
        });
        this._proxies.set(appId, proxy);
        this._owners.set(appId, owner);
        this._pull(appId);
    }

    _pull(appId) {
        const busName = SUPPORTED.get(appId);
        if (!busName)
            return;
        try {
            const unpacked = Gio.DBus.session.call_sync(
                busName,
                CLIENT_PATH,
                CLIENT_IFACE,
                'GetState',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null).deepUnpack();
            const reply = readStateReply(unpacked);
            this._store(appId, reply.text, reply.state);
        } catch {
            this._proxies.delete(appId);
            this._owners.delete(appId);
        }
    }

    _store(appId, text, state) {
        if (this.captureHeld)
            return;
        const previous = this.contexts.get(appId);
        const incoming = usefulText(text) ? text : '';
        const nextText = incoming || (usefulText(previous?.text) ? previous.text : '');
        const nextState = state && Object.keys(state).length
            ? plainState(state)
            : (previous?.state ?? {});
        const changed = previous?.text !== nextText
            || previous?.state?.type !== nextState.type
            || previous?.state?.title !== nextState.title;
        this.contexts.set(appId, {text: nextText, state: nextState});
        if (changed || !previous)
            this.onContext?.(appId);
    }

    insertPending(appId, text) {
        const proxy = this._proxies.get(appId);
        if (!proxy)
            throw new Error('The terminal agent switch is off.');
        proxy.call_sync(
            'InsertPending',
            new GLib.Variant('(s)', [text]),
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    }
}

function usefulText(text) {
    return typeof text === 'string' && text.trim().length > 0;
}

function plainValue(value) {
    if (value instanceof GLib.Variant)
        return plainValue(value.deepUnpack());
    return value;
}

function plainState(state) {
    const out = {};
    if (!state || typeof state !== 'object')
        return out;
    for (const key of Object.keys(state))
        out[key] = plainValue(state[key]);
    return out;
}

function readStateReply(unpacked) {
    if (typeof unpacked?.[0] === 'string')
        return {text: unpacked[0], state: unpacked[1] ?? {}};
    return {text: '', state: unpacked?.[0] ?? {}};
}

function nameOwner(name) {
    try {
        const variant = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'GetNameOwner',
            new GLib.Variant('(s)', [name]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            500,
            null);
        return variant.deepUnpack()[0];
    } catch {
        return '';
    }
}

function exportsClient(name) {
    try {
        Gio.DBus.session.call_sync(
            name,
            CLIENT_PATH,
            'org.freedesktop.DBus.Introspectable',
            'Introspect',
            null,
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            500,
            null);
        return true;
    } catch {
        return false;
    }
}
