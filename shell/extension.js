import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ASSISTANT = 'org.contexttap.ContextTap';
const LAUNCH_HEIGHT = 760;
const BUS_NAME = 'org.contexttap.ContextTap.Shell';
const OBJECT_PATH = '/org/contexttap/ContextTap/Shell';
const IFACE = 'org.contexttap.ContextTap.Shell1';

const XML = `
<node>
  <interface name="${IFACE}">
    <method name="ListWindows">
      <arg type="a(sssbu)" name="windows" direction="out"/>
    </method>
    <method name="GetCapture">
      <arg type="s" name="app_id" direction="in"/>
      <arg type="ay" name="png" direction="out"/>
      <arg type="s" name="title" direction="out"/>
      <arg type="x" name="timestamp_us" direction="out"/>
    </method>
    <method name="CaptureNow">
      <arg type="s" name="app_id" direction="in"/>
      <arg type="ay" name="png" direction="out"/>
      <arg type="s" name="title" direction="out"/>
      <arg type="x" name="timestamp_us" direction="out"/>
    </method>
    <method name="SetPlacement">
      <arg type="s" name="mode" direction="in"/>
      <arg type="b" name="above" direction="in"/>
    </method>
    <method name="GetPlacement">
      <arg type="s" name="mode" direction="out"/>
      <arg type="b" name="above" direction="out"/>
    </method>
    <method name="FocusApp">
      <arg type="s" name="app_id" direction="in"/>
    </method>
    <method name="SetWidth">
      <arg type="i" name="width" direction="in"/>
    </method>
    <method name="FocusSelf"/>
    <signal name="FocusChanged">
      <arg type="s" name="app_id"/>
      <arg type="s" name="title"/>
      <arg type="s" name="previous_app_id"/>
    </signal>
  </interface>
</node>`;

function gtkApplicationId(metaWindow) {
    try {
        if (metaWindow.get_gtk_application_id)
            return metaWindow.get_gtk_application_id() || '';
    } catch {
        /* This Mutter build has no GTK application id. */
    }
    return '';
}

function dottedId(value) {
    const text = String(value ?? '');
    return text.includes('.') ? text : '';
}

function placementMode(mode) {
    return mode === 'left' || mode === 'right' ? mode : 'off';
}

function storedWidth() {
    try {
        const path = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'context-tap', 'layout.json']);
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (data.contextOpen === true) {
            const settingsWidth = Math.round(Number(data.contextWidth));
            if (settingsWidth >= 1)
                return settingsWidth;
        }
        const width = Math.round(Number(data.width));
        return width >= 1 ? width : 0;
    } catch {
        return 0;
    }
}

function chosenWidth(win, area) {
    const saved = storedWidth();
    const current = win.get_frame_rect()?.width || 0;
    const width = saved || current || 210;
    return Math.min(Math.max(width, 210), Math.max(210, area.width));
}

function placementFile() {
    const dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return Gio.File.new_for_path(GLib.build_filenamev([dir, 'placement.json']));
}

function loadPlacement() {
    try {
        const [, bytes] = placementFile().load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return {mode: placementMode(data.mode), above: data.above === true};
    } catch {
        return {mode: 'off', above: false};
    }
}

function savePlacement(mode, above) {
    try {
        placementFile().replace_contents(
            new TextEncoder().encode(JSON.stringify({
                mode: placementMode(mode),
                above: above === true,
            })),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null);
    } catch (error) {
        console.error(`Context Tap could not store placement: ${error}`);
    }
}

