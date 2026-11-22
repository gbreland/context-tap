import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const CHATS_FILE = 'chats.json';

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

export function chatTitle(text) {
    const line = String(text ?? '').split('\n').map(part => part.trim()).find(Boolean) ?? 'New chat';
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function emptyIndex() {
    return {openId: '', skipLegacy: false, chats: []};
}

function turnRow(turn) {
    const elapsed = Number(turn?.elapsedMs);
    return {
        sentAt: Number(turn?.sentAt) || 0,
        elapsedMs: Number.isFinite(elapsed) ? elapsed : null,
    };
}

export function normalizeIndex(data) {
    const chats = Array.isArray(data?.chats) ? data.chats.filter(row => row?.id) : [];
    return {
        openId: typeof data?.openId === 'string' ? data.openId : '',
        skipLegacy: Boolean(data?.skipLegacy),
        chats: chats.map(row => ({
            id: String(row.id),
            title: String(row.title || 'New chat'),
            createdAt: Number(row.createdAt) || 0,
            turns: Array.isArray(row.turns) ? row.turns.map(turnRow) : [],
        })),
    };
}

export function loadChats() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), CHATS_FILE]));
        const [, bytes] = file.load_contents(null);
        return normalizeIndex(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return emptyIndex();
    }
}

export function saveChats(index) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), CHATS_FILE]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    const body = JSON.stringify(normalizeIndex(index));
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(body)), null);
    stream.close(null);
}

export function upsertChat(index, chat) {
    const next = normalizeIndex(index);
    const row = {
        id: String(chat.id),
        title: String(chat.title || 'New chat'),
        createdAt: Number(chat.createdAt) || 0,
        turns: Array.isArray(chat.turns) ? chat.turns.map(turnRow) : [],
    };
    const found = next.chats.findIndex(item => item.id === row.id);
    if (found >= 0)
        next.chats[found] = row;
    else
        next.chats.unshift(row);
    next.openId = row.id;
    return next;
}

export function turnsFrom(messages) {
    const turns = [];
    for (let i = 0; i + 1 < messages.length; i += 2) {
        const user = messages[i];
        const assistant = messages[i + 1];
        if (user?.role !== 'user' || assistant?.role !== 'assistant' || !assistant.text)
            break;
        turns.push(turnRow({sentAt: user.sentAt, elapsedMs: assistant.elapsedMs}));
    }
    return turns;
}

export function zipMessages(items, turns) {
    const messages = [];
    let turn = 0;
    for (const item of items ?? []) {
        if (item?.role === 'user') {
            const sentAt = Number(turns?.[turn]?.sentAt) || 0;
            messages.push(sentAt
                ? {role: 'user', text: item.text ?? '', sentAt}
                : {role: 'user', text: item.text ?? ''});
        } else if (item?.role === 'assistant') {
            const elapsed = Number(turns?.[turn]?.elapsedMs);
            const message = {role: 'assistant', text: item.text ?? ''};
            if (Number.isFinite(elapsed))
                message.elapsedMs = elapsed;
            messages.push(message);
            turn += 1;
        }
    }
    return messages;
}

export function countPairs(messages) {
    let count = 0;
    for (let i = 0; i + 1 < messages.length; i += 2) {
        if (messages[i]?.role === 'user' && messages[i + 1]?.role === 'assistant' && messages[i + 1].text)
            count += 1;
        else
            break;
    }
    return count;
}
