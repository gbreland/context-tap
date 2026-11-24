import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ALLOW_FILE = 'context-allow.json';

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function normalize(value) {
    return value === 'allow' || value === 'deny' ? value : 'ask';
}

function normalizeMap(value) {
    const out = {};
    if (!value || typeof value !== 'object')
        return out;
    for (const [key, item] of Object.entries(value))
        out[key] = normalize(item);
    return out;
}

export function loadAllow() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), ALLOW_FILE]));
        const [, bytes] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return allowFrom(data);
    } catch {
        return allowFrom(null);
    }
}

export function allowFrom(data) {
    const source = data ?? {};
    return {
        host: source.host === 'deny' ? 'deny' : 'allow',
        packages: normalize(source.packages),
        graphics: source.graphics === 'deny' ? 'deny' : source.graphics === 'ask' ? 'ask' : 'allow',
        terminal: normalizeMap(source.terminal),
        terminalInstructions: source.terminalInstructions === 'deny' ? 'deny' : 'allow',
        screenshot: normalizeMap(source.screenshot),
    };
}

export function saveAllow(allow) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), ALLOW_FILE]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(allow))), null);
    stream.close(null);
}

function topLevel(kind) {
    return kind === 'host' || kind === 'packages' || kind === 'graphics' || kind === 'terminalInstructions';
}

export function decision(allow, kind, id) {
    if (topLevel(kind))
        return normalize(allow[kind]);
    const value = allow[kind]?.[id];
    if (kind === 'terminal')
        return value === 'deny' ? 'deny' : 'allow';
    return normalize(value);
}

export function decide(allow, kind, id, value) {
    const next = value === 'allow' ? 'allow' : 'deny';
    if (topLevel(kind)) {
        allow[kind] = next;
        return;
    }
    allow[kind][id] = next;
}

export function splitFresh(previous, current) {
    const text = current ?? '';
    const prior = previous ?? '';
    if (!text)
        return {sent: '', fresh: '', changed: false};
    if (!prior)
        return {sent: '', fresh: text, changed: true};
    if (prior === text)
        return {sent: text, fresh: '', changed: false};
    if (text.startsWith(prior))
        return {sent: prior, fresh: text.slice(prior.length), changed: true};
    const count = suffixPrefix(prior, text);
    if (count > 40)
        return {sent: text.slice(0, count), fresh: text.slice(count), changed: true};
    return {sent: '', fresh: text, changed: true};
}

function suffixPrefix(previous, current) {
    const limit = current.length;
    const border = new Array(limit);
    border[0] = 0;
    let matched = 0;
    for (let index = 1; index < limit; index++) {
        while (matched > 0 && current[index] !== current[matched])
            matched = border[matched - 1];
        if (current[index] === current[matched])
            matched++;
        border[index] = matched;
    }
    let state = 0;
    for (let index = 0; index < previous.length; index++) {
        while (state > 0 && previous[index] !== current[state])
            state = border[state - 1];
        if (previous[index] === current[state])
            state++;
        if (state === limit && index !== previous.length - 1)
            state = border[limit - 1];
    }
    return state;
}
