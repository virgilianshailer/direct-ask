# Direct Ask — SillyTavern Extension

A SillyTavern extension that lets you ask the AI questions **out-of-character**, interview any character directly, inject narrator events into the RP chat, visualize scenes as images, attach files and pictures, and use customizable quick-access shortcut buttons — all without interrupting your roleplay.

---

## Features

- **OOC Assistant mode** — ask anything as a player. The AI breaks character and answers using full RP context (chat history, character cards, scenario, world state) or pure general knowledge.
- **Character Interview mode** — pick any character present in the current chat and talk to them directly. The AI stays fully in-character.
- **Quick Shortcuts** — one-click buttons for common questions: Time, Location, POV, Weather, Who's here, Summary, Mood, Random Event, Plot Twist, and more. Fully editable: add your own, mark them as injectable, or restore defaults.
- **Inject into RP chat** — generate narrator events (Random Event, Plot Twist, custom prompt) and push them directly into the SillyTavern chat as a Narrator message.
- **Visualize scenes** — click the 🖼 icon on any reply to turn it into an image generation prompt and render the scene via the **AutoIllustrator** extension and a ComfyUI workflow. Choose a dedicated preset or use the active one.
- **File & image upload** — attach text files (`.txt`, `.md`, `.json`, `.js`, `.css`, `.html`, `.py`, `.xml`, `.csv`) as context, or images that are analyzed via SillyTavern's Caption API (Extras or Multimodal).
- **Translation** — translate any AI response inline using SillyTavern's built-in **translate** extension.
- **Conversation mode** — keep a short-term history within Direct Ask so follow-up questions retain context.
- **Floating / draggable window** — optionally detach the dialog from modal mode into a free-floating, resizable window that stays open while you RP.
- **Slash commands** — `/ask <question>`, `/direct`, `/inject-event <instruction>`.
- **Keyboard shortcut** — `Ctrl+Shift+A` toggles the panel.
- **Fully theme-aware** — built on SillyTavern's CSS variables; looks native in any theme.

---

## Installation

1. In SillyTavern, open **Extensions → Install extension**.
2. Paste the URL of this repository and confirm.
3. The extension appears in the Extensions settings panel as **Direct Ask**.

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

1. Open Direct Ask.
2. Pick a target from the dropdown:
   - **🤖 AI Assistant (OOC)** — answers out-of-character.
   - **🎭 Character name** — replies fully in-character as that character.
3. Toggle **RP context** on/off (forced on for character interviews).
4. Type your question and press **Enter** or click Send.

### Quick Shortcuts

Click any shortcut button to send a pre-written question instantly. Shortcuts marked **INJECT** generate a narrator scene and push it straight into the RP chat.

Manage them under **Extensions → Direct Ask → Quick Shortcuts** (add, edit, remove, or reset defaults).

### Injecting events into the RP chat

There are three ways:

- Click an **INJECT** shortcut (e.g. 🎲 Random Event, ⚡ Plot Twist).
- Click the **inject** button (↗ icon) on any AI response to push it into the chat as a Narrator message.
- Run `/inject-event Generate a dramatic earthquake` from the chat input.

### Visualizing a scene (image generation)

Direct Ask integrates with the **AutoIllustrator** extension to turn AI responses into images via ComfyUI.

1. Make sure the **AutoIllustrator** extension is installed and connected to a running ComfyUI instance.
2. In **Extensions → Direct Ask → Visualize**, pick a ComfyUI preset (or leave it as **— Use active AI preset —**).
3. In any Direct Ask reply, click the 🖼 image icon. Direct Ask will build an image generation prompt from the reply and send it to ComfyUI. The result is shown inline.

> If the selected preset has no ComfyUI workflow, the visualize button will report an error — pick a preset that does.

### Attaching files

Click the 📎 paperclip icon to attach:

- **Image** — analyzed via the Caption API. You can ask a question about it or just get a caption.
- **Text file** — its contents are included in the prompt as additional context.

### Translation

Click the 🌐 translate button on any AI response to show a translation underneath it. The target language follows your SillyTavern **translate** extension settings.

---

## Settings

All settings live under **Extensions → Direct Ask**:

| Setting | Description |
|---|---|
| Enable extension | Master on/off switch |
| Show button in chat area | Show or hide the 🤖 trigger button |
| Floating mode | Detach the dialog into a draggable floating window |
| Window size (W × H) | Floating window dimensions in pixels |
| Reset position | Move the floating window back to the screen center |
| Use RP context by default | Whether context is on by default in OOC assistant mode |
| Conversation mode | Keep a short history of this session for follow-ups |
| Max context messages | How many recent messages to include in follow-up context |
| Prompt WITH RP context | System prompt used when RP context is enabled |
| Prompt WITHOUT context | System prompt used for general-knowledge questions |
| Reset prompts | Restore both system prompts to defaults |
| 🎨 Visualize (AutoIllustrator) — ComfyUI preset | Preset used when visualizing replies; refresh button reloads the list |
| Quick Shortcuts | Add, edit, remove, or reset shortcut buttons |

---

## Slash Commands

| Command | Description |
|---|---|
| `/ask <question>` | Open the panel and send the question right away |
| `/direct` | Open the Direct Ask panel |
| `/inject-event <instruction>` | Generate a narrator event from the instruction and inject it into chat (instruction is optional — defaults to a generic dramatic event) |

---

## Requirements

- A recent SillyTavern build that exposes the `extensions.js` and `script.js` modules.
- An AI backend connected in SillyTavern (any backend supported by ST works).
- For **image captioning**: SillyTavern Extras, or a Multimodal-capable API configured in the Caption extension settings.
- For **translation**: the SillyTavern **translate** extension enabled and configured.
- For **scene visualization**: the **AutoIllustrator** extension installed, plus a reachable ComfyUI instance (default: `http://127.0.0.1:8188`).

---

## Compatibility

- Works with every AI backend SillyTavern supports (OpenAI, Claude, local models via Ollama / KoboldAI / etc.).
- Works in both single-character chats and group chats.
- Character Interview mode automatically discovers every character present in the current chat.

---

## License

MIT
