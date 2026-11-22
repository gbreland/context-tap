import {inlineMarkup, isShellLang, isTerminalAction, markdownBlocks, markupFor, TERMINAL_ACTION_TEXT} from '../src/markdown.js';

function assert(cond, message) {
    if (!cond)
        throw new Error(message);
}

const sample = [
    '# Title',
    '',
    'A **bold** and *italic* word with `code` and [a link](https://example.com).',
    '',
    '- one',
    '- two',
    '  - nested',
    '- [x] done',
    '',
    '1. first',
    '',
    '> quoted **text**',
    '',
    '```bash',
    'echo hi',
    '```',
    '',
    '```python',
    'print(1)',
    '```',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| a | b |',
    '',
    '---',
    '',
    'Use <b>plain</b> & stars',
    '',
    '```',
    'still open',
].join('\n');

const blocks = markdownBlocks(sample);
assert(blocks[0].type === 'heading' && blocks[0].level === 1 && blocks[0].text === 'Title', 'heading');
const para = blocks.find(block => block.type === 'paragraph' && block.text.startsWith('A '));
const markup = inlineMarkup(para.text);
assert(markup.includes('<b>bold</b>'), markup);
assert(markup.includes('<i>italic</i>'), markup);
assert(markup.includes('<tt>code</tt>'), markup);
assert(markup.includes('href="https://example.com"'), markup);
assert(!markup.includes('**'), markup);

const list = blocks.find(block => block.type === 'list' && block.items.length === 4);
const listMarkup = markupFor(list);
assert(listMarkup.includes('• one'), listMarkup);
assert(listMarkup.includes('    • nested'), listMarkup);
assert(listMarkup.includes('☑ done'), listMarkup);
const ordered = blocks.find(block => block.type === 'list' && block.items[0].ordered);
assert(markupFor(ordered).startsWith('1. first'), markupFor(ordered));

const quote = blocks.find(block => block.type === 'quote');
assert(markupFor(quote) === '<b>text</b>' || markupFor(quote).includes('<b>text</b>'), markupFor(quote));

const bash = blocks.find(block => block.type === 'code' && block.lang === 'bash');
assert(bash && !isTerminalAction(bash.lang), 'plain bash is not an action');
const actionSample = markdownBlocks('```bash terminal-action\nfree -h\n```\n');
assert(actionSample.length === 1 && actionSample[0].text === 'free -h', actionSample[0]?.text);
assert(isTerminalAction(actionSample[0].lang), actionSample[0].lang);
assert(isTerminalAction('Bash  Terminal-Action'), 'marker case');
assert(isTerminalAction('terminal-action'), 'short marker');
assert(TERMINAL_ACTION_TEXT.includes('bash terminal-action'), 'action instructions');
assert(TERMINAL_ACTION_TEXT.includes('200 lines'), 'line cap');
assert(TERMINAL_ACTION_TEXT.includes('Group commands'), 'group order');
assert(TERMINAL_ACTION_TEXT.includes('separate groups with one empty line'), 'group marker');
assert(TERMINAL_ACTION_TEXT.includes('two Run buttons'), 'group example');
assert(TERMINAL_ACTION_TEXT.includes('Never put a comment alone'), 'comment rule');
const python = blocks.find(block => block.type === 'code' && block.lang === 'python');
const open = blocks.find(block => block.type === 'code' && block.text === 'still open');
assert(bash.text === 'echo hi' && isShellLang(bash.lang), bash.text);
assert(python.text === 'print(1)' && !isShellLang(python.lang), python.text);
assert(open && isShellLang(open.lang), 'open fence');

const table = blocks.find(block => block.type === 'table');
assert(table.header[0] === 'Name' && table.rows[0][1] === 'b', 'table');
assert(blocks.some(block => block.type === 'rule'), 'rule');

const plain = blocks.find(block => block.type === 'paragraph' && block.text.includes('plain'));
const escaped = inlineMarkup(plain.text);
assert(escaped.includes('&lt;b&gt;plain&lt;/b&gt;'), escaped);
assert(escaped.includes('&amp;'), escaped);
assert(markupFor(blocks[0]).includes('size="x-large"'), markupFor(blocks[0]));

print('markdown tests passed');
