import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function concatBytes(parts) {
    const len = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(len);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function derLen(length) {
    if (length < 128)
        return Uint8Array.of(length);
    const bytes = [];
    let value = length;
    while (value > 0) {
        bytes.unshift(value & 0xff);
        value >>= 8;
    }
    return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derTag(tag, content) {
    return concatBytes([Uint8Array.of(tag), derLen(content.length), content]);
}

function derInteger(bytes) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0)
        start += 1;
    let body = bytes.subarray(start);
    if (body[0] & 0x80)
        body = concatBytes([Uint8Array.of(0), body]);
    return derTag(0x02, body);
}

function base64urlDecode(text) {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/')
        .padEnd(text.length + (4 - text.length % 4) % 4, '=');
    return Uint8Array.from(GLib.base64_decode(padded));
}

function pemFromJwk(jwk) {
    const oid = Uint8Array.of(
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
    const rsaSeq = derTag(0x30, concatBytes([
        derInteger(base64urlDecode(jwk.n)),
        derInteger(base64urlDecode(jwk.e)),
    ]));
    const bitString = derTag(0x03, concatBytes([Uint8Array.of(0x00), rsaSeq]));
    const alg = derTag(0x30, concatBytes([oid, Uint8Array.of(0x05, 0x00)]));
    const spki = derTag(0x30, concatBytes([alg, bitString]));
    const b64 = GLib.base64_encode(spki);
    const lines = b64.match(/.{1,64}/g).join('\n');
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

function writeTemp(bytes, suffix) {
    const path = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `aia-${GLib.uuid_string_random()}${suffix}`,
    ]);
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(bytes), null);
    stream.close(null);
    return path;
}

function opensslVerify(pem, signingInput, signature) {
    const pemPath = writeTemp(new TextEncoder().encode(pem), '.pem');
    const dataPath = writeTemp(new TextEncoder().encode(signingInput), '.dat');
    const sigPath = writeTemp(signature, '.sig');
    try {
        const proc = Gio.Subprocess.new(
            ['openssl', 'dgst', '-sha256', '-verify', pemPath, '-signature', sigPath, dataPath],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        return proc.wait_check(null);
    } catch {
        return false;
    } finally {
        for (const path of [pemPath, dataPath, sigPath])
            Gio.File.new_for_path(path).delete(null);
    }
}

export function audienceAccepted(aud, clientId) {
    const allowed = new Set([
        clientId,
        'dynamic_agent_client',
        'https://api.openai.com/v1',
    ].filter(Boolean));
    const got = Array.isArray(aud) ? aud.map(String) : [String(aud ?? '')];
    return got.some(item => allowed.has(item));
}

export function verifyIdToken(token, {clientId, nonce, jwks}) {
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('ChatGPT did not return a verifiable identity.');
    const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
    if (header.alg !== 'RS256')
        throw new Error('ChatGPT identity used an unsupported algorithm.');
    const key = (jwks.keys ?? []).find(item => item.kid === header.kid && item.kty === 'RSA');
    if (!key)
        throw new Error('ChatGPT identity key was not found.');
    if (!opensslVerify(pemFromJwk(key), `${parts[0]}.${parts[1]}`, base64urlDecode(parts[2])))
        throw new Error('ChatGPT identity signature was rejected.');
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== 'https://auth.openai.com')
        throw new Error('ChatGPT identity issuer was rejected.');
    if (!audienceAccepted(payload.aud, clientId)) {
        const got = Array.isArray(payload.aud) ? payload.aud.map(String).join(', ') : String(payload.aud ?? '');
        throw new Error(`ChatGPT identity audience was rejected: ${got}.`);
    }
    if (payload.nonce !== nonce)
        throw new Error('ChatGPT identity nonce was rejected.');
    if (typeof payload.exp === 'number' && payload.exp < now)
        throw new Error('ChatGPT identity token has expired.');
    return payload;
}
