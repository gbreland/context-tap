import {ancestorPids, clientForWindow, parentPid, parseActivePane, parseClients, trimCapture} from '../src/tmux.js';

const plain = parentPid('123 (bash) S 45 123 123');
if (plain !== 45)
    throw new Error(`parent pid failed: ${plain}`);
const paren = parentPid('123 (tmux: client) S 9 1 1');
if (paren !== 9)
    throw new Error(`paren name failed: ${paren}`);
if (parentPid('bad') !== 0)
    throw new Error('bad stat must return 0');

const stats = new Map([
    [50, '50 (tmux) S 40 0 0'],
    [40, '40 (bash) S 10 0 0'],
    [10, '10 (ptyxis) S 1 0 0'],
]);
const chain = ancestorPids(50, pid => stats.get(pid) || '');
if (chain.join(',') !== '50,40,10,1')
    throw new Error(`ancestor chain failed: ${chain}`);
const match = clientForWindow([{pid: 50, session: 'main'}], 10, pid => stats.get(pid) || '');
if (match?.session !== 'main')
    throw new Error('window pid must match the tmux client');
if (clientForWindow([{pid: 50, session: 'main'}], 0, () => '') !== null)
    throw new Error('a missing pid must not match');

const clients = parseClients('50\tmain\nbad\tnope\n\n60\tother\n');
if (clients.length !== 2 || clients[1].session !== 'other')
    throw new Error(`client parse failed: ${JSON.stringify(clients)}`);
const pane = parseActivePane('%1\t0\t/home\told\n%2\t1\t/tmp\twork');
if (pane?.id !== '%2' || pane.directory !== '/tmp' || pane.title !== 'work')
    throw new Error(`active pane failed: ${JSON.stringify(pane)}`);
const only = parseActivePane('%3\t0\t/var\tlone');
if (only?.id !== '%3')
    throw new Error('a single pane must be used');
const kept = trimCapture('prompt\n\n   \n');
if (kept !== 'prompt')
    throw new Error(`capture must end on the last text line: ${JSON.stringify(kept)}`);

print('tmux tests passed');
