import Gio from 'gi://Gio';

import {withEnter} from './insert.js';

export function parentPid(statText) {
    const text = String(statText ?? '');
    const end = text.lastIndexOf(')');
    if (end < 0)
        return 0;
    const rest = text.slice(end + 2).trim().split(/\s+/);
    const pid = Number(rest[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

export function ancestorPids(pid, readStat) {
    const seen = new Set();
    const chain = [];
    let current = Number(pid);
    while (current > 0 && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        current = parentPid(readStat(current));
    }
    return chain;
}

export function parseClients(text) {
    const clients = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim())
            continue;
        const [pidText, session] = line.split('\t');
        const pid = Number(pidText);
        if (!Number.isInteger(pid) || pid <= 0 || !session)
            continue;
        clients.push({pid, session});
    }
    return clients;
}

export function parseActivePane(text) {
    let fallback = null;
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim())
            continue;
        const [id, active, directory, ...title] = line.split('\t');
        if (!id)
            continue;
        const pane = {id, directory: directory || '', title: title.join('\t')};
        if (!fallback)
            fallback = pane;
        if (active === '1')
            return pane;
    }
    return fallback;
}

export function clientForWindow(clients, windowPid, readStat) {
    const pid = Number(windowPid);
    if (!pid)
        return null;
    for (const client of clients) {
        if (ancestorPids(client.pid, readStat).includes(pid))
            return client;
    }
    return null;
}

export function trimCapture(text) {
    return String(text ?? '').trim();
}

function runTmux(args) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            ['tmux', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch {
        throw new Error('tmux is not available.');
    }
    const [, stdout, stderr] = proc.communicate_utf8(null, null);
    if (!proc.get_successful()) {
        const message = String(stderr || stdout || '').trim();
        throw new Error(message || 'tmux failed.');
    }
    return stdout ?? '';
}

function readProcStat(pid) {
    try {
        const file = Gio.File.new_for_path(`/proc/${pid}/stat`);
        const [, bytes] = file.load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

export function contextForPid(windowPid) {
    if (!Number(windowPid))
        return null;
    let listed;
    try {
        listed = runTmux(['list-clients', '-F', '#{client_pid}\t#{session_name}']);
    } catch {
        return null;
    }
    const client = clientForWindow(parseClients(listed), windowPid, readProcStat);
    if (!client)
        return null;
    let panes;
    try {
        panes = runTmux([
            'list-panes', '-t', client.session, '-F',
            '#{pane_id}\t#{pane_active}\t#{pane_current_path}\t#{pane_title}',
        ]);
    } catch {
        return null;
    }
    const pane = parseActivePane(panes);
    if (!pane)
        return null;
    let text = '';
    try {
        text = trimCapture(runTmux(['capture-pane', '-p', '-t', pane.id, '-S', '-200']));
    } catch {
        return null;
    }
    return {
        text,
        paneId: pane.id,
        state: {
            type: 'terminal',
            title: pane.title,
            directory: pane.directory,
            container: '',
        },
    };
}

export function sendToPane(paneId, text) {
    const body = withEnter(text);
    if (!paneId || !body)
        return;
    const lines = body.split('\n');
    for (let index = 0; index < lines.length; index++) {
        if (lines[index])
            runTmux(['send-keys', '-t', paneId, '-l', '--', lines[index]]);
        if (index < lines.length - 1)
            runTmux(['send-keys', '-t', paneId, 'Enter']);
    }
}
