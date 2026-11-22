const SHELL = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console', 'fish', 'terminal', 'shellsession', 'shell-session']);
const TERMINAL_ACTION = 'bash terminal-action';

export function isShellLang(lang) {
    const text = String(lang ?? '').trim().toLowerCase();
    if (SHELL.has(text))
        return true;
    return text.startsWith('bash') || text.startsWith('sh ');
}

export function isTerminalAction(lang) {
    const text = String(lang ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return text === TERMINAL_ACTION || text === 'terminal-action'
        || text === 'sh terminal-action' || text === 'shell terminal-action';
}

export const TERMINAL_ACTION_TEXT = [
    'Every command the user should run must be inside a fenced code block with the exact info string "bash terminal-action". A plain bash, sh, or unmarked fence does not count.',
    'Only use that marker for commands the user should execute now. Do not use it for illustrative examples, quoted commands, terminal output, or commands the user should avoid.',
    'You receive only the last 200 lines of terminal text. If a command may print more, say so. Suggest head, tail, or grep, or split the work so each command returns fewer than 200 lines.',
    'Group commands. A group is the lines the user should run together with one click. You decide the groups.',
    'Inside a bash terminal-action block, separate groups with one empty line. Keep the lines of one group next to each other with no empty line between them. The application shows one Run button for each group and one Run All button for the whole block.',
    'A # comment line that labels a command belongs in the same group as that command, directly above it. Never put a comment alone in a group.',
    'Example. This block has two groups, so it shows two Run buttons:\n```bash terminal-action\n# GPUs and bound kernel drivers\nlspci -nnk | grep -A3 -Ei \'VGA|3D|Display\'\n\n# Session and desktop\nprintf \'%s %s\\n\' "$XDG_SESSION_TYPE" "$XDG_CURRENT_DESKTOP"\ngnome-shell --version\n```',
    'Do not put an empty line inside a loop, a conditional, a brace group, or a heredoc unless it is part of the command.',
    'Use normal shell syntax. Each line of a group runs in order, as if the user typed it and pressed Enter. Use && when a later command requires earlier success. Use || for a deliberate fallback.',
    'The application does not add && or ; for you.',
    'Give one next step, then wait for the user to run it and for the new terminal text.',
    'Do not include shell prompts. Keep the block contents limited to the exact text to run.',
    'Explain destructive actions, privileged operations, and important side effects before the block.',
    'The application may offer Copy or Run controls for marked blocks. You cannot execute commands yourself; never claim execution unless execution results have been provided.',
].join('\n\n');

function escapePango(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function softWrap(text) {
    return text.replace(/\S{24,}/g, token => token.replace(/(.{24})/g, '$1\u200b'));
}

export function inlineMarkup(text) {
    const s = String(text ?? '');
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s.startsWith('***', i)) {
            const end = s.indexOf('***', i + 3);
            if (end !== -1) {
                out += `<b><i>${inlineMarkup(s.slice(i + 3, end))}</i></b>`;
                i = end + 3;
                continue;
            }
        }
        if (s.startsWith('**', i) || s.startsWith('__', i)) {
            const mark = s.slice(i, i + 2);
            const end = s.indexOf(mark, i + 2);
            if (end !== -1) {
                out += `<b>${inlineMarkup(s.slice(i + 2, end))}</b>`;
                i = end + 2;
                continue;
            }
        }
        if (s.startsWith('~~', i)) {
            const end = s.indexOf('~~', i + 2);
            if (end !== -1) {
                out += `<s>${inlineMarkup(s.slice(i + 2, end))}</s>`;
                i = end + 2;
                continue;
            }
        }
        if (s[i] === '`') {
            const end = s.indexOf('`', i + 1);
            if (end !== -1) {
                out += `<tt>${escapePango(softWrap(s.slice(i + 1, end)))}</tt>`;
                i = end + 1;
                continue;
            }
        }
        const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
        if (image) {
            out += inlineMarkup(image[1] || image[2]);
            i += image[0].length;
            continue;
        }
        const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
        if (link) {
            out += linkMarkup(link[1], link[2]);
            i += link[0].length;
            continue;
        }
        const auto = /^<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/i.exec(s.slice(i));
        if (auto) {
            out += linkMarkup(auto[1], auto[1]);
            i += auto[0].length;
            continue;
        }
        if ((s[i] === '*' || s[i] === '_') && s[i + 1] !== s[i]) {
            const mark = s[i];
            const startOk = mark !== '_' || i === 0 || /\W/.test(s[i - 1]);
            const end = s.indexOf(mark, i + 1);
            const endOk = end !== -1 && (mark !== '_' || end + 1 === s.length || /\W/.test(s[end + 1]));
            if (startOk && endOk && end > i + 1) {
                out += `<i>${inlineMarkup(s.slice(i + 1, end))}</i>`;
                i = end + 1;
                continue;
            }
        }
        const ch = s[i];
        if (ch === '&' || ch === '<' || ch === '>')
            out += escapePango(ch);
        else if (/\s/.test(ch))
            out += ch;
        else {
            let j = i + 1;
            while (j < s.length && !/\s/.test(s[j]) && !'*_`[~!<'.includes(s[j]))
                j += 1;
            out += escapePango(softWrap(s.slice(i, j)));
            i = j;
            continue;
        }
        i += 1;
    }
    return out;
}

