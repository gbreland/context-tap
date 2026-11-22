import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
        const width = Math.round(Number(data.width));
        return width >= 1 ? width : 0;
    } catch {
        return 0;
    }
}

function chosenWidth(win, area) {
    const saved = storedWidth();
    const current = win.get_frame_rect()?.width || 0;
    const width = saved || current || 1;
    return Math.min(Math.max(width, 1), Math.max(1, area.width));
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
        const saved = loadPlacement();
        this._mode = saved.mode;
        this._above = saved.above;
        this._freeOrigin = null;
        this._placeIdle = 0;
        this._placeTries = 0;
        this._current = global.display.focus_window;
        console.error('Context Tap extension ready');
        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            connection => this._export(connection),
            null,
            null);
        this._focusId = global.display.connect('notify::focus-window', () => this._onFocus());
        this._createdId = global.display.connect('window-created', () => this._schedulePlacement());
        this._schedulePlacement();
    }

    disable() {
        if (this._focusId)
            global.display.disconnect(this._focusId);
        if (this._createdId)
            global.display.disconnect(this._createdId);
        this._focusId = this._createdId = 0;
        if (this._placeIdle) {
            GLib.source_remove(this._placeIdle);
            this._placeIdle = 0;
        }
        if (this._holdIdle) {
            GLib.source_remove(this._holdIdle);
            this._holdIdle = 0;
        }
        if (this._positionId && this._watched) {
            this._watched.disconnect(this._positionId);
            this._positionId = 0;
            this._watched = null;
        }
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

    _assistantWindows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(win => win && this._describe(win).appId === ASSISTANT);
    }

    _leaveOverview(win) {
        try {
            if (!win.is_skip_taskbar())
                win.hide_from_window_list();
        } catch (error) {
            console.error(`Context Tap could not leave the overview: ${error}`);
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
        const png = this._png(target);
        if (png?.length) {
            this._keep(target, png);
            finish();
            return;
        }
        this._pngAsync(target, finish);
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

    _pngStage(metaWindow) {
        const rect = metaWindow.get_frame_rect();
        if (!rect || rect.width < 1 || rect.height < 1)
            return null;
        const stage = global.stage;
        let width = rect.width;
        let height = rect.height;
        let scale = 1;
        const sized = stage.get_capture_final_size(rect);
        if (Array.isArray(sized)) {
            if (sized[0] === false)
                return null;
            if (sized.length >= 4) {
                width = sized[1];
                height = sized[2];
                scale = sized[3];
            } else if (sized.length >= 3) {
                width = sized[0];
                height = sized[1];
                scale = sized[2];
            }
        }
        width = Math.max(1, Math.round(width));
        height = Math.max(1, Math.round(height));
        const stride = width * 4;
        const pixels = new Uint8Array(stride * height);
        const painted = stage.paint_to_buffer(
            rect,
            scale,
            pixels,
            stride,
            Cogl.PixelFormat.RGBA_8888,
            null,
            Clutter.PaintFlag.NO_CURSORS);
        if (!painted || !hasInk(pixels))
            return null;
        return this._pngBytes(pixels, width, height, stride);
    }

    _pngAsync(metaWindow, done) {
        const rect = metaWindow.get_frame_rect();
        if (!rect || rect.width < 1 || rect.height < 1) {
            done();
            return;
        }
        const stream = Gio.MemoryOutputStream.new_resizable();
        const shot = new Shell.Screenshot();
        try {
            shot.screenshot_area(
                rect.x, rect.y, rect.width, rect.height, stream, (obj, result) => {
                    try {
                        shot.screenshot_area_finish(result);
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
        try {
            return this._pngStage(metaWindow);
        } catch (error) {
            console.error(`Context Tap stage capture failed: ${error}`);
            return null;
        }
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
        let found = false;
        for (const win of this._assistantWindows()) {
            found = true;
            this._leaveOverview(win);
            this._watch(win);
            if (this._above)
                win.make_above();
            else
                win.unmake_above();
            const docking = this._mode === 'left' || this._mode === 'right';
            if (docking) {
                if (!this._freeOrigin)
                    this._freeOrigin = this._frameOf(win);
                const area = win.get_work_area_current_monitor();
                const width = chosenWidth(win, area);
                const x = this._mode === 'left' ? area.x : area.x + area.width - width;
                this._holdPlacement();
                win.move_resize_frame(true, x, area.y, width, area.height);
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
        return found;
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

    _releaseIfMoved(win) {
        if (this._holding || (this._mode !== 'left' && this._mode !== 'right'))
            return;
        const frame = win.get_frame_rect();
        const area = win.get_work_area_current_monitor();
        if (!frame || !area)
            return;
        const slack = 16;
        const parked = this._mode === 'left'
            ? frame.x <= area.x + slack
            : frame.x + frame.width >= area.x + area.width - slack;
        if (parked)
            return;
        this._mode = 'off';
        this._freeOrigin = this._frameOf(win);
        savePlacement(this._mode, this._above);
    }
}

function hasInk(pixels) {
    for (let i = 0; i < pixels.length; i += 67)
        if (pixels[i])
            return true;
    return false;
}
