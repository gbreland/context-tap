import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
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

const DESKTOP_ID = 'org.gnome.Desktop';
const CHAT_FILE = 'chat.json';
const LAYOUT_FILE = 'layout.json';
const LAUNCH_HEIGHT = 760;
const CONTEXT_WIDTH = 600;

function widgetSize(widget) {
    if (!widget)
        return {w: 0, h: 0};
    const [, size] = widget.get_preferred_size();
    return {w: size?.width || 0, h: size?.height || 0};
}

function placeChild(child, x, y, width, height) {
    if (!child || width < 1 || height < 1)
        return;
    const point = new Graphene.Point();
    point.init(x, y);
    let transform = new Gsk.Transform();
    transform = transform.translate(point);
    child.allocate(width, height, -1, transform);
}

const PromptHead = GObject.registerClass({
}, class PromptHead extends Gtk.Widget {
    _init(dateLabel, chip, copyButton) {
        super._init({hexpand: true});
        this._date = dateLabel || null;
        this._chip = chip || null;
        this._copy = copyButton;
        if (this._date)
            this._date.set_parent(this);
        if (this._chip)
            this._chip.set_parent(this);
        this._copy.set_parent(this);
    }

    vfunc_get_request_mode() {
        return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
    }

    vfunc_measure(orientation, forSize) {
        const date = widgetSize(this._date);
        const chip = widgetSize(this._chip);
        const copy = widgetSize(this._copy);
        const gap = 8;
        const first = date.w + copy.w + (date.w && copy.w ? gap : 0);
        const inline = first + (chip.w ? chip.w + gap : 0);
        if (orientation === Gtk.Orientation.HORIZONTAL) {
            const min = Math.max(first, chip.w);
            return [min, Math.max(min, inline), -1, -1];
        }
        const width = forSize < 0 ? inline : forSize;
        const wrap = chip.w > 0 && inline > width;
        const row = Math.max(date.h, copy.h, wrap ? 0 : chip.h);
        const height = wrap ? row + 2 + chip.h : Math.max(row, 1);
        return [height, height, -1, -1];
    }

    vfunc_size_allocate(width, height, baseline) {
        const date = widgetSize(this._date);
        const chip = widgetSize(this._chip);
        const copy = widgetSize(this._copy);
        const gap = 8;
        const inline = date.w + copy.w + (chip.w ? chip.w + gap * 2 : gap);
        const wrap = chip.w > 0 && inline > width;
        const row = Math.max(date.h, copy.h, wrap ? 0 : chip.h, 1);
        const dateY = Math.max(0, Math.floor((row - date.h) / 2));
        const copyY = Math.max(0, Math.floor((row - copy.h) / 2));
        placeChild(this._date, 0, dateY, date.w, date.h);
        placeChild(this._copy, Math.max(0, width - copy.w), copyY, copy.w, copy.h);
        if (!this._chip)
            return;
        if (wrap)
            placeChild(this._chip, 0, row + 2, Math.min(chip.w, width), chip.h);
        else {
            const chipY = Math.max(0, Math.floor((row - chip.h) / 2));
            placeChild(this._chip, date.w + (date.w ? gap : 0), chipY, chip.w, chip.h);
        }
    }

    vfunc_dispose() {
        for (const child of [this._date, this._chip, this._copy]) {
            if (child)
                child.unparent();
        }
        this._date = null;
        this._chip = null;
        this._copy = null;
        super.vfunc_dispose();
    }
});

function chartGlyph() {
    const area = new Gtk.DrawingArea({
        content_width: 16,
        content_height: 16,
        can_target: false,
    });
    area.set_draw_func((widget, cr) => {
        const rgba = widget.get_color();
        cr.setSourceRGBA(rgba.red, rgba.green, rgba.blue, rgba.alpha);
        const heights = [6, 11, 15];
        for (let i = 0; i < heights.length; i += 1) {
            const height = heights[i];
            cr.rectangle(1 + (i * 5), 16 - height, 3, height);
            cr.fill();
        }
    });
    return area;
}

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
        const contextWidth = Math.round(Number(data.contextWidth));
        return {
            contextPercent: clampContextPercent(data.contextPercent),
            colorScheme,
            width: width >= 1 ? width : 0,
            contextWidth: contextWidth >= 1 ? contextWidth : 0,
            submitCtrl: data.submitCtrl === true,
        };
    } catch {
        return {contextPercent: 50, colorScheme: 'default', width: 0, contextWidth: 0, submitCtrl: false};
    }
}

function loadSavedPlacement() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_state_dir(), 'context-tap', 'placement.json']));
        const [, bytes] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        const mode = data.mode === 'left' || data.mode === 'right' ? data.mode : 'off';
        return {mode, above: data.above === true};
    } catch {
        return {mode: 'left', above: true};
    }
}

function screenHeight() {
    const monitors = Gdk.Display.get_default()?.get_monitors?.();
    let height = 0;
    if (monitors) {
        for (let i = 0; i < monitors.get_n_items(); i++) {
            const geo = monitors.get_item(i)?.get_geometry?.();
            if (geo?.height > height)
                height = geo.height;
        }
    }
    return height > 200 ? height : LAUNCH_HEIGHT;
}

function saveLayout(percent, colorScheme, width = 0, submitCtrl = false, contextWidth = 0, contextOpen = false) {
    const scheme = colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : 'default';
    const nextWidth = Math.round(Number(width));
    const settingsWidth = Math.round(Number(contextWidth));
    const payload = {
        contextPercent: clampContextPercent(percent),
        colorScheme: scheme,
        submitCtrl: submitCtrl === true,
    };
    if (nextWidth >= 1)
        payload.width = nextWidth;
    if (settingsWidth >= 1)
        payload.contextWidth = settingsWidth;
    if (contextOpen)
        payload.contextOpen = true;
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), LAYOUT_FILE]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(payload))), null);
    stream.close(null);
}

