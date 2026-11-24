## Context Tap
Context Tap is currently a Gnome only extension that enables a a side-panel AI assistant.  It helps you with any task you are working on
by sending prompts and various other contextual information to an AI agent while being in full control of what is sent.  The UI provides
frictionless sharing of system information, app specific data and screenshots of the app with each prompt.

## Screenshots

The panel is persistent on the desktop as a panel taking up some amount of desktop space for windows. It receives different context information from different apps.  For most apps this will just be automatically capturing screenshots of the app before you send a prompt to your AI. For terminal apps there is native integration protocols but it also supports tmux for reading and sending commands to any terminal application as shown here. You are in control of what context is sent to AI per application. You could use it just like any AI window and copy/paste your context in manually if you turn off all context.  The power of the app is removing the friction of the copy/paste work to inform AI of the result of what you're doing.

<img src="data/images/Context Tap Full Desktop Hero.png" alt="Context Tap docked beside a terminal and a calculator" width="1030">

---

The same panel, on its own. The header names the app and how old its data is. The line under Chat is the whole conversation: input tokens, output tokens, and how much of the input was cached. The reply includes a command you can run. Under the prompt, the terminal text and the screenshot are separate items. Each has its own check mark.

<img src="data/images/Context Tap Hero.png" alt="The Context Tap panel with a chat, a command, and the terminal context" width="231">

---

The gear opens the list of what a prompt can include. Each row shows the size. A checked row is sent. An unchecked row stays on the machine. Copy on a row puts that text on the clipboard.

<img src="data/images/Context Tap Context Details.png" alt="Context rows with sizes and include checks" width="400">

---

When the reply has commands, each group gets a Run button. Run All runs every group in the block. The commands stay visible, so you read them before they run.

<img src="data/images/Context Tap Run Commands.png" alt="Two command groups with Run and Run All" width="400">

---

The percent on a prompt opens that turn. It shows input, cached, uncached, output, and how long the reply took. A green check means 80% or more of that prompt's input was cached.

<img src="data/images/Context Tap Prompt Stats.png" alt="Per-prompt cache details" width="400">

---

The chart next to the chat totals opens the session. One bar is the whole chat. The rows under it are the prompts, oldest first, each with its own cached share. Later prompts reuse more of the earlier input.

<img src="data/images/Context Tap Session Stats.png" alt="Session cache totals and one bar per prompt" width="340">

---

## Install

Context Tap has two parts: the app and a GNOME Shell extension. The extension docks the window, keeps it on top, and reads window focus. Run `shell/install.sh` in one of three modes.

| Command | Extension location | App location | In the Extensions app |
|---|---|---|---|
| `shell/install.sh` | `~/.local/share/gnome-shell/extensions/` (copy) | `~/.local/lib/context-tap/` (copy) | On/off and Remove. Remove deletes only the copy. |
| `shell/install.sh --dev` | Link to the repo `shell/` folder | Runs from the repo | On/off and Remove. **Remove deletes the repo files.** |
| `sudo shell/install.sh --system` | `/usr/share/gnome-shell/extensions/` | `/usr/share/context-tap/` | On/off only. No Remove. |

### User install (default)

```sh
shell/install.sh
```

- Copies the extension and the app into your home folder.
- Installs the app launcher, the D-Bus service file, and the autostart entry.
- Turns the extension on for you.
- Log out, then log in. GNOME loads the extension and starts Context Tap.

### Developer install

```sh
shell/install.sh --dev
```

- Links the extension to the repo, so your edits go live after the next login.
- The app runs from the repo.
- **Do not use Remove in the Extensions app with this mode.** GNOME follows the link and deletes the files in the repo `shell/` folder. To turn the extension off, use the on/off switch.

### System install (packages)

```sh
sudo shell/install.sh --system
```

- Installs the extension, the app, the launcher, and the D-Bus service file under `/usr`. The autostart entry goes in `/etc/xdg/autostart/`.
- Does not change any user's settings. Each user turns the extension on in Extensions, then logs out and logs in.
- The Extensions app shows on/off only. To remove Context Tap from the OS, remove the package.
- For package builds, set `PREFIX` (default `/usr`) and `DESTDIR`:

  ```sh
  DESTDIR="$RPM_BUILD_ROOT" PREFIX=/usr shell/install.sh --system
  ```

### Startup behavior

- At login, Context Tap starts only when the extension is on for that user.
- When you turn the extension on in Extensions, Context Tap starts if it is not already running.
- When you turn the extension off, the app keeps running. It does not start at the next login.
- Without the extension, the app opens at the default size. Screen bind and Always on Top are not available, because on Wayland an app cannot set its own position.

### Notes

- If the same extension is installed in your home folder and in `/usr`, GNOME uses the copy in your home folder.
- After you change the extension code, log out and log in. GNOME Shell cannot reload an extension in the same session.