function linkMarkup(label, href) {
    const body = inlineMarkup(label);
    if (!/^(https?:|mailto:)/i.test(href))
        return body;
    return `<a href="${escapePango(href)}">${body}</a>`;
}

function listMatch(line) {
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match)
        return null;
    let text = match[3];
    let checked = null;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
        checked = task[1].toLowerCase() === 'x';
        text = task[2];
    }
    return {
        indent: match[1].length,
        ordered: /\d/.test(match[2]),
        n: Number.parseInt(match[2], 10) || 0,
        text,
        checked,
    };
}

function isTableRow(line) {
    const text = line.trim();
    return text.startsWith('|') && text.endsWith('|') && text.length > 2;
}

function isTableRule(line) {
    return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function cells(line) {
    let text = line.trim();
    if (text.startsWith('|'))
        text = text.slice(1);
    if (text.endsWith('|'))
        text = text.slice(0, -1);
    return text.split('|').map(cell => cell.trim());
}

function joinLines(lines) {
    let out = '';
    for (const line of lines) {
        if (!out) {
            out = line;
            continue;
        }
        if (/\s{2}$|\\$/.test(out))
            out = `${out.replace(/[ \\\t]+$/, '')}\n${line}`;
        else
            out += ` ${line}`;
    }
    return out;
}

function isBlockStart(line) {
    if (/^(#{1,6})\s+\S/.test(line))
        return true;
    if (/^(```|~~~)/.test(line))
        return true;
    if (/^>\s?/.test(line))
        return true;
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line))
        return true;
    if (listMatch(line))
        return true;
    return isTableRow(line);
}

export function markupFor(block) {
    if (block.type === 'heading') {
        const size = block.level === 1 ? 'x-large' : block.level === 2 ? 'large' : 'medium';
        return `<span weight="bold" size="${size}">${inlineMarkup(block.text)}</span>`;
    }
    if (block.type === 'paragraph' || block.type === 'quote')
        return inlineMarkup(block.text);
    if (block.type === 'list') {
        return block.items.map(item => {
            const pad = '    '.repeat(Math.min(6, Math.floor(item.indent / 2)));
            let mark = '• ';
            if (item.checked === true)
                mark = '☑ ';
            else if (item.checked === false)
                mark = '☐ ';
            else if (item.ordered)
                mark = `${item.n}. `;
            return `${pad}${mark}${inlineMarkup(item.text)}`;
        }).join('\n');
    }
    return '';
}

export function markdownBlocks(source) {
    const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            i += 1;
            continue;
        }
        const fence = /^(```|~~~)(.*)$/.exec(line);
        if (fence) {
            const close = fence[1];
            const lang = fence[2].trim();
            const body = [];
            i += 1;
            while (i < lines.length && lines[i].trim() !== close) {
                body.push(lines[i]);
                i += 1;
            }
            if (i < lines.length)
                i += 1;
            blocks.push({type: 'code', lang, text: body.join('\n').replace(/\n$/, '')});
            continue;
        }
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            blocks.push({type: 'heading', level: heading[1].length, text: heading[2].trim()});
            i += 1;
            continue;
        }
        if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push({type: 'rule'});
            i += 1;
            continue;
        }
        if (isTableRow(line) && isTableRule(lines[i + 1] ?? '')) {
            const header = cells(line);
            const rows = [];
            i += 2;
            while (i < lines.length && isTableRow(lines[i])) {
                rows.push(cells(lines[i]));
                i += 1;
            }
            blocks.push({type: 'table', header, rows});
            continue;
        }
        const item = listMatch(line);
        if (item) {
            const items = [];
            while (i < lines.length) {
                if (lines[i].trim() === '')
                    break;
                const next = listMatch(lines[i]);
                if (next) {
                    items.push(next);
                    i += 1;
                    continue;
                }
                if (isBlockStart(lines[i]) && !/^\s+\S/.test(lines[i]))
                    break;
                items[items.length - 1].text += ` ${lines[i].trim()}`;
                i += 1;
            }
            blocks.push({type: 'list', items});
            continue;
        }
        if (/^>\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^>\s?/, ''));
                i += 1;
            }
            blocks.push({type: 'quote', text: joinLines(quote)});
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
            para.push(lines[i].trim());
            i += 1;
        }
        if (para.length)
            blocks.push({type: 'paragraph', text: joinLines(para)});
        else
            i += 1;
    }
    return blocks;
}