export function openWindow(application, services) {
    const {chatgpt, shell, clients} = services;
    const shots = new Map();
    const layout = loadLayout();
    let windowWidth = layout.width;
    let widthSet = layout.width >= 1;
    let contextWidth = layout.contextWidth >= 1 ? layout.contextWidth : CONTEXT_WIDTH;
    let contextOpen = false;
    let ignoreWidth = false;
    let widthSave = 0;
    let applyWidthTimer = 0;
    let acceptWidth = false;
    let chatIndex = loadChats();
    let chatId = chatIndex.openId || '';
    let storedPairs = 0;
    let messages = chatId || chatIndex.skipLegacy ? [] : loadChat();
    let cacheKey = GLib.uuid_string_random();
    let models = [];
    let model = '';
    let workingId = '';
    let workingTitle = '';
    const savedPlace = loadSavedPlacement();
    let above = savedPlace.above;
    let dock = savedPlace.mode;
    let startupDock = true;
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
    let submitCtrl = layout.submitCtrl;

    function persistLayout() {
        saveLayout(
            splitPercent,
            colorScheme,
            widthSet ? windowWidth : 0,
            submitCtrl,
            contextWidth,
            contextOpen);
    }

    function shownWidth() {
        if (contextOpen)
            return contextWidth >= 1 ? contextWidth : CONTEXT_WIDTH;
        return windowWidth || window.get_width() || 1;
    }

    function applyAppWidth(width) {
        if (applyWidthTimer) {
            GLib.source_remove(applyWidthTimer);
            applyWidthTimer = 0;
        }
        ignoreWidth = true;
        const target = Math.max(210, Math.round(Number(width)) || 210);
        const push = () => {
            try {
                shell.setWidth(target);
            } catch {
                /* The shell applies the width when it is connected. */
            }
            const height = window.get_height();
            if (height > 1)
                window.set_default_size(target, height);
        };
        push();
        applyWidthTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            push();
            applyWidthTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
                applyWidthTimer = 0;
                ignoreWidth = false;
                const live = Math.round(window.get_width());
                rememberWidth(Math.abs(live - target) <= 16 ? live : target);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }
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
        default_width: Math.max(layout.width || 210, 210),
        default_height: dock === 'off' ? LAUNCH_HEIGHT : screenHeight(),
    });
    window.set_size_request(210, 200);
    if (dock === 'left' || dock === 'right')
        window.add_css_class('docked');
    const focusClick = new Gtk.GestureClick({
        button: 0,
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    focusClick.connect('pressed', () => {
        if (!window.is_active)
            shell.focusSelf();
    });
    window.add_controller(focusClick);

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
        margin_top: 20,
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
        left_margin: 12,
        right_margin: 12,
        top_margin: 8,
        bottom_margin: 8,
        css_classes: ['chat-input'],
        hexpand: true,
        vexpand: false,
    });
    const entryScroll = new Gtk.ScrolledWindow({
        child: entry,
        hexpand: true,
        vexpand: false,
        propagate_natural_height: false,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.EXTERNAL,
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
    const entryOverlay = new Gtk.Overlay({hexpand: true, vexpand: false, child: entryScroll});
    entryOverlay.add_overlay(entryHint);
    const send = new Gtk.Button({
        child: new Gtk.Image({
            icon_name: 'go-up-symbolic',
            pixel_size: 22,
        }),
        tooltip_text: 'Send',
        css_classes: ['chat-send'],
        valign: Gtk.Align.FILL,
        vexpand: false,
        width_request: 30,
    });
    const entryShell = new Gtk.Box({
        hexpand: true,
        vexpand: false,
        css_classes: ['chat-input-shell'],
        overflow: Gtk.Overflow.HIDDEN,
    });
    entryShell.append(entryOverlay);
    entryShell.append(send);

    let entrySizeKey = '';

    function textPixelHeight(text, wrapWidth) {
        const layout = entry.create_pango_layout(text);
        if (wrapWidth > 1) {
            layout.set_width(wrapWidth * Pango.SCALE);
            layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        }
        return layout.get_pixel_size()[1] ?? 0;
    }

    function fitEntry() {
        const twoLines = textPixelHeight('Ag\nAg', 0);
        if (twoLines < 8)
            return;
        const pad = entry.top_margin + entry.bottom_margin;
        const minHeight = twoLines + pad;
        const [start, end] = entry.buffer.get_bounds();
        const text = entry.buffer.get_text(start, end, false);
        const inner = entry.get_width() - entry.left_margin - entry.right_margin;
        const block = text ? textPixelHeight(text, inner) + pad : minHeight;
        const content = Math.max(minHeight, block);
        const windowHeight = window.get_height();
        const cap = windowHeight >= 8
            ? Math.max(minHeight, Math.floor(windowHeight * 0.5))
            : content;
        const atCap = content > cap;
        entryScroll.vscrollbar_policy = atCap
            ? Gtk.PolicyType.AUTOMATIC
            : Gtk.PolicyType.EXTERNAL;
        entryScroll.height_request = atCap ? cap : content;
    }

    entryShell.add_tick_callback(() => {
        const key = `${window.get_height()}:${entry.get_width()}`;
        if (key !== entrySizeKey) {
            entrySizeKey = key;
            fitEntry();
        }
        return GLib.SOURCE_CONTINUE;
    });
    const shotThumb = new Gtk.Picture({
        can_shrink: true,
        content_fit: Gtk.ContentFit.SCALE_DOWN,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false,
        vexpand: false,
    });
    const shotFrame = new Gtk.Box({
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    });
    shotFrame.append(shotThumb);
    shotThumb.can_target = false;
    shotFrame.can_target = false;
    const shotToggle = new Gtk.ToggleButton({
        css_classes: ['context-card'],
        hexpand: true,
        child: shotFrame,
    });
    function includeBadge() {
        const icon = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            pixel_size: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
            can_target: false,
            visible: false,
        });
        const badge = new Gtk.Box({
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            margin_end: 8,
            can_target: false,
            width_request: 18,
            height_request: 18,
            css_classes: ['context-mark'],
        });
        badge.append(icon);
        return {badge, icon};
    }

    function paintBadge(mark, on) {
        mark.icon.visible = on;
        if (on)
            mark.badge.add_css_class('on');
        else
            mark.badge.remove_css_class('on');
    }

    const shotMark = includeBadge();
    const shotWrap = new Gtk.Overlay({child: shotToggle, visible: false});
    shotWrap.add_overlay(shotMark.badge);
    const dataBuffer = new Gtk.TextBuffer();
    const dataView = new Gtk.TextView({
        buffer: dataBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        accepts_tab: false,
        left_margin: 6,
        right_margin: 28,
        top_margin: 4,
        bottom_margin: 4,
        css_classes: ['data-preview'],
    });
    dataView.can_target = false;
    const dataScroll = new Gtk.ScrolledWindow({
        child: dataView,
        hexpand: true,
        propagate_natural_height: false,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.EXTERNAL,
        height_request: 48,
        css_classes: ['data-preview'],
    });
    dataScroll.can_target = false;
    const dataPort = dataScroll.get_first_child();
    if (dataPort)
        dataPort.can_target = false;
    const dataToggle = new Gtk.ToggleButton({
        css_classes: ['context-card'],
        hexpand: true,
        child: dataScroll,
    });
    const dataMark = includeBadge();
    const dataWrap = new Gtk.Overlay({child: dataToggle, visible: false});
    dataWrap.add_overlay(dataMark.badge);
    const dataTipView = new Gtk.TextView({
        buffer: dataBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        left_margin: 8,
        right_margin: 8,
        top_margin: 8,
        bottom_margin: 8,
        css_classes: ['data-preview-tip'],
    });
    const dataTipScroll = new Gtk.ScrolledWindow({
        child: dataTipView,
        width_request: 420,
        height_request: 240,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    dataToggle.connect('query-tooltip', (_widget, _x, _y, _keyboard, tooltip) => {
        const [start, end] = dataBuffer.get_bounds();
        if (!dataBuffer.get_text(start, end, false))
            return false;
        tooltip.set_custom(dataTipScroll);
        return true;
    });
    const shotTip = new Gtk.Picture({
        can_shrink: true,
        content_fit: Gtk.ContentFit.SCALE_DOWN,
    });
    let shotTipKey = '';
    shotToggle.connect('query-tooltip', (_widget, _x, _y, _keyboard, tooltip) => {
        const image = imageForMessage();
        if (!image?.png?.length)
            return false;
        const key = `${image.appId}:${image.timestamp}:${image.png.length}`;
        if (key !== shotTipKey) {
            try {
                const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(image.png));
                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
                const scale = Math.min(1, 520 / pixbuf.get_width(), 400 / pixbuf.get_height());
                const width = Math.max(1, Math.round(pixbuf.get_width() * scale));
                const height = Math.max(1, Math.round(pixbuf.get_height() * scale));
                const fitted = scale < 1
                    ? pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
                    : pixbuf;
                shotTip.paintable = Gdk.Texture.new_for_pixbuf(fitted);
                shotTip.width_request = width;
                shotTip.height_request = height;
                shotTipKey = key;
            } catch {
                return false;
            }
        }
        tooltip.set_custom(shotTip);
        return true;
    });
    const entryRow = new Gtk.Box({
        spacing: 8,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 8,
    });
    entryRow.append(entryShell);

    const contextButton = new Gtk.ToggleButton({
        child: new Gtk.Image({
            icon_name: 'preferences-system-symbolic',
            pixel_size: 18,
        }),
        tooltip_text: 'Show the context sent to ChatGPT',
        css_classes: ['context-gear'],
        valign: Gtk.Align.FILL,
        vexpand: false,
        width_request: 30,
    });
    const contextItems = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        hexpand: true,
        margin_start: 8,
        margin_end: 4,
        margin_top: 6,
        margin_bottom: 6,
    });
    contextItems.append(dataWrap);
    contextItems.append(shotWrap);
    const contextShell = new Gtk.Box({
        hexpand: true,
        vexpand: false,
        visible: false,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
        visible: true,
        css_classes: ['chat-input-shell', 'context-strip'],
        overflow: Gtk.Overflow.HIDDEN,
    });
    contextShell.append(contextItems);
    contextShell.append(contextButton);
    const holdLabel = new Gtk.Label({
        label: 'Check a box, or press Send again to leave that item out.',
        wrap: true,
        ellipsize: Pango.EllipsizeMode.END,
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
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            selectable: false,
            xalign: 0,
            hexpand: true,
            width_chars: 24,
            max_width_chars: 48,
            css_classes: extraClasses,
        });
    }

    function byteText(count) {
        const n = Math.max(0, Math.round(Number(count) || 0));
        return `${n.toLocaleString('en-US')} bytes`;
    }

    function utf8Bytes(text) {
        return new TextEncoder().encode(String(text ?? '')).length;
    }

    function showBytes(label, count) {
        const next = byteText(count);
        if (label.label !== next)
            label.label = next;
    }

    function sectionTitle(text) {
        const label = new Gtk.Label({
            label: text,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const bytes = new Gtk.Label({
            label: byteText(0),
            xalign: 0,
        });
        const copy = copyButton();
        const box = new Gtk.Box({spacing: 6, hexpand: true});
        box.append(label);
        box.append(bytes);
        box.append(new Gtk.Label({hexpand: true}));
        box.append(copy);
        return {box, copy, bytes};
    }

    function copyButton() {
        return new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
    }

    function allowSection(name, check) {
        check.tooltip_text = 'Send this section';
        check.valign = Gtk.Align.START;
        const header = sectionTitle(name);
        const expander = new Gtk.Expander({
            label_widget: header.box,
            hexpand: true,
            expanded: false,
        });
        const row = new Gtk.Box({spacing: 6});
        row.append(check);
        row.append(expander);
        return {row, expander, copy: header.copy, bytes: header.bytes};
    }

    const policyCheck = new Gtk.CheckButton({
        active: true,
        sensitive: false,
        tooltip_text: 'These instructions are always sent',
        valign: Gtk.Align.START,
    });
    const policyTitle = sectionTitle('Always sent');
    const policyExpander = new Gtk.Expander({
        label_widget: policyTitle.box,
        hexpand: true,
        expanded: false,
        child: policyView,
    });
    policyView.hexpand = true;
    const policyRow = new Gtk.Box({spacing: 6});
    policyRow.append(policyCheck);
    policyRow.append(policyExpander);
    policyTitle.copy.connect('clicked', () => {
        const [start, end] = policyBuffer.get_bounds();
        copyText(policyBuffer.get_text(start, end, false));
    });

    const hostCheck = new Gtk.CheckButton();
    const hostBody = cappedLabel(['context-detail']);
    const hostParts = allowSection('Host', hostCheck);
    hostParts.expander.child = hostBody;
    hostParts.copy.connect('clicked', () => copyText(hostBody.label));

    const packageCheck = new Gtk.CheckButton();
    const packageNoteLabel = new Gtk.Label({
        wrap: true,
        ellipsize: Pango.EllipsizeMode.END,
        xalign: 0,
        hexpand: true,
        css_classes: ['caption', 'dim-label'],
    });
    const packageBody = cappedLabel(['context-detail']);
    const packageBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    packageBox.append(packageNoteLabel);
    packageBox.append(packageBody);
    const packageParts = allowSection('Packages', packageCheck);
    packageParts.expander.child = packageBox;
    packageParts.copy.connect('clicked', () => {
        const note = String(packageNoteLabel.label ?? '').trim();
        const body = packageBody.label ?? '';
        copyText(note ? `${note}\n${body}` : body);
    });

    const graphicsCheck = new Gtk.CheckButton();
    const graphicsBody = cappedLabel(['context-detail']);
    const graphicsParts = allowSection('Graphics', graphicsCheck);
    graphicsParts.expander.child = graphicsBody;
    graphicsParts.copy.connect('clicked', () => copyText(graphicsBody.label));

    const termCheck = new Gtk.CheckButton();
    const termBody = cappedLabel(['context-detail']);
    const termParts = allowSection('Data', termCheck);
    termParts.expander.child = termBody;
    termParts.copy.connect('clicked', () => copyText(termBody.label));
    const termSection = termParts.row;

    const actionCheck = new Gtk.CheckButton();
    const actionBody = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        wrap: true,
        wrap_mode: Gtk.WrapMode.WORD,
        natural_wrap_mode: Gtk.NaturalWrapMode.INHERIT,
        width_chars: 24,
        max_width_chars: 48,
        selectable: true,
        label: TERMINAL_ACTION_TEXT,
        css_classes: ['context-detail'],
    });
    const actionParts = allowSection('AI Instructions', actionCheck);
    actionParts.expander.child = actionBody;
    actionParts.copy.connect('clicked', () => copyText(actionBody.label));
    const actionSection = actionParts.row;

    const shotCheck = new Gtk.CheckButton();
    const shotCaption = new Gtk.Label({
        wrap: true,
        ellipsize: Pango.EllipsizeMode.END,
        xalign: 0,
        hexpand: true,
        css_classes: ['caption', 'dim-label'],
    });
    const shotPicture = new Gtk.Picture({
        can_shrink: true,
        content_fit: Gtk.ContentFit.SCALE_DOWN,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
        hexpand: false,
        vexpand: false,
    });
    function shotLimits() {
        const windowHeight = window.get_height();
        const windowWidth = window.get_width();
        if (windowHeight < 8 || windowWidth < 8)
            return null;
        return {
            height: Math.max(1, Math.floor(windowHeight * 0.15)),
            width: Math.max(1, windowWidth - 64),
        };
    }

    function fittedPreview(png, limits) {
        const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(png));
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        const imageWidth = pixbuf.get_width();
        const imageHeight = pixbuf.get_height();
        if (!(imageWidth > 0) || !(imageHeight > 0))
            return null;
        const scale = Math.min(1, limits.height / imageHeight, limits.width / imageWidth);
        const width = Math.max(1, Math.round(imageWidth * scale));
        const height = Math.max(1, Math.round(imageHeight * scale));
        const fitted = width === imageWidth && height === imageHeight
            ? pixbuf
            : pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);
        if (!fitted)
            return null;
        return {texture: Gdk.Texture.new_for_pixbuf(fitted), width, height};
    }

    const stripFit = {key: '', png: null};
    const panelFit = {key: '', png: null};

    function applyFitted(picture, fit) {
        const limits = shotLimits();
        if (!fit.png?.length || !limits)
            return false;
        const key = `${limits.width}x${limits.height}:${fit.png.length}`;
        if (fit.key === key && picture.paintable)
            return true;
        const fitted = fittedPreview(fit.png, limits);
        if (!fitted)
            return false;
        fit.key = key;
        picture.paintable = fitted.texture;
        picture.width_request = -1;
        picture.height_request = -1;
        return true;
    }

    shotThumb.add_tick_callback(() => {
        if (shotThumb.visible)
            applyFitted(shotThumb, stripFit);
        return GLib.SOURCE_CONTINUE;
    });
    shotPicture.add_tick_callback(() => {
        if (shotPicture.visible)
            applyFitted(shotPicture, panelFit);
        return GLib.SOURCE_CONTINUE;
    });
    const shotPanelFrame = new Gtk.Box({
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
    });
    shotPanelFrame.append(shotPicture);
    const shotBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
    shotBox.append(shotCaption);
    shotBox.append(shotPanelFrame);
    const shotParts = allowSection('Screenshot', shotCheck);
    shotParts.expander.child = shotBox;
    shotParts.copy.connect('clicked', () => {
        const image = imageForMessage();
        if (image?.png?.length)
            copyPng(image.png);
        else
            copyText(shotCaption.label ?? '');
    });
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
        hexpand: true,
        vexpand: false,
        visible: false,
        propagate_natural_height: false,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    contextItems.append(contextScroll);
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

    const chatColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true,
        hexpand: true,
    });
    chatColumn.append(scroller);
    chatColumn.append(entryRow);
    chatColumn.append(contextShell);
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
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['dim-label'],
    });
    const contextRow = new Gtk.Box({
        spacing: 12,
        margin_start: 12,
        margin_end: 12,
        margin_top: 8,
        margin_bottom: 4,
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

    const signIn = new Gtk.Button({
        label: 'Sign in',
        tooltip_text: 'Sign in',
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    });
    const signInGate = new Gtk.CenterBox({
        visible: false,
        vexpand: true,
        hexpand: true,
    });
    signInGate.set_center_widget(signIn);
    chatColumn.prepend(signInGate);
    const menuAccountLabel = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 28,
    });
    const menuAccountButton = new Gtk.Button({
        child: menuAccountLabel,
        css_classes: ['flat'],
        hexpand: true,
        visible: false,
    });
    const accountSep = new Gtk.Separator({visible: false});
    const accountNameLabel = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 32,
    });
    const accountEmailLabel = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 32,
        selectable: true,
        css_classes: ['dim-label'],
    });
    const signOutButton = new Gtk.Button({
        label: 'Sign out',
        halign: Gtk.Align.END,
    });
    const accountCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        hexpand: true,
        visible: false,
        css_classes: ['account-card'],
    });
    accountCard.append(accountNameLabel);
    accountCard.append(accountEmailLabel);
    accountCard.append(signOutButton);
    let accountOpen = false;
    const modelBox = new Gtk.DropDown({visible: false, hexpand: true, tooltip_text: 'Model'});
    function shrinkModelLabel() {
        const button = modelBox.get_first_child();
        if (!button)
            return;
        const visit = widget => {
            if (widget instanceof Gtk.Label) {
                widget.ellipsize = Pango.EllipsizeMode.END;
                widget.width_chars = 1;
            }
            let child = widget.get_first_child?.();
            while (child) {
                visit(child);
                child = child.get_next_sibling();
            }
        };
        visit(button);
    }
    modelBox.connect('notify::model', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            shrinkModelLabel();
            return GLib.SOURCE_REMOVE;
        });
    });
    const aboveSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: above,
    });
    const aboveRow = new Gtk.Box({spacing: 12});
    aboveRow.append(new Gtk.Label({
        label: 'Always on Top',
        xalign: 0,
        hexpand: true,
    }));
    aboveRow.append(aboveSwitch);
    const submitSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: submitCtrl,
    });
    const submitRow = new Gtk.Box({spacing: 12});
    submitRow.append(new Gtk.Label({
        label: 'Submit with Ctrl+Enter',
        xalign: 0,
        hexpand: true,
    }));
    submitRow.append(submitSwitch);
    const dockBox = new Gtk.Box({
        css_classes: ['linked'],
        halign: Gtk.Align.CENTER,
    });
    let dockGroup = null;
    const dockButtons = [
        ['left', 'aia-dock-left-symbolic', 'Dock left'],
        ['off', 'aia-dialog-symbolic', 'Default size'],
        ['right', 'aia-dock-right-symbolic', 'Dock right'],
    ].map(([mode, iconName, tip]) => {
        const button = new Gtk.ToggleButton({
            icon_name: iconName,
            tooltip_text: tip,
            css_classes: ['flat'],
            active: mode === dock,
        });
        if (dockGroup)
            button.group = dockGroup;
        else
            dockGroup = button;
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
    menuBox.append(dockBox);
    menuBox.append(new Gtk.Separator());
    menuBox.append(aboveRow);
    menuBox.append(submitRow);
    menuBox.append(accountSep);
    menuBox.append(menuAccountButton);
    menuBox.append(accountCard);
    const menuPopover = new Gtk.Popover({child: menuBox});
    const menuButton = new Gtk.MenuButton({
        icon_name: 'open-menu-symbolic',
        tooltip_text: 'Menu',
        popover: menuPopover,
    });

    const header = new Adw.HeaderBar();
    header.pack_end(menuButton);

    const appBar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
    });
    const usageBox = new Gtk.Box({
        spacing: 8,
        halign: Gtk.Align.END,
        valign: Gtk.Align.CENTER,
        visible: false,
    });
    const usageMain = new Gtk.Label({
        xalign: 1,
        selectable: true,
        css_classes: ['dim-label', 'caption'],
    });
    const usageRatio = new Gtk.Label({
        xalign: 1,
        selectable: true,
        visible: false,
        css_classes: ['caption', 'cache-good'],
    });
    const sessionScroll = new Gtk.ScrolledWindow({
        propagate_natural_width: true,
        propagate_natural_height: true,
        max_content_width: 360,
        max_content_height: 420,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    const sessionPopover = new Gtk.Popover({
        child: sessionScroll,
        position: Gtk.PositionType.BOTTOM,
        has_arrow: true,
    });
    const chartButton = new Gtk.Button({
        child: chartGlyph(),
        tooltip_text: 'Session',
        css_classes: ['flat', 'chart-button'],
        visible: false,
    });
    usageBox.append(usageMain);
    usageBox.append(usageRatio);
    usageBox.append(chartButton);
    chartButton.connect('clicked', () => {
        if (sessionPopover.visible) {
            sessionPopover.popdown();
            return;
        }
        fillSessionPopover();
        openPopover(sessionPopover, chartButton);
    });
    const chatFlow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        min_children_per_line: 1,
        max_children_per_line: 2,
        column_spacing: 8,
        row_spacing: 2,
        homogeneous: false,
        activate_on_single_click: false,
        focusable: false,
        hexpand: true,
        css_classes: ['chat-stats'],
    });
    chatFlow.insert(chatButton, -1);
    chatFlow.insert(usageBox, -1);
    const usageChild = chatFlow.get_child_at_index(1);
    usageChild.hexpand = true;
    usageChild.visible = false;
    const accountRow = new Gtk.Box({spacing: 8});
    accountRow.append(modelBox);
    appBar.append(accountRow);
    appBar.append(chatFlow);
    content.append(contextRow);
    content.append(errorBar);
    content.append(appBar);
    content.append(split);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(content);
    const frame = new Gtk.Overlay();
    frame.set_child(toolbar);
    const resizeGrip = new Gtk.Box({
        css_classes: ['panel-resize'],
        can_target: true,
        cursor: Gdk.Cursor.new_from_name(dock === 'right' ? 'w-resize' : 'e-resize', null),
        halign: dock === 'right' ? Gtk.Align.START : Gtk.Align.END,
        valign: Gtk.Align.FILL,
        vexpand: true,
        width_request: 8,
        visible: dock === 'left' || dock === 'right',
    });
    // The window frame edge cannot resize a dock window, so this drag also claims that edge.
    const resizeDrag = new Gtk.GestureDrag({
        button: Gdk.BUTTON_PRIMARY,
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    let resizeStart = 0;
    let resizeWanted = 0;
    resizeDrag.connect('drag-begin', (gesture, x, y) => {
        const [ok, point] = window.compute_point(frame, new Graphene.Point({x, y}));
        const width = frame.get_width();
        const onEdge = ok && (dock === 'right' ? point.x <= 8 : dock === 'left' && point.x >= width - 8);
        if (!onEdge) {
            gesture.set_state(Gtk.EventSequenceState.DENIED);
            return;
        }
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        resizeStart = window.get_width();
        resizeWanted = resizeStart;
    });
    resizeDrag.connect('drag-update', (gesture, offsetX) => {
        if (!gesture.is_active())
            return;
        const delta = dock === 'right' ? -offsetX : offsetX;
        resizeWanted = Math.max(210, Math.round(resizeStart + delta));
        try {
            shell.setWidth(resizeWanted);
        } catch {
            /* The shell applies the width when it is connected. */
        }
    });
    resizeDrag.connect('drag-end', () => {
        if (resizeWanted)
            rememberWidth(resizeWanted);
        resizeWanted = 0;
    });
    window.add_controller(resizeDrag);
    frame.add_overlay(resizeGrip);
    window.set_content(frame);
    syncDockClass();

    function showError(error) {
        errorText.label = error?.message ?? String(error);
        errorBar.visible = true;
    }

    function clearError() {
        errorBar.visible = false;
    }

    function syncModelTip() {
        const item = models[modelBox.selected];
        const text = item?.display_name || 'Model';
        modelBox.tooltip_text = text;
        const button = modelBox.get_first_child();
        if (button)
            button.tooltip_text = text;
    }

    function syncChatTip() {
        const row = chatIndex.chats.find(item => item.id === chatId);
        chatButton.tooltip_text = row?.title || 'Past chats';
    }

    function updateAccount() {
        if (chatgpt.signedIn()) {
            const email = String(chatgpt.email() || '');
            const name = String(chatgpt.name() || '') || 'Signed in';
            menuAccountLabel.label = name;
            menuAccountButton.tooltip_text = email || name;
            accountNameLabel.label = name;
            accountEmailLabel.label = email;
            signInGate.visible = false;
            contextRow.visible = true;
            appBar.visible = true;
            scroller.visible = true;
            entryRow.visible = true;
            modelBox.visible = true;
            accountSep.visible = true;
            menuAccountButton.visible = true;
            accountCard.visible = accountOpen;
        } else {
            accountOpen = false;
            accountCard.visible = false;
            accountSep.visible = false;
            menuAccountButton.visible = false;
            signIn.tooltip_text = 'Sign in';
            signInGate.visible = true;
            contextRow.visible = false;
            appBar.visible = false;
            scroller.visible = false;
            entryRow.visible = false;
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

    function developerText() {
        const parts = [
            standingText(),
            'When terminal_actions_available=true, executable commands must use the bash terminal-action format.',
            'When terminal_actions_available=false, do not generate executable terminal-action blocks.',
            TERMINAL_ACTION_TEXT,
        ];
        if (graphicsInfo && decision(allow, 'graphics') === 'allow')
            parts.push(graphicsInfo);
        if (hostInfo && decision(allow, 'host') === 'allow')
            parts.push(hostInfo);
        return parts.filter(Boolean).join('\n\n');
    }

    function requestFacts(actionsAvailable) {
        let application = 'none';
        if (workingId && workingId !== ASSISTANT_ID)
            application = terminalActionsOn()
                ? 'terminal'
                : (workingTitle || names.get(workingId) || workingId);
        return [
            `application: ${application}`,
            `terminal_actions_available: ${actionsAvailable ? 'true' : 'false'}`,
        ].join('\n');
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
        dataScroll.height_request = Math.max(1, Math.round((height + 10) * 0.9));
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
        const showData = !open && Boolean(term);
        let showShot = false;
        if (!open && image?.png?.length && shotLimits()) {
            const key = `${image.appId}:${image.timestamp}:${image.png.length}`;
            try {
                stripFit.png = image.png;
                if (key !== stripShotKey)
                    stripFit.key = '';
                showShot = applyFitted(shotThumb, stripFit);
                if (showShot)
                    stripShotKey = key;
            } catch {
                showShot = false;
            }
        }
        shotThumb.visible = showShot;
        shotWrap.visible = showShot;
        dataWrap.visible = showData;
        contextScroll.visible = open;
        contextItems.height_request = -1;
        contextShell.visible = true;
        if (showShot) {
            const on = decision(allow, 'screenshot', shotPermitId()) === 'allow';
            shotToggle.active = on;
            paintBadge(shotMark, on);
        }
        if (showData) {
            const on = decision(allow, 'terminal', terminalKey()) === 'allow';
            dataToggle.active = on;
            paintBadge(dataMark, on);
            showDataText(term.text);
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
        showBytes(hostParts.bytes, factsReady && !factsError ? utf8Bytes(hostInfo) : 0);

        packageCheck.sensitive = factsReady && !factsError && Boolean(packageInfo);
        packageCheck.active = decision(allow, 'packages') === 'allow';
        setText(packageNoteLabel, packageNote);
        if (!factsReady)
            setBody(packageBody, 'Package names are still loading.');
        else if (factsError)
            setBody(packageBody, factsError);
        else
            setBody(packageBody, packageInfo);
        showBytes(packageParts.bytes, factsReady && !factsError ? utf8Bytes(packageInfo) : 0);

        graphicsCheck.sensitive = factsReady && !factsError && Boolean(graphicsInfo);
        graphicsCheck.active = decision(allow, 'graphics') === 'allow';
        if (!factsReady)
            setBody(graphicsBody, 'Graphics facts are still loading.');
        else if (factsError)
            setBody(graphicsBody, factsError);
        else
            setBody(graphicsBody, graphicsInfo);
        showBytes(graphicsParts.bytes, factsReady && !factsError ? utf8Bytes(graphicsInfo) : 0);

        const instructionsOn = terminalActionsOn();
        actionCheck.sensitive = instructionsOn;
        actionCheck.active = instructionsOn && decision(allow, 'terminalInstructions') === 'allow';
        actionParts.expander.sensitive = true;
        actionParts.copy.sensitive = true;
        const term = terminalPayload();
        const termShown = term ? `${term.head}\n\n${term.text}` : '';
        termSection.visible = true;
        termCheck.active = decision(allow, 'terminal', terminalKey()) === 'allow';
        setBody(termBody, termShown || 'No terminal text yet.');
        showBytes(actionParts.bytes, utf8Bytes(actionBody.label));
        showBytes(termParts.bytes, utf8Bytes(termShown));
        showBytes(policyTitle.bytes, utf8Bytes(standingText()));

        const image = imageForMessage();
        shotSection.visible = Boolean(image?.png?.length);
        showBytes(shotParts.bytes, image?.png?.length ?? 0);
        if (image?.png?.length) {
            shotCheck.active = decision(allow, 'screenshot', shotPermitId()) === 'allow';
            setText(shotCaption, image.title
                ? `${image.title} at ${image.timestamp ?? ''}`
                : String(image.timestamp ?? ''));
            const key = `${image.appId}:${image.timestamp}:${image.png.length}`;
            if (key !== shotKey) {
                try {
                    panelFit.png = image.png;
                    panelFit.key = '';
                    shotPicture.visible = applyFitted(shotPicture, panelFit);
                    shotKey = key;
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
        if (contextButton.active)
            applyContextView();
        else
            updateSendStrip();
    }

    function revealContext() {
        const keys = pendingAsk();
        for (const key of keys)
            prompted.add(key);
    }

    function collapseContext() {
        policyExpander.expanded = false;
        hostParts.expander.expanded = false;
        packageParts.expander.expanded = false;
        graphicsParts.expander.expanded = false;
        actionParts.expander.expanded = false;
        termParts.expander.expanded = false;
        shotParts.expander.expanded = false;
    }

    function fitContextDetail() {
        if (!contextButton.active)
            return;
        const windowHeight = window.get_height();
        const cap = Math.max(48, Math.floor(windowHeight * 0.5));
        const width = Math.max(contextScroll.get_width(), 1);
        const [, natural] = contextBody.measure(Gtk.Orientation.VERTICAL, width);
        contextScroll.height_request = Math.max(1, Math.min(natural || cap, cap));
    }

    let detailKey = '';
    contextShell.add_tick_callback(() => {
        if (!contextButton.active)
            return GLib.SOURCE_CONTINUE;
        const flags = [
            policyExpander,
            hostParts.expander,
            packageParts.expander,
            graphicsParts.expander,
            actionParts.expander,
            termParts.expander,
            shotParts.expander,
        ].map(item => item.expanded ? '1' : '0').join('');
        const key = `${window.get_height()}:${contextScroll.get_width()}:${flags}`;
        if (key !== detailKey) {
            detailKey = key;
            fitContextDetail();
        }
        return GLib.SOURCE_CONTINUE;
    });

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
            contextName.tooltip_text = 'No app';
            methodLabel.tooltip_text = '';
            setText(contextAge, '');
            contextAge.tooltip_text = '';
            syncRunButtons();
            return;
        }
        setText(contextName, workingTitle || names.get(workingId) || workingId);
        if (nativeOn())
            showMethod('native');
        else if (tmuxContext?.state?.type === 'terminal') {
            showMethod('tmux');
            if (errorText.label === 'Turn on Tap support or tmux for better app integration')
                clearError();
        } else
            showMethod('basic');
        const fullName = `${contextName.label}${methodLabel.visible ? methodLabel.label : ''}`;
        contextName.tooltip_text = fullName;
        methodLabel.tooltip_text = fullName;
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
            contextAge.tooltip_text = '';
        } else {
            const age = (GLib.get_real_time() - stamp) / 1e6;
            setText(contextAge, ageLabel(age));
            contextAge.tooltip_text = contextAge.label;
        }
        syncRunButtons();
    }

    function copyText(text) {
        const bytes = GLib.Bytes.new(new TextEncoder().encode(text));
        const provider = Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes);
        window.get_clipboard().set_content(provider);
    }

    function copyPng(png) {
        const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(png));
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
        window.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(texture));
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

    const runButtons = [];

    function canRun() {
        if (nativeOn())
            return true;
        return Boolean(tmuxContext?.paneId && tmuxContext.state?.type === 'terminal');
    }

    function syncRunButtons() {
        const on = canRun();
        for (const button of runButtons)
            button.sensitive = on;
    }

    function dropRunButtons(root) {
        for (let i = runButtons.length - 1; i >= 0; i -= 1) {
            let node = runButtons[i];
            while (node && node !== root)
                node = node.get_parent();
            if (node === root)
                runButtons.splice(i, 1);
        }
    }

    function addCodeCard(parent, block, commands) {
        const headerRow = new Gtk.Box({spacing: 6});
        headerRow.append(new Gtk.Label({
            label: commands ? 'Command' : 'Code',
            xalign: 0,
            hexpand: true,
            css_classes: ['heading'],
        }));
        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy',
            css_classes: ['flat'],
            valign: Gtk.Align.START,
            sensitive: true,
        });
        headerRow.append(copyButton);
        parent.append(headerRow);
        copyButton.connect('clicked', () => copyText(block));
        if (!commands) {
            const label = new Gtk.Label({
                xalign: 0,
                css_classes: ['monospace', 'md-code'],
            });
            setBody(label, block);
            parent.append(label);
            return;
        }
        const enabled = canRun();
        const units = commandUnits(block);
        for (const unit of units) {
            const view = new Gtk.Label({
                xalign: 0,
                hexpand: true,
                margin_start: 8,
                margin_end: 36,
                margin_top: 8,
                margin_bottom: 8,
                css_classes: ['monospace'],
            });
            setBody(view, unit);
            const run = new Gtk.Button({
                child: new Gtk.Image({
                    icon_name: 'media-playback-start-symbolic',
                    pixel_size: 18,
                }),
                tooltip_text: 'Run',
                css_classes: ['context-gear'],
                halign: Gtk.Align.END,
                valign: Gtk.Align.FILL,
                width_request: 30,
                sensitive: enabled,
            });
            const shell = new Gtk.Overlay({
                hexpand: true,
                child: view,
                css_classes: ['command-shell'],
                overflow: Gtk.Overflow.HIDDEN,
            });
            shell.add_overlay(run);
            parent.append(shell);
            run.connect('clicked', () => runCommand(unit));
            runButtons.push(run);
        }
        if (units.length > 1) {
            const runAll = new Gtk.Button({
                label: 'Run All',
                halign: Gtk.Align.START,
                sensitive: enabled,
            });
            parent.append(runAll);
            runAll.connect('clicked', () => runCommand(block));
            runButtons.push(runAll);
        }
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
                const commands = isTerminalAction(block.lang) || isShellLang(block.lang);
                addCodeCard(parent, block.text, commands);
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

    function clockText(when) {
        let hour = when.get_hour() % 12;
        if (hour === 0)
            hour = 12;
        const minute = String(when.get_minute()).padStart(2, '0');
        const second = String(when.get_second()).padStart(2, '0');
        return `${hour}:${minute}:${second}`;
    }

    function dateStamp(when) {
        const month = String(when.get_month()).padStart(2, '0');
        const day = String(when.get_day_of_month()).padStart(2, '0');
        return `${month}/${day}/${when.get_year()}`;
    }

    function sameDay(left, right) {
        return left.get_year() === right.get_year()
            && left.get_day_of_year() === right.get_day_of_year();
    }

    function sentParts(ms) {
        const when = GLib.DateTime.new_from_unix_local(Math.floor(Number(ms) / 1000));
        if (!when)
            return null;
        const now = GLib.DateTime.new_now_local();
        const yesterday = now.add_days(-1);
        const clock = clockText(when);
        const full = `${dateStamp(when)} ${clock}`;
        let short = full;
        if (sameDay(when, now))
            short = `Today ${clock}`;
        else if (yesterday && sameDay(when, yesterday))
            short = `Yesterday ${clock}`;
        return {short, full};
    }

    function sentView(message) {
        if (!Number.isFinite(message?.sentAt))
            return null;
        if (!message.sentShort) {
            const parts = sentParts(message.sentAt);
            if (!parts)
                return null;
            message.sentShort = parts.short;
            message.sentFull = parts.full;
        }
        return {short: message.sentShort, full: message.sentFull};
    }

    function tokenCountText(count) {
        const number = Math.round(Number(count));
        if (!Number.isFinite(number))
            return '';
        const sign = number < 0 ? '-' : '';
        const value = Math.abs(number);
        if (value < 1000)
            return `${sign}${value}`;
        let scale = 1e3;
        let suffix = 'k';
        if (value >= 1e9) {
            scale = 1e9;
            suffix = 'b';
        } else if (value >= 1e6) {
            scale = 1e6;
            suffix = 'm';
        }
        const scaled = value / scale;
        if (scaled >= 100)
            return `${sign}${Math.floor(scaled)}${suffix}`;
        return `${sign}${(Math.floor(scaled * 10) / 10).toFixed(1)}${suffix}`;
    }

    function ratioText(part, whole) {
        if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0)
            return '0%';
        return `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%`;
    }

    function detailCount(count) {
        const number = Math.round(Number(count));
        if (!Number.isFinite(number))
            return '';
        return number.toLocaleString('en-US');
    }

    function percentNumber(part, whole) {
        if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0)
            return 0;
        return Math.round((part / whole) * 100);
    }

    function percentText(part, whole) {
        return `${percentNumber(part, whole)}%`;
    }

    function durationText(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value) || value < 500)
            return '0 seconds';
        return elapsedLabel(value);
    }

    function usageDetail(input, output, cached) {
        const lines = [];
        if (Number.isFinite(input))
            lines.push(`In ${detailCount(input)}`);
        if (Number.isFinite(output))
            lines.push(`Out ${detailCount(output)}`);
        if (Number.isFinite(cached)) {
            lines.push(`Cached ${detailCount(cached)}`);
            lines.push(`Uncached ${detailCount(Math.max(0, input - cached))}`);
            lines.push(`Cache Ratio ${ratioText(cached, input)}`);
        }
        return lines.join('\n');
    }

    function cacheAccount(message) {
        const input = Number(message?.inputTokens);
        const cached = Number(message?.cachedTokens);
        const writes = Number(message?.cacheWriteTokens);
        if (!Number.isFinite(input) || (!Number.isFinite(cached) && !Number.isFinite(writes)))
            return null;
        const read = Number.isFinite(cached) ? cached : 0;
        const write = Number.isFinite(writes) ? writes : 0;
        return {
            input,
            cached: read,
            writes: write,
            ordinary: Math.max(0, input - read - write),
        };
    }

    function appendCaption(row, text) {
        if (!text)
            return;
        row.append(new Gtk.Label({
            label: text,
            xalign: 0,
            selectable: true,
            css_classes: ['dim-label', 'caption'],
        }));
    }

    function promptCopyText(message) {
        const lines = [];
        const when = sentView(message);
        if (when)
            lines.push(when.full);
        const account = cacheAccount(message);
        const tokens = account
            ? usageDetail(account.input, null, account.cached)
            : usageDetail(message.inputTokens, null, null);
        if (tokens)
            lines.push(tokens);
        lines.push(message.text ?? '');
        return lines.join('\n');
    }

    function addMessageView(message) {
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            css_classes: [message.role === 'user' ? 'user-message' : 'assistant-message'],
        });
        const titleRow = new Gtk.Box({spacing: 8});
        if (message.role === 'assistant') {
            titleRow.append(new Gtk.Label({
                label: 'AI',
                xalign: 0,
                css_classes: ['heading'],
            }));
            if (Number.isFinite(message.elapsedMs))
                appendCaption(titleRow, elapsedLabel(message.elapsedMs));
            if (Number.isFinite(message.outputTokens))
                appendCaption(titleRow, `Out ${detailCount(message.outputTokens)}`);
            wrap.append(titleRow);
            addMarkdown(wrap, message.text);
        } else {
            const account = cacheAccount(message);
            const when = sentView(message);
            let dateLabel = null;
            if (when) {
                dateLabel = new Gtk.Label({
                    label: when.short,
                    tooltip_text: when.full,
                    xalign: 0,
                    selectable: true,
                    css_classes: ['dim-label', 'caption'],
                });
            }
            const tokenLabel = account ? cacheChip(message, when) : null;
            const copyPrompt = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: 'Copy',
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            copyPrompt.connect('clicked', () => copyText(promptCopyText(message)));
            titleRow.append(new PromptHead(dateLabel, tokenLabel, copyPrompt));
            wrap.append(titleRow);
            wrap.append(new Gtk.Label({xalign: 0}));
            setBody(wrap.get_last_child(), message.text);
        }
        return wrap;
    }

    function messageChild(index) {
        let child = messageBox.get_first_child();
        for (let i = 0; child && i < index; i += 1)
            child = child.get_next_sibling();
        return child;
    }

    function appendMessage(message) {
        messageBox.append(addMessageView(message));
    }

    function replaceMessage(index) {
        const message = messages[index];
        if (!message)
            return;
        const old = messageChild(index);
        const prev = old ? old.get_prev_sibling() : null;
        if (old) {
            dropRunButtons(old);
            messageBox.remove(old);
        }
        const wrap = addMessageView(message);
        if (prev || messageBox.get_first_child())
            messageBox.insert_child_after(wrap, prev);
        else
            messageBox.append(wrap);
    }

    function popMessageView() {
        const last = messageBox.get_last_child();
        if (!last)
            return;
        dropRunButtons(last);
        messageBox.remove(last);
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

    let streamPaint = 0;

    function stopStreamPaint() {
        if (!streamPaint)
            return;
        GLib.source_remove(streamPaint);
        streamPaint = 0;
    }

    function queueStreamPaint() {
        if (streamPaint)
            return;
        streamPaint = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            streamPaint = 0;
            replaceMessage(messages.length - 1);
            showChatUsage();
            schedulePlace();
            return GLib.SOURCE_REMOVE;
        });
    }

    function redrawMessages() {
        stopStreamPaint();
        if (!followBottom)
            savedValue = chatAdj.value;
        placing = true;
        runButtons.length = 0;
        let child = messageBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            messageBox.remove(child);
            child = next;
        }
        for (const message of messages)
            appendMessage(message);
        placing = false;
        showChatUsage();
        schedulePlace();
    }

    function replyAfter(message) {
        const index = messages.indexOf(message);
        const next = index >= 0 ? messages[index + 1] : null;
        return next && next.role === 'assistant' ? next : null;
    }

    function cacheTrack(cached, input) {
        const whole = Number(input);
        const part = Number(cached);
        const fraction = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
        return new Gtk.ProgressBar({
            fraction,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['cache-bar'],
        });
    }

    function statRow(name, value) {
        const row = new Gtk.Box({spacing: 12});
        row.append(new Gtk.Label({
            label: name,
            xalign: 0,
            hexpand: true,
            css_classes: ['dim-label'],
        }));
        row.append(new Gtk.Label({
            label: String(value),
            xalign: 1,
            selectable: true,
        }));
        return row;
    }

    function cacheChip(message, when) {
        const account = cacheAccount(message);
        if (!account)
            return null;
        const good = percentNumber(account.cached, account.input) >= 80;
        const box = new Gtk.Box({spacing: 4});
        if (good) {
            box.append(new Gtk.Image({
                icon_name: 'object-select-symbolic',
                css_classes: ['cache-good'],
            }));
        }
        box.append(new Gtk.Label({
            label: `${percentText(account.cached, account.input)} cached`,
            css_classes: good ? ['caption', 'cache-good'] : ['caption', 'dim-label'],
        }));
        const popover = new Gtk.Popover({
            position: Gtk.PositionType.BOTTOM,
            has_arrow: true,
        });
        const button = new Gtk.Button({
            child: box,
            css_classes: ['flat', 'cache-chip'],
            hexpand: false,
            halign: Gtk.Align.START,
        });
        button.connect('clicked', () => {
            if (popover.visible) {
                popover.popdown();
                return;
            }
            popover.set_child(promptStats(message, when));
            openPopover(popover, button);
        });
        button.connect('unrealize', () => {
            popover.popdown();
            if (popover.get_parent())
                popover.unparent();
        });
        return button;
    }

    function openPopover(popover, widget) {
        if (popover.get_parent() !== window)
            popover.set_parent(window);
        const found = widget.compute_bounds(window);
        const bounds = found?.[1];
        if (found?.[0] && bounds) {
            const x = typeof bounds.get_x === 'function' ? bounds.get_x() : bounds.x;
            const y = typeof bounds.get_y === 'function' ? bounds.get_y() : bounds.y;
            const width = typeof bounds.get_width === 'function' ? bounds.get_width() : bounds.width;
            const height = typeof bounds.get_height === 'function' ? bounds.get_height() : bounds.height;
            popover.set_pointing_to(new Gdk.Rectangle({
                x: Math.round(x),
                y: Math.round(y),
                width: Math.max(1, Math.round(width)),
                height: Math.max(1, Math.round(height)),
            }));
        }
        popover.position = Gtk.PositionType.BOTTOM;
        popover.popup();
    }

    function promptStats(message, when) {
        const account = cacheAccount(message);
        const input = account ? account.input : Number(message.inputTokens);
        const cached = account ? account.cached : 0;
        const reply = replyAfter(message);
        const output = Number(reply?.outputTokens);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            width_request: 240,
        });
        box.append(new Gtk.Label({
            label: when ? when.short : '',
            tooltip_text: when ? when.full : '',
            xalign: 0,
            css_classes: ['dim-label'],
        }));
        box.append(new Gtk.Label({
            label: `${ratioText(cached, input)} input cached`,
            xalign: 0,
            css_classes: ['title-2', 'cache-good'],
        }));
        box.append(cacheTrack(cached, input));
        box.append(statRow('Input', detailCount(input)));
        box.append(statRow('Cached', detailCount(cached)));
        box.append(statRow('Uncached', detailCount(Math.max(0, input - cached))));
        box.append(statRow('Output', Number.isFinite(output) ? detailCount(output) : '0'));
        box.append(statRow('Thinking', durationText(reply?.elapsedMs)));
        return box;
    }

    function chatTotals() {
        let input = 0;
        let output = 0;
        let cached = 0;
        let thinking = 0;
        let any = false;
        let hasCache = false;
        for (const message of messages) {
            if (message.role === 'user' && Number.isFinite(message.inputTokens)) {
                input += message.inputTokens;
                any = true;
                const account = cacheAccount(message);
                if (account) {
                    hasCache = true;
                    cached += account.cached;
                }
            } else if (message.role === 'assistant') {
                if (Number.isFinite(message.outputTokens)) {
                    output += message.outputTokens;
                    any = true;
                }
                if (Number.isFinite(message.elapsedMs))
                    thinking += message.elapsedMs;
            }
        }
        return {input, output, cached, thinking, any, hasCache};
    }

    function sessionLength() {
        let start = 0;
        let end = 0;
        for (let i = 0; i < messages.length; i += 1) {
            const message = messages[i];
            if (message.role !== 'user' || !Number.isFinite(message.sentAt))
                continue;
            if (!start)
                start = message.sentAt;
            const reply = messages[i + 1];
            const replyEnd = reply && reply.role === 'assistant' && Number.isFinite(reply.elapsedMs)
                ? message.sentAt + reply.elapsedMs
                : message.sentAt;
            if (replyEnd > end)
                end = replyEnd;
        }
        return end > start ? end - start : 0;
    }

    function fillSessionPopover() {
        const totals = chatTotals();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            width_request: 300,
        });
        box.append(new Gtk.Label({
            label: 'Session',
            xalign: 0,
            css_classes: ['heading'],
        }));
        box.append(new Gtk.Label({
            label: `${ratioText(totals.cached, totals.input)} input cached`,
            xalign: 0,
            css_classes: ['title-2', 'cache-good'],
        }));
        box.append(cacheTrack(totals.cached, totals.input));
        box.append(statRow('Input', detailCount(totals.input)));
        box.append(statRow('Cached', detailCount(totals.cached)));
        box.append(statRow('Uncached', detailCount(Math.max(0, totals.input - totals.cached))));
        box.append(statRow('Output', detailCount(totals.output)));
        box.append(statRow('Cache ratio', ratioText(totals.cached, totals.input)));
        box.append(statRow('Thinking', durationText(totals.thinking)));
        box.append(statRow('Session', durationText(sessionLength())));
        for (const message of messages) {
            if (message.role !== 'user' || !Number.isFinite(message.inputTokens))
                continue;
            const account = cacheAccount(message);
            const input = account ? account.input : message.inputTokens;
            const cached = account ? account.cached : 0;
            const when = sentView(message);
            const row = new Gtk.Box({spacing: 8});
            row.append(new Gtk.Label({
                label: when ? when.short : '',
                tooltip_text: when ? when.full : '',
                xalign: 0,
                css_classes: ['caption', 'dim-label'],
            }));
            row.append(cacheTrack(cached, input));
            row.append(new Gtk.Label({
                label: percentText(cached, input),
                xalign: 1,
                css_classes: ['caption'],
            }));
            box.append(row);
        }
        sessionScroll.child = box;
    }

    function showChatUsage() {
        const totals = chatTotals();
        if (!totals.any) {
            usageMain.label = '';
            usageMain.tooltip_text = '';
            usageRatio.label = '';
            usageRatio.tooltip_text = '';
            usageRatio.visible = false;
            usageBox.tooltip_text = '';
            usageBox.visible = false;
            chartButton.visible = false;
            usageChild.visible = false;
            return;
        }
        const tip = usageDetail(totals.input, totals.output, totals.hasCache ? totals.cached : null);
        usageMain.label = `${tokenCountText(totals.input)} in · ${tokenCountText(totals.output)} out`;
        usageMain.tooltip_text = tip;
        usageBox.tooltip_text = tip;
        usageRatio.visible = totals.hasCache;
        if (totals.hasCache) {
            usageRatio.label = `${percentText(totals.cached, totals.input)} cached`;
            usageRatio.tooltip_text = tip;
        }
        usageBox.visible = true;
        chartButton.visible = true;
        usageChild.visible = true;
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
        workingId = appId;
        workingTitle = names.get(appId) || appId;
        touchData(appId);
        refreshTmux();
        const tmuxOn = tmuxContext?.state?.type === 'terminal';
        if (!tmuxOn && clients.isSupported(appId) && !clients.isActive(appId)
            && !clients.contextFor(appId)?.text?.trim?.())
            showError('Turn on Tap support or tmux for better app integration');
        else if (errorText.label === 'Turn on Tap support or tmux for better app integration')
            clearError();
    }

    function liveApps(windows) {
        return windows.filter(item =>
            item.appId && item.appId !== ASSISTANT_ID && item.appId !== DESKTOP_ID);
    }

    function useDesktop() {
        const current = shots.get(DESKTOP_ID);
        const shot = shell.getCapture(DESKTOP_ID);
        if (shot?.png?.length && shot.timestamp !== current?.timestamp)
            rememberShot(DESKTOP_ID, shot);
        if (workingId !== DESKTOP_ID)
            adopt(DESKTOP_ID);
    }

    function seedContext(windows) {
        if (workingId || shell.missing())
            return;
        if (liveApps(windows).length === 0) {
            useDesktop();
            return;
        }
        const focused = windows.find(item =>
            item.focused && item.appId && item.appId !== ASSISTANT_ID && item.appId !== DESKTOP_ID);
        if (focused) {
            rememberShot(
                focused.appId,
                shell.captureNow(focused.appId) || shell.getCapture(focused.appId));
            adopt(focused.appId);
            return;
        }
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
        if (windows && liveApps(windows).length === 0)
            useDesktop();
        else if (windows && workingId && !windows.some(item => item.appId === workingId))
            workingId = '';
        if (windows)
            seedContext(windows);
        syncPlacement();
        updateContextRow();
        refreshContext();
    }

    function syncPlacement() {
        if (startupDock)
            return;
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
        if (!shell.available())
            return;
        try {
            shell.setPlacement(dock, above);
            startupDock = false;
        } catch (error) {
            showError(error);
        }
    }

    function syncShellControls() {
        const up = shell.available();
        dockBox.sensitive = up;
        aboveRow.sensitive = up;
        const tip = up ? null : 'Needs the Context Tap shell extension';
        dockBox.tooltip_text = tip;
        aboveRow.tooltip_text = tip;
        if (up || startupDock || (dock === 'off' && !above))
            return;
        dock = 'off';
        above = false;
        showPlacement();
        window.set_default_size(shownWidth(), LAUNCH_HEIGHT);
    }

    shell.onReady = () => {
        syncShellControls();
        restorePlacement();
        refreshState();
    };

    shell.onFocus = (appId, title, previous) => {
        clients.releaseCapture();
        clients.refresh();
        readWindows();
        const contextId = appId === ASSISTANT_ID ? previous : appId;
        if (contextId && contextId !== ASSISTANT_ID) {
            const shot = contextId === DESKTOP_ID
                ? shell.getCapture(contextId)
                : (shell.captureNow(contextId) || shell.getCapture(contextId));
            rememberShot(contextId, shot);
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

    function syncDockClass() {
        const docked = dock === 'left' || dock === 'right';
        if (docked)
            window.add_css_class('docked');
        else
            window.remove_css_class('docked');
        resizeGrip.visible = docked;
        resizeGrip.halign = dock === 'right' ? Gtk.Align.START : Gtk.Align.END;
        resizeGrip.cursor = Gdk.Cursor.new_from_name(dock === 'right' ? 'w-resize' : 'e-resize', null);
    }

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
        syncDockClass();
    }

    function restorePlacement() {
        if (startupDock) {
            showPlacement();
            queuePlacement();
            return;
        }
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

    function placeAfterMenu() {
        const place = () => {
            if (dock === 'off')
                window.set_default_size(shownWidth(), LAUNCH_HEIGHT);
            applyPlacement();
        };
        if (!menuPopover.get_visible()) {
            place();
            return;
        }
        const closed = menuPopover.connect('closed', () => {
            menuPopover.disconnect(closed);
            place();
        });
        menuPopover.popdown();
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
            syncDockClass();
            placeAfterMenu();
        });
    }

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
        showBytes(policyTitle.bytes, utf8Bytes(standingText()));
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
            persistLayout();
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
        const live = Math.round(window.get_width());
        if (contextButton.active) {
            if (live > 1) {
                windowWidth = live;
                widthSet = true;
            }
            contextOpen = true;
            persistLayout();
            applyAppWidth(contextWidth);
            collapseContext();
            applyContextView();
            fitContextDetail();
        } else {
            const restore = windowWidth > 1 ? windowWidth : live;
            if (live > 1)
                contextWidth = live;
            ignoreWidth = true;
            contextOpen = false;
            persistLayout();
            updateSendStrip();
            applyAppWidth(restore);
        }
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

    function signOut() {
        chatgpt.signOut();
        models = [];
        model = '';
        updateAccount();
        clearError();
    }

    menuAccountButton.connect('clicked', () => {
        accountOpen = !accountOpen;
        updateAccount();
    });
    signIn.connect('clicked', () => {
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
            syncModelTip();
            if (!messages.length)
                loadOpenChat();
        }).catch(showError).finally(() => {
            signIn.sensitive = true;
            updateAccount();
        });
    });
    signOutButton.connect('clicked', () => {
        menuPopover.popdown();
        signOut();
    });
    modelBox.connect('notify::selected', () => {
        const item = models[modelBox.selected];
        if (item)
            model = item.slug;
        syncModelTip();
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
        syncChatTip();
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
        const newChat = new Gtk.Button({css_classes: ['flat']});
        const newChatBox = new Gtk.Box({spacing: 8});
        newChatBox.append(new Gtk.Label({
            label: 'New Chat',
            xalign: 0,
            hexpand: true,
        }));
        newChat.child = newChatBox;
        newChat.connect('clicked', () => {
            chatPopover.popdown();
            startNewChat().catch(showError);
        });
        chatList.append(newChat);
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
        chatList.append(new Gtk.Separator());
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
            row.tooltip_text = chat.title;
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
        cacheKey = GLib.uuid_string_random();
        chatId = id;
        storedPairs = countPairs(messages);
        historyReady = true;
        chatIndex.openId = id;
        saveChats(chatIndex);
        followBottom = true;
        redrawMessages();
        syncChatTip();
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
        cacheKey = GLib.uuid_string_random();
        storedPairs = 0;
        historyReady = true;
        chatIndex.openId = '';
        if (!stored)
            chatIndex.skipLegacy = true;
        saveChats(chatIndex);
        clearCaptures();
        followBottom = true;
        redrawMessages();
        chatPopover.popdown();
        syncChatTip();
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
        persistLayout();
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
        if (contextButton.active && pendingAsk().length) {
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
        appendMessage(messages[messages.length - 2]);
        appendMessage(messages[messages.length - 1]);
        showChatUsage();
        schedulePlace();
        const actionsAvailable = terminalActionsOn()
            && decision(allow, 'terminalInstructions') === 'allow';
        const context = [];
        if (sendPackages)
            context.push(`User-installed packages:\n${packageInfo}`);
        let prompt = [text, ...context].filter(Boolean).join('\n\n');
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
        parts[0].text += `\n\n${requestFacts(actionsAvailable)}`;
        messages[messages.length - 2].sentText = parts[0].text;
        const input = [{role: 'developer', content: developerText()}];
        for (const message of messages.slice(0, -2)) {
            const text = message.role === 'user' ? (message.sentText || message.text) : message.text;
            input.push({role: message.role, content: text});
        }
        input.push({role: 'user', content: parts});
        try {
            const result = await chatgpt.streamReply({
                model,
                input,
                cacheKey,
                onDelta: partial => {
                    messages[messages.length - 1].text = partial;
                    queueStreamPaint();
                },
            });
            const reply = result.text;
            if (result.usage) {
                const sent = messages[messages.length - 2];
                sent.inputTokens = result.usage.input;
                if (result.usage.cached != null)
                    sent.cachedTokens = result.usage.cached;
                if (result.usage.cacheWrite != null)
                    sent.cacheWriteTokens = result.usage.cacheWrite;
                messages[messages.length - 1].outputTokens = result.usage.output;
            }
            messages[messages.length - 1].text = reply;
            messages[messages.length - 1].elapsedMs = Date.now() - sentAt;
            stopStreamPaint();
            replaceMessage(messages.length - 2);
            replaceMessage(messages.length - 1);
            showChatUsage();
            schedulePlace();
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
            refreshContext();
        } catch (error) {
            messages.pop();
            messages.pop();
            popMessageView();
            popMessageView();
            showChatUsage();
            schedulePlace();
            const [boxStart, boxEnd] = buffer.get_bounds();
            if (!buffer.get_text(boxStart, boxEnd, false).trim())
                buffer.set_text(text, -1);
            entry.grab_focus();
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
    submitSwitch.connect('notify::active', () => {
        submitCtrl = submitSwitch.active;
        persistLayout();
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
    menuPopover.connect('show', () => {
        syncPlacement();
        let frames = 0;
        menuPopover.add_tick_callback(() => {
            frames += 1;
            for (const [, button] of dockButtons)
                button.unset_state_flags(Gtk.StateFlags.ACTIVE | Gtk.StateFlags.PRELIGHT);
            return frames < 2 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    });
    entry.buffer.connect('changed', () => {
        const [start, end] = entry.buffer.get_bounds();
        entryHint.visible = entry.buffer.get_text(start, end, false).length === 0;
        fitEntry();
    });
    const key = new Gtk.EventControllerKey();
    key.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter)
            return false;
        const shift = state & Gdk.ModifierType.SHIFT_MASK;
        const ctrl = state & Gdk.ModifierType.CONTROL_MASK;
        const sendNow = submitCtrl ? ctrl && !shift : !shift;
        if (!sendNow)
            return false;
        sendMessage().catch(showError);
        return true;
    });
    entry.add_controller(key);
    window.connect('notify::is-active', () => {
        if (window.is_active && !window.get_focus())
            entry.grab_focus();
    });

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
        if (applyWidthTimer)
            GLib.source_remove(applyWidthTimer);
        const liveWidth = window.get_width();
        if (liveWidth > 1) {
            if (contextOpen)
                contextWidth = liveWidth;
            else if (widthSet)
                windowWidth = liveWidth;
        }
        persistLayout();
        if (placeIdle)
            GLib.source_remove(placeIdle);
        if (placementIdle)
            GLib.source_remove(placementIdle);
        if (dataScrollIdle)
            GLib.source_remove(dataScrollIdle);
        stopStreamPaint();
        stopPlaceTick();
        shell.close();
        application.quit();
        return false;
    });
    function rememberWidth(width) {
        const next = Math.round(Number(width));
        if (!acceptWidth || ignoreWidth || next < 1)
            return;
        if (contextOpen) {
            if (next === contextWidth)
                return;
            contextWidth = next;
        } else {
            if (next === windowWidth)
                return;
            windowWidth = next;
            widthSet = true;
        }
        if (widthSave)
            GLib.source_remove(widthSave);
        widthSave = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            widthSave = 0;
            persistLayout();
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
            syncModelTip();
        }).catch(showError);
    }
    syncChatTip();
    persistLayout();
    window.present();
}
