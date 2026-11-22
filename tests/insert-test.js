import {commandUnits, insertAll, insertLine, isHeredoc, shellBlocks, withEnter} from '../src/insert.js';

function assert(cond, message) {
    if (!cond)
        throw new Error(message);
}

const joined = insertAll('dnf install -y foo\nls /\n');
assert(joined.ok && joined.text === 'dnf install -y foo\nls /\n', joined.text);
assert(joined.text.includes('\n'), 'original newlines');
assert(!joined.text.includes('&&'), joined.text);

const cont = insertAll('echo one \\\n  two\ntrue');
assert(cont.ok && cont.text === 'echo one \\\n  two\ntrue', cont.text);

const doc = insertAll('cat <<EOF\nhello\nEOF');
assert(doc.ok && doc.text.includes('<<EOF') && doc.text.includes('\n'), doc.text);
assert(isHeredoc('cat <<EOF\nhi'));
assert(!isHeredoc('echo hi'));

const two = commandUnits('dnf install -y foo\n\nls /');
assert(two.length === 2 && two[0] === 'dnf install -y foo' && two[1] === 'ls /', JSON.stringify(two));

const one = commandUnits('dnf install -y foo\nls /');
assert(one.length === 1 && one[0] === 'dnf install -y foo\nls /', JSON.stringify(one));

const noted = commandUnits("# GPUs and bound kernel drivers\nlspci -nnk | grep VGA\n\n# Session\nprintf '%s\\n' \"$XDG_SESSION_TYPE\"\ngnome-shell --version\n");
assert(noted.length === 2 && noted[0].startsWith('#') && noted[0].includes('lspci'), JSON.stringify(noted));
assert(noted[1].includes('printf') && noted[1].includes('gnome-shell'), JSON.stringify(noted));

const spaced = commandUnits('echo a\n\n\n\necho b\n\n');
assert(spaced.length === 2 && spaced[0] === 'echo a' && spaced[1] === 'echo b', JSON.stringify(spaced));

const loop = commandUnits('for i in 1 2; do\n  echo "$i"\n\ndone\n\necho after');
assert(loop.length === 2 && loop[0].startsWith('for') && loop[0].includes('done') && loop[1] === 'echo after', JSON.stringify(loop));

const here = commandUnits('cat <<EOF\nhello\n\nworld\nEOF\n\necho after');
assert(here.length === 2 && here[0].includes('world') && here[1] === 'echo after', JSON.stringify(here));

const quoted = commandUnits("echo 'a\n\nb'\n\necho c");
assert(quoted.length === 2 && quoted[0].includes('b\'') && quoted[1] === 'echo c', JSON.stringify(quoted));

const first = insertLine('echo a\n\necho b', 0);
assert(first.ok && first.text === 'echo a' && first.index === 1, first.text);
const second = insertLine('echo a\n\necho b', first.index);
assert(second.ok && second.text === 'echo b', second.text);

assert(withEnter('echo a') === 'echo a\n', withEnter('echo a'));
assert(withEnter('echo a\n') === 'echo a\n', 'keeps the final newline');

const blocks = shellBlocks('Use this:\n```bash\necho hi\n```\n');
assert(blocks.length === 1 && blocks[0] === 'echo hi', blocks[0]);

print('insert tests passed');
