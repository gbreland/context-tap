## Context Tap
Context Tap is a Gnome side-panel AI assistant extension.  It helps with any task in any appliccation by providing AI prompts with more context
of the state of the app you are working with. You are always in control of what context is sent.  The UI just reduces the friction of sharing system context, app specific data and screenshots with each prompt.

This app is currently more of a demo and only supports login with ChatGPT but if it proves useful, the future plans for improvement are:

* Add more AI agents via CLI integration
* Multiple screenshots instead of just the last one
* Live response mode where a cheap AI model watches and decides when your main model might want to provide feedback
* Multi-step mode where the model provides a series of steps and the app walks you through them one step at a time with AI feedback when needed.

## Screenshots

The panel is persistent on the desktop as a panel taking up some amount of desktop space for windows. It receives different context information from different apps.  For most apps this will just be automatically capturing screenshots of the app before you send a prompt to your AI. For terminal apps there is native integration protocols but it also supports tmux for reading and sending commands to any terminal application as shown here.  The power of the app is removing the friction of the copy/paste work to inform AI of the result of what you're doing.

<img src="data/images/Context Tap Full Desktop Hero.png" alt="Context Tap docked beside a terminal and a calculator" width="1030">

---

When the app in context is a temrinal app with native or tmux integration enabled and the ai response has commands, each group gets a Run button per command. If there are multiple commands, a Run All button will run all commands in the block. 

<img src="data/images/Context Tap Run Commands.png" alt="Two command groups with Run and Run All" width="400">

---

The full side panel in detail. The header names the app in context and how long ago it sent data. You can choose the model that is best for what you are doing but right now only ChatGPT is supported. The Chat dropdown is for loading old chats or starting new ones.  Currently saving chats is no supported for security reasons and Login with Chat GPT doesn't support saving/loading chats in the cloud. Right below the chat drop down are statistics about this chat session and clicking on the graph icon will show even more detail. Below the session stats is the prompt history. Ai can suggest commands you might want to run and the app will present them as easy to click on run commands as long as you have a native or tmux terminal in context as the currently focused application. Toward the bottom, the "Ask AI something" is the AI input prompt common to all AI chat UIs.  Below the prompt input is where you tell the app what additional context you want to send. Most of the content options you will set once and leave which can be set by clicking on the setting icon in the context area. It's common to want to send app data or a screen shot on a prompt-by-prompt basis so they remain persistant in the UI so you can easily click on them to turn sending data on/off.

<img src="data/images/Context Tap Hero.png" alt="The Context Tap panel with a chat, a command, and the terminal context" width="231">

---

Clicking on the settings icon in the context area at the bottom opens a list of context data a prompt will include. Data and screenshots are easily turned on/off anytime but the additional data soruces listed here are ones that you set once and send every time. Turning these additional data souces on/off for each prompt will cause cache failure and increased token usage.  You can expand each one and see exactly what the app is sending.

<img src="data/images/Context Tap Context Details.png" alt="Context rows with sizes and include checks" width="400">

---

Each prompt sent to AI records stats about token usage and time AI spent thinking.  Tapping on the chached percentage label opens up this detailed stats window so you can see exactly what went on.  Not all prompts can cache static system information but you want to see some caching so you know you are not using more tokens than you should be.

<img src="data/images/Context Tap Prompt Stats.png" alt="Per-prompt cache details" width="400">

---

This is the details of all the tokens and prompts for the current chat session.  It is opened by clicking on the graph icon next to the session stats at the top of the app. 

<img src="data/images/Context Tap Session Stats.png" alt="Session cache totals and one bar per prompt" width="340">

---

## Install

Context Tap has two parts: the app and a GNOME Shell extension. The extension docks the window, keeps it on top, and reads window focus. Run `shell/install.sh` in one of three modes based on how you want it installed.

For most installations, just installing it for your user if fine so just run the install.sh script without paramaters.

| Command | Extension location | App location | In the Extensions app |
|---|---|---|---|
| `shell/install.sh` | `~/.local/share/gnome-shell/extensions/` (copy) | `~/.local/lib/context-tap/` (copy) | On/off and Remove. Remove deletes only the copy. |
| `shell/install.sh --dev` | Link to the repo `shell/` folder | Runs from the repo path | On/off and Remove. **Remove deletes the repo files. (BE CAREFUL)** |
| `sudo shell/install.sh --system` | `/usr/share/gnome-shell/extensions/` | `/usr/share/context-tap/` | On/off only. No Remove. |

### User install (default)

```sh
shell/install.sh
```

- Copies the extension and the app into your home folder.
- Installs the app launcher, the D-Bus service file, and the autostart entry.
- Turns the extension on for you.
- You MUST Log out and then log back in. GNOME loads the extension and starts Context Tap.

### Developer install

```sh
shell/install.sh --dev
```

- Links the extension to the repo, so your edits go live after the next login without deploying it.
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
- Turning the extension off and then back on will clear ALL settings for your user if you want to reset everything.

### Notes

- If the same extension is installed in your home folder and in `/usr`, GNOME uses the copy in your home folder.
- After you change the extension code, log out and log in. GNOME Shell cannot reload an extension in the same session.
