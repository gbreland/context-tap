# Context Tap protocol

Private session-bus API. This is not a FreeDesktop or GNOME standard.

The assistant process owns `org.contexttap.ContextTap`. The shell extension owns `org.contexttap.ContextTap.Shell`. A supporting app exports `org.contexttap.ContextTap.Client1` on its own bus name only while its agent switch is on.

There is no method that runs a command. `InsertPending` only places text. A newline in that text is Enter.

## org.contexttap.ContextTap.Client1

Object path: `/org/contexttap/ContextTap/Client`

Ptyxis exports this on `org.gnome.Ptyxis` or `org.gnome.Ptyxis.Devel`.

```xml
<node>
  <interface name="org.contexttap.ContextTap.Client1">
    <method name="GetState">
      <arg type="s" name="text" direction="out"/>
      <arg type="a{sv}" name="state" direction="out"/>
    </method>
    <method name="InsertPending">
      <arg type="s" name="text" direction="in"/>
    </method>
    <signal name="ContextChanged">
      <arg type="s" name="text"/>
      <arg type="a{sv}" name="state"/>
    </signal>
  </interface>
</node>
```

`GetState` and `ContextChanged` use these string fields: `app-id`, `type`, `version`, `title`, `directory`, `container`.

`type` is `terminal` when the client is a terminal. Context Tap sends the terminal-action instructions only for an active client with that type.

`text` is the recent plain text of the focused tab, including scrollback above the visible screen, up to 200 lines. `GetState` returns that text. `ContextChanged` sends it again when the text changes. A new push replaces the previous text.

`InsertPending` writes `text` to the focused terminal. A newline is Enter. The call presents that window and focuses the terminal.

## org.contexttap.ContextTap.Shell1

Well-known name: `org.contexttap.ContextTap.Shell`

Object path: `/org/contexttap/ContextTap/Shell`

Every method checks the caller. The caller must own `org.contexttap.ContextTap`.

```xml
<node>
  <interface name="org.contexttap.ContextTap.Shell1">
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
</node>
```

`ListWindows` rows are `app-id`, display name, window title, focused, and process id. When one app has several windows, the row uses the focused window.

The extension captures an app when that app gains focus. If the focused app is Context Tap, it captures the app that lost focus instead. It keeps one PNG per app id, with the window title and a microsecond timestamp. `GetCapture` returns that image.

`CaptureNow` captures the current window of `app_id`. Context Tap uses it when the user selects the assistant itself.

`SetPlacement` mode is `off`, `left`, or `right`. Dragging the window off the docked left or right edge sets the mode to `off` and leaves the window where the user put it. `above` raises the assistant window above other windows. The extension applies this because a Wayland client cannot place or raise its own window on GNOME. Mutter does not keep this dock or the above flag. The extension stores both and applies them when the assistant window opens. `GetPlacement` returns the stored mode and above flag.

`FocusApp` activates the window whose app id matches `app_id`. The assistant calls it after Run or Run All. The method is available after the next login.

## Slots

The assistant keeps three kinds of context:

- `text` from an active client
- `image` from the per-app screenshot cache
- `state` from the client or from the window title and app id

The model receives the working image on the next user message only. The working image is the newest shot whose app is not Context Tap, unless the user has selected Context Tap.
