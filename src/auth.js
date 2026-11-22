import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {verifyIdToken} from './jwt.js';

const AUTH_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const SUCCESS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Context Tap</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: sans-serif;
    background: #f6f5f4;
    color: #241f31;
  }
  main {
    width: min(24rem, calc(100vw - 3rem));
    padding: 2rem 1.75rem;
    text-align: center;
    background: #fff;
    border-radius: 18px;
  }
  h1 { font-size: 1.35rem; font-weight: 650; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.5; }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1e1e; color: #f6f5f4; }
    main { background: #2d2d2d; }
  }
</style>
</head>
<body>
<main>
  <h1>Signed in</h1>
  <p>You can close this window and return to Context Tap.</p>
</main>
</body>
</html>`;

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function readJson(name) {
    const path = GLib.build_filenamev([dataDir(), name]);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    const [, bytes] = file.load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

function writeJson(name, value) {
    const path = GLib.build_filenamev([dataDir(), name]);
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(value, null, 2))), null);
    stream.close(null);
}

function formEncode(fields) {
    return Object.entries(fields)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

function formDecode(query) {
    const params = {};
    for (const part of (query ?? '').split('&')) {
        if (!part)
            continue;
        const eq = part.indexOf('=');
        const rawKey = eq === -1 ? part : part.slice(0, eq);
        const rawValue = eq === -1 ? '' : part.slice(eq + 1);
        const key = decodeURIComponent(rawKey.replaceAll('+', ' '));
        params[key] = decodeURIComponent(rawValue.replaceAll('+', ' '));
    }
    return params;
}

function randomUrl(size) {
    const file = Gio.File.new_for_path('/dev/urandom');
    const stream = file.read(null);
    const bytes = stream.read_bytes(size, null).toArray();
    stream.close(null);
    return GLib.base64_encode(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function sha256Url(text) {
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    checksum.update(new TextEncoder().encode(text));
    const hex = checksum.get_string();
    const raw = Uint8Array.from(hex.match(/.{2}/g), pair => parseInt(pair, 16));
    return GLib.base64_encode(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function hostId() {
    const saved = readJson('host.json');
    if (saved?.ext_agent_host_id)
        return saved.ext_agent_host_id;
    const id = `urn:uuid:${GLib.uuid_string_random()}`;
    writeJson('host.json', {ext_agent_host_id: id});
    return id;
}

function formBody(fields) {
    return Object.entries(fields)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

function itemText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map(part => part?.text || part?.output_text || '').join('');
}

function messageItem(row) {
    if (row?.role !== 'user' && row?.role !== 'assistant')
        return null;
    return {role: row.role, text: itemText(row.content)};
}

function httpError(text, status) {
    const error = new Error(text || `HTTP ${status}`);
    try {
        const item = JSON.parse(text).error ?? {};
        error.apiType = item.type ?? '';
        error.apiCode = item.code ?? '';
        if (item.type === 'rejected_by_access_enforcement')
            error.message = 'ChatGPT cannot store chats for this sign-in.';
        else if (item.message)
            error.message = item.message;
    } catch {
        /* Keep the raw response when it is not JSON. */
    }
    return error;
}

function sendBytes(session, method, uri, body, contentType, token) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new(method, uri);
        if (token)
            message.request_headers.append('Authorization', `Bearer ${token}`);
        if (body != null) {
            const bytes = typeof body === 'string'
                ? new TextEncoder().encode(body)
                : body;
            message.set_request_body_from_bytes(contentType, GLib.Bytes.new(bytes));
        }
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                const data = src.send_and_read_finish(res);
                const status = message.get_status();
                const text = new TextDecoder().decode(data.toArray());
                if (status < 200 || status >= 300)
                    reject(httpError(text, status));
                else
                    resolve(text);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function jwks(session) {
    const config = JSON.parse(await sendBytes(
        session, 'GET', 'https://auth.openai.com/.well-known/openid-configuration', null, null, null));
    return JSON.parse(await sendBytes(session, 'GET', config.jwks_uri, null, null, null));
}

function listenForCode() {
    const listener = new Gio.SocketListener();
    const address = Gio.InetSocketAddress.new(Gio.InetAddress.new_from_string('127.0.0.1'), 0);
    const [, effective] = listener.add_address(
        address,
        Gio.SocketType.STREAM,
        Gio.SocketProtocol.TCP,
        null);
    const port = effective.get_port();
    let settled = false;
    let done;
    const result = new Promise(resolve => {
        done = resolve;
    });

    const finish = params => {
        if (settled)
            return;
        settled = true;
        done(params);
    };

    const reply = (connection, page) => {
        const body = new TextEncoder().encode(page);
        const header = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
        const head = new TextEncoder().encode(header);
        const payload = new Uint8Array(head.length + body.length);
        payload.set(head, 0);
        payload.set(body, head.length);
        try {
            connection.get_output_stream().write_all(payload, null);
        } catch {
            /* The browser can close before the write finishes. */
        }
        try {
            connection.close(null);
        } catch {
            /* The socket is already closed. */
        }
    };

    const readCallback = connection => {
        const chunks = [];
        const pump = () => {
            connection.get_input_stream().read_bytes_async(8192, GLib.PRIORITY_DEFAULT, null, (src, res) => {
                let bytes = [];
                try {
                    bytes = src.read_bytes_finish(res).toArray();
                } catch {
                    connection.close(null);
                    return;
                }
                if (bytes.length)
                    chunks.push(bytes);
                const text = new TextDecoder().decode(concat(chunks));
                if (!text.includes('\r\n\r\n') && bytes.length) {
                    pump();
                    return;
                }
                const start = text.split('\r\n', 1)[0] ?? '';
                const target = start.split(' ')[1] ?? '/';
                const qmark = target.indexOf('?');
                const path = qmark === -1 ? target : target.slice(0, qmark);
                const query = qmark === -1 ? '' : target.slice(qmark + 1);
                const callback = path.startsWith('/auth/callback');
                reply(connection, callback ? SUCCESS_PAGE : '');
                if (!callback)
                    return;
                const params = formDecode(query);
                finish({
                    code: params.code ?? '',
                    state: params.state ?? '',
                    clientId: params.client_id ?? '',
                    error: params.error ?? '',
                });
            });
        };
        pump();
    };

    const acceptNext = () => {
        listener.accept_async(null, (src, res) => {
            try {
                const [connection] = src.accept_finish(res);
                readCallback(connection);
            } catch {
                /* accept_finish fails after close(). */
            }
            if (!settled)
                acceptNext();
        });
    };
    acceptNext();

    return {
        listener,
        port,
        result,
        close() {
            settled = true;
            listener.close();
        },
    };
}

export function loadSession() {
    return readJson('chatgpt-auth.json');
}

export class ChatGpt {
    constructor() {
        this.session = new Soup.Session();
        this.auth = loadSession();
    }

    signedIn() {
        return Boolean(this.auth?.access_token);
    }

    signOut() {
        this.auth = null;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), 'chatgpt-auth.json']));
        if (file.query_exists(null))
            file.delete(null);
    }

    email() {
        return this.auth?.email ?? '';
    }

    async signIn() {
        const verifier = randomUrl(32);
        const state = randomUrl(24);
        const nonce = randomUrl(24);
        this._listener = listenForCode();
        const listener = this._listener;
        const redirect = `http://127.0.0.1:${listener.port}/auth/callback`;
        const clientId = this.auth?.client_id || 'dynamic_agent_client';
        const params = {
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirect,
            scope: SCOPE,
            resource: RESOURCE,
            state,
            nonce,
            code_challenge_method: 'S256',
            code_challenge: sha256Url(verifier),
            ext_agent_host_id: hostId(),
        };
        if (clientId === 'dynamic_agent_client')
            params.agent_name_hint = 'Context Tap';
        else if (this.auth?.id_token)
            params.id_token_hint = this.auth.id_token;
        const uri = `${AUTH_URL}?${formEncode(params)}`;
        Gio.AppInfo.launch_default_for_uri(uri, null);
        const callback = await listener.result;
        listener.close();
        this._listener = null;
        if (callback.error)
            throw new Error(callback.error);
        if (!callback.code)
            throw new Error('ChatGPT did not return a login code.');
        if (callback.state !== state)
            throw new Error('ChatGPT login state did not match.');
        const exchangeId = callback.clientId || clientId;
        const tokenText = await sendBytes(this.session, 'POST', TOKEN_URL, formBody({
            grant_type: 'authorization_code',
            client_id: exchangeId,
            code: callback.code,
            code_verifier: verifier,
            redirect_uri: redirect,
            resource: RESOURCE,
        }), 'application/x-www-form-urlencoded', null);
        const token = JSON.parse(tokenText);
        const identity = verifyIdToken(token.id_token, {
            clientId: exchangeId,
            nonce,
            jwks: await jwks(this.session),
        });
        const issued = callback.clientId
            || (identity.aud && identity.aud !== 'dynamic_agent_client' ? identity.aud : exchangeId);
        this.auth = {
            email: identity.email ?? '',
            issuer: identity.iss,
            subject: identity.sub,
            client_id: issued,
            ext_agent_host_id: hostId(),
            id_token: token.id_token,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            token_type: token.token_type,
            expires_at: Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600),
            scopes: String(token.scope ?? '').split(/\s+/).filter(Boolean),
            saved_at: new Date().toISOString(),
        };
        writeJson('chatgpt-auth.json', this.auth);
    }

    async accessToken() {
        if (!this.auth?.access_token)
            throw new Error('Sign in with ChatGPT first.');
        if (this.auth.expires_at > Math.floor(Date.now() / 1000) + 60)
            return this.auth.access_token;
        const text = await sendBytes(this.session, 'POST', TOKEN_URL, formBody({
            grant_type: 'refresh_token',
            client_id: this.auth.client_id,
            refresh_token: this.auth.refresh_token,
            resource: RESOURCE,
        }), 'application/x-www-form-urlencoded', null);
        const token = JSON.parse(text);
        this.auth.access_token = token.access_token;
        this.auth.refresh_token = token.refresh_token ?? this.auth.refresh_token;
        this.auth.expires_at = Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600);
        if (token.scope)
            this.auth.scopes = String(token.scope).split(/\s+/).filter(Boolean);
        writeJson('chatgpt-auth.json', this.auth);
        return this.auth.access_token;
    }

    async createConversation() {
        const text = await sendBytes(
            this.session, 'POST', 'https://api.openai.com/v1/conversations',
            '{}', 'application/json', await this.accessToken());
        const body = JSON.parse(text);
        if (!body.id)
            throw new Error('ChatGPT did not return a chat id.');
        return body;
    }

    async addItems(id, items) {
        await sendBytes(
            this.session, 'POST',
            `https://api.openai.com/v1/conversations/${encodeURIComponent(id)}/items`,
            JSON.stringify({items}), 'application/json', await this.accessToken());
    }

    async listItems(id) {
        const out = [];
        let after = '';
        for (;;) {
            const query = [`limit=100`, 'order=asc'];
            if (after)
                query.push(`after=${encodeURIComponent(after)}`);
            const text = await sendBytes(
                this.session, 'GET',
                `https://api.openai.com/v1/conversations/${encodeURIComponent(id)}/items?${query.join('&')}`,
                null, null, await this.accessToken());
            const body = JSON.parse(text);
            const rows = body.data ?? body.items ?? [];
            for (const row of rows) {
                const item = messageItem(row);
                if (item)
                    out.push(item);
            }
            if (!body.has_more || !rows.length)
                break;
            after = body.last_id ?? rows[rows.length - 1]?.id ?? '';
            if (!after)
                break;
        }
        return out;
    }

    async listModels() {
        const text = await sendBytes(
            this.session, 'GET', 'https://api.openai.com/v1/models', null, null, await this.accessToken());
        const body = JSON.parse(text);
        const rows = body.models ?? body.data ?? [];
        return rows
            .filter(row => !row.visibility || row.visibility === 'list')
            .map(row => ({
                slug: row.slug ?? row.id,
                display_name: row.display_name ?? row.id ?? row.slug,
            }))
            .filter(row => row.slug);
    }

    async streamReply({model, instructions, input, onDelta}) {
        const message = Soup.Message.new('POST', 'https://api.openai.com/v1/responses');
        message.request_headers.append('Authorization', `Bearer ${await this.accessToken()}`);
        message.request_headers.append('Accept', 'text/event-stream');
        message.set_request_body_from_bytes('application/json', GLib.Bytes.new(new TextEncoder().encode(JSON.stringify({
            model,
            instructions,
            input,
            store: false,
            stream: true,
        }))));
        const stream = await new Promise((resolve, reject) => {
            this.session.send_async(message, GLib.PRIORITY_DEFAULT, null, (src, res) => {
                try {
                    resolve(src.send_finish(res));
                } catch (error) {
                    reject(error);
                }
            });
        });
        const status = message.get_status();
        if (status < 200 || status >= 300) {
            const errBytes = await readAll(stream);
            throw httpError(new TextDecoder().decode(errBytes), status);
        }
        let pending = '';
        let text = '';
        let completed = false;
        const takeBlocks = () => {
            let split = pending.indexOf('\n\n');
            while (split >= 0) {
                const block = pending.slice(0, split);
                pending = pending.slice(split + 2);
                let data = '';
                for (const line of block.split('\n')) {
                    if (line.startsWith('data:'))
                        data += line.slice(5).trim();
                }
                if (!data || data === '[DONE]') {
                    split = pending.indexOf('\n\n');
                    continue;
                }
                const event = JSON.parse(data);
                if (event.type === 'response.output_text.delta' && event.delta) {
                    text += event.delta;
                    onDelta(text);
                } else if (event.type === 'response.completed') {
                    completed = true;
                } else if (event.type === 'response.failed') {
                    throw new Error(event.response?.error?.message ?? 'ChatGPT request failed.');
                }
                split = pending.indexOf('\n\n');
            }
        };
        for (;;) {
            const chunk = await readSome(stream);
            if (!chunk.length)
                break;
            pending += new TextDecoder().decode(chunk);
            takeBlocks();
        }
        takeBlocks();
        if (!completed)
            throw new Error('ChatGPT ended the reply before it was complete.');
        return text;
    }
}

function readSome(stream) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                resolve(src.read_bytes_finish(res).toArray());
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readAll(stream) {
    return (async () => {
        const parts = [];
        for (;;) {
            const chunk = await readSome(stream);
            if (!chunk.length)
                break;
            parts.push(chunk);
        }
        return concat(parts);
    })();
}

function concat(parts) {
    const len = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(len);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
