import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {ageLabel, elapsedLabel} from './age.js';
import {chatTitle, countPairs, loadChats, saveChats, turnsFrom, upsertChat, zipMessages} from './chats.js';
import {ASSISTANT_ID, SUPPORTED} from './clients.js';
import {decide, decision, loadAllow, saveAllow} from './context.js';
import {commandUnits, withEnter} from './insert.js';
import {inlineMarkup, isShellLang, isTerminalAction, markdownBlocks, markupFor, TERMINAL_ACTION_TEXT} from './markdown.js';
import {loadStanding, policyText, saveStanding} from './profile.js';
import {contextForPid, sendToPane} from './tmux.js';

const CHAT_FILE = 'chat.json';
const LAYOUT_FILE = 'layout.json';
const LAUNCH_HEIGHT = 760;

function naturalScroll(scroller) {
    const viewport = scroller.get_first_child();
    if (!viewport)
        return;
    viewport.vscroll_policy = Gtk.ScrollablePolicy.NATURAL;
    viewport.hscroll_policy = Gtk.ScrollablePolicy.MINIMUM;
}

export function clampContextPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return 50;
    return Math.min(80, Math.max(20, Math.round(number)));
}

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function loadChat() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), CHAT_FILE]));
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return [];
    }
}

function pngBase64(png) {
    return GLib.base64_encode(png);
}

function loadLayout() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), LAYOUT_FILE]));
        const [, bytes] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        const colorScheme = data.colorScheme === 'light' || data.colorScheme === 'dark'
            ? data.colorScheme
            : 'default';
        const width = Math.round(Number(data.width));
        return {
            contextPercent: clampContextPercent(data.contextPercent),
            colorScheme,
            width: width >= 1 ? width : 0,
        };
    } catch {
        return {contextPercent: 50, colorScheme: 'default', width: 0};
    }
}

function saveLayout(percent, colorScheme, width = 0) {
    const scheme = colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : 'default';
    const nextWidth = Math.round(Number(width));
    const payload = {
        contextPercent: clampContextPercent(percent),
        colorScheme: scheme,
    };
    if (nextWidth >= 1)
        payload.width = nextWidth;
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), LAYOUT_FILE]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(payload))), null);
    stream.close(null);
}

function previewTexture(png) {
    const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(png));
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
    return Gdk.Texture.new_for_pixbuf(pixbuf);
}

