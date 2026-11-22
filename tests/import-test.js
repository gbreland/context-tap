import {ChatGpt} from '../src/auth.js';
import {ClientDirectory, ASSISTANT_ID} from '../src/clients.js';
import {commandUnits} from '../src/insert.js';

const chat = new ChatGpt();
print('signed in', chat.signedIn());
print('lines', commandUnits('a\\\nb').join('|'));
print('id', ASSISTANT_ID);
const clients = new ClientDirectory();
clients.refresh();
print('ptyxis active', clients.isActive('org.gnome.Ptyxis'));
print('import ok');
