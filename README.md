# Direct Ask — SillyTavern Extension

A SillyTavern extension that lets you ask the AI questions **out-of-character**, interview any character directly, inject narrator events into the RP chat, attach files and images, and use quick-access shortcut buttons — all without interrupting your roleplay.

---

## Features

- **OOC Assistant mode** — ask anything as a player; the AI steps out of character and answers using full RP context (chat history, character cards, scenario, world state) or pure general knowledge
- **Character Interview mode** — select a character from the current chat and talk to them directly; the AI responds fully in-character
- **Quick Shortcuts** — one-click buttons for common questions: Time, Location, POV, Weather, Who's here, Summary, Mood, and more — fully customizable
- **Inject into RP chat** — generate narrator events (Random Event, Plot Twist, custom instructions) and inject them directly into the SillyTavern chat as a Narrator message
- **File & Image upload** — attach text files (`.txt`, `.md`, `.json`, `.js`, `.css`, `.html`, `.py`, `.xml`, `.csv`) or images; images are analyzed via SillyTavern's Caption API (Extras or Multimodal)
- **Translation** — translate any AI response using SillyTavern's built-in translate extension
- **Conversation mode** — maintain a short-term conversation history within Direct Ask so follow-up questions have context
- **Floating / Draggable window** — optionally detach the dialog from modal mode into a freely draggable, resizable floating window that stays open while you RP
- **Slash commands** — `/ask <question>`, `/direct`, `/inject-event <instruction>`
- **Keyboard shortcut** — `Ctrl+Shift+A` to toggle the panel
- **Fully theme-aware** — uses SillyTavern's CSS variables, looks native in any theme

---

## Installation

1. In SillyTavern, go to **Extensions → Install extension**
2. Paste the URL of this repository and confirm
3. The extension will appear in the Extensions settings panel under **Direct Ask**

**Or install manually:**

```
SillyTavern/public/scripts/extensions/third-party/direct-ask/
├── index.js
├── style.css
└── manifest.json
```

Reload SillyTavern after copying the files.

---

## Usage

### Opening Direct Ask

| Method | Action |
|---|---|
| Chat button | Click the 🤖 robot icon near the send area |
| Keyboard | `Ctrl+Shift+A` |
| Slash command | `/direct` |
| Settings panel | Click **Open Direct Ask** |

### Asking a question

1. Open Direct Ask
2. Select a target from the dropdown:
   - **🤖 AI Assistant (OOC)** — the AI answers out-of-character
   - **🎭 Character name** — the AI responds fully in-character as that character
3. Toggle **RP context** on/off (forced on for character interviews)
4. Type your question and press **Enter** or click Send

### Quick Shortcuts

Click any shortcut button to send a pre-written question instantly. Shortcuts marked **INJECT** generate a narrator scene and inject it into the RP chat automatically.

To add, edit, or remove shortcuts go to **Extensions → Direct Ask → Quick Shortcuts**.

### Injecting events into RP chat

- Use an **INJECT** shortcut (e.g. 🎲 Random Event, ⚡ Plot Twist)
- Or click the **inject** button (↗ icon) on any AI response to push it into the chat as a Narrator message
- Or use the slash command: `/inject-event Generate a dramatic earthquake`

### Attaching files

Click the 📎 paperclip icon to attach:
- **Image** — analyzed via the Caption API; you can ask a question about it or get a caption
- **Text file** — content is included in the prompt as context

### Translation

Click the 🌐 translate button on any AI response to show a translation below it. The target language follows your SillyTavern translate extension settings.

---

## Settings

All settings are in **Extensions → Direct Ask**:

| Setting | Description |
|---|---|
| Enable extension | Master on/off switch |
| Show button in chat area | Show/hide the 🤖 trigger button |
| Floating mode | Detach the dialog into a draggable floating window |
| Window size (W × H) | Set the floating window dimensions in pixels |
| Reset position | Move the floating window back to screen center |
| Use RP context by default | Whether context is on by default for OOC assistant mode |
| Conversation mode | Keep a short history of this session for follow-up questions |
| Max context messages | How many recent messages to include in follow-up context |
| Prompt WITH RP context | System prompt used when RP context is enabled |
| Prompt WITHOUT context | System prompt used for general knowledge questions |
| Quick Shortcuts | Add, view, or delete shortcut buttons |

---

## Slash Commands

| Command | Description |
|---|---|
| `/ask <question>` | Ask a question directly (opens the panel and sends the question) |
| `/direct` | Open the Direct Ask panel |
| `/inject-event <instruction>` | Generate a narrator event from the given instruction and inject it into chat |

---

## Requirements

- SillyTavern (recent version with `extensions.js` and `script.js` module exports)
- An API connected in SillyTavern (any backend supported by ST)
- For image captioning: SillyTavern Extras or a Multimodal-capable API configured in the Caption extension settings
- For translation: the SillyTavern **translate** extension enabled and configured

---

## Compatibility

- Works with all SillyTavern-supported AI backends (OpenAI, Claude, local models via Ollama / KoboldAI / etc.)
- Works in single-character chats and group chats
- Character Interview mode automatically discovers all characters present in the current chat

---

## License

MIT