export function openWindow(application, services) {
    const {chatgpt, shell, clients} = services;
    const shots = new Map();
    const layout = loadLayout();
    let windowWidth = layout.width;
    let widthSet = layout.width >= 1;
    let widthSave = 0;
    let acceptWidth = false;
    let chatIndex = loadChats();
    let chatId = chatIndex.openId || '';
    let storedPairs = 0;
    let messages = chatId || chatIndex.skipLegacy ? [] : loadChat();
    let models = [];
    let model = '';
    let workingId = '';
    let workingTitle = '';
    let above = false;
    let dock = 'off';
    let syncingDock = false;
    let placementIdle = 0;
    let hostInfo = '';
    let packageInfo = '';
    let graphicsInfo = '';
    let packageNote = '';
    let factsReady = false;
    let factsError = '';
    let sending = false;
    let reviewHoldAt = 0;
    let standingSave = 0;
    let splitSave = 0;
    let splitPercent = layout.contextPercent;
    let colorScheme = layout.colorScheme;
    let applyingSplit = false;
    let splitReady = false;
    let policyFit = 0;
    let policyHeight = 0;
    const names = new Map();
    const pids = new Map();
    let tmuxContext = null;
    const dataAt = new Map();
    const allow = loadAllow();
    const prompted = new Set();
    const lastSent = {host: '', packages: '', graphics: '', terminal: new Map(), screenshot: new Map()};
    services.profile.then(result => {
        hostInfo = result.host ?? '';
        packageInfo = result.packages ?? '';
        graphicsInfo = result.graphics ?? '';
        const count = result.packageCount ?? 0;
        packageNote = result.capped
            ? `Source: dnf repoquery --userinstalled. First 400 of ${count} names.`
            : `Source: dnf repoquery --userinstalled. ${count} names.`;
        factsReady = true;
        revealContext(true);
        refreshContext();
    }).catch(error => {
        factsError = error.message;
        factsReady = true;
        refreshContext();
    });

    const window = new Adw.ApplicationWindow({
        application,
        title: 'Context Tap',
        default_width: layout.width || 1,
        default_height: LAUNCH_HEIGHT,
    });

    const errorText = new Gtk.Label({
        xalign: 0,
        wrap: true,
        selectable: true,
        css_classes: ['error-text'],
    });
    const copyError = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: 'Copy error',
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    const errorBar = new Gtk.Box({
        spacing: 6,
        margin_start: 12,
        margin_end: 6,
        margin_top: 6,
        margin_bottom: 6,
        visible: false,
        css_classes: ['error-bar'],
    });
    errorText.hexpand = true;
    errorBar.append(errorText);
    errorBar.append(copyError);
    const messageBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    const scroller = new Gtk.ScrolledWindow({
        vexpand: true,
        child: messageBox,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    naturalScroll(scroller);
    scroller.hexpand = true;
    const entry = new Gtk.TextView({
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        accepts_tab: false,
        height_request: 64,
        left_margin: 12,
        right_margin: 12,
        top_margin: 8,
        bottom_margin: 8,
        css_classes: ['card', 'chat-input'],
        hexpand: true,
    });
    const entryHint = new Gtk.Label({
        label: 'Ask AI something',
        xalign: 0,
        yalign: 0,
        halign: Gtk.Align.START,
        valign: Gtk.Align.START,
        margin_start: 12,
        margin_top: 8,
        can_target: false,
        css_classes: ['dim-label'],
    });
    const entryOverlay = new Gtk.Overlay({hexpand: true, child: entry});
    entryOverlay.add_overlay(entryHint);
    const send = new Gtk.Button({
        label: 'Send',
        css_classes: ['suggested-action'],
        valign: Gtk.Align.CENTER,
    });
    const shotToggle = new Gtk.CheckButton({
        tooltip_text: 'Send the screenshot',
        valign: Gtk.Align.CENTER,
    });
    const shotThumb = new Gtk.Picture({
        width_request: 72,
        height_request: 48,
        can_shrink: true,
        content_fit: Gtk.ContentFit.COVER,
    });
    const shotRow = new Gtk.Box({spacing: 6});
    shotRow.append(shotToggle);
    shotRow.append(shotThumb);
    const shotChip = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        visible: false,
        halign: Gtk.Align.START,
    });
    shotChip.append(new Gtk.Label({
        label: 'Screenshot',
        xalign: 0,
        css_classes: ['caption', 'dim-label'],
    }));
    shotChip.append(shotRow);
    const dataToggle = new Gtk.CheckButton({
        tooltip_text: 'Send the app data',
        valign: Gtk.Align.START,
    });
    const dataBuffer = new Gtk.TextBuffer();
    const dataView = new Gtk.TextView({
        buffer: dataBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        accepts_tab: false,
        left_margin: 6,
        right_margin: 6,
        top_margin: 4,
        bottom_margin: 4,
        css_classes: ['data-preview'],
    });
    const dataScroll = new Gtk.ScrolledWindow({
        child: dataView,
        hexpand: true,
        propagate_natural_height: false,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        height_request: 48,
        css_classes: ['data-preview'],
    });
    const dataTextRow = new Gtk.Box({spacing: 6});
    dataTextRow.append(dataToggle);
    dataTextRow.append(dataScroll);
    const dataPreview = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        visible: false,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 6,
    });
    dataPreview.append(new Gtk.Label({
        label: 'Data',
        xalign: 0,
        css_classes: ['caption', 'dim-label'],
    }));
    dataPreview.append(dataTextRow);
    const emptyCapture = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        label: 'No app context was captured.',
        css_classes: ['dim-label'],
    });
    const captureStrip = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
    });
    captureStrip.append(shotChip);
    captureStrip.append(emptyCapture);
    const entryRow = new Gtk.Box({
        spacing: 8,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 8,
    });
    entryRow.append(entryOverlay);
    entryRow.append(send);
    const sendRow = new Gtk.Box({
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 4,
    });
    sendRow.append(captureStrip);

    const contextButton = new Gtk.ToggleButton({
        label: 'Context',
        tooltip_text: 'Show the context sent to ChatGPT',
        css_classes: ['suggested-action', 'context-button'],
    });
    const holdLabel = new Gtk.Label({
        label: 'Check a box, or press Send again to leave that item out.',
        wrap: true,
        xalign: 0,
        visible: false,
        css_classes: ['caption', 'dim-label'],
    });
    const policyBuffer = new Gtk.TextBuffer();
    policyBuffer.set_text(loadStanding() || policyText(), -1);
    const policyView = new Gtk.TextView({
        buffer: policyBuffer,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        accepts_tab: false,
        left_margin: 6,
        right_margin: 6,
        top_margin: 6,
        bottom_margin: 6,
    });
    function cappedLabel(extraClasses) {
        return new Gtk.Label({
            wrap: true,
            wrap_mode: Gtk.WrapMode.WORD,
            selectable: false,
            xalign: 0,
            max_width_chars: 48,
            css_classes: extraClasses,
        });
    }

    function sectionTitle(text) {
        return new Gtk.Label({
            label: text,
            xalign: 0,
            hexpand: true,
            css_classes: ['context-title'],
        });
    }

    function allowSection(title, check) {
        check.tooltip_text = 'Send this section';
        check.valign = Gtk.Align.START;
        const expander = new Gtk.Expander({
            label_widget: sectionTitle(title),
            hexpand: true,
            expanded: false,
        });
        const row = new Gtk.Box({spacing: 6});
        row.append(check);
        row.append(expander);
        return {row, expander};
    }

    const policyCheck = new Gtk.CheckButton({
        active: true,
        sensitive: false,
        tooltip_text: 'These instructions are always sent',
        valign: Gtk.Align.START,
    });
    const policyExpander = new Gtk.Expander({
        label_widget: sectionTitle('Always sent'),
        hexpand: true,
        expanded: false,
        child: policyView,
    });
    policyView.hexpand = true;
    const policyRow = new Gtk.Box({spacing: 6});
    policyRow.append(policyCheck);
    policyRow.append(policyExpander);

    const hostCheck = new Gtk.CheckButton();
    const hostBody = cappedLabel(['monospace', 'caption']);
    const hostParts = allowSection('Host', hostCheck);
    hostParts.expander.child = hostBody;

    const packageCheck = new Gtk.CheckButton();
    const packageNoteLabel = new Gtk.Label({
        wrap: true,
        xalign: 0,
        css_classes: ['caption', 'dim-label'],
    });
    const packageBody = cappedLabel(['monospace', 'caption']);
    const packageBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    packageBox.append(packageNoteLabel);
    packageBox.append(packageBody);
    const packageParts = allowSection('Packages', packageCheck);
    packageParts.expander.child = packageBox;

    const graphicsCheck = new Gtk.CheckButton();
    const graphicsBody = cappedLabel(['monospace', 'caption']);
    const graphicsParts = allowSection('Graphics', graphicsCheck);
    graphicsParts.expander.child = graphicsBody;

    const termCheck = new Gtk.CheckButton();
    const termBody = cappedLabel(['monospace', 'caption']);
    const termParts = allowSection('Data', termCheck);
    termParts.expander.child = termBody;
    const termSection = termParts.row;

    const actionCheck = new Gtk.CheckButton();
    const actionBody = new Gtk.Label({
        xalign: 0,
        wrap: true,
        wrap_mode: Gtk.WrapMode.WORD,
        max_width_chars: 48,
        selectable: true,
        label: TERMINAL_ACTION_TEXT,
    });
    const actionParts = allowSection('Terminal Instructions', actionCheck);
    actionParts.expander.child = actionBody;
    const actionSection = actionParts.row;
    actionSection.visible = false;

    const shotCheck = new Gtk.CheckButton();
    const shotCaption = new Gtk.Label({
        wrap: true,
        xalign: 0,
        css_classes: ['caption', 'dim-label'],
    });
    const shotPicture = new Gtk.Picture({
        hexpand: true,
        can_shrink: true,
        content_fit: Gtk.ContentFit.CONTAIN,
    });
    function fitShot() {
        const paintable = shotPicture.paintable;
        const width = shotPicture.get_width();
        if (!paintable || width < 8)
            return;
        const imageWidth = paintable.get_width();
        const imageHeight = paintable.get_height();
        if (!(imageWidth > 0) || !(imageHeight > 0))
            return;
        const next = Math.max(1, Math.round(width * imageHeight / imageWidth));
        if (shotPicture.height_request !== next)
            shotPicture.height_request = next;
    }
    shotPicture.add_tick_callback(() => {
        fitShot();
        return GLib.SOURCE_CONTINUE;
    });
    const shotBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    shotBox.append(shotCaption);
    shotBox.append(shotPicture);
    const shotParts = allowSection('Screenshot', shotCheck);
    shotParts.expander.child = shotBox;
    const shotSection = shotParts.row;

    const contextBody = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    contextBody.append(holdLabel);
    contextBody.append(policyRow);
    contextBody.append(hostParts.row);
    contextBody.append(packageParts.row);
    contextBody.append(graphicsParts.row);
    contextBody.append(actionSection);
    contextBody.append(termSection);
    contextBody.append(shotSection);
    const contextScroll = new Gtk.ScrolledWindow({
        child: contextBody,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    naturalScroll(contextScroll);
    const contextPanel = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        visible: false,
        vexpand: true,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
        css_classes: ['context-panel'],
        overflow: Gtk.Overflow.HIDDEN,
    });
    contextPanel.append(contextScroll);

    const captureAge = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        css_classes: ['dim-label'],
    });
    const timeRow = new Gtk.Box({
        spacing: 8,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });
    timeRow.append(captureAge);
    timeRow.append(contextButton);
    const chatColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true,
    });
    chatColumn.append(scroller);
    chatColumn.append(entryRow);
    chatColumn.append(dataPreview);
    chatColumn.append(sendRow);
    chatColumn.append(timeRow);
    const split = new Gtk.Paned({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true,
        wide_handle: true,
        resize_start_child: true,
        resize_end_child: false,
        shrink_start_child: false,
        shrink_end_child: true,
        start_child: chatColumn,
        end_child: contextPanel,
        css_classes: ['context-split'],
    });

    const contextName = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        label: 'No app',
    });
    const methodLabel = new Gtk.Label({
        xalign: 0,
        visible: false,
    });
    const nameBox = new Gtk.Box({spacing: 0, hexpand: true});
    nameBox.append(contextName);
    nameBox.append(methodLabel);
    nameBox.append(new Gtk.Box({hexpand: true}));
    const contextAge = new Gtk.Label({
        xalign: 1,
        css_classes: ['dim-label'],
    });
    const contextRow = new Gtk.Box({
        spacing: 12,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 8,
    });
    contextRow.append(nameBox);
    contextRow.append(contextAge);

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    iconTheme.add_search_path(GLib.build_filenamev([
        GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
        '..',
        'data',
        'icons',
    ]));

    const accountLabel = new Gtk.Label({
        label: 'Sign in',
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 22,
    });
    const signIn = new Gtk.Button({child: accountLabel, tooltip_text: 'Sign in'});
    const modelBox = new Gtk.DropDown({visible: false, hexpand: true, tooltip_text: 'Model'});
    const aboveSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: false,
    });
    const aboveRow = new Gtk.Box({spacing: 12});
    aboveRow.append(new Gtk.Label({
        label: 'Always on Top',
        xalign: 0,
        hexpand: true,
    }));
    aboveRow.append(aboveSwitch);
    const dockBox = new Gtk.Box({
        css_classes: ['linked'],
        halign: Gtk.Align.CENTER,
    });
    const dockButtons = [
        ['left', 'aia-dock-left-symbolic', 'Dock left'],
        ['off', 'aia-dialog-symbolic', 'Default size'],
        ['right', 'aia-dock-right-symbolic', 'Dock right'],
    ].map(([mode, iconName, tip]) => {
        const button = new Gtk.ToggleButton({
            icon_name: iconName,
            tooltip_text: tip,
            css_classes: ['flat'],
            active: mode === 'off',
        });
        dockBox.append(button);
        return [mode, button];
    });

    const chatList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
    });
    const chatPopover = new Gtk.Popover();
    const chatScroll = new Gtk.ScrolledWindow({
        child: chatList,
        propagate_natural_width: true,
        propagate_natural_height: true,
        max_content_height: 320,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    chatPopover.child = chatScroll;
    const chatButton = new Gtk.MenuButton({
        label: 'Chat',
        tooltip_text: 'Past chats',
        popover: chatPopover,
    });

    function styleCircle(name, tip, cssClass) {
        const check = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            visible: name === colorScheme,
        });
        const button = new Gtk.ToggleButton({
            tooltip_text: tip,
            css_classes: ['style-circle', cssClass],
            child: check,
            active: name === colorScheme,
        });
        return [name, button];
    }
    const schemeButtons = [
        styleCircle('default', 'Follow System Style', 'style-follow'),
        styleCircle('light', 'Light Style', 'style-light'),
        styleCircle('dark', 'Dark Style', 'style-dark'),
    ];
    const styleRow = new Gtk.Box({
        spacing: 12,
        halign: Gtk.Align.CENTER,
        margin_bottom: 6,
    });
    for (const [, button] of schemeButtons)
        styleRow.append(button);
    const newChatButton = new Gtk.Button({
        label: 'New Chat',
        css_classes: ['flat'],
        halign: Gtk.Align.CENTER,
    });
    const menuBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 10,
        margin_bottom: 8,
        margin_start: 10,
        margin_end: 10,
    });
    menuBox.append(styleRow);
    menuBox.append(new Gtk.Separator());
    menuBox.append(aboveRow);
    menuBox.append(dockBox);
    menuBox.append(new Gtk.Separator());
    menuBox.append(newChatButton);
    const menuPopover = new Gtk.Popover({child: menuBox});
    const menuButton = new Gtk.MenuButton({
        icon_name: 'open-menu-symbolic',
        tooltip_text: 'Menu',
        popover: menuPopover,
    });

    const header = new Adw.HeaderBar();
    header.pack_end(menuButton);

    const appBar = new Gtk.Box({
        spacing: 8,
        margin_start: 12,
        margin_end: 12,
        margin_top: 8,
        margin_bottom: 4,
    });
    const appSpacer = new Gtk.Box({hexpand: true});
    appBar.append(chatButton);
    appBar.append(modelBox);
    appBar.append(appSpacer);
    appBar.append(signIn);
    content.append(errorBar);
    content.append(appBar);
    content.append(contextRow);
    content.append(split);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(content);
    window.set_content(toolbar);

    function showError(error) {
        errorText.label = error?.message ?? String(error);
        errorBar.visible = true;
    }

    function clearError() {
        errorBar.visible = false;
    }

    function updateAccount() {
        if (chatgpt.signedIn()) {
            const email = String(chatgpt.email() || '');
            const at = email.indexOf('@');
            accountLabel.label = at > 0 ? email.slice(0, at) : (email || 'Signed in');
            signIn.tooltip_text = email || 'Sign out';
            modelBox.visible = true;
        } else {
            accountLabel.label = 'Sign in';
            signIn.tooltip_text = 'Sign in';
            modelBox.visible = false;
        }
    }

    function setText(label, text) {
        if (label.label !== text)
            label.label = text;
    }

    function setBody(label, text) {
        const next = text ?? '';
        let longest = 0;
        for (const line of next.split('\n'))
            longest = Math.max(longest, line.length);
        label.wrap = true;
        label.wrap_mode = Gtk.WrapMode.WORD;
        label.max_width_chars = 48;
        label.selectable = longest > 0 && longest < 400;
        if (label.label !== next)
            label.label = next;
    }

    function clientId() {
        const shellId = String(workingId ?? '');
        const shellName = String(names.get(shellId) || workingTitle || '');
        for (const [id] of SUPPORTED) {
            const reported = String(clients.contextFor(id)?.state?.['app-id'] ?? '');
            if (shellId === id || shellName === id || (reported && (shellId === reported || shellName === reported)))
                return id;
        }
        return shellId;
    }

    function terminalKey() {
        const id = clientId();
        if (id && !String(id).startsWith('window:'))
            return id;
        const live = [];
        for (const [supported] of SUPPORTED) {
            const text = clients.contextFor(supported)?.text;
            const hasText = typeof text === 'string' && text.trim().length > 0;
            if (clients.isActive(supported) || hasText)
                live.push(supported);
        }
        if (live.length === 1)
            return live[0];
        return id || workingId;
    }

    function shotPermitId() {
        const image = imageForMessage();
        const id = String(image?.appId || '');
        if (id && !id.startsWith('window:'))
            return id;
        const client = clientId();
        if (client && !String(client).startsWith('window:'))
            return client;
        return id || workingId;
    }

    function nativeOn() {
        return clients.isActive(clientId());
    }

    function terminalContext() {
        if (nativeOn()) {
            const id = terminalKey();
            const context = clients.contextFor(id);
            const text = typeof context?.text === 'string' ? context.text.trim() : '';
            if (!text)
                return null;
            if (context.state?.type && context.state.type !== 'terminal')
                return null;
            return {id, context};
        }
        if (tmuxContext?.text?.trim() && tmuxContext.state?.type === 'terminal')
            return {id: workingId, context: tmuxContext};
        return null;
    }

    function terminalPayload() {
        const found = terminalContext();
        if (!found)
            return null;
        const {context} = found;
        const state = context.state ?? {};
        const head = ['Focused terminal:', state.title, state.directory, state.container]
            .filter(Boolean)
            .join(' ');
        return {head, text: context.text.slice(-12000)};
    }

    function pendingAsk() {
        const keys = [];
        if (hostInfo && decision(allow, 'host') === 'ask')
            keys.push('host');
        if (packageInfo && decision(allow, 'packages') === 'ask')
            keys.push('packages');
        if (graphicsInfo && decision(allow, 'graphics') === 'ask')
            keys.push('graphics');
        if (terminalPayload() && decision(allow, 'terminal', terminalKey()) === 'ask')
            keys.push(`terminal:${terminalKey()}`);
        if (terminalActionsOn() && decision(allow, 'terminalInstructions') === 'ask')
            keys.push('terminalInstructions');
        const image = imageForMessage();
        if (image?.png?.length && decision(allow, 'screenshot', shotPermitId()) === 'ask')
            keys.push(`screenshot:${shotPermitId()}`);
        return keys;
    }

    function declinePending() {
        if (hostInfo && decision(allow, 'host') === 'ask')
            decide(allow, 'host', null, 'deny');
        if (packageInfo && decision(allow, 'packages') === 'ask')
            decide(allow, 'packages', null, 'deny');
        if (graphicsInfo && decision(allow, 'graphics') === 'ask')
            decide(allow, 'graphics', null, 'deny');
        if (terminalPayload() && decision(allow, 'terminal', terminalKey()) === 'ask')
            decide(allow, 'terminal', terminalKey(), 'deny');
        if (terminalActionsOn() && decision(allow, 'terminalInstructions') === 'ask')
            decide(allow, 'terminalInstructions', null, 'deny');
        const image = imageForMessage();
        if (image?.png?.length && decision(allow, 'screenshot', shotPermitId()) === 'ask')
            decide(allow, 'screenshot', shotPermitId(), 'deny');
        saveAllow(allow);
    }

    function standingText() {
        const [start, end] = policyBuffer.get_bounds();
        const text = policyBuffer.get_text(start, end, false).trim();
        return text || policyText();
    }

    function terminalActionsOn() {
        return terminalContext()?.context?.state?.type === 'terminal';
    }

    function instructions() {
        const parts = [standingText()];
        if (terminalActionsOn() && decision(allow, 'terminalInstructions') === 'allow')
            parts.push(TERMINAL_ACTION_TEXT);
        if (hostInfo && decision(allow, 'host') === 'allow')
            parts.push(hostInfo);
        if (packageInfo && decision(allow, 'packages') === 'allow')
            parts.push(`User-installed packages:\n${packageInfo}`);
        if (graphicsInfo && decision(allow, 'graphics') === 'allow')
            parts.push(graphicsInfo);
        return parts.join('\n\n');
    }

    let updatingChecks = false;
    let shotKey = '';

    function expandAsk(expander, key) {
        if (pendingAsk().includes(key))
            expander.expanded = true;
    }

    let stripShotKey = '';
    let dataShown = '';
    let dataFit = false;
    let dataScrollIdle = 0;

    function fitDataPreview() {
        if (dataFit)
            return;
        const layout = dataView.create_pango_layout('Ag\nAg');
        const [, height] = layout.get_pixel_size();
        if (height < 8)
            return;
        dataScroll.height_request = height + 10;
        dataFit = true;
    }

    function showDataText(text) {
        fitDataPreview();
        if (dataShown === text)
            return;
        dataShown = text;
        dataBuffer.set_text(text ?? '', -1);
        if (dataScrollIdle)
            GLib.source_remove(dataScrollIdle);
        dataScrollIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            dataScrollIdle = 0;
            const adj = dataScroll.get_vadjustment();
            adj.value = Math.max(0, adj.upper - adj.page_size);
            return GLib.SOURCE_REMOVE;
        });
    }

    function updateSendStrip() {
        const was = updatingChecks;
        updatingChecks = true;
        const open = contextButton.active;
        const image = imageForMessage();
        const term = terminalPayload();
        const showShot = !open && Boolean(image?.png?.length);
        const showData = Boolean(term);
        shotChip.visible = showShot;
        dataPreview.visible = showData;
        emptyCapture.visible = !open && !showShot && !showData;
        captureAge.visible = !open && (showShot || showData);
        if (showShot) {
            shotToggle.active = decision(allow, 'screenshot', shotPermitId()) === 'allow';
            const key = `${image.appId}:${image.timestamp}:${image.png.length}`;
            if (key !== stripShotKey) {
                try {
                    shotThumb.paintable = previewTexture(image.png);
                    shotThumb.visible = true;
                    stripShotKey = key;
                } catch {
                    shotThumb.visible = false;
                }
            }
        }
        if (showData) {
            dataToggle.active = decision(allow, 'terminal', terminalKey()) === 'allow';
            showDataText(term.text);
        }
        if (captureAge.visible) {
            const stamps = [];
            if (image?.timestamp)
                stamps.push(image.timestamp);
            const dataStamp = dataAt.get(workingId) ?? 0;
            if (dataStamp)
                stamps.push(dataStamp);
            const newest = stamps.length ? Math.max(...stamps) : 0;
            captureAge.label = newest ? ageLabel((GLib.get_real_time() - newest) / 1e6) : '';
        }
        updatingChecks = was;
    }

    function applyContextView() {
        updatingChecks = true;
        hostCheck.sensitive = factsReady && !factsError && Boolean(hostInfo);
        hostCheck.active = decision(allow, 'host') === 'allow';
        if (!factsReady)
            setBody(hostBody, 'Host facts are still loading.');
        else if (factsError)
            setBody(hostBody, factsError);
        else
            setBody(hostBody, hostInfo);

        packageCheck.sensitive = factsReady && !factsError && Boolean(packageInfo);
        packageCheck.active = decision(allow, 'packages') === 'allow';
        setText(packageNoteLabel, packageNote);
        if (!factsReady)
            setBody(packageBody, 'Package names are still loading.');
        else if (factsError)
            setBody(packageBody, factsError);
        else
            setBody(packageBody, packageInfo);

        graphicsCheck.sensitive = factsReady && !factsError && Boolean(graphicsInfo);
        graphicsCheck.active = decision(allow, 'graphics') === 'allow';
        if (!factsReady)
            setBody(graphicsBody, 'Graphics facts are still loading.');
        else if (factsError)
            setBody(graphicsBody, factsError);
        else
            setBody(graphicsBody, graphicsInfo);

        const instructionsOn = terminalActionsOn();
        actionSection.visible = instructionsOn;
        actionCheck.sensitive = instructionsOn;
        if (instructionsOn)
            actionCheck.active = decision(allow, 'terminalInstructions') === 'allow';
        const term = terminalPayload();
        termSection.visible = true;
        termCheck.active = decision(allow, 'terminal', terminalKey()) === 'allow';
        setBody(termBody, term ? `${term.head}\n\n${term.text}` : 'No terminal text yet.');

        const image = imageForMessage();
        shotSection.visible = Boolean(image?.png?.length);
        if (image?.png?.length) {
            shotCheck.active = decision(allow, 'screenshot', shotPermitId()) === 'allow';
            setText(shotCaption, image.title
                ? `${image.title} at ${image.timestamp ?? ''}`
                : String(image.timestamp ?? ''));
            const key = `${image.appId}:${image.timestamp}:${image.png.length}`;
            if (key !== shotKey) {
                try {
                    shotPicture.paintable = previewTexture(image.png);
                    shotPicture.visible = true;
                    shotKey = key;
                    fitShot();
                } catch {
                    shotPicture.visible = false;
                }
            }
        }
        holdLabel.visible = reviewHoldAt !== 0 && pendingAsk().length > 0;
        updateSendStrip();
        updatingChecks = false;
    }

    function refreshContext() {
        if (contextPanel.visible)
            applyContextView();
        else
            updateSendStrip();
    }

    function revealContext(force) {
        const keys = pendingAsk();
        const fresh = keys.filter(key => !prompted.has(key));
        for (const key of keys)
            prompted.add(key);
        if ((force || fresh.length) && keys.length) {
            expandAsk(hostParts.expander, 'host');
            expandAsk(packageParts.expander, 'packages');
            expandAsk(graphicsParts.expander, 'graphics');
            expandAsk(termParts.expander, `terminal:${terminalKey()}`);
            expandAsk(actionParts.expander, 'terminalInstructions');
            expandAsk(shotParts.expander, `screenshot:${shotPermitId()}`);
        }
    }

    function storeDecision(kind, id, active) {
        if (kind !== 'host' && kind !== 'packages' && kind !== 'graphics' && kind !== 'terminalInstructions' && !id)
            return;
        decide(allow, kind, id, active ? 'allow' : 'deny');
        saveAllow(allow);
        if (!pendingAsk().length)
            reviewHoldAt = 0;
        applyContextView();
    }

    function noteData(appId, timestamp) {
        if (!appId || !timestamp)
            return;
        const prev = dataAt.get(appId) ?? 0;
        if (timestamp > prev)
            dataAt.set(appId, timestamp);
    }

    function rememberShot(appId, shot) {
        if (!shot?.png?.length)
            return;
        shots.set(appId, {
            png: shot.png,
            title: shot.title || appId,
            timestamp: shot.timestamp,
            appId,
        });
        noteData(appId, shot.timestamp);
    }

    function imageForMessage() {
        if (!workingId || workingId === ASSISTANT_ID)
            return null;
        const shot = shots.get(workingId);
        if (!shot?.png?.length)
            return null;
        return shot;
    }

    function showMethod(kind) {
        const methods = {
            basic: ['Basic', 'integration-basic'],
            native: ['Native', 'integration-native'],
            tmux: ['tmux', 'integration-tmux'],
        };
        for (const css of ['integration-basic', 'integration-native', 'integration-tmux'])
            methodLabel.remove_css_class(css);
        const next = methods[kind];
        if (!next) {
            methodLabel.visible = false;
            methodLabel.label = '';
            return;
        }
        methodLabel.label = ` - ${next[0]}`;
        methodLabel.add_css_class(next[1]);
        methodLabel.visible = true;
    }

    function updateContextRow() {
        refreshTmux();
        if (!workingId || workingId === ASSISTANT_ID) {
            setText(contextName, 'No app');
            showMethod('');
            setText(contextAge, '');
            return;
        }
        setText(contextName, workingTitle || names.get(workingId) || workingId);
        if (nativeOn())
            showMethod('native');
        else if (tmuxContext?.state?.type === 'terminal')
            showMethod('tmux');
        else
            showMethod('basic');
        const client = clients.contextFor(clientId());
        const shot = shots.get(workingId);
        if (!dataAt.get(workingId)) {
            if (client?.text)
                noteData(workingId, GLib.get_real_time());
            else if (shot?.timestamp)
                noteData(workingId, shot.timestamp);
        }
        const stamp = dataAt.get(workingId) ?? 0;
        if (!stamp) {
            setText(contextAge, '');
            return;
        }
        const age = (GLib.get_real_time() - stamp) / 1e6;
        setText(contextAge, ageLabel(age));
    }

    function copyText(text) {
        const bytes = GLib.Bytes.new(new TextEncoder().encode(text));
        const provider = Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes);
        window.get_clipboard().set_content(provider);
    }

    copyError.connect('clicked', () => copyText(errorText.label));

    function runCommand(text) {
        try {
            if (nativeOn())
                clients.insertPending(clientId(), withEnter(text));
            else if (tmuxContext?.paneId)
                sendToPane(tmuxContext.paneId, text);
            else
                throw new Error('Link an active terminal before running a command.');
            try {
                shell.focusApp(workingId);
            } catch {
                /* FocusApp loads after the next login. */
            }
        } catch (error) {
            showError(error);
        }
    }

    function addCodeCard(parent, block) {
        const headerRow = new Gtk.Box({spacing: 6});
        headerRow.append(new Gtk.Label({
            label: 'Command',
            xalign: 0,
            hexpand: true,
            css_classes: ['heading'],
        }));
        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy',
            css_classes: ['flat'],
            valign: Gtk.Align.START,
        });
        headerRow.append(copyButton);
        parent.append(headerRow);
        copyButton.connect('clicked', () => copyText(block));
        for (const unit of commandUnits(block)) {
            const row = new Gtk.Box({spacing: 6});
            const view = new Gtk.Label({
                xalign: 0,
                hexpand: true,
                css_classes: ['monospace', 'card'],
            });
            setBody(view, unit);
            const run = new Gtk.Button({
                label: 'Run',
                valign: Gtk.Align.END,
            });
            row.append(view);
            row.append(run);
            parent.append(row);
            run.connect('clicked', () => runCommand(unit));
        }
        const allRow = new Gtk.Box({spacing: 6});
        allRow.append(new Gtk.Box({hexpand: true}));
        const runAll = new Gtk.Button({
            label: 'Run All',
            halign: Gtk.Align.END,
        });
        allRow.append(runAll);
        parent.append(allRow);
        runAll.connect('clicked', () => runCommand(block));
    }

    function addMarkupLabel(parent, markup, plain, cssClass) {
        if (!markup)
            return;
        let longest = 0;
        for (const line of String(plain ?? markup).split('\n'))
            longest = Math.max(longest, line.length);
        const label = new Gtk.Label({
            xalign: 0,
            use_markup: true,
            wrap: true,
            wrap_mode: Gtk.WrapMode.WORD,
            max_width_chars: 48,
            selectable: longest > 0 && longest < 400,
            label: markup,
        });
        if (cssClass)
            label.add_css_class(cssClass);
        parent.append(label);
    }

    function addTable(parent, table) {
        const grid = new Gtk.Grid({column_spacing: 12, row_spacing: 4});
        const put = (text, column, row, header) => {
            const body = inlineMarkup(text);
            grid.attach(new Gtk.Label({
                xalign: 0,
                use_markup: true,
                wrap: true,
                wrap_mode: Gtk.WrapMode.WORD,
                max_width_chars: 22,
                selectable: false,
                label: header ? `<b>${body}</b>` : body,
            }), column, row, 1, 1);
        };
        table.header.forEach((cell, column) => put(cell, column, 0, true));
        table.rows.forEach((row, index) => {
            row.forEach((cell, column) => put(cell, column, index + 1, false));
        });
        parent.append(grid);
    }

    function addMarkdown(parent, text) {
        for (const block of markdownBlocks(text)) {
            if (block.type === 'code') {
                if (!block.text)
                    continue;
                const terminal = clients.isActive(clientId());
                if (terminal && (isTerminalAction(block.lang) || isShellLang(block.lang))) {
                    addCodeCard(parent, block.text);
                    continue;
                }
                const label = new Gtk.Label({
                    xalign: 0,
                    css_classes: ['monospace', 'md-code'],
                });
                setBody(label, block.text);
                parent.append(label);
                continue;
            }
            if (block.type === 'rule') {
                parent.append(new Gtk.Separator({margin_top: 4, margin_bottom: 4}));
                continue;
            }
            if (block.type === 'table') {
                addTable(parent, block);
                continue;
            }
            const plain = block.type === 'list'
                ? block.items.map(item => item.text).join('\n')
                : block.text;
            addMarkupLabel(parent, markupFor(block), plain, block.type === 'quote' ? 'md-quote' : null);
        }
    }

    function sentLabel(ms) {
        const when = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
        return when ? when.format('%x %X') : '';
    }

    function addMessageView(message) {
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            css_classes: [message.role === 'user' ? 'user-message' : 'assistant-message'],
        });
        const titleRow = new Gtk.Box({spacing: 8});
        titleRow.append(new Gtk.Label({
            label: message.role === 'user' ? 'You' : 'Assistant',
            xalign: 0,
            css_classes: ['heading'],
        }));
        let stamp = '';
        if (message.role === 'user' && message.sentAt)
            stamp = sentLabel(message.sentAt);
        if (message.role === 'assistant' && Number.isFinite(message.elapsedMs))
            stamp = elapsedLabel(message.elapsedMs);
        if (stamp) {
            titleRow.append(new Gtk.Label({
                label: stamp,
                xalign: 0,
                css_classes: ['dim-label', 'caption'],
            }));
        }
        wrap.append(titleRow);
        if (message.role !== 'assistant') {
            wrap.append(new Gtk.Label({xalign: 0}));
            setBody(wrap.get_last_child(), message.text);
        } else {
            addMarkdown(wrap, message.text);
        }
        messageBox.append(wrap);
    }

    let followBottom = true;
    let splitDragging = false;
    let splitDragEnd = 0;
    let savedValue = 0;
    let placing = false;
    let placeIdle = 0;
    let placeTick = 0;
    let seenUpper = 0;
    let seenPage = 0;
    const chatAdj = scroller.get_vadjustment();

    function messageEnd() {
        return Math.max(chatAdj.lower, chatAdj.upper - chatAdj.page_size);
    }

    function noteSize() {
        seenUpper = chatAdj.upper;
        seenPage = chatAdj.page_size;
    }

    function placeMessages() {
        const end = messageEnd();
        const next = followBottom ? end : Math.min(savedValue, end);
        noteSize();
        if (Math.abs(chatAdj.value - next) < 1)
            return;
        placing = true;
        chatAdj.value = next;
        placing = false;
        noteSize();
    }

    function stopPlaceTick() {
        if (!placeTick)
            return;
        scroller.remove_tick_callback(placeTick);
        placeTick = 0;
    }

    function queuePlace() {
        if (placeIdle)
            return;
        placeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            placeIdle = 0;
            placeMessages();
            return GLib.SOURCE_REMOVE;
        });
    }

    function schedulePlace() {
        if (splitDragging)
            return;
        if (!followBottom) {
            stopPlaceTick();
            placeMessages();
            return;
        }
        queuePlace();
        stopPlaceTick();
        let last = -1;
        let stable = 0;
        let ticks = 0;
        placeTick = scroller.add_tick_callback(() => {
            if (!followBottom) {
                placeTick = 0;
                return GLib.SOURCE_REMOVE;
            }
            const end = messageEnd();
            placeMessages();
            ticks += 1;
            if (Math.abs(end - last) < 1)
                stable += 1;
            else
                stable = 0;
            last = end;
            if ((stable >= 6 && ticks >= 8) || ticks >= 40) {
                placeTick = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    chatAdj.connect('changed', () => {
        if (placing || splitDragging)
            return;
        if (followBottom)
            queuePlace();
        else
            placeMessages();
    });
    chatAdj.connect('value-changed', () => {
        const sizeChanged = chatAdj.upper !== seenUpper || chatAdj.page_size !== seenPage;
        noteSize();
        if (placing || sizeChanged)
            return;
        const gap = messageEnd() - chatAdj.value;
        if (gap <= 12) {
            followBottom = true;
            queuePlace();
            return;
        }
        followBottom = false;
        savedValue = chatAdj.value;
        stopPlaceTick();
    });

    function redrawMessages() {
        if (!followBottom)
            savedValue = chatAdj.value;
        placing = true;
        let child = messageBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            messageBox.remove(child);
            child = next;
        }
        for (const message of messages)
            addMessageView(message);
        placing = false;
        schedulePlace();
    }

    function readWindows() {
        let windows = [];
        try {
            windows = shell.listWindows();
        } catch (error) {
            if (shell.missing())
                showError('Enable the Context Tap shell extension.');
            else if (shell.available())
                showError(error);
            return null;
        }
        if (shell.missing())
            showError('Enable the Context Tap shell extension.');
        else if (errorText.label === 'Enable the Context Tap shell extension.')
            clearError();
        for (const item of windows) {
            if (!item.appId)
                continue;
            names.set(item.appId, item.name || item.appId);
            if (item.pid)
                pids.set(item.appId, item.pid);
            else
                pids.delete(item.appId);
        }
        if (workingId && names.has(workingId))
            workingTitle = names.get(workingId);
        return windows;
    }

    function refreshTmux() {
        if (!workingId || nativeOn()) {
            tmuxContext = null;
            return;
        }
        try {
            tmuxContext = contextForPid(pids.get(workingId) || 0);
        } catch {
            tmuxContext = null;
        }
    }

    function touchData(appId) {
        if (dataAt.has(appId))
            return;
        const shot = shots.get(appId);
        if (shot?.timestamp) {
            noteData(appId, shot.timestamp);
            return;
        }
        if (clients.contextFor(appId)?.text)
            noteData(appId, GLib.get_real_time());
    }

    function adopt(appId) {
        const changed = workingId !== appId;
        workingId = appId;
        workingTitle = names.get(appId) || appId;
        touchData(appId);
        if (clients.isSupported(appId) && !clients.isActive(appId)
            && !clients.contextFor(appId)?.text?.trim?.())
            showError('Turn on agent support in this app.');
        else if (errorText.label === 'Turn on agent support in this app.')
            clearError();
        if (changed)
            redrawMessages();
    }

    function seedContext(windows) {
        if (workingId || shell.missing())
            return;
        let bestId = '';
        let bestTs = 0;
        for (const item of windows) {
            if (!item.appId || item.appId === ASSISTANT_ID)
                continue;
            const shot = shell.getCapture(item.appId);
            if (shot?.png?.length)
                rememberShot(item.appId, shot);
            const ts = shot?.timestamp ?? 0;
            if (ts > bestTs) {
                bestTs = ts;
                bestId = item.appId;
            }
        }
        if (bestId)
            adopt(bestId);
    }

    function refreshState() {
        clients.refresh();
        const windows = readWindows();
        if (windows && workingId && !windows.some(item => item.appId === workingId))
            workingId = '';
        if (windows)
            seedContext(windows);
        syncPlacement();
        updateContextRow();
        refreshContext();
    }

    function syncPlacement() {
        let saved = null;
        try {
            saved = shell.getPlacement();
        } catch {
            return;
        }
        if (!saved)
            return;
        const mode = saved.mode === 'left' || saved.mode === 'right' ? saved.mode : 'off';
        const nextAbove = saved.above === true;
        if (mode === dock && nextAbove === above)
            return;
        dock = mode;
        above = nextAbove;
        showPlacement();
    }

    function applyPlacement() {
        try {
            shell.setPlacement(dock, above);
        } catch (error) {
            showError(error);
        }
    }

    shell.onReady = () => {
        restorePlacement();
        refreshState();
    };

    shell.onFocus = (appId, title, previous) => {
        clients.releaseCapture();
        clients.refresh();
        readWindows();
        const contextId = appId === ASSISTANT_ID ? previous : appId;
        if (contextId && contextId !== ASSISTANT_ID) {
            rememberShot(contextId, shell.captureNow(contextId) || shell.getCapture(contextId));
            adopt(contextId);
        }
        updateContextRow();
        revealContext(false);
        refreshContext();
    };

    clients.onContext = appId => {
        if (clients.contextFor(appId)?.text)
            noteData(appId, GLib.get_real_time());
        if (appId !== workingId && appId !== clientId())
            return;
        updateContextRow();
        revealContext(false);
        refreshContext();
    };

    function showPlacement() {
        syncingDock = true;
        if (aboveSwitch.active !== above)
            aboveSwitch.active = above;
        for (const [mode, button] of dockButtons) {
            const on = mode === dock;
            if (button.active !== on)
                button.active = on;
        }
        syncingDock = false;
    }

    function restorePlacement() {
        let saved = null;
        try {
            saved = shell.getPlacement();
        } catch {
            return;
        }
        if (!saved)
            return;
        dock = saved.mode === 'left' || saved.mode === 'right' ? saved.mode : 'off';
        above = saved.above === true;
        showPlacement();
        queuePlacement();
    }

    function queuePlacement() {
        applyPlacement();
        if (placementIdle)
            GLib.source_remove(placementIdle);
        let tries = 0;
        placementIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            tries += 1;
            applyPlacement();
            if (tries >= 8) {
                placementIdle = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    aboveSwitch.connect('notify::active', () => {
        if (syncingDock)
            return;
        above = aboveSwitch.active;
        applyPlacement();
    });
    for (const [mode, button] of dockButtons) {
        button.connect('toggled', () => {
            if (syncingDock)
                return;
            if (!button.active) {
                if (dock === mode)
                    button.active = true;
                return;
            }
            if (dock === mode)
                return;
            dock = mode;
            for (const [otherMode, other] of dockButtons) {
                if (otherMode !== mode)
                    other.active = false;
            }
            if (mode === 'off')
                window.set_default_size(windowWidth || window.get_width() || 1, LAUNCH_HEIGHT);
            applyPlacement();
        });
    }

    modelBox.connect('notify::visible', () => {
        appSpacer.visible = !modelBox.visible;
    });
    function fitPolicy() {
        if (!policyExpander.expanded)
            return;
        const viewWidth = policyView.get_width();
        const width = viewWidth > 20 ? viewWidth - 12 : policyExpander.get_width() - 16;
        if (width < 20)
            return;
        const [start, end] = policyBuffer.get_bounds();
        const text = policyBuffer.get_text(start, end, false);
        const layout = policyView.create_pango_layout(text);
        layout.set_width(width * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        const [, height] = layout.get_pixel_size();
        const next = Math.max(24, height + 16);
        if (next === policyHeight)
            return;
        policyHeight = next;
        policyView.height_request = next;
    }

    function schedulePolicyFit() {
        if (!policyExpander.expanded)
            return;
        fitPolicy();
        if (policyFit)
            return;
        policyFit = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            policyFit = 0;
            fitPolicy();
            return GLib.SOURCE_REMOVE;
        });
    }

    policyExpander.connect('notify::expanded', () => {
        if (!policyExpander.expanded) {
            policyHeight = 0;
            policyView.height_request = -1;
            return;
        }
        schedulePolicyFit();
    });
    policyView.connect('notify::width', () => schedulePolicyFit());
    policyBuffer.connect('changed', () => {
        schedulePolicyFit();
        if (standingSave)
            GLib.source_remove(standingSave);
        standingSave = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            standingSave = 0;
            saveStanding(standingText());
            return GLib.SOURCE_REMOVE;
        });
    });
    function positionFor(height, percent) {
        const [floor] = chatColumn.measure(Gtk.Orientation.VERTICAL, -1);
        const preferred = Math.round(height * (100 - percent) / 100);
        const limit = Math.max(0, height - 48);
        const low = Math.min(Math.max(floor, 0), limit);
        return Math.min(limit, Math.max(preferred, low));
    }

    function applySplit() {
        if (!contextPanel.visible)
            return;
        const height = split.get_height();
        if (height < 80)
            return;
        const next = positionFor(height, splitPercent);
        applyingSplit = true;
        if (Math.abs(split.position - next) >= 2)
            split.position = next;
        applyingSplit = false;
        splitReady = true;
    }

    function rememberSplit() {
        if (applyingSplit || !splitReady || !contextPanel.visible)
            return;
        const height = split.get_height();
        if (height < 80)
            return;
        const clamped = clampContextPercent((height - split.position) / height * 100);
        const next = positionFor(height, clamped);
        if (Math.abs(split.position - next) > 1) {
            applyingSplit = true;
            split.position = next;
            applyingSplit = false;
        }
        if (clamped === splitPercent)
            return;
        splitPercent = clamped;
        if (splitSave)
            GLib.source_remove(splitSave);
        splitSave = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            splitSave = 0;
            saveLayout(splitPercent, colorScheme, widthSet ? windowWidth : 0);
            return GLib.SOURCE_REMOVE;
        });
    }

    function beginSplitDrag() {
        splitDragging = true;
        stopPlaceTick();
        if (splitDragEnd)
            GLib.source_remove(splitDragEnd);
        splitDragEnd = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            splitDragEnd = 0;
            splitDragging = false;
            if (followBottom)
                schedulePlace();
            return GLib.SOURCE_REMOVE;
        });
    }

    split.connect('notify::position', () => {
        if (!applyingSplit)
            beginSplitDrag();
        rememberSplit();
    });
    split.connect('notify::height', () => applySplit());
    contextButton.connect('toggled', () => {
        contextPanel.visible = contextButton.active;
        splitReady = false;
        if (contextButton.active) {
            applyContextView();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                applySplit();
                return GLib.SOURCE_REMOVE;
            });
        } else
            updateSendStrip();
    });
    hostCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('host', null, hostCheck.active);
    });
    packageCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('packages', null, packageCheck.active);
    });
    graphicsCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('graphics', null, graphicsCheck.active);
    });
    actionCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('terminalInstructions', null, actionCheck.active);
    });
    termCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('terminal', terminalKey(), termCheck.active);
    });
    shotCheck.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('screenshot', shotPermitId(), shotCheck.active);
    });
    shotToggle.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('screenshot', shotPermitId(), shotToggle.active);
    });
    dataToggle.connect('toggled', () => {
        if (!updatingChecks)
            storeDecision('terminal', terminalKey(), dataToggle.active);
    });

    signIn.connect('clicked', () => {
        if (chatgpt.signedIn()) {
            chatgpt.signOut();
            models = [];
            model = '';
            updateAccount();
            clearError();
            return;
        }
        signIn.sensitive = false;
        chatgpt.signIn().then(async () => {
            updateAccount();
            clearError();
            revealContext(true);
            models = await chatgpt.listModels();
            const modelNames = new Gtk.StringList();
            for (const item of models)
                modelNames.append(item.display_name);
            modelBox.model = modelNames;
            modelBox.visible = models.length > 0;
            if (models.length) {
                model = models[0].slug;
                modelBox.selected = 0;
            }
            if (!messages.length)
                loadOpenChat();
        }).catch(showError).finally(() => {
            signIn.sensitive = true;
            updateAccount();
        });
    });
    modelBox.connect('notify::selected', () => {
        const item = models[modelBox.selected];
        if (item)
            model = item.slug;
    });

    let historyReady = !chatId;
    let loadGen = 0;
    // This sign-in can call /v1/responses only. The store code stays, but it does not run.
    let remoteStore = false;

    function storageRefused(error) {
        return error?.apiType === 'rejected_by_access_enforcement'
            || error?.apiCode === 'no_matching_rule';
    }

    function clearCaptures() {
        clients.holdCapture();
        shots.clear();
        dataAt.clear();
        lastSent.host = '';
        lastSent.packages = '';
        lastSent.terminal.clear();
        lastSent.screenshot.clear();
        stripShotKey = '';
        updateContextRow();
        refreshContext();
    }

    async function persistMessages() {
        const pairs = countPairs(messages);
        if (!pairs || !remoteStore)
            return true;
        try {
            return await writeMessages(pairs);
        } catch (error) {
            if (!storageRefused(error))
                throw error;
            remoteStore = false;
            return false;
        }
    }

    async function writeMessages(pairs) {
        if (!chatId) {
            const conv = await chatgpt.createConversation();
            chatId = conv.id;
            storedPairs = 0;
            chatIndex = upsertChat(chatIndex, {
                id: chatId,
                title: chatTitle(messages[0].text),
                createdAt: Number(conv.created_at) || Math.floor(Date.now() / 1000),
                turns: [],
            });
            saveChats(chatIndex);
        }
        for (let index = storedPairs; index < pairs; index++) {
            const user = messages[index * 2];
            const assistant = messages[index * 2 + 1];
            await chatgpt.addItems(chatId, [
                {type: 'message', role: 'user', content: [{type: 'input_text', text: user.text}]},
                {type: 'message', role: 'assistant', content: [{type: 'output_text', text: assistant.text}]},
            ]);
        }
        storedPairs = pairs;
        const record = chatIndex.chats.find(row => row.id === chatId);
        chatIndex = upsertChat(chatIndex, {
            id: chatId,
            title: record?.title || chatTitle(messages[0].text),
            createdAt: record?.createdAt || Math.floor(Date.now() / 1000),
            turns: turnsFrom(messages),
        });
        saveChats(chatIndex);
        const legacy = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), CHAT_FILE]));
        if (legacy.query_exists(null))
            legacy.delete(null);
        return true;
    }

    function loadOpenChat() {
        const gen = ++loadGen;
        const id = chatId;
        if (!id || !chatgpt.signedIn()) {
            historyReady = true;
            return;
        }
        historyReady = false;
        chatgpt.listItems(id).then(items => {
            if (gen !== loadGen || chatId !== id)
                return;
            const record = chatIndex.chats.find(row => row.id === id);
            messages = zipMessages(items, record?.turns ?? []);
            storedPairs = countPairs(messages);
            historyReady = true;
            followBottom = true;
            redrawMessages();
        }).catch(error => {
            if (gen !== loadGen)
                return;
            historyReady = true;
            showError(error);
        });
    }

    function rebuildChatMenu() {
        let child = chatList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            chatList.remove(child);
            child = next;
        }
        if (!chatIndex.chats.length) {
            chatList.append(new Gtk.Label({
                label: 'No chats yet.',
                xalign: 0,
                margin_start: 8,
                margin_end: 8,
                margin_top: 6,
                margin_bottom: 6,
                css_classes: ['dim-label'],
            }));
            return;
        }
        for (const chat of chatIndex.chats) {
            const row = new Gtk.Button({css_classes: ['flat']});
            const box = new Gtk.Box({spacing: 8});
            if (chat.id === chatId)
                box.append(new Gtk.Image({icon_name: 'object-select-symbolic'}));
            box.append(new Gtk.Label({
                label: chat.title,
                xalign: 0,
                hexpand: true,
                ellipsize: Pango.EllipsizeMode.END,
            }));
            const when = GLib.DateTime.new_from_unix_local(chat.createdAt);
            box.append(new Gtk.Label({
                label: when ? when.format('%x') : '',
                css_classes: ['dim-label'],
            }));
            row.child = box;
            row.connect('clicked', () => {
                chatPopover.popdown();
                openSavedChat(chat.id).catch(showError);
            });
            chatList.append(row);
        }
    }

    async function openSavedChat(id) {
        if (!id || id === chatId || sending)
            return;
        if (!chatgpt.signedIn())
            throw new Error('Sign in with ChatGPT first.');
        if (countPairs(messages))
            await persistMessages();
        loadGen += 1;
        const items = await chatgpt.listItems(id);
        const record = chatIndex.chats.find(row => row.id === id);
        messages = zipMessages(items, record?.turns ?? []);
        chatId = id;
        storedPairs = countPairs(messages);
        historyReady = true;
        chatIndex.openId = id;
        saveChats(chatIndex);
        followBottom = true;
        redrawMessages();
    }

    async function startNewChat() {
        if (sending)
            return;
        let stored = true;
        if (messages.some(message => message.text)) {
            if (!chatgpt.signedIn())
                throw new Error('Sign in with ChatGPT first.');
            stored = await persistMessages();
        }
        loadGen += 1;
        chatId = '';
        messages = [];
        storedPairs = 0;
        historyReady = true;
        chatIndex.openId = '';
        if (!stored)
            chatIndex.skipLegacy = true;
        saveChats(chatIndex);
        clearCaptures();
        followBottom = true;
        redrawMessages();
        menuPopover.popdown();
        if (!stored)
            showError(new Error('ChatGPT cannot store chats for this sign-in. The new chat is open.'));
    }

    function selectScheme(name) {
        colorScheme = name === 'light' || name === 'dark' ? name : 'default';
        Adw.StyleManager.get_default().color_scheme = colorScheme === 'light'
            ? Adw.ColorScheme.FORCE_LIGHT
            : colorScheme === 'dark'
                ? Adw.ColorScheme.FORCE_DARK
                : Adw.ColorScheme.DEFAULT;
        for (const [key, button] of schemeButtons) {
            const on = key === colorScheme;
            if (button.active !== on)
                button.active = on;
            if (button.child)
                button.child.visible = on;
        }
        saveLayout(splitPercent, colorScheme, widthSet ? windowWidth : 0);
    }

    async function sendMessage() {
        const buffer = entry.buffer;
        const [start, end] = buffer.get_bounds();
        const text = buffer.get_text(start, end, false).trim();
        if (!text || sending)
            return;
        if (!historyReady) {
            showError(new Error('The chat is still loading.'));
            return;
        }
        if (!chatgpt.signedIn()) {
            showError(new Error('Sign in with ChatGPT first.'));
            return;
        }
        if (!model) {
            showError(new Error('No ChatGPT model is available.'));
            return;
        }
        if (contextPanel.visible && pendingAsk().length) {
            const now = GLib.get_monotonic_time();
            if (!reviewHoldAt || now - reviewHoldAt < 500000) {
                if (!reviewHoldAt)
                    reviewHoldAt = now;
                applyContextView();
                return;
            }
            declinePending();
            reviewHoldAt = 0;
        }
        const term = terminalPayload();
        const sendTerm = Boolean(term) && decision(allow, 'terminal', terminalKey()) === 'allow';
        const image = imageForMessage();
        const sendShot = Boolean(image?.png?.length)
            && decision(allow, 'screenshot', shotPermitId()) === 'allow';
        const sendHost = Boolean(hostInfo) && decision(allow, 'host') === 'allow';
        const sendPackages = Boolean(packageInfo) && decision(allow, 'packages') === 'allow';
        const sendGraphics = Boolean(graphicsInfo) && decision(allow, 'graphics') === 'allow';
        sending = true;
        send.sensitive = false;
        clearError();
        followBottom = true;
        buffer.set_text('', -1);
        const sentAt = Date.now();
        messages.push({role: 'user', text, sentAt});
        messages.push({role: 'assistant', text: ''});
        redrawMessages();
        let prompt = text;
        if (sendTerm)
            prompt += `\n\n${term.head}\n\n\`\`\`\n${term.text}\n\`\`\``;
        const parts = [{type: 'input_text', text: prompt}];
        if (sendShot) {
            parts.push({
                type: 'input_image',
                image_url: `data:image/png;base64,${pngBase64(image.png)}`,
            });
            parts[0].text += `\n\nScreenshot of ${image.title} at ${image.timestamp}.`;
        }
        const input = messages.slice(0, -2).map(message => ({
            role: message.role,
            content: message.text,
        }));
        input.push({role: 'user', content: parts});
        try {
            const reply = await chatgpt.streamReply({
                model,
                instructions: instructions(),
                input,
                onDelta: partial => {
                    messages[messages.length - 1].text = partial;
                    redrawMessages();
                },
            });
            messages[messages.length - 1].text = reply;
            messages[messages.length - 1].elapsedMs = Date.now() - sentAt;
            if (sendHost)
                lastSent.host = hostInfo;
            if (sendPackages)
                lastSent.packages = packageInfo;
            if (sendGraphics)
                lastSent.graphics = graphicsInfo;
            if (sendTerm)
                lastSent.terminal.set(terminalKey(), term.text);
            if (sendShot)
                lastSent.screenshot.set(shotPermitId(), image.timestamp);
            redrawMessages();
            refreshContext();
        } catch (error) {
            messages.pop();
            messages.pop();
            redrawMessages();
            showError(error);
            return;
        } finally {
            sending = false;
            send.sensitive = true;
        }
        try {
            if (await persistMessages() === false)
                showError(new Error('ChatGPT cannot store chats for this sign-in.'));
        } catch (error) {
            showError(error);
        }
    }

    send.connect('clicked', () => {
        sendMessage().catch(showError);
    });
    newChatButton.connect('clicked', () => {
        startNewChat().catch(showError);
    });
    for (const [name, button] of schemeButtons) {
        button.connect('toggled', () => {
            if (!button.active) {
                if (colorScheme === name)
                    button.active = true;
                return;
            }
            if (colorScheme !== name)
                selectScheme(name);
        });
    }
    chatPopover.connect('show', () => rebuildChatMenu());
    entry.buffer.connect('changed', () => {
        const [start, end] = entry.buffer.get_bounds();
        entryHint.visible = entry.buffer.get_text(start, end, false).length === 0;
    });
    const key = new Gtk.EventControllerKey();
    key.connect('key-pressed', (controller, keyval, keycode, state) => {
        if (keyval === Gdk.KEY_Return && !(state & Gdk.ModifierType.SHIFT_MASK)) {
            sendMessage().catch(showError);
            return true;
        }
        return false;
    });
    entry.add_controller(key);

    const refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        refreshState();
        return GLib.SOURCE_CONTINUE;
    });
    window.connect('close-request', () => {
        GLib.source_remove(refreshId);
        if (policyFit)
            GLib.source_remove(policyFit);
        if (standingSave)
            GLib.source_remove(standingSave);
        if (splitSave)
            GLib.source_remove(splitSave);
        if (splitDragEnd)
            GLib.source_remove(splitDragEnd);
        if (widthSave)
            GLib.source_remove(widthSave);
        const liveWidth = window.get_width();
        if (widthSet && liveWidth > 1)
            windowWidth = liveWidth;
        saveLayout(splitPercent, colorScheme, widthSet ? windowWidth : 0);
        if (placeIdle)
            GLib.source_remove(placeIdle);
        if (placementIdle)
            GLib.source_remove(placementIdle);
        if (dataScrollIdle)
            GLib.source_remove(dataScrollIdle);
        stopPlaceTick();
        shell.close();
        application.quit();
        return false;
    });
    function rememberWidth(width) {
        const next = Math.round(Number(width));
        if (!acceptWidth || next < 1 || next === windowWidth)
            return;
        windowWidth = next;
        widthSet = true;
        if (widthSave)
            GLib.source_remove(widthSave);
        widthSave = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            widthSave = 0;
            saveLayout(splitPercent, colorScheme, windowWidth);
            return GLib.SOURCE_REMOVE;
        });
    }

    let widthWatch = false;
    window.connect('realize', () => {
        if (widthWatch)
            return;
        const surface = window.get_surface();
        if (!surface)
            return;
        widthWatch = true;
        surface.connect('layout', () => rememberWidth(window.get_width()));
    });
    window.connect('map', () => {
        queuePlacement();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const current = window.get_width();
            if (!windowWidth && current > 1)
                windowWidth = current;
            acceptWidth = true;
            return GLib.SOURCE_REMOVE;
        });
    });
    shell.start();
    selectScheme(colorScheme);
    loadOpenChat();
    updateSendStrip();
    refreshState();
    updateAccount();
    redrawMessages();
    if (chatgpt.signedIn()) {
        chatgpt.listModels().then(found => {
            models = found;
            const modelNames = new Gtk.StringList();
            for (const item of models)
                modelNames.append(item.display_name);
            modelBox.model = modelNames;
            modelBox.visible = models.length > 0;
            if (models[0])
                model = models[0].slug;
        }).catch(showError);
    }
    window.present();
}
