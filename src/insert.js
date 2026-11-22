// Split a terminal-action block into the groups the model marked with blank lines. The text stays as written.

export function commandUnits(text) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = src.split('\n');
    const units = [];
    let buf = [];
    let quote = '';
    let doDepth = 0;
    let ifDepth = 0;
    let caseDepth = 0;
    let braceDepth = 0;
    let parenDepth = 0;
    let funcParen = 0;
    const pendingHeredocs = [];
    let activeHeredoc = null;

    function depth() {
        return doDepth + ifDepth + caseDepth + braceDepth + parenDepth + (activeHeredoc ? 1 : 0) + pendingHeredocs.length;
    }

    function flush() {
        while (buf.length && buf[buf.length - 1] === '')
            buf.pop();
        const chunk = buf.join('\n').replace(/^\n+/, '');
        buf = [];
        if (chunk.trim())
            units.push(chunk);
    }

    function takeWord(word) {
        if (word === 'for' || word === 'while' || word === 'until' || word === 'select')
            doDepth++;
        else if (word === 'if')
            ifDepth++;
        else if (word === 'case')
            caseDepth++;
        else if (word === 'done' && doDepth)
            doDepth--;
        else if (word === 'fi' && ifDepth)
            ifDepth--;
        else if (word === 'esac' && caseDepth)
            caseDepth--;
    }

    for (const line of lines) {
        if (activeHeredoc) {
            buf.push(line);
            const body = activeHeredoc.strip ? line.replace(/^\t+/, '') : line;
            if (body === activeHeredoc.delim) {
                activeHeredoc = pendingHeredocs.shift() ?? null;
                if (!activeHeredoc && depth() === 0 && !quote)
                    flush();
            }
            continue;
        }

        buf.push(line);
        let word = '';
        let cont = false;
        let escape = false;
        const opened = [];

        function endWord() {
            if (!word)
                return;
            takeWord(word);
            word = '';
        }

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quote) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\' && quote === '"') {
                    escape = true;
                    continue;
                }
                if (ch === quote)
                    quote = '';
                continue;
            }
            if (escape) {
                escape = false;
                word += ch;
                continue;
            }
            if (ch === '\\') {
                if (i === line.length - 1) {
                    cont = true;
                    endWord();
                    break;
                }
                escape = true;
                continue;
            }
            if (ch === '#') {
                endWord();
                break;
            }
            if (ch === '\'' || ch === '"') {
                endWord();
                quote = ch;
                continue;
            }
            if (ch === '{') {
                endWord();
                const prev = i > 0 ? line[i - 1] : ' ';
                const next = line[i + 1] ?? ' ';
                if (prev !== '$' && /[\s;|&(]/.test(prev) && /[\s;]/.test(next))
                    braceDepth++;
                continue;
            }
            if (ch === '}') {
                endWord();
                const prev = i > 0 ? line[i - 1] : ' ';
                if (braceDepth && /[\s;|&}]/.test(prev))
                    braceDepth--;
                continue;
            }
            if (ch === '(') {
                const prev = i > 0 ? line[i - 1] : ' ';
                endWord();
                if (/[A-Za-z0-9_]/.test(prev))
                    funcParen++;
                else
                    parenDepth++;
                continue;
            }
            if (ch === ')') {
                endWord();
                if (funcParen)
                    funcParen--;
                else if (parenDepth)
                    parenDepth--;
                continue;
            }
            if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
                endWord();
                let j = i + 2;
                let strip = false;
                if (line[j] === '-') {
                    strip = true;
                    j++;
                }
                while (j < line.length && /\s/.test(line[j]))
                    j++;
                let mark = '';
                if (line[j] === '\'' || line[j] === '"') {
                    mark = line[j];
                    j++;
                }
                let delim = '';
                while (j < line.length && (mark ? line[j] !== mark : !/[\s;|&<>()]/.test(line[j]))) {
                    delim += line[j];
                    j++;
                }
                if (mark && line[j] === mark)
                    j++;
                if (delim)
                    opened.push({delim, strip});
                i = Math.max(i, j - 1);
                continue;
            }
            if (/[A-Za-z0-9_]/.test(ch)) {
                word += ch;
                continue;
            }
            endWord();
        }
        endWord();
        if (opened.length)
            pendingHeredocs.push(...opened);
        if (cont || quote)
            continue;
        if (pendingHeredocs.length) {
            activeHeredoc = pendingHeredocs.shift();
            continue;
        }
        if (depth() === 0 && line.trim() === '')
            flush();
    }
    if (buf.length)
        flush();
    return units;
}

export function withEnter(text) {
    const body = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!body)
        return '';
    return body.endsWith('\n') ? body : `${body}\n`;
}

export function isHeredoc(text) {
    return commandUnits(text).some(line => line.includes('<<'));
}

export function insertAll(text) {
    return {ok: true, text: String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')};
}

export function insertLine(text, index) {
    const units = commandUnits(text);
    if (index >= units.length)
        return {ok: false, reason: 'done', index};
    return {ok: true, text: units[index], index: index + 1};
}

export function shellBlocks(markdown) {
    const blocks = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match = re.exec(markdown);
    while (match) {
        const lang = match[1].trim().toLowerCase();
        if (lang === '' || lang === 'sh' || lang === 'bash' || lang === 'shell' ||
            lang === 'zsh' || lang === 'console' || lang === 'fish')
            blocks.push(match[2].replace(/\n$/, ''));
        match = re.exec(markdown);
    }
    return blocks;
}
