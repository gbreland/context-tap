import {chatTitle, countPairs, normalizeIndex, turnsFrom, upsertChat, zipMessages} from '../src/chats.js';

function assert(cond, message) {
    if (!cond)
        throw new Error(message);
}

assert(chatTitle('  hello\nmore') === 'hello', chatTitle('  hello\nmore'));
assert(chatTitle('x'.repeat(90)).length === 80, 'title length');

const index = upsertChat({openId: '', chats: []}, {
    id: 'conv_1',
    title: 'hello',
    createdAt: 10,
    turns: [{sentAt: 5, elapsedMs: 1200}],
});
assert(index.openId === 'conv_1' && index.chats.length === 1, 'insert chat');
const again = upsertChat(index, {
    id: 'conv_1',
    title: 'hello',
    createdAt: 10,
    turns: [{sentAt: 5, elapsedMs: 2200}],
});
assert(again.chats.length === 1 && again.chats[0].turns[0].elapsedMs === 2200, 'update chat');

const messages = zipMessages([
    {role: 'user', text: 'Hi'},
    {role: 'assistant', text: 'Hello'},
], [{sentAt: 50, elapsedMs: 1500}]);
assert(messages[0].sentAt === 50 && messages[1].elapsedMs === 1500, JSON.stringify(messages));
assert(countPairs(messages) === 1, 'pairs');
assert(turnsFrom(messages)[0].elapsedMs === 1500, 'turns');
assert(normalizeIndex({chats: [{id: 4}]}).chats[0].id === '4', 'id string');

print('chat tests passed');