export default class GnomeAiAssistantExtension extends Extension {
    enable() {
        this._shots = new Map();
        this._shotBusy = false;
        const saved = loadPlacement();
        this._mode = saved.mode;
        this._above = saved.above;
        this._freeOrigin = null;
        this._placeIdle = 0;
        this._placeTries = 0;
        this._current = global.display.focus_window;
        this._framed = new Set();
        this._frameIds = new Map();
        this._framePending = new Set();
        for (const actor of global.get_window_actors())
            this._framed.add(actor);
        console.error('Context Tap extension ready');
        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            connection => this._export(connection),
            null,
            null);
        this._focusId = global.display.connect('notify::focus-window', () => this._onFocus());
        this._createdId = global.display.connect('window-created', (_display, win) => {
            if (this._isAssistant(win))
                this._schedulePlacement();
            this._armFirstFrame(win);
        });
        this._grabId = global.display.connect('grab-op-end', (_display, win) => {
            if (this._isAssistant(win))
                this._releaseIfMoved(win, true);
        });
        this._schedulePlacement();
        if (!Main.layoutManager._startingUp)
            this._launchAssistant();
    }

    _launchAssistant() {
        try {
            const [owned] = Gio.DBus.session.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'NameHasOwner',
                new GLib.Variant('(s)', [ASSISTANT]),
                new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null).deepUnpack();
            if (owned)
                return;
            Shell.AppSystem.get_default().lookup_app(`${ASSISTANT}.desktop`)?.activate();
        } catch (error) {
            console.error(`Context Tap could not start the app: ${error}`);
        }
    }

    disable() {
        this._cancelRaiseCapture();
        if (this._frameIds) {
            for (const [actor, id] of this._frameIds) {
                try {
                    actor.disconnect(id);
                } catch {
                    /* The actor is already gone. */
                }
            }
            this._frameIds.clear();
        }
        if (this._focusId)
            global.display.disconnect(this._focusId);
        if (this._createdId)
            global.display.disconnect(this._createdId);
        if (this._grabId)
            global.display.disconnect(this._grabId);
        this._focusId = this._createdId = this._grabId = 0;
        if (this._placeIdle) {
            GLib.source_remove(this._placeIdle);
            this._placeIdle = 0;
        }
        if (this._holdIdle) {
            GLib.source_remove(this._holdIdle);
            this._holdIdle = 0;
        }
        if (this._pinIdle) {
            GLib.source_remove(this._pinIdle);
            this._pinIdle = 0;
        }
        if (this._positionId && this._watched) {
            this._watched.disconnect(this._positionId);
            this._positionId = 0;
            this._watched = null;
        }
        try {
            for (const win of this._assistantWindows())
                win.show_in_window_list();
        } catch {
            /* The window list is already gone. */
        }
        this._clearStrut();
        if (this._registration)
            this._connection.unregister_object(this._registration);
        this._registration = 0;
        if (this._nameId)
            Gio.bus_unown_name(this._nameId);
        this._nameId = 0;
        this._shots = null;
        this._connection = null;
    }

    _export(connection) {
        this._connection = connection;
        const node = Gio.DBusNodeInfo.new_for_xml(XML);
        this._registration = connection.register_object(
            OBJECT_PATH,
            node.lookup_interface(IFACE),
            this._call.bind(this),
            null,
            null);
    }

    _callerAllowed(sender) {
        try {
            const owner = Gio.DBus.session.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'GetNameOwner',
                new GLib.Variant('(s)', [ASSISTANT]),
                new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null).deepUnpack()[0];
            return owner === sender;
        } catch {
            return false;
        }
    }

    _call(connection, sender, path, iface, method, params, invocation) {
        if (!this._callerAllowed(sender)) {
            invocation.return_error_literal(
                'org.freedesktop.DBus.Error.AccessDenied',
                'Only Context Tap can call this interface.');
            return;
        }
        try {
            if (method === 'ListWindows') {
                invocation.return_value(new GLib.Variant('(a(sssbu))', [this._windowRows()]));
            } else if (method === 'GetCapture') {
                invocation.return_value(this._captureVariant(params.deepUnpack()[0], false));
            } else if (method === 'CaptureNow') {
                invocation.return_value(this._captureVariant(params.deepUnpack()[0], true));
            } else if (method === 'SetPlacement') {
                const [mode, above] = params.deepUnpack();
                const nextMode = placementMode(mode);
                const wasDocked = this._mode === 'left' || this._mode === 'right';
                this._mode = nextMode;
                this._above = above === true;
                savePlacement(this._mode, this._above);
                const restoreSize = wasDocked && nextMode === 'off';
                this._applyPlacement(restoreSize);
                invocation.return_value(new GLib.Variant('()', []));
            } else if (method === 'GetPlacement') {
                invocation.return_value(new GLib.Variant('(sb)', [this._mode, this._above]));
            } else if (method === 'FocusApp') {
                this._focusApp(params.deepUnpack()[0]);
                invocation.return_value(new GLib.Variant('()', []));
            } else if (method === 'SetWidth') {
                this._setWidth(params.deepUnpack()[0]);
                invocation.return_value(new GLib.Variant('()', []));
            } else if (method === 'FocusSelf') {
                this._focusSelf();
                invocation.return_value(new GLib.Variant('()', []));
            } else {
                invocation.return_error_literal(
                    'org.freedesktop.DBus.Error.UnknownMethod', method);
            }
        } catch (error) {
            invocation.return_error_literal(
                'org.contexttap.ContextTap.Error',
                error?.message ?? String(error));
        }
    }

    _focusApp(appId) {
        if (!appId)
            return;
        for (const win of this._windows()) {
            const info = this._describe(win);
            if (info.appId === appId || info.name === appId) {
                win.activate(global.get_current_time());
                return;
            }
        }
    }

    _windowPid(win) {
        try {
            return win.get_pid?.() || 0;
        } catch {
            return 0;
        }
    }

    _windowRows() {
        const rows = new Map();
        for (const win of this._windows()) {
            const info = this._describe(win);
            if (!info.appId)
                continue;
            const focused = win === global.display.focus_window;
            const pid = this._windowPid(win);
            const previous = rows.get(info.appId);
            if (!previous) {
                rows.set(info.appId, [
                    info.appId,
                    info.name,
                    info.title,
                    focused,
                    pid,
                ]);
                continue;
            }
            if (!focused)
                continue;
            previous[1] = info.name;
            previous[2] = info.title;
            previous[3] = true;
            if (pid)
                previous[4] = pid;
        }
        return [...rows.values()];
    }

    _windows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(win => win && !win.is_skip_taskbar());
    }

    _isAssistant(win) {
        if (!win)
            return false;
        const type = win.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DOCK)
            return false;
        return this._describe(win).appId === ASSISTANT;
    }

    _assistantWindows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(win => this._isAssistant(win));
    }

    _syncTaskbar(win) {
        const panel = this._mode === 'left' || this._mode === 'right';
        try {
            if (panel)
                win.hide_from_window_list();
            else
                win.show_in_window_list();
        } catch (error) {
            console.error(`Context Tap could not update the task bar: ${error}`);
        }
        if (!panel)
            return;
        try {
            const settings = new Gio.Settings({schema: 'org.gnome.shell'});
            const id = `${ASSISTANT}.desktop`;
            const favorites = settings.get_strv('favorite-apps');
            if (favorites.includes(id))
                settings.set_strv('favorite-apps', favorites.filter(item => item !== id));
        } catch (error) {
            console.error(`Context Tap could not leave the dash: ${error}`);
        }
    }

    _describe(metaWindow) {
        if (!metaWindow)
            return {appId: '', name: '', title: ''};
        const app = Shell.WindowTracker.get_default().get_window_app(metaWindow);
        const shellId = app?.get_id()?.replace(/\.desktop$/, '') ?? '';
        const gtkId = gtkApplicationId(metaWindow);
        const wmClass = metaWindow.get_wm_class?.() ?? '';
        let appId = shellId;
        if (!appId || appId.startsWith('window:'))
            appId = gtkId || dottedId(wmClass) || shellId || wmClass;
        const name = app?.get_name() || appId || wmClass || '';
        return {
            appId,
            name,
            title: metaWindow.get_title() ?? '',
        };
    }

    _onFocus() {
        const next = global.display.focus_window;
        const prev = this._current;
        this._current = next;
        const nextId = this._describe(next).appId;
        const target = nextId === ASSISTANT ? prev : next;
        const finish = () => this._emitFocus(next, prev);
        if (!target) {
            finish();
            return;
        }
        this._captureAfterRaise(target, finish);
    }

    _overlaps(a, b) {
        return a.x < b.x + b.width
            && a.x + a.width > b.x
            && a.y < b.y + b.height
            && a.y + a.height > b.y;
    }

    _isOnTop(metaWindow) {
        const target = metaWindow?.get_frame_rect?.();
        if (!target || target.width < 1 || target.height < 1)
            return false;
        const actors = global.get_window_actors();
        for (let i = actors.length - 1; i >= 0; i--) {
            const actor = actors[i];
            const win = actor.meta_window;
            if (!win || win.minimized)
                continue;
            if (win.showing_on_its_workspace && !win.showing_on_its_workspace())
                continue;
            if (this._describe(win).appId === ASSISTANT)
                continue;
            if (actor.visible === false)
                continue;
            const rect = win.get_frame_rect();
            if (!rect || !this._overlaps(target, rect))
                continue;
            return win === metaWindow;
        }
        return false;
    }

    _armFirstFrame(metaWindow) {
        const actor = metaWindow?.get_compositor_private?.();
        if (!actor) {
            if (!this._framePending)
                this._framePending = new Set();
            if (this._framePending.has(metaWindow))
                return;
            this._framePending.add(metaWindow);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._framePending.delete(metaWindow);
                this._armFirstFrame(metaWindow);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (this._framed.has(actor) || this._frameIds.has(actor))
            return;
        let id = 0;
        try {
            id = actor.connect('first-frame', () => {
                if (this._frameIds.get(actor) === id)
                    this._frameIds.delete(actor);
                try {
                    actor.disconnect(id);
                } catch {
                    /* Already disconnected. */
                }
                this._framed.add(actor);
                if (this._raiseCapture?.window === metaWindow)
                    this._raiseCapture.consider();
            });
        } catch (error) {
            console.error(`Context Tap could not watch the first frame: ${error}`);
            this._framed.add(actor);
            return;
        }
        this._frameIds.set(actor, id);
    }

    _hasFrame(metaWindow) {
        const actor = metaWindow?.get_compositor_private?.();
        return Boolean(actor && this._framed.has(actor));
    }

    _cancelRaiseCapture() {
        this._raiseCapture?.cleanup();
        this._raiseCapture = null;
    }

    _captureAfterRaise(metaWindow, done) {
        this._shotEpoch = (this._shotEpoch || 0) + 1;
        this._cancelRaiseCapture();
        let finished = false;
        let restackId = 0;
        let paintId = 0;
        let timerId = 0;
        let idleId = 0;
        const cleanup = () => {
            if (restackId) {
                global.display.disconnect(restackId);
                restackId = 0;
            }
            if (paintId) {
                global.stage.disconnect(paintId);
                paintId = 0;
            }
            if (timerId) {
                GLib.source_remove(timerId);
                timerId = 0;
            }
            if (idleId) {
                GLib.source_remove(idleId);
                idleId = 0;
            }
            if (this._raiseCapture?.cleanup === cleanup)
                this._raiseCapture = null;
        };
        const shoot = () => {
            if (finished)
                return;
            finished = true;
            cleanup();
            try {
                const png = this._png(metaWindow);
                if (png?.length) {
                    this._keep(metaWindow, png);
                    done();
                    return;
                }
            } catch (error) {
                console.error(`Context Tap window capture failed: ${error}`);
            }
            this._pngAsync(metaWindow, done);
        };
        const paintThenShoot = () => {
            if (finished || paintId)
                return;
            paintId = global.stage.connect('after-paint', () => {
                if (paintId) {
                    global.stage.disconnect(paintId);
                    paintId = 0;
                }
                shoot();
            });
        };
        const consider = () => {
            this._armFirstFrame(metaWindow);
            if (finished || !this._hasFrame(metaWindow))
                return;
            if (this._isOnTop(metaWindow))
                paintThenShoot();
        };
        this._armFirstFrame(metaWindow);
        restackId = global.display.connect('restacked', consider);
        idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            idleId = 0;
            consider();
            return GLib.SOURCE_REMOVE;
        });
        const limit = this._hasFrame(metaWindow) ? 250 : 2000;
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, limit, () => {
            timerId = 0;
            shoot();
            return GLib.SOURCE_REMOVE;
        });
        this._raiseCapture = {cleanup, consider, window: metaWindow};
    }

    _emitFocus(next, prev) {
        const nextInfo = this._describe(next);
        const prevInfo = this._describe(prev);
        if (!this._connection)
            return;
        this._connection.emit_signal(
            null,
            OBJECT_PATH,
            IFACE,
            'FocusChanged',
            new GLib.Variant('(sss)', [nextInfo.appId, nextInfo.title, prevInfo.appId]));
    }

    _keep(metaWindow, png) {
        const info = this._describe(metaWindow);
        if (!info.appId || !png?.length)
            return;
        this._shots.set(info.appId, {
            png,
            title: info.title,
            timestamp: Date.now() * 1000,
        });
        if (!this._loggedShot) {
            this._loggedShot = true;
            console.error(`Context Tap stored a screenshot, ${png.length} bytes`);
        }
    }

    _captureVariant(appId, refresh) {
        if (refresh) {
            const win = this._windows().find(item => this._describe(item).appId === appId);
            if (win) {
                const png = this._png(win);
                if (png?.length)
                    this._keep(win, png);
            }
        }
        const shot = this._shots.get(appId);
        if (!shot)
            return new GLib.Variant('(aysx)', [new Uint8Array(), '', 0]);
        return new GLib.Variant('(aysx)', [shot.png, shot.title, shot.timestamp]);
    }

    _pngBytes(pixels, width, height, stride) {
        if (!pixels || width < 1 || height < 1 || stride < width * 4)
            return null;
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            GLib.Bytes.new(pixels),
            GdkPixbuf.Colorspace.RGB,
            true,
            8,
            width,
            height,
            stride);
        if (!pixbuf)
            return null;
        const [, contents] = pixbuf.save_to_bufferv('png', [], []);
        return contents ?? null;
    }

    _pngWindow(metaWindow) {
        const actor = metaWindow.get_compositor_private();
        if (!actor)
            return null;
        const content = actor.paint_to_content(null);
        const texture = content?.get_texture?.();
        if (!texture)
            return null;
        const width = texture.get_width();
        const height = texture.get_height();
        if (width < 1 || height < 1)
            return null;
        const stride = width * 4;
        const pixels = new Uint8Array(stride * height);
        const written = texture.get_data(Cogl.PixelFormat.RGBA_8888, stride, pixels);
        if (!written || !hasInk(pixels))
            return null;
        return this._pngBytes(pixels, width, height, stride);
    }

    _captureSize(rect) {
        let width = Math.max(1, Math.round(rect.width));
        let height = Math.max(1, Math.round(rect.height));
        let scale = 1;
        try {
            const sized = global.stage.get_capture_final_size(rect);
            if (Array.isArray(sized)) {
                if (sized.length >= 4 && sized[1] > 0 && sized[2] > 0) {
                    width = sized[1];
                    height = sized[2];
                    scale = sized[3] > 0 ? sized[3] : 1;
                } else if (sized.length >= 3 && sized[0] > 0 && sized[1] > 0) {
                    width = sized[0];
                    height = sized[1];
                    scale = sized[2] > 0 ? sized[2] : 1;
                }
            }
        } catch {
            /* Use the window size. */
        }
        return {width, height, scale};
    }

    _toRgba(pixels, premultiplied) {
        for (let i = 0; i < pixels.length; i += 4) {
            const blue = pixels[i];
            const green = pixels[i + 1];
            const red = pixels[i + 2];
            const alpha = pixels[i + 3];
            if (!premultiplied || alpha === 0 || alpha === 255) {
                pixels[i] = red;
                pixels[i + 1] = green;
                pixels[i + 2] = blue;
                continue;
            }
            pixels[i] = Math.min(255, Math.round(red * 255 / alpha));
            pixels[i + 1] = Math.min(255, Math.round(green * 255 / alpha));
            pixels[i + 2] = Math.min(255, Math.round(blue * 255 / alpha));
        }
    }

    _pngStage(metaWindow) {
        const rect = metaWindow.get_frame_rect();
        if (!rect || rect.width < 1 || rect.height < 1)
            return null;
        const {width, height, scale} = this._captureSize(rect);
        const stride = width * 4;
        const formats = [
            [Cogl.PixelFormat.BGRA_8888, false],
            [Cogl.PixelFormat.BGRA_8888_PRE, true],
            [Cogl.PixelFormat.RGBA_8888, null],
        ];
        for (const [format, premultiplied] of formats) {
            const pixels = new Uint8Array(stride * height);
            let painted = false;
            try {
                painted = global.stage.paint_to_buffer(
                    rect,
                    scale,
                    pixels,
                    stride,
                    format,
                    null,
                    Clutter.PaintFlag.NO_CURSORS);
            } catch {
                continue;
            }
            if (!painted || !hasInk(pixels))
                continue;
            if (premultiplied !== null)
                this._toRgba(pixels, premultiplied);
            const png = this._pngBytes(pixels, width, height, stride);
            if (png?.length)
                return png;
        }
        return null;
    }

    _pngContent(content, rect) {
        const texture = content?.get_texture?.();
        if (!texture)
            return null;
        const texW = texture.get_width();
        const texH = texture.get_height();
        if (texW < 1 || texH < 1)
            return null;
        const stride = texW * 4;
        const pixels = new Uint8Array(stride * texH);
        if (!texture.get_data(Cogl.PixelFormat.RGBA_8888, stride, pixels))
            return null;
        const [stageW, stageH] = global.stage.get_size();
        const scaleX = stageW > 0 ? texW / stageW : 1;
        const scaleY = stageH > 0 ? texH / stageH : 1;
        const x = Math.max(0, Math.min(texW - 1, Math.round(rect.x * scaleX)));
        const y = Math.max(0, Math.min(texH - 1, Math.round(rect.y * scaleY)));
        const width = Math.max(1, Math.min(texW - x, Math.round(rect.width * scaleX)));
        const height = Math.max(1, Math.min(texH - y, Math.round(rect.height * scaleY)));
        const outStride = width * 4;
        const out = new Uint8Array(outStride * height);
        for (let row = 0; row < height; row++) {
            const src = (y + row) * stride + x * 4;
            out.set(pixels.subarray(src, src + outStride), row * outStride);
        }
        if (!hasInk(out))
            return null;
        return this._pngBytes(out, width, height, outStride);
    }

    _pngAsync(metaWindow, done, epoch = this._shotEpoch, attempt = 0) {
        if (epoch !== this._shotEpoch)
            return;
        const rect = metaWindow.get_frame_rect?.();
        if ((this._holding || this._placing) && attempt < 10) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._pngAsync(metaWindow, done, epoch, attempt + 1);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (!rect || rect.width < 1 || rect.height < 1) {
            done();
            return;
        }
        const stream = Gio.MemoryOutputStream.new_resizable();
        const shot = new Shell.Screenshot();
        try {
            shot.screenshot_area(
                rect.x, rect.y, rect.width, rect.height, stream, (obj, result) => {
                    if (epoch !== this._shotEpoch)
                        return;
                    try {
                        obj.screenshot_area_finish(result);
                        stream.close(null);
                        const png = stream.steal_as_bytes()?.toArray?.() ?? null;
                        if (png?.length)
                            this._keep(metaWindow, png);
                    } catch (error) {
                        console.error(`Context Tap area capture failed: ${error}`);
                    }
                    done();
                });
        } catch (error) {
            console.error(`Context Tap area capture failed: ${error}`);
            done();
        }
    }

    _png(metaWindow) {
        try {
            const png = this._pngWindow(metaWindow);
            if (png?.length)
                return png;
        } catch (error) {
            console.error(`Context Tap window capture failed: ${error}`);
        }
        return null;
    }

    _schedulePlacement() {
        if (this._applyPlacement())
            return;
        if (this._placeIdle)
            return;
        this._placeTries = 0;
        this._placeIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._placeTries += 1;
            if (this._applyPlacement() || this._placeTries >= 40) {
                this._placeIdle = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _frameOf(win) {
        const rect = win.get_frame_rect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    }

    _applyPlacement(restoreSize = false) {
        this._placing = true;
        let found = false;
        for (const win of this._assistantWindows()) {
            found = true;
            this._syncTaskbar(win);
            this._watch(win);
            if (this._above)
                win.make_above();
            else
                win.unmake_above();
            const docking = this._mode === 'left' || this._mode === 'right';
            if (!docking) {
                this._dockedRect = null;
                this._clearStrut();
            }
            if (docking) {
                if (!this._freeOrigin)
                    this._freeOrigin = this._frameOf(win);
                this._placeDock(win);
                continue;
            }
            if (!restoreSize)
                continue;
            const area = win.get_work_area_current_monitor();
            const width = chosenWidth(win, area);
            let x = this._freeOrigin
                ? this._freeOrigin.x
                : area.x + Math.round((area.width - width) / 2);
            let y = this._freeOrigin
                ? this._freeOrigin.y
                : area.y + Math.round((area.height - LAUNCH_HEIGHT) / 2);
            const height = Math.min(LAUNCH_HEIGHT, area.height);
            if (x + width > area.x + area.width)
                x = area.x + area.width - width;
            if (y + height > area.y + area.height)
                y = area.y + area.height - height;
            if (x < area.x)
                x = area.x;
            if (y < area.y)
                y = area.y;
            this._freeOrigin = null;
            this._holdPlacement();
            win.move_resize_frame(true, x, y, width, height);
        }
        if (!found) {
            this._dockedRect = null;
            this._clearStrut();
        }
        this._placing = false;
        return found;
    }

    _dockSlot(win, wanted = null) {
        const monitor = global.display.get_monitor_geometry(win.get_monitor());
        if (!monitor || monitor.height < 1 || monitor.width < 1)
            return null;
        const top = this._panelInset(monitor);
        const width = wanted
            ? Math.min(Math.max(wanted, 210), Math.max(210, monitor.width))
            : chosenWidth(win, monitor);
        const x = this._mode === 'left' ? monitor.x : monitor.x + monitor.width - width;
        return {
            x,
            y: monitor.y + top,
            width,
            height: Math.max(1, monitor.height - top),
        };
    }

    _panelInset(monitor) {
        try {
            const panel = Main.panel;
            if (!panel?.get_transformed_position)
                return 0;
            const [px, py] = panel.get_transformed_position();
            const [pw, ph] = panel.get_transformed_size();
            if (py <= monitor.y + 1 && px < monitor.x + monitor.width && px + pw > monitor.x)
                return Math.max(0, Math.round(ph));
        } catch {
            /* The top bar is not available. */
        }
        return 0;
    }

    _placeDock(win, width = null) {
        const slot = this._dockSlot(win, width);
        if (!slot)
            return;
        const frame = win.get_frame_rect();
        const ready = this._above
            ? win.get_window_type() === Meta.WindowType.DOCK && this._strut
            : win.get_window_type() !== Meta.WindowType.DOCK && !this._strut;
        if (ready && frame.x === slot.x && frame.y === slot.y
            && frame.width === slot.width && frame.height === slot.height)
            return;
        this._dockedRect = slot;
        this._holdPlacement();
        this._removeStrut();
        this._forceNormal(win);
        win.move_resize_frame(true, slot.x, slot.y, slot.width, slot.height);
        this._settleTries = 0;
        this._queueSettle(win);
    }

    _queueSettle(win) {
        if (this._pinIdle)
            GLib.source_remove(this._pinIdle);
        this._pinIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._pinIdle = 0;
            this._settle(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    _settle(win) {
        const slot = this._dockedRect;
        if (!win || !slot || (this._mode !== 'left' && this._mode !== 'right'))
            return;
        const frame = win.get_frame_rect();
        const placed = frame.x === slot.x && frame.y === slot.y
            && frame.width === slot.width && frame.height === slot.height;
        if (!placed && this._settleTries < 12) {
            this._settleTries += 1;
            this._holdPlacement();
            this._forceNormal(win);
            win.move_resize_frame(true, slot.x, slot.y, slot.width, slot.height);
            this._queueSettle(win);
            return;
        }
        if (!this._above)
            return;
        if (!placed) {
            const monitor = global.display.get_monitor_geometry(win.get_monitor());
            slot.width = frame.width;
            slot.x = this._mode === 'left' ? monitor.x : monitor.x + monitor.width - frame.width;
        }
        this._setDockType(win);
        this._syncStrut(win);
    }

    _syncStrut(win) {
        const docked = this._mode === 'left' || this._mode === 'right';
        const rect = this._dockedRect;
        if (!this._above || !docked || !win || !rect) {
            this._clearStrut();
            return;
        }
        const monitor = global.display.get_monitor_geometry(win.get_monitor());
        if (!monitor)
            return;
        const x = this._mode === 'left' ? monitor.x : monitor.x + monitor.width - rect.width;
        if (!this._strut) {
            this._strut = new Clutter.Actor({
                reactive: false,
                opacity: 0,
                width: rect.width,
                height: monitor.height,
            });
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true});
        }
        this._strut.set_position(x, monitor.y);
        this._strut.set_size(rect.width, monitor.height);
    }

    _forceNormal(win) {
        try {
            if (win.get_window_type() === Meta.WindowType.DOCK)
                win.set_type(Meta.WindowType.NORMAL);
        } catch (error) {
            console.error(`Context Tap could not restore the window type: ${error}`);
        }
    }

    _setDockType(win) {
        try {
            if (win.get_window_type() !== Meta.WindowType.DOCK)
                win.set_type(Meta.WindowType.DOCK);
        } catch (error) {
            console.error(`Context Tap could not set the dock type: ${error}`);
        }
    }

    _focusSelf() {
        const time = global.display.get_current_time_roundtrip();
        for (const win of this._assistantWindows()) {
            if (!win.has_focus())
                win.focus(time);
        }
    }

    _pinDock(win) {
        const rect = this._dockedRect;
        if (!win || !rect || (this._mode !== 'left' && this._mode !== 'right'))
            return;
        const frame = win.get_frame_rect();
        if (!frame)
            return;
        if (frame.x === rect.x && frame.y === rect.y
            && frame.width === rect.width && frame.height === rect.height)
            return;
        this._placeDock(win, rect.width);
    }

    _removeStrut() {
        if (!this._strut)
            return;
        Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
    }

    _clearStrut() {
        if (this._pinIdle) {
            GLib.source_remove(this._pinIdle);
            this._pinIdle = 0;
        }
        this._removeStrut();
        try {
            for (const win of this._assistantWindows())
                this._forceNormal(win);
        } catch {
            /* The window list is already gone. */
        }
    }

    _resizeDock(win, width) {
        const slot = this._dockSlot(win, width);
        if (!slot)
            return;
        this._dockedRect = slot;
        this._holdPlacement();
        win.move_resize_frame(true, slot.x, slot.y, slot.width, slot.height);
        if (this._above)
            this._syncStrut(win);
    }

    _setWidth(width) {
        const requested = Math.max(210, Math.round(Number(width)));
        for (const win of this._assistantWindows()) {
            const frame = win.get_frame_rect();
            const area = win.get_work_area_current_monitor();
            if (!frame || !area)
                continue;
            const monitor = global.display.get_monitor_geometry(win.get_monitor()) || area;
            const next = Math.min(requested, Math.max(210, monitor.width));
            if (this._mode === 'left' || this._mode === 'right') {
                this._resizeDock(win, next);
                continue;
            }
            let x = frame.x;
            if (x + next > area.x + area.width)
                x = area.x + area.width - next;
            if (x < area.x)
                x = area.x;
            this._holdPlacement();
            this._clearStrut();
            win.move_resize_frame(true, x, frame.y, next, frame.height);
        }
    }

    _watch(win) {
        if (this._watched === win)
            return;
        if (this._positionId && this._watched)
            this._watched.disconnect(this._positionId);
        this._watched = win;
        this._positionId = win.connect('position-changed', () => this._releaseIfMoved(win));
    }

    _holdPlacement() {
        this._holding = true;
        if (this._holdIdle)
            GLib.source_remove(this._holdIdle);
        this._holdIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._holdIdle = 0;
            this._holding = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _releaseIfMoved(win, fromUser = false) {
        if (this._mode !== 'left' && this._mode !== 'right')
            return;
        if (!fromUser && (this._holding || this._pinIdle))
            return;
        const frame = win.get_frame_rect();
        const monitor = global.display.get_monitor_geometry(win.get_monitor());
        if (!frame || !monitor)
            return;
        const slack = 48;
        const nearEdge = this._mode === 'left'
            ? frame.x <= monitor.x + slack
            : frame.x + frame.width >= monitor.x + monitor.width - slack;
        if (fromUser && !nearEdge) {
            this._mode = 'off';
            this._freeOrigin = this._frameOf(win);
            savePlacement(this._mode, this._above);
            this._clearStrut();
            return;
        }
        if (fromUser && nearEdge && this._dockedRect) {
            const top = this._panelInset(monitor);
            this._dockedRect = {
                x: this._mode === 'left' ? monitor.x : monitor.x + monitor.width - frame.width,
                y: monitor.y + top,
                width: frame.width,
                height: Math.max(1, monitor.height - top),
            };
        }
        this._pinDock(win);
    }
}

function hasInk(pixels) {
    for (let i = 0; i < pixels.length; i += 67)
        if (pixels[i])
            return true;
    return false;
}
