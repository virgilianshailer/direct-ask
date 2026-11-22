/*
 *  Direct Ask — SillyTavern Extension
 *  Shortcuts + RP context + Translation + Chat Injection + File Upload + Character Interview
 */

var MODULE = "direct-ask";

var PROMPT_WITH_CONTEXT =
    "[OOC: The user is asking a question as a PLAYER, not as their character. " +
    "Break character completely and answer as a helpful AI assistant. " +
    "Use all available context — chat history, character info, scenario, " +
    "world state, time of day, location, etc. — to give an accurate answer. " +
    "Do NOT continue the roleplay. Just answer the question directly. " +
    "Respond in the same language the user uses.]";

var PROMPT_NO_CONTEXT =
    "You are a helpful AI assistant. This question is NOT related to any " +
    "roleplay or story. Ignore all character cards, personas, and chat history. " +
    "Answer based on your general knowledge. Respond in the user's language.";

// Restated right before the answer marker. The system instruction sits far
// above a long story block, and the last thing a model reads wins — without
// this the model slides back into the character it has just read pages of.
var PROMPT_OOC_REMINDER =
    "[Reminder: answer OUT OF CHARACTER, as the AI assistant talking to the player. " +
    "Do NOT reply as {{char}} or any other character, do NOT write dialogue, actions, " +
    "narration or *asterisks*, do NOT continue the scene. Give a plain, direct answer " +
    "to the question above, in the user's language.]";

var PROMPT_CHARACTER_INTERVIEW =
    "[OOC: This is a direct, out-of-scene interview or conversation with the character \"{{char}}\". " +
    "You MUST respond entirely IN-CHARACTER as \"{{char}}\". Maintain your persona, speech style, formatting, and current knowledge based on the story. " +
    "Do NOT advance the main roleplay scene. Answer the user's questions directly, speaking to the user. " +
    "Respond in the same language the user uses.]";

var PROMPT_VISUALIZE_SCENE =
    "[OOC: Your task is to create a detailed image generation prompt based on the following text. " +
    "The prompt must vividly describe the visual scene: characters, their appearance, clothing, pose, " +
    "setting, environment, lighting, atmosphere, mood, and art style. " +
    "Style guidance: {{FORMAT_HINT}}\n\n" +
    "Text to visualize:\n{{TEXT}}\n\n" +
    "Respond ONLY with JSON: {\"image_prompt\": \"the full image generation prompt\"}\nONLY JSON!]";

var DEFAULT_SHORTCUTS = [
    { label: "\u{1F552} Time",       prompt: "What time of day is it right now in the current scene? Be specific." },
    { label: "\u{1F4CD} Location",   prompt: "Where is the current scene taking place? Describe the location." },
        { label: "\u{1F441} POV",        prompt: "Describe what the PLAYER's character currently sees from their own eyes and perspective. NOT from any NPC's point of view — only what the player's character can see right now." },
    { label: "\u{26C5} Weather",     prompt: "What is the current weather and atmosphere in the scene?" },
    { label: "\u{1F465} Who's here", prompt: "Who is currently present in the scene? List all characters and what they're doing." },
    { label: "\u{1F4CB} Summary",    prompt: "Summarize the key events of the story so far in a few sentences." },
    { label: "\u{1F4AD} Mood",       prompt: "What is the overall mood and emotional atmosphere of the current scene?" },
    { label: "\u{1F3B2} Random Event", prompt: "Generate a sudden, dramatic random event that completely disrupts the current scene. It should be unexpected and force all characters to react immediately. Be creative and surprising.", inject: true },
    { label: "\u{26A1} Plot Twist",   prompt: "Create a shocking plot twist or revelation that radically changes the story's direction. It should recontextualize previous events or introduce a dramatic new element.", inject: true }
];

var DEFAULTS = {
    enabled: true, showButton: true,
    promptWithCtx: PROMPT_WITH_CONTEXT, promptNoCtx: PROMPT_NO_CONTEXT,
    useContext: true, conversationMode: true, maxContextMessages: 10,
    shortcuts: null,
    floatingMode: false, modalWidth: 660, modalHeight: 520,
    modalPosX: -1, modalPosY: -1,
    mainFontSize: 14,
    visualizePresetId: "",
    enforcePromptLimit: true, maxPromptTokens: 8192
};

var settings      = null;
var extSettings   = null;
var saveFn        = null;
var scriptModule  = null;
var genRaw        = null;
var genQuiet      = null;
var getHeadersFn  = null;
var getContextFn  = null;
var translateFn   = null;
var busy          = false;
var msgId         = 0;
var convo         = [];

/* ================ GENERATION CALL HELPERS ================ */

/**
 * ST moved generateRaw/generateQuietPrompt from positional arguments to a
 * single options object. Both signatures are destructured with defaults, so
 * the object-API versions report `fn.length === 0` while the old positional
 * ones report a non-zero arity. Detect once instead of calling twice inside a
 * try/catch (the old fallback re-ran generation on *any* error, including API
 * errors, which cost a second request per failure).
 */
function usesObjectApi(fn) { return typeof fn === "function" && fn.length === 0; }

/**
 * Raw generation: only the system prompt + our prompt are sent. No character
 * card, no persona, no post-history instructions (jailbreak), no "{{char}}:"
 * prefix. This is what an OOC answer must use.
 */
function callRaw(prompt, systemPrompt) {
    if (!genRaw) return null;
    if (usesObjectApi(genRaw)) return genRaw({ prompt: prompt, systemPrompt: systemPrompt || "" });
    return genRaw(prompt, null, false, false, systemPrompt || "");
}

/**
 * Quiet generation: runs the full ST pipeline (card, persona, world info,
 * jailbreak, force_name2). Use it only when the answer is *supposed* to be
 * in character.
 */
function callQuiet(prompt) {
    if (!genQuiet) return null;
    if (usesObjectApi(genQuiet)) return genQuiet({ quietPrompt: prompt });
    return genQuiet(prompt);
}

function L() { console.log.apply(console, ["[DirectAsk]"].concat(Array.from(arguments))); }
function W() { console.warn.apply(console, ["[DirectAsk]"].concat(Array.from(arguments))); }
function E() { console.error.apply(console, ["[DirectAsk]"].concat(Array.from(arguments))); }
function cloneShortcuts(a) { return JSON.parse(JSON.stringify(a)); }

/* ================ TOKEN BUDGET ================ */

/**
 * Estimate the number of tokens in a string.
 * Tries to use SillyTavern's built-in tokenizer (getTokenCount on the global
 * context or window). If unavailable, falls back to a rough char/4 estimate,
 * which is conservative for English-like text and a reasonable approximation
 * for most LLM tokenizers.
 */
function estimateTokens(text) {
    if (!text) return 0;
    try {
        if (getContextFn) {
            var ctx = getContextFn();
            if (ctx && typeof ctx.getTokenCount === "function") {
                var n = ctx.getTokenCount(text);
                if (typeof n === "number" && isFinite(n) && n >= 0) return n;
            }
        }
        if (typeof window !== "undefined" && typeof window.getTokenCount === "function") {
            var n2 = window.getTokenCount(text);
            if (typeof n2 === "number" && isFinite(n2) && n2 >= 0) return n2;
        }
    } catch (e) { /* fall through to estimate */ }
    return Math.ceil(text.length / 4);
}

L("File loaded");

/* ================ BOOTSTRAP ================ */

jQuery(function () { L("jQuery ready"); initAll(); });

async function initAll() {
    try {
        await loadModules();
        await initTranslation();
        loadSettings();
        buildModal();
        buildSettingsPanel();
        buildChatButton();
        await loadSlashCommands();
        bindKeys();
        L("Fully loaded!");
    } catch (e) { E("Init error:", e); }
}

async function loadModules() {
    try {
        var m = await import("../../../extensions.js");
        extSettings = m.extension_settings;
        saveFn = m.saveSettingsDebounced;
        if (typeof m.getContext === "function") getContextFn = m.getContext;
        L("extensions.js OK, getContext:", !!getContextFn);
    } catch (e) { W("extensions.js failed:", e.message); }

    try {
        scriptModule = await import("../../../../script.js");
        if (typeof scriptModule.generateRaw === "function") genRaw = scriptModule.generateRaw;
        if (typeof scriptModule.generateQuietPrompt === "function") genQuiet = scriptModule.generateQuietPrompt;
        if (typeof scriptModule.getRequestHeaders === "function") getHeadersFn = scriptModule.getRequestHeaders;
        L("script.js OK | raw:", !!genRaw, "| quiet:", !!genQuiet,
          "| chat:", !!scriptModule.chat,
          "| addOneMessage:", typeof scriptModule.addOneMessage === "function",
          "| saveChatConditional:", typeof scriptModule.saveChatConditional === "function");
    } catch (e) { W("script.js failed:", e.message); }
}

/* ================ TRANSLATION ================ */

async function initTranslation() {
    try {
        var tMod = await import("../../translate/index.js");
        if (typeof tMod.translate === "function") {
            translateFn = tMod.translate; L("Translate: direct import OK"); return;
        }
    } catch (e) {}

    var headers = await makeHeaders();
    var body = JSON.stringify({ text: "test", lang: "en" });
    var eps = ["/api/translate", "/api/translate/", "/api/translate/translate",
               "/api/plugins/translate", "/api/plugins/translate/", "/api/plugins/translate/translate"];
    for (var i = 0; i < eps.length; i++) {
        try {
            var r = await fetch(eps[i], { method: "POST", headers: headers, body: body });
            if (r.ok) {
                var url = eps[i];
                translateFn = function (t, l) { return apiTranslate(t, l, url); };
                return;
            }
        } catch (e) {}
    }
}

async function makeHeaders() {
    if (getHeadersFn) try { return getHeadersFn(); } catch (e) {}
    var h = { "Content-Type": "application/json" };
    try { var r = await fetch("/csrf-token"); if (r.ok) { var d = await r.json(); if (d.token) h["X-CSRF-Token"] = d.token; } } catch (e) {}
    return h;
}

async function apiTranslate(text, lang, url) {
    var r = await fetch(url, { method: "POST", headers: await makeHeaders(), body: JSON.stringify({ text: text, lang: lang }) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var t = await r.text();
    try { var j = JSON.parse(t); if (typeof j === "string") return j; if (j.text) return j.text; } catch (e) {}
    return t;
}

async function translateText(text, lang) {
    if (translateFn) return await translateFn(text, lang);
    throw new Error("Translation not available.");
}

function getTargetLang() {
    if (extSettings && extSettings.translate && extSettings.translate.target_language) return extSettings.translate.target_language;
    return "ru";
}

/* ================ SETTINGS ================ */

function loadSettings() {
    if (extSettings) {
        if (!extSettings[MODULE]) extSettings[MODULE] = {};
        var keys = Object.keys(DEFAULTS);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (extSettings[MODULE][k] === undefined || extSettings[MODULE][k] === null)
                extSettings[MODULE][k] = (k === "shortcuts") ? cloneShortcuts(DEFAULT_SHORTCUTS) : DEFAULTS[k];
        }
        settings = extSettings[MODULE];
    } else {
        settings = {};
        var keys2 = Object.keys(DEFAULTS);
        for (var j = 0; j < keys2.length; j++) {
            var k2 = keys2[j];
            settings[k2] = (k2 === "shortcuts") ? cloneShortcuts(DEFAULT_SHORTCUTS) : DEFAULTS[k2];
        }
    }

    if (settings.shortcuts && settings.shortcuts.length > 0) {
        var hasInject = false;
        for (var s = 0; s < settings.shortcuts.length; s++) {
            if (settings.shortcuts[s].inject) { hasInject = true; break; }
        }
        if (!hasInject) {
            for (var d = 0; d < DEFAULT_SHORTCUTS.length; d++) {
                if (DEFAULT_SHORTCUTS[d].inject) {
                    settings.shortcuts.push({
                        label: DEFAULT_SHORTCUTS[d].label,
                        prompt: DEFAULT_SHORTCUTS[d].prompt,
                        inject: true
                    });
                }
            }
            save();
        }
    }
}

function save() { if (saveFn) saveFn(); }

function normalizeMainFontSize(value) {
    var size = parseInt(value, 10);
    if (!isFinite(size)) size = DEFAULTS.mainFontSize;
    return Math.min(32, Math.max(10, size));
}

function applyMainFontSize() {
    var size = normalizeMainFontSize(settings && settings.mainFontSize);
    if (settings) settings.mainFontSize = size;
    var modal = document.getElementById("direct-ask-modal");
    if (modal) modal.style.setProperty("--da-main-font-size", size + "px");
    $("#da-opt-font-size").val(size);
    $("#da-font-val").text(size);
    $(".da-font-dec").attr("title", "Decrease font size (" + size + " px)");
    $(".da-font-inc").attr("title", "Increase font size (" + size + " px)");
}

function setMainFontSize(value) {
    settings.mainFontSize = normalizeMainFontSize(value);
    applyMainFontSize();
    save();
}

/* ================ TARGET (CHARACTER) SELECTOR ================ */

/* Pure (v1.0.5). Who can be interviewed: the characters of THE OPEN CHAT — the
   solo character, or the members of the open group, in the group's order.
   A group used to offer `ctx.characters`, which is every card installed, so
   the list was the whole library whatever chat was open. Nothing is filtered
   by kind: a narrator card or a location card that sits in the group is in
   the chat like anyone else (and is often the one worth asking). Muted
   members are listed too — muted is not absent.
   null means "the context cannot say" (a group whose record is not loaded);
   the caller then falls back to the names that have spoken in the chat. */
function daChatTargets(ctx) {
    if (!ctx) return null;
    var chars = Array.isArray(ctx.characters) ? ctx.characters : [];
    var out = [];
    var add = function (name) {
        name = String(name == null ? "" : name).trim();
        if (name && out.indexOf(name) === -1) out.push(name);
    };
    if (ctx.groupId) {
        var groups = Array.isArray(ctx.groups) ? ctx.groups : [], group = null;
        for (var g = 0; g < groups.length; g++) {
            if (groups[g] && String(groups[g].id) === String(ctx.groupId)) { group = groups[g]; break; }
        }
        if (!group || !Array.isArray(group.members)) return null;
        for (var m = 0; m < group.members.length; m++) {
            for (var i = 0; i < chars.length; i++) {
                if (chars[i] && chars[i].avatar === group.members[m]) { add(chars[i].name); break; }
            }
        }
        return out;
    }
    var chid = ctx.characterId;
    if (chid !== undefined && chid !== null && chid !== "" && chars[chid]) add(chars[chid].name);
    else if (ctx.name2 && chid !== undefined && chid !== null && chid !== "") add(ctx.name2);
    return out;
}

function updateTargetList() {
    var $sel = $("#da-target-select");
    if (!$sel.length) return;
    
    var currentVal = $sel.val();
    $sel.empty();
    $sel.append('<option value="assistant">🤖 AI Assistant (OOC)</option>');

    var chars = [];
    var known = null;       /* null: the context could not say who is in the chat */

    if (getContextFn) {
        try { known = daChatTargets(getContextFn()); } catch(e) { known = null; }
    }
    if (known) chars = known;

    if (known === null && scriptModule && scriptModule.chat) {
        var userName = getContextFn ? ((getContextFn() || {}).name1 || "User") : "User";
        for(var j = 0; j < scriptModule.chat.length; j++) {
            var n = scriptModule.chat[j].name;
            if(n && n !== userName && n !== "System" && n !== "Narrator" && chars.indexOf(n) === -1) {
                chars.push(n);
            }
        }
    }

    var uniqueChars = [];
    for(var k = 0; k < chars.length; k++) {
        if(uniqueChars.indexOf(chars[k]) === -1) uniqueChars.push(chars[k]);
    }

    for (var c = 0; c < uniqueChars.length; c++) {
        var cName = uniqueChars[c];
        $sel.append('<option value="' + esc(cName) + '">🎭 ' + esc(cName) + '</option>');
    }

    if (currentVal && $sel.find('option[value="' + esc(currentVal) + '"]').length) {
        $sel.val(currentVal);
    }
}

/* ================ GENERATION ================ */

async function askLLM(question) {
    var target = $("#da-target-select").val() || "assistant";
    var isCharacter = (target !== "assistant");
    
    var useCtx = isCharacter ? true : settings.useContext; 
    
    var sysPrompt = "";
    var oocReminder = "";
    if (isCharacter) {
        sysPrompt = PROMPT_CHARACTER_INTERVIEW.replace(/\{\{char\}\}/g, target);
    } else {
        sysPrompt = useCtx ? settings.promptWithCtx : settings.promptNoCtx;
        var oocChar = "";
        try { oocChar = ((getContextFn && getContextFn()) || {}).name2 || ""; } catch (e) {}
        oocReminder = PROMPT_OOC_REMINDER.replace(/\{\{char\}\}/g, oocChar || "the character");
    }
    
    // Body only — the system instruction is passed separately (as a real
    // system message for the OOC path) and re-prepended for the quiet path.
    var prompt = "";

    if (useCtx && getContextFn) {
        try {
            var ctx = getContextFn();
            if (ctx) {
                var playerName = ctx.name1 || "User";
                var charName = ctx.name2 || "";
                
                if (isCharacter) {
                    prompt += "[System Note: The player interviewing you is named \"" + playerName + "\". Answer their question directly as " + target + ".]\n\n";
                } else {
                    prompt += "[PLAYER INFO: The player's character is named \"" + playerName + "\". ";
                    if (ctx.groupId) {
                        prompt += "This is a GROUP CHAT with multiple AI characters. ";
                        prompt += "IMPORTANT: When describing POV, what someone sees, location, etc. — ";
                        prompt += "ALWAYS answer from \"" + playerName + "\"'s perspective (the PLAYER). ";
                        prompt += "Do NOT answer from any NPC's or AI character's perspective. ";
                        prompt += "\"" + playerName + "\" is the player, everyone else are NPCs.";
                    } else if (charName) {
                        prompt += "The AI character is \"" + charName + "\". ";
                        prompt += "Answer about the scene from \"" + playerName + "\"'s perspective.";
                    }
                    prompt += "]\n\n";
                }
            }
        } catch (e) {}
    }

    if (useCtx && scriptModule && scriptModule.chat && scriptModule.chat.length > 0) {
        var stChat = scriptModule.chat;
        var rpHeader = "--- RECENT STORY EVENTS & CONTEXT ---\n";
        var rpFooter = "--------------------------------------\n\n";

        // Build a budget for the RP history segment so the final prompt
        // stays within the user's configured token limit. The budget is
        // computed against the prompt as-it-stands plus a small reserve for
        // the conversation block and the trailing "User: ... Assistant:".
        var limitOn = !!(settings && settings.enforcePromptLimit);
        var maxTokens = (settings && settings.maxPromptTokens) || 0;
        var maxMessages = 15; // legacy hard cap, also the cap when limit is off
        var historyBudget = Infinity;

        if (limitOn && maxTokens > 0) {
            var reserveText = "User: " + question + "\n" + oocReminder + "\n" + (isCharacter ? target : "Assistant") + ":";
            if (settings.conversationMode && convo.length > 0) {
                var slicePreview = convo.slice(-settings.maxContextMessages);
                for (var ci = 0; ci < slicePreview.length; ci++) {
                    reserveText += slicePreview[ci].role + ": " + slicePreview[ci].content + "\n\n";
                }
            }
            var used = estimateTokens(sysPrompt) + estimateTokens(prompt) + estimateTokens(rpHeader) + estimateTokens(rpFooter) + estimateTokens(reserveText);
            historyBudget = Math.max(0, maxTokens - used);
            // Allow a much larger window of candidate messages when the
            // budget controls the cut-off — limit only by the budget itself.
            maxMessages = stChat.length;
        }

        // Walk the chat newest-first; keep adding messages while they fit
        // the budget. Drop the oldest first, preserve the most recent.
        var lines = [];
        var usedHistoryTokens = 0;
        var lookback = Math.min(stChat.length, maxMessages);
        for (var k = stChat.length - 1; k >= stChat.length - lookback; k--) {
            var msgName2 = stChat[k].name || "System";
            var line = msgName2 + ": " + stChat[k].mes + "\n\n";
            var lineTokens = estimateTokens(line);
            if (limitOn && (usedHistoryTokens + lineTokens > historyBudget)) {
                // No more room. Stop walking back further — older messages
                // would only make it worse.
                break;
            }
            lines.push(line);
            usedHistoryTokens += lineTokens;
        }

        if (lines.length > 0) {
            prompt += rpHeader;
            // lines were collected newest-first; flip to chronological order
            for (var m = lines.length - 1; m >= 0; m--) prompt += lines[m];
            prompt += rpFooter;
            if (limitOn && lines.length < stChat.length) {
                L("RP history truncated: kept " + lines.length + " / " + stChat.length + " messages (~" + usedHistoryTokens + " tokens, budget " + historyBudget + ")");
            }
        } else if (limitOn) {
            L("RP history skipped entirely: prompt is already at/over the token limit (" + maxTokens + ").");
        }
    }

    if (settings.conversationMode && convo.length > 0) {
        prompt += "--- Previous questions in this direct session ---\n";
        var slice = convo.slice(-settings.maxContextMessages);
        for (var i = 0; i < slice.length; i++) {
            prompt += slice[i].role + ": " + slice[i].content + "\n\n";
        }
        prompt += "--- Current interaction ---\n";
    }

    prompt += "User: " + question + "\n";
    if (!isCharacter) prompt += oocReminder + "\n";
    prompt += (isCharacter ? target : "Assistant") + ":";

    // Final safety net: log a warning if the prompt is still over the user's
    // budget after history truncation (e.g. huge character card + huge sys
    // prompt + huge conversation history). We don't silently mutilate those
    // segments — but the user gets a clear log entry to act on.
    if (settings && settings.enforcePromptLimit && settings.maxPromptTokens > 0) {
        var finalTokens = estimateTokens(sysPrompt) + estimateTokens(prompt);
        if (finalTokens > settings.maxPromptTokens) {
            W("Prompt is still over the configured limit after truncation: ~" +
              finalTokens + " > " + settings.maxPromptTokens +
              " tokens. Consider lowering character card size, conversation history, or raising the limit.");
            if (typeof toastr !== "undefined") {
                toastr.warning("Direct Ask: prompt (~" + finalTokens + " tok) exceeds the configured limit (" + settings.maxPromptTokens + "). The API may reject it.");
            }
        }
    }

    var answer;

    if (isCharacter) {
        // Interview mode: the answer is *supposed* to be in character, so the
        // full ST pipeline (card, persona, world info) is exactly what we want.
        if (!genQuiet) throw new Error("generateQuietPrompt not available. Check API.");
        answer = await callQuiet(sysPrompt + "\n\n" + prompt);
    } else {
        // OOC assistant: never go through generateQuietPrompt. It runs the
        // whole character pipeline — card, persona, post-history instructions
        // ("stay in character") and force_name2 — all of which sit *after* our
        // OOC instruction and drag the reply back into the character's voice.
        // generateRaw sends only systemPrompt + our prompt.
        if (genRaw) {
            answer = await callRaw(prompt, sysPrompt);
        } else if (genQuiet) {
            W("generateRaw unavailable — falling back to generateQuietPrompt. The answer may come out in character.");
            answer = await callQuiet(sysPrompt + "\n\n" + prompt);
        } else {
            throw new Error("No generation function. Connect an API first.");
        }
    }

    if (settings.conversationMode) {
        convo.push({ role: "User", content: question });
        convo.push({ role: isCharacter ? target : "Assistant", content: answer });
        while (convo.length > settings.maxContextMessages) convo.shift();
    }

    return answer;
}

/* ================ NARRATION + INJECTION ================ */

async function generateNarration(instruction) {
    if (!genQuiet) throw new Error("Generation not available. Connect an API first.");
    var prompt =
        "[OOC Narrator instruction for the story:\n" + instruction +
        "\n\nIMPORTANT: Write ONLY the in-character narrative scene/event description. " +
        "Do NOT break character. Do NOT add any OOC notes or explanations. " +
        "Write as the story's narrator, matching the existing language, writing style, " +
        "and tone. Write 2-3 vivid paragraphs.]";
    // Narration is meant to be in-story, so the full pipeline is correct here.
    return await callQuiet(prompt);
}

async function injectToChat(text) {
    if (!scriptModule) throw new Error("Script module not loaded.");
    var chat = scriptModule.chat;
    var addOneMsg = scriptModule.addOneMessage;
    var saveChat = scriptModule.saveChatConditional || scriptModule.saveChatDebounced;
    if (!chat || typeof addOneMsg !== "function") throw new Error("Chat functions not available.");

    var msg = {
        name: "Narrator",
        is_user: false,
        is_system: false,
        send_date: new Date().toLocaleString("en-US", {
            year: "numeric", month: "long", day: "numeric",
            hour: "numeric", minute: "numeric", second: "numeric", hour12: true
        }),
        mes: text,
        extra: { type: "narrator", isSmallSys: false }
    };

    chat.push(msg);
    addOneMsg(msg);
    if (typeof saveChat === "function") await saveChat();
}

/* ================ HELPERS ================ */

function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

function fmt(t) {
    if (!t) return "<em>No response</em>";
    var h = esc(t);
    h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>");
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\n/g, "<br>");
    return h;
}

/* ================ MODAL ================ */

function buildModal() {
    if (document.getElementById("direct-ask-modal")) return;
    var h = '';
    h += '<div id="direct-ask-modal" style="display:none">';
    h += '<div class="da-overlay"></div><div class="da-dialog">';
    h += '<div class="da-header"><div class="da-title"><i class="fa-solid fa-robot"></i> <span>Direct Ask</span></div>';
    h += '<div class="da-header-actions">';
    h += '<button class="da-font-btn da-font-dec menu_button" title="Decrease font size" aria-label="Decrease font size">A&minus;</button>';
    h += '<button class="da-font-btn da-font-inc menu_button" title="Increase font size" aria-label="Increase font size">A+</button>';
    h += '<button class="da-clear-btn menu_button" title="Clear"><i class="fa-solid fa-trash-can"></i></button>';
    h += '<button class="da-close-btn menu_button" title="Close"><i class="fa-solid fa-xmark"></i></button>';
    h += '</div></div>';
    h += '<div class="da-body"><div id="da-conversation" class="da-conversation">';
    h += '<div class="da-welcome"><i class="fa-solid fa-comment-dots"></i>';
    h += '<p>Ask the AI anything — as an assistant, or interview a character.</p>';
    h += '<p class="da-hint">Use quick shortcuts or type your own question.</p>';
    h += '</div></div></div>';
    h += '<div class="da-options-bar">';
    
    h += '<select id="da-target-select" class="da-target-select" title="Who to ask?"></select>';
    
    h += '<label class="da-ctx-toggle" title="When ON: AI sees chat history and character info">';
    h += '<input type="checkbox" id="da-use-ctx">';
    h += '<span class="da-ctx-label-text"><i class="fa-solid fa-book-open"></i> RP context</span>';
    h += '</label>';
    h += '<span class="da-ctx-hint" id="da-ctx-hint"></span></div>';
    h += '<div class="da-shortcuts-bar" id="da-shortcuts-bar"><div class="da-shortcuts-scroll" id="da-shortcuts-scroll"></div></div>';
    
    h += '<input type="file" id="da-file-hidden" style="display:none" accept="image/*, .txt, .md, .json, .js, .css, .html, .py, .xml, .csv">';
    
    h += '<div class="da-footer">';
    h += '<button id="da-file-btn" class="da-file-btn" title="Attach File / Image"><i class="fa-solid fa-paperclip"></i></button>';
    h += '<div id="da-file-preview" class="da-file-preview" style="display:none;"></div>';
    h += '<textarea id="da-input" class="da-input" placeholder="Type your question..." rows="1"></textarea>';
    h += '<button id="da-send" class="da-send-btn" title="Send"><i class="fa-solid fa-paper-plane"></i></button>';
    h += '</div></div></div>';

    document.body.insertAdjacentHTML("beforeend", h);
    applyMainFontSize();
    $("#da-use-ctx").prop("checked", settings.useContext);
    updateCtxHint(); renderShortcuts();

    $(document).on("click", ".da-overlay", function () { if (!settings.floatingMode) hideModal(); });
    $(document).on("click", ".da-close-btn", function () { hideModal(); });
    $(document).on("click", ".da-clear-btn", clearChat);
    $(document).on("click", ".da-font-dec", function () { setMainFontSize(settings.mainFontSize - 1); });
    $(document).on("click", ".da-font-inc", function () { setMainFontSize(settings.mainFontSize + 1); });
    $(document).on("click", "#da-send", doSend);
    
    $(document).on("change", "#da-target-select", function() {
        if ($(this).val() !== "assistant") {
            $("#da-use-ctx").prop("disabled", true).prop("checked", true);
            $("#da-ctx-hint").text("Forced on for character").addClass("da-ctx-on").removeClass("da-ctx-off");
        } else {
            $("#da-use-ctx").prop("disabled", false).prop("checked", settings.useContext);
            updateCtxHint();
        }
    });
    
    $(document).on("click", "#da-file-btn", function() { $("#da-file-hidden").click(); });
    $(document).on("change", "#da-file-hidden", handleFileSelect);
    $(document).on("click", "#da-file-preview", clearFilePreview);

    $(document).on("change", "#da-use-ctx", function () {
        settings.useContext = this.checked; save(); updateCtxHint();
        $("#da-opt-ctx").prop("checked", this.checked);
    });
    $(document).on("click", ".da-shortcut", function () {
        if (busy) return;
        var idx = parseInt($(this).attr("data-index"), 10);
        if (idx >= 0 && idx < settings.shortcuts.length) sendShortcut(settings.shortcuts[idx]);
    });
    $(document).on("click", ".da-copy-btn", function () {
        var t = $(this).closest(".da-message").find(".da-msg-content").text();
        navigator.clipboard.writeText(t).then(function () { if (typeof toastr !== "undefined") toastr.info("Copied!"); });
    });

    $(document).on("click", ".da-translate-btn", function () {
        var $btn = $(this), $msg = $btn.closest(".da-message"), $c = $msg.find(".da-msg-content");
        var $ex = $c.find(".da-translation");
        if ($ex.length) { $ex.toggle(); $btn.toggleClass("da-translated"); return; }
        var raw = $msg.data("raw-text") || $c.text();
        if (!raw || !raw.trim()) return;
        if (!$c.find(".da-msg-original").length) $c.wrapInner('<div class="da-msg-original"></div>');
        $c.append('<div class="da-translation"><span class="da-translation-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Translating...</span></div>');
        $btn.prop("disabled", true);
        translateText(raw, getTargetLang()).then(function (tr) {
            $c.find(".da-translation").html('<div class="da-translation-divider"><span>translation</span></div><div class="da-translated-text">' + esc(tr).replace(/\n/g, "<br>") + '</div>');
            $btn.addClass("da-translated").prop("disabled", false);
        }).catch(function (e) {
            $c.find(".da-translation").html('<span class="da-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</span>');
            $btn.prop("disabled", false);
        });
        scrollDown();
    });

    $(document).on("click", ".da-visualize-btn", function () {
        var $msg = $(this).closest(".da-message");
        var raw = $msg.data("raw-text") || $msg.find(".da-msg-content").text();
        if (!raw || !raw.trim()) return;
        visualizeResponse($msg.attr("id"), raw);
    });

    $(document).on("click", ".da-inject-btn", function () {
        var $btn = $(this), $msg = $btn.closest(".da-message");
        if ($btn.hasClass("da-injected")) {
            if (typeof toastr !== "undefined") toastr.info("Already injected.");
            return;
        }
        var raw = $msg.data("raw-text") || $msg.find(".da-msg-content").text();
        if (!raw || !raw.trim()) return;
        $btn.prop("disabled", true);
        injectToChat(raw).then(function () {
            $btn.addClass("da-injected").prop("disabled", false).attr("title", "Injected \u2713");
            $btn.find("i").removeClass("fa-share-from-square").addClass("fa-check");
            if (typeof toastr !== "undefined") toastr.success("Injected into RP chat as Narrator!");
        }).catch(function (e) {
            $btn.prop("disabled", false);
            if (typeof toastr !== "undefined") toastr.error("Inject failed: " + e.message);
        });
    });

    $(document).on("click", ".da-viz-img", function () {
        var src = $(this).attr("src");
        if (!src) return;
        $("#da-lightbox").remove();
        var lb = '<div id="da-lightbox"><div class="da-lb-overlay"></div><div class="da-lb-content"><img src="' + src + '" class="da-lb-img"><button class="da-lb-close" title="Close"><i class="fa-solid fa-xmark"></i></button></div></div>';
        document.body.insertAdjacentHTML("beforeend", lb);
        setTimeout(function () { $("#da-lightbox").addClass("da-lb-visible"); }, 10);
    });
    $(document).on("click", ".da-lb-overlay, .da-lb-close", function () {
        var $lb = $("#da-lightbox");
        $lb.removeClass("da-lb-visible");
        setTimeout(function () { $lb.remove(); }, 220);
    });
    $(document).on("keydown.da-lb", function (e) {
        if (e.key === "Escape" && $("#da-lightbox").length) {
            var $lb = $("#da-lightbox");
            $lb.removeClass("da-lb-visible");
            setTimeout(function () { $lb.remove(); }, 220);
        }
    });

    $(document).on("keydown", "#da-input", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
    $(document).on("input", "#da-input", function () { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 120) + "px"; });
    $(document).on("keydown", function (e) { if (e.key === "Escape" && $("#direct-ask-modal").is(":visible")) hideModal(); });

    initModalDrag();
    initModalResize();
}

function handleFileSelect(e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    
    if (file.type.startsWith('image/')) {
        reader.onload = function(e) {
            var base64 = e.target.result;
            $("#da-file-preview").html('<img src="' + base64 + '" alt="preview"><div class="da-file-remove" title="Remove"><i class="fa-solid fa-xmark"></i></div>').show();
            $("#da-file-preview").data('file-data', base64);
            $("#da-file-preview").data('file-name', file.name);
            $("#da-file-preview").data('file-type', 'image');
        };
        reader.readAsDataURL(file);
    } else {
        reader.onload = function(e) {
            var text = e.target.result;
            $("#da-file-preview").html('<div class="da-file-text-icon"><i class="fa-solid fa-file-code"></i></div><span>' + esc(file.name) + '</span><div class="da-file-remove" title="Remove"><i class="fa-solid fa-xmark"></i></div>').show();
            $("#da-file-preview").data('file-data', text);
            $("#da-file-preview").data('file-name', file.name);
            $("#da-file-preview").data('file-type', 'text');
        };
        reader.readAsText(file);
    }
}

function clearFilePreview() {
    $("#da-file-preview").hide().empty().removeData();
    $("#da-file-hidden").val(''); 
}

function renderShortcuts() {
    var $bar = $("#da-shortcuts-bar"), $s = $("#da-shortcuts-scroll"); $s.empty();
    if (!settings.shortcuts || !settings.shortcuts.length) { $bar.hide(); return; }
    $bar.show();
    for (var i = 0; i < settings.shortcuts.length; i++) {
        var sc = settings.shortcuts[i];
        var cls = "da-shortcut interactable" + (sc.inject ? " da-shortcut-inject" : "");
        $s.append('<button class="' + cls + '" data-index="' + i + '" title="' + esc(sc.prompt) + '">' + esc(sc.label) + '</button>');
    }
}

function sendShortcut(sc) {
    if (busy || !settings.enabled) return;
    if (sc.inject) { sendInjectShortcut(sc); return; }

    var target = $("#da-target-select").val() || "assistant";
    var isCharacter = (target !== "assistant");

    var ctxTag = '';
    if (isCharacter) {
        ctxTag = ' <span class="da-tag da-tag-char">@' + esc(target) + '</span>';
    } else {
        ctxTag = settings.useContext ? ' <span class="da-tag da-tag-rp">RP</span>' : ' <span class="da-tag da-tag-gen">General</span>';
    }
    
    $(".da-welcome").remove();
    addMsg("user", '<span class="da-sc-sent">' + esc(sc.label) + '</span>' + ctxTag + '<br><span class="da-sc-prompt-preview">' + esc(sc.prompt) + '</span>');
    busy = true; setInputsDisabled(true);
    
    var lid = addMsg("assistant", '<span class="da-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Generating...</span>', isCharacter ? target : null);
    
    askLLM(sc.prompt).then(function (a) {
        $("#" + lid).data("raw-text", a);
        $("#" + lid + " .da-msg-content").html(fmt(a));
    }).catch(function (e) {
        $("#" + lid + " .da-msg-content").html('<span class="da-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</span>'); E(e);
    }).finally(function () { busy = false; setInputsDisabled(false); scrollDown(); });
}

function sendInjectShortcut(sc) {
    $(".da-welcome").remove();
    addMsg("user", '<span class="da-sc-sent">' + esc(sc.label) + '</span> <span class="da-tag da-tag-inject">INJECT</span><br><span class="da-sc-prompt-preview">' + esc(sc.prompt) + '</span>');
    busy = true; setInputsDisabled(true);
    var lid = addMsg("assistant", '<span class="da-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Generating event...</span>');
    generateNarration(sc.prompt).then(function (text) {
        $("#" + lid).data("raw-text", text);
        $("#" + lid + " .da-msg-content").html(fmt(text));
        return injectToChat(text).then(function () {
            $("#" + lid + " .da-inject-btn").addClass("da-injected").attr("title", "Injected \u2713");
            $("#" + lid + " .da-inject-btn i").removeClass("fa-share-from-square").addClass("fa-check");
            if (typeof toastr !== "undefined") toastr.success("\u2705 Event injected into RP chat!");
        });
    }).catch(function (e) {
        $("#" + lid + " .da-msg-content").html('<span class="da-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</span>'); E(e);
    }).finally(function () { busy = false; setInputsDisabled(false); scrollDown(); });
}

function setInputsDisabled(on) {
    $("#da-input").prop("disabled", on);
    $("#da-send").prop("disabled", on).toggleClass("da-disabled", on);
    $(".da-shortcut").toggleClass("da-disabled", on);
    $("#da-file-btn").prop("disabled", on);
    $("#da-target-select").prop("disabled", on);
}

function updateCtxHint() {
    var target = $("#da-target-select").val() || "assistant";
    if (target !== "assistant") return; 
    
    if (settings.useContext) {
        $("#da-ctx-hint").text("AI sees the story").removeClass("da-ctx-off").addClass("da-ctx-on");
        $(".da-ctx-toggle").addClass("da-ctx-active");
    } else {
        $("#da-ctx-hint").text("General knowledge only").removeClass("da-ctx-on").addClass("da-ctx-off");
        $(".da-ctx-toggle").removeClass("da-ctx-active");
    }
}

function hideModal() { $("#direct-ask-modal").fadeOut(150); }

function showModal(on) {
    if (on) { 
        updateTargetList();
        applyModalMode();
        $("#direct-ask-modal").fadeIn(150); 
        setTimeout(function () { $("#da-input").trigger("focus"); }, 200); 
    }
    else { hideModal(); }
}

function applyModalMode() {
    var $modal = $("#direct-ask-modal");
    var $dialog = $modal.find(".da-dialog");
    if (settings.floatingMode) {
        $modal.addClass("da-floating");
        var w = Math.max(320, settings.modalWidth || 660);
        var h = Math.max(280, settings.modalHeight || 520);
        $dialog.css({ width: w + "px", height: h + "px", maxWidth: "none", maxHeight: "none" });
        var px = settings.modalPosX, py = settings.modalPosY;
        if (px >= 0 && py >= 0) {
            px = Math.min(px, window.innerWidth - 100);
            py = Math.min(py, window.innerHeight - 50);
            $dialog.css({ left: px + "px", top: py + "px" });
        } else {
            $dialog.css({ left: Math.max(0, (window.innerWidth - w) / 2) + "px", top: Math.max(0, (window.innerHeight - h) / 2) + "px" });
        }
    } else {
        $modal.removeClass("da-floating");
        $dialog.css({ width: "", height: "", maxWidth: "", maxHeight: "", left: "", top: "" });
    }
}

function initModalDrag() {
    var $dialog = $("#direct-ask-modal .da-dialog");
    var $header = $("#direct-ask-modal .da-header");
    var dragging = false, startX, startY, origLeft, origTop;
    $header.on("mousedown", function (e) {
        if (!settings.floatingMode) return;
        if ($(e.target).closest("button").length) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        var r = $dialog[0].getBoundingClientRect();
        origLeft = r.left; origTop = r.top;
        $("body").addClass("da-dragging");
        e.preventDefault();
    });
    $(document).on("mousemove.da-drag", function (e) {
        if (!dragging) return;
        var nx = Math.max(0, Math.min(window.innerWidth - 100, origLeft + e.clientX - startX));
        var ny = Math.max(0, Math.min(window.innerHeight - 50, origTop + e.clientY - startY));
        $dialog.css({ left: nx + "px", top: ny + "px" });
    });
    $(document).on("mouseup.da-drag", function () {
        if (!dragging) return;
        dragging = false;
        $("body").removeClass("da-dragging");
        var r = $dialog[0].getBoundingClientRect();
        settings.modalPosX = Math.round(r.left);
        settings.modalPosY = Math.round(r.top);
        save();
    });
}

function initModalResize() {
    var el = document.querySelector("#direct-ask-modal .da-dialog");
    if (!el || !window.ResizeObserver) return;
    var ro = new ResizeObserver(function (entries) {
        if (!settings.floatingMode || !$("#direct-ask-modal").is(":visible")) return;
        var cr = entries[0].contentRect;
        settings.modalWidth = Math.round(cr.width);
        settings.modalHeight = Math.round(cr.height);
        save();
    });
    ro.observe(el);
}

function clearChat() {
    convo.length = 0; msgId = 0;
    $("#da-conversation").html('<div class="da-welcome"><i class="fa-solid fa-comment-dots"></i><p>Ask the AI anything — as an assistant, or interview a character.</p><p class="da-hint">Use quick shortcuts or type your own question.</p></div>');
}

function addMsg(role, content, customName) {
    $(".da-welcome").remove();
    var id = "da-msg-" + (msgId++), isU = (role === "user");
    var isChar = !isU && customName && customName !== "Assistant";
    
    var icon = isU ? "fa-user" : (isChar ? "fa-masks-theater" : "fa-robot");
    var name = isU ? "You" : (isChar ? customName : "Assistant");
    var extraCls = isChar ? " da-character" : "";
    
    var avatarContent = '<i class="fa-solid ' + icon + '"></i>';
    if (isChar) {
        var avatarFile = null;
        if (typeof characters !== "undefined" && Array.isArray(characters)) {
            for (var i = 0; i < characters.length; i++) {
                if (characters[i].name === customName) {
                    avatarFile = characters[i].avatar;
                    break;
                }
            }
        }
        if (avatarFile) {
            avatarContent = '<img src="/characters/' + encodeURIComponent(avatarFile) + '" class="da-avatar-img" alt="' + esc(customName) + '">';
        }
    }
    
    var btns = "";
    if (!isU) {
        btns += '<button class="da-translate-btn" title="Translate"><i class="fa-solid fa-language"></i></button>';
        btns += '<button class="da-inject-btn" title="Inject into RP chat"><i class="fa-solid fa-share-from-square"></i></button>';
        btns += '<button class="da-visualize-btn" title="Visualize with AutoIllustrator"><i class="fa-solid fa-image"></i></button>';
        btns += '<button class="da-copy-btn" title="Copy"><i class="fa-solid fa-copy"></i></button>';
    }
    
    var m = '<div id="' + id + '" class="da-message da-' + role + extraCls + '"><div class="da-msg-avatar">' + avatarContent + '</div><div class="da-msg-body"><div class="da-msg-meta"><span class="da-msg-name">' + name + '</span>' + btns + '</div><div class="da-msg-content">' + content + '</div>' + ((!isU) ? '<div class="da-img-result" style="display:none"></div>' : '') + '</div></div>';
    
    $("#da-conversation").append(m); scrollDown();
    return id;
}

function scrollDown() {
    var el = document.getElementById("da-conversation");
    if (el) requestAnimationFrame(function () { el.scrollTop = el.scrollHeight; });
}

async function doSend() {
    var $in = $("#da-input"), q = $in.val().trim();
    var $filePrev = $("#da-file-preview");
    var fileData = $filePrev.data('file-data');
    var fileType = $filePrev.data('file-type');
    var fileName = $filePrev.data('file-name');
    
    if (!q && !fileData) return; 
    if (!settings.enabled) { if (typeof toastr !== "undefined") toastr.warning("Direct Ask is disabled."); return; }
    
    busy = true; 
    $in.val("").trigger("input"); 
    setInputsDisabled(true);

    var target = $("#da-target-select").val() || "assistant";
    var isCharacter = (target !== "assistant");

    var ctxTag = '';
    if (isCharacter) {
        ctxTag = ' <span class="da-tag da-tag-char">@' + esc(target) + '</span>';
    } else {
        ctxTag = settings.useContext ? ' <span class="da-tag da-tag-rp">RP</span>' : ' <span class="da-tag da-tag-gen">General</span>';
    }
    
    var userContent = esc(q) + ctxTag;
    
    if (fileData) {
        if (fileType === 'image') {
            userContent += '<br><img src="' + fileData + '" class="da-msg-img-preview" alt="attached image">';
        } else {
            userContent += '<br><div class="da-msg-file-attached"><i class="fa-solid fa-file-code"></i> ' + esc(fileName) + '</div>';
        }
    }

    addMsg("user", userContent);
    clearFilePreview(); 

    var lid = addMsg("assistant", '<span class="da-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Generating...</span>', isCharacter ? target : null);
    try {
        if (fileData && fileType === 'image') {
            // Use the same Caption API as SillyTavern's built-in button
            $("#" + lid + " .da-msg-content").html('<span class="da-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Analyzing image...</span>');
            var caption;
            try {
                caption = await captionImage(fileData);
            } catch (capErr) {
                caption = null;
                if (typeof toastr !== "undefined") toastr.warning("Caption API unavailable: " + capErr.message);
            }

            if (caption && !q) {
                // No text question — display caption directly, without askLLM
                $("#" + lid).data("raw-text", caption);
                $("#" + lid + " .da-msg-content").html(fmt(caption));
            } else {
                // Text question present — pass caption as context to askLLM
                var imageCtx = caption
                    ? "[Image attached: \"" + fileName + "\".\nCaption:\n" + caption + "]\n\n"
                    : "[Image attached: \"" + fileName + "\". Caption unavailable.]\n\n";
                q = imageCtx + (q ? "User question: " + q : "");
                var a = await askLLM(q);
                $("#" + lid).data("raw-text", a);
                $("#" + lid + " .da-msg-content").html(fmt(a));
            }
        } else if (fileData && fileType === 'text') {
            q = "[User attached a file: " + fileName + "]\n\nContent:\n```\n" + fileData + "\n```\n\nUser question: " + q;
            var a = await askLLM(q);
            $("#" + lid).data("raw-text", a);
            $("#" + lid + " .da-msg-content").html(fmt(a));
        } else {
            var a = await askLLM(q);
            $("#" + lid).data("raw-text", a);
            $("#" + lid + " .da-msg-content").html(fmt(a));
        }
    }
    catch (e) { $("#" + lid + " .da-msg-content").html('<span class="da-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</span>'); E(e); }
    busy = false; setInputsDisabled(false); $in.trigger("focus"); scrollDown();
}

/* ================ VISION / IMAGE CAPTION ================ */

async function captionImage(base64DataUrl) {
    var headers = await makeHeaders();
    var icSettings = (extSettings && extSettings["caption"]) || {};
    var captionPrompt = icSettings.prompt || "What's in this image?";
    var source        = icSettings.source || "extras";
    var mmApi         = icSettings.multimodal_api   || "openrouter";
    var mmModel       = icSettings.multimodal_model || "";

    var dataUrl = base64DataUrl;
    var base64 = base64DataUrl;
    var commaIdx = base64DataUrl.indexOf(",");
    if (commaIdx !== -1) base64 = base64DataUrl.slice(commaIdx + 1);
    else dataUrl = "data:image/jpeg;base64," + base64;

    if (source === "multimodal") {
        L("captionImage → multimodal, api:", mmApi, "model:", mmModel);

        // Method 1: direct call to the ST backend with chat_completion_source.
        // This is the only reliable way to send an image to the target model,
        // because generateRaw uses the main chat pipeline and cannot see the image.
        try {
            var visionMessages = [{
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: dataUrl } },
                    { type: "text", text: captionPrompt }
                ]
            }];
            // chat_completion_source — required field: it tells the ST server
            // which backend to route to and which API key to use.
            var visionBody = {
                chat_completion_source: mmApi,
                messages:  visionMessages,
                model:     mmModel || undefined,
                max_tokens: 500,
                stream:    false
            };
            var vr = await fetch("/api/backends/chat-completions/generate", {
                method:  "POST",
                headers: headers,
                body:    JSON.stringify(visionBody)
            });
            if (vr.ok) {
                var vd = await vr.json();
                var vcap = vd && vd.choices && vd.choices[0] &&
                           (vd.choices[0].message && vd.choices[0].message.content ||
                            vd.choices[0].text);
                if (vcap && typeof vcap === "string" && vcap.trim()) {
                    L("Multimodal caption OK via ST chat-completions backend");
                    return vcap.trim();
                }
            } else {
                var errText = await vr.text().catch(function() { return ""; });
                W("ST backend HTTP", vr.status, errText.slice(0, 200));
            }
        } catch(e) { W("ST backend vision call failed:", e.message); }

        // Method 2: /api/extra/caption with multimodal flag
        try {
            var mr = await fetch("/api/extra/caption", {
                method:  "POST",
                headers: headers,
                body:    JSON.stringify({ image: base64, prompt: captionPrompt, source: "multimodal" })
            });
            if (mr.ok) {
                var md = await mr.json();
                if (md && md.caption) { L("Caption via /api/extra/caption OK"); return md.caption.trim(); }
            }
        } catch(e) { W("/api/extra/caption failed:", e.message); }

        throw new Error("Multimodal caption failed. Check logs — api:" + mmApi + " model:" + mmModel);
    }

    // Fallback: /api/extra/caption
    L("captionImage → /api/extra/caption, prompt:", captionPrompt);
    var r2 = await fetch("/api/extra/caption", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ image: base64, prompt: captionPrompt })
    });
    if (!r2.ok) throw new Error("Extras caption HTTP " + r2.status);
    var d2 = await r2.json();
    if (d2 && d2.caption) { L("Got extras caption OK"); return d2.caption; }
    throw new Error("No caption in extras response");
}

/* ================ AUTO ILLUSTRATOR BRIDGE ================ */

function daGetAISettings() { return (extSettings && extSettings.auto_illustrator) ? extSettings.auto_illustrator : null; }
function daGetAIPresetsAll() { var ai = daGetAISettings(); if (!ai || !ai.workflowPresets) return []; return ai.workflowPresets; }
function daGetAIPresetById(id) { if (!id) return null; var p = daGetAIPresetsAll(); for (var i = 0; i < p.length; i++) { if (p[i].id === id) return p[i]; } return null; }
function daGetAIActivePreset() { var ai = daGetAISettings(); if (!ai || !ai.workflowPresets || !ai.activePresetId) return null; for (var i = 0; i < ai.workflowPresets.length; i++) { if (ai.workflowPresets[i].id === ai.activePresetId) return ai.workflowPresets[i]; } return null; }
function daGetImagePreset() { if (settings && settings.visualizePresetId) { var p = daGetAIPresetById(settings.visualizePresetId); if (p) return p; } return daGetAIActivePreset(); }
function daGetAutoIllustratorApi() { return (typeof window !== "undefined" && window.AutoIllustrator) ? window.AutoIllustrator : null; }
function daGetComfyUrl() { var ai = daGetAISettings(); if (ai && ai.comfyUrl && ai.comfyUrl.trim()) return ai.comfyUrl.trim().replace(/\/+$/, ""); if (extSettings && extSettings.sd && extSettings.sd.comfy_url) return extSettings.sd.comfy_url.replace(/\/+$/, ""); return "http://127.0.0.1:8188"; }
function daEscJ(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"); }

function daGetFormatHint(preset) {
    var fmt = preset ? (preset.promptFormat || "flux") : "flux";
    var key = fmt.replace(/^pov_/, "");
    var hints = {
        flux: "Natural language, vivid and detailed. Describe the scene cinematically.",
        sd15: "Comma-separated tags: detailed, cinematic, dramatic lighting, high quality",
        illustrious: "Danbooru-style tags: detailed, cinematic_composition, atmospheric",
        noobai: "Tags: detailed, cinematic, atmospheric, masterpiece",
        gemini: "Rich natural-language description in 2-4 flowing sentences. No tag lists or quality keywords. Describe the subject, action, setting, lighting, mood, framing, and visual style.",
        custom: "Descriptive scene illustration prompt."
    };
    return hints[key] || hints.flux;
}

function daFillWorkflow(workflowStr, promptText, negText, width, height, preset) {
    var t = workflowStr;
    var sd = (extSettings && extSettings.sd) || {};
    function v(pv, k1, def) { return pv || sd[k1] || def || ""; }
    var BLANK = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    var strMap = {
        "%prompt%": daEscJ(promptText),
        "%negative_prompt%": daEscJ(negText || ""),
        "%model%": daEscJ(v(preset && preset.model, "comfy_model", "")),
        "%vae%": daEscJ(v(preset && preset.vae, "comfy_vae", "")),
        "%vae_name%": daEscJ(v(preset && preset.vae, "comfy_vae", "")),
        "%sampler%": daEscJ(v(preset && preset.sampler, "comfy_sampler", "euler")),
        "%scheduler%": daEscJ(v(preset && preset.scheduler, "comfy_scheduler", "normal")),
        "%clip_name%": daEscJ(sd.comfy_clip || ""),
        "%clip_name1%": daEscJ(sd.comfy_clip1 || sd.comfy_clip || ""),
        "%clip_name2%": daEscJ(sd.comfy_clip2 || ""),
        "%user_avatar%": BLANK,
        "%char_avatar%": BLANK
    };
    for (var ai = 1; ai <= 8; ai++) strMap["%avatar_" + ai + "%"] = BLANK;
    var numMap = {
        "%width%": Math.max(512, Math.round((preset && preset.width || 768) / 64) * 64),
        "%height%": Math.max(512, Math.round((preset && preset.height || 768) / 64) * 64),
        "%seed%": Math.floor(Math.random() * 2147483647),
        "%steps%": (preset && preset.steps) || sd.comfy_steps || 20,
        "%cfg%": (preset && preset.cfg) || sd.comfy_cfg || 7,
        "%scale%": (preset && preset.cfg) || sd.comfy_cfg || 7,
        "%denoise%": (preset && preset.denoise !== undefined) ? preset.denoise : 1,
        "%clip_skip%": (preset && preset.clipSkip) || 1,
        "%batch%": 1,
        "%batch_size%": 1
    };
    var key;
    for (key in strMap) if (strMap.hasOwnProperty(key)) t = t.split(key).join(strMap[key]);
    for (key in numMap) if (numMap.hasOwnProperty(key)) {
        var val = String(numMap[key]);
        t = t.split('"' + key + '"').join(val);
        t = t.split(key).join(val);
    }
    try { return JSON.parse(t); } catch(e) { E("DA workflow parse error:", e.message); return null; }
}

async function daComfyGenerate(workflowObj) {
    var base = daGetComfyUrl();
    var qr = await fetch(base + "/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflowObj })
    });
    if (!qr.ok) {
        var ei = ""; try { var ed = await qr.json(); ei = ed.error ? ed.error.message : JSON.stringify(ed).substring(0, 200); } catch(e) {}
        throw new Error("ComfyUI: " + qr.status + " " + ei);
    }
    var pid = (await qr.json()).prompt_id;
    var deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        var hr;
        try { hr = await fetch(base + "/history/" + pid); if (!hr.ok) continue; } catch(e) { continue; }
        var hist = await hr.json();
        if (!hist[pid]) continue;
        var entry = hist[pid];
        if (entry.status && entry.status.status_str === "error") {
            var errMsg = "ComfyUI error";
            if (entry.status.messages) entry.status.messages.forEach(function(m) {
                if (m[0] === "execution_error") errMsg = (m[1].node_type || "") + ": " + (m[1].exception_message || "").substring(0, 200);
            });
            throw new Error(errMsg);
        }
        var outs = entry.outputs;
        if (!outs || !Object.keys(outs).length) { if (entry.status && entry.status.completed) return null; continue; }
        for (var nid in outs) {
            var imgs = outs[nid] && outs[nid].images;
            if (!imgs || !imgs.length) continue;
            var ir = await fetch(base + "/view?" + new URLSearchParams({ filename: imgs[0].filename, subfolder: imgs[0].subfolder || "", type: imgs[0].type || "output" }).toString());
            if (!ir.ok) continue;
            return await ir.blob();
        }
    }
    throw new Error("ComfyUI timeout (3 min)");
}

function daImageSrc(image) {
    var value = String(image || "");
    if (!value) return "";
    if (value.indexOf("data:") === 0 || /^https?:\/\//i.test(value) || value.charAt(0) === "/") return value;
    return "data:image/jpeg;base64," + value.replace(/\s/g, "");
}

async function daGenerateWithPreset(preset, imgPrompt, onStatus) {
    var api = daGetAutoIllustratorApi();
    if (api && typeof api.illustrateText === "function") {
        var parts = await api.illustrateText({
            text: imgPrompt,
            count: 1,
            presetId: preset.id,
            skipAnalysis: true,
            mirrorToGallery: false,
            /* v1.0.6: no faces, the same as the ComfyUI branch below (its
               %char_avatar% is BLANK). Without an avatarMap AutoIllustrator
               collects the open chat's avatars and, naming nobody, attaches the
               first one — the companion's face (or the location card's
               building) as "the character's appearance" in every picture. */
            avatarMap: {},
            charNames: [],
            onStatus: onStatus
        });
        var part = parts && parts[0];
        if (!part || !part.image) throw new Error("AutoIllustrator returned no image.");
        return { src: daImageSrc(part.image), prompt: part.imagePrompt || imgPrompt };
    }

    // Compatibility path for older AutoIllustrator versions that did not
    // expose illustrateText yet. Gemini requires the public API because its
    // bridge, polling mode, and optional references belong to AutoIllustrator.
    if (preset.useGemini) throw new Error("AutoIllustrator " + daBridgeEngineLabel(preset) + " API is not ready. Reload SillyTavern and try again.");
    if (!preset.workflow) throw new Error("Selected preset has no image backend.");
    if (onStatus) onStatus("Generating image via ComfyUI…");
    var neg = preset.negativePrompt || "";
    var wfObj = daFillWorkflow(preset.workflow, imgPrompt, neg, preset.width || 768, preset.height || 768, preset);
    if (!wfObj) throw new Error("Failed to parse workflow JSON.");
    var blob = await daComfyGenerate(wfObj);
    if (!blob) throw new Error("No image returned by ComfyUI.");
    var dataUrl = await new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.onerror = function() { reject(new Error("Failed to read image blob")); };
        reader.readAsDataURL(blob);
    });
    return { src: dataUrl, prompt: imgPrompt };
}

async function daGenerateVisualPrompt(text) {
    if (!genRaw && !genQuiet) throw new Error("Generation not available. Connect an API first.");
    var preset = daGetImagePreset();
    var hint = daGetFormatHint(preset);
    var prompt = PROMPT_VISUALIZE_SCENE
        .replace("{{FORMAT_HINT}}", hint)
        .replace("{{TEXT}}", text.substring(0, 1500));
    // Pure text->JSON transform: raw generation, no character pipeline.
    var raw = genRaw ? await callRaw(prompt, "") : await callQuiet(prompt);
    try {
        var m = raw.match(/\{[\s\S]*\}/);
        if (m) { var d = JSON.parse(m[0]); if (d && d.image_prompt) return d.image_prompt.trim(); }
    } catch(e) {}
    return raw.trim().substring(0, 600);
}

async function visualizeResponse(id, rawText) {
    var preset = daGetImagePreset();
    if (!preset) {
        if (typeof toastr !== "undefined") toastr.error("No AutoIllustrator preset found. Select one in Direct Ask settings.");
        return;
    }
    if (!preset.workflow && !preset.useGemini) {
        if (typeof toastr !== "undefined") toastr.error("Selected preset has no usable image backend.");
        return;
    }
    var $msg = $("#" + id);
    var $btn = $msg.find(".da-visualize-btn");
    var $area = $msg.find(".da-img-result");
    $btn.prop("disabled", true);
    $area.html('<div class="da-viz-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Building image prompt…</div>').show();
    scrollDown();
    try {
        var imgPrompt = await daGenerateVisualPrompt(rawText);
        var result = await daGenerateWithPreset(preset, imgPrompt, function(status) {
            $area.html('<div class="da-viz-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> ' + esc(status || "Generating image…") + '</div>');
            scrollDown();
        });
        imgPrompt = result.prompt || imgPrompt;
        $area.html(
            '<div class="da-viz-result">' +
            '<div class="da-viz-prompt-label" title="' + esc(imgPrompt) + '">' +
            '<i class="fa-solid fa-wand-magic-sparkles"></i> ' +
            '<em>' + esc(imgPrompt.substring(0, 90)) + (imgPrompt.length > 90 ? "…" : "") + '</em>' +
            '</div>' +
            '<img src="' + result.src + '" class="da-viz-img" alt="Visualized scene">' +
            '</div>'
        );
        $btn.addClass("da-visualized").prop("disabled", false)
            .attr("title", "Re-visualize").find("i").removeClass("fa-image").addClass("fa-rotate-right");
    } catch(e) {
        $area.html('<span class="da-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</span>');
        $btn.prop("disabled", false);
        E("Visualize error:", e);
    }
    scrollDown();
}

// Which site a bridge preset draws with (AutoIllustrator 3.21+: bridgeEngine).
// The preset list and the error text both ask here.
function daBridgeEngineLabel(preset) {
    return (preset && preset.bridgeEngine === "chatgpt") ? "ChatGPT" : "Gemini";
}

function rebuildDAImgPresetDropdown() {
    var $sel = $("#da-opt-viz-preset");
    if (!$sel.length) return;
    var current = $sel.val();
    $sel.empty().append('<option value="">— Use active AutoIllustrator preset —</option>');
    var presets = daGetAIPresetsAll();
    for (var i = 0; i < presets.length; i++) {
        var p = presets[i];
        var backend = p.useGemini ? ' [' + daBridgeEngineLabel(p) + ']' : '';
        $sel.append('<option value="' + esc(p.id) + '">' + esc((p.name || p.id) + backend) + '</option>');
    }
    var saved = (settings && settings.visualizePresetId) || current || "";
    if (saved) {
        if ($sel.find('option[value="' + esc(saved) + '"]').length) {
            $sel.val(saved);
        } else {
            $sel.append('<option value="' + esc(saved) + '">Loading saved preset…</option>');
            $sel.val(saved);
        }
    }
}

/* ================ CHAT BUTTON ================ */

function buildChatButton() {
    if (document.getElementById("da-trigger-btn")) return;
    var btn = '<div id="da-trigger-btn" class="da-trigger interactable" title="Direct Ask"><i class="fa-solid fa-robot"></i></div>';
    var $l = $("#leftSendForm");
    if ($l.length) $l.append(btn); else { var $f = $("#send_form"); if ($f.length) $f.prepend(btn); else return; }
    $(document).on("click", "#da-trigger-btn", function () { if (settings.enabled) showModal(true); });
    syncBtn();
}

function syncBtn() { $("#da-trigger-btn").toggle(!!(settings.enabled && settings.showButton)); }

/* ================ SETTINGS PANEL ================ */

function buildSettingsPanel() {
    var $c = $("#extensions_settings2"); if (!$c.length) $c = $("#extensions_settings"); if (!$c.length) return;
    var h = '';
    h += '<div id="da-settings"><div class="inline-drawer">';
    h += '<div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-robot"></i> Direct Ask</b>';
    h += '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>';
    h += '<div class="inline-drawer-content">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-on"><span>Enable extension</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-btn"><span>Show button in chat area</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-floating"><span>Floating mode <small>(draggable, stays open)</small></span></label></div>';
    h += '<div class="da-srow da-floating-opts" id="da-floating-opts">';
    h += '<label><small>Window size (px): ';
    h += 'W&nbsp;<input type="number" id="da-opt-w" class="da-size-input" min="320" max="1400" step="10"> ';
    h += '&times;&nbsp;H&nbsp;<input type="number" id="da-opt-h" class="da-size-input" min="280" max="1000" step="10">';
    h += '</small></label>';
    h += '<input id="da-opt-reset-pos" class="menu_button" type="button" value="Reset position">';
    h += '</div>';
    h += '<div class="da-srow da-font-size-row"><label><small>Main window font size: <span id="da-font-val">14</span> px</small></label>';
    h += '<input type="range" id="da-opt-font-size" min="10" max="32" step="1"></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-ctx"><span>Use RP context by default</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-conv"><span>Conversation mode</span></label></div>';
    h += '<div class="da-srow" id="da-ctxn-row"><label><small>Max context messages: <span id="da-ctx-val">10</span></small></label>';
    h += '<input type="range" id="da-opt-maxctx" min="2" max="30" step="2"></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-opt-tok-on"><span>Limit prompt size <small>(prevents API context-overflow errors)</small></span></label></div>';
    h += '<div class="da-srow" id="da-tok-row">';
    h += '<label><small>Max prompt tokens:</small></label>';
    h += '<input type="number" id="da-opt-maxtok" class="text_pole" min="512" max="1000000" step="256" style="width:140px">';
    h += '<small class="da-settings-hint">Older RP chat messages will be dropped first to fit. Set this a bit below your model\'s context window to leave room for the reply. Range: 512 – 1,000,000.</small>';
    h += '</div><hr>';
    h += '<div class="da-srow"><label><small>Prompt WITH RP context:</small></label>';
    h += '<textarea id="da-opt-prompt-ctx" class="text_pole textarea_compact" rows="3"></textarea></div>';
    h += '<div class="da-srow"><label><small>Prompt WITHOUT context:</small></label>';
    h += '<textarea id="da-opt-prompt-noctx" class="text_pole textarea_compact" rows="2"></textarea></div>';
    h += '<div class="da-srow da-srow-btns"><input id="da-opt-reset-prompts" class="menu_button" type="button" value="Reset prompts"></div><hr>';
    h += '<div class="da-srow"><label><small><b>\uD83C\uDFA8 Visualize (AutoIllustrator):</b></small></label></div>';
    h += '<div class="da-srow" id="da-viz-preset-row">';
    h += '<label><small>Image preset:</small></label>';
    h += '<div style="display:flex;gap:6px;align-items:center;margin-top:4px">';
    h += '<select id="da-opt-viz-preset" class="text_pole" style="flex:1;font-size:.85em"><option value="">— Use active AutoIllustrator preset —</option></select>';
    h += '<input id="da-viz-preset-refresh" class="menu_button" type="button" value="\u21BB" title="Refresh preset list">';
    h += '</div></div>';
    h += '<small class="da-settings-hint">Click <i class="fa-solid fa-image"></i> on any AI reply to visualize it. Supports AutoIllustrator presets backed by <b>Gemini</b> or <b>ComfyUI</b>.</small><hr>';
    h += '<div class="da-srow"><label><small><b>Quick Shortcuts:</b></small></label></div>';
    h += '<div id="da-sc-list" class="da-sc-list"></div>';
    h += '<div class="da-sc-add-form">';
    h += '<input id="da-sc-add-label" class="text_pole" placeholder="Label, e.g.: &#x1F552; Time">';
    h += '<textarea id="da-sc-add-prompt" class="text_pole textarea_compact" rows="2" placeholder="Question / instruction..."></textarea>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="da-sc-add-inject"><span>Inject into RP chat (narrator event)</span></label></div>';
    h += '<div class="da-srow-btns">';
    h += '<input id="da-sc-add-btn" class="menu_button" type="button" value="+ Add shortcut">';
    h += '<input id="da-sc-reset-btn" class="menu_button" type="button" value="Reset defaults">';
    h += '</div></div><hr>';
    h += '<div class="da-srow da-srow-btns"><input id="da-opt-open" class="menu_button" type="button" value="Open Direct Ask"></div>';
    h += '<small class="da-settings-hint">Commands: <code>/ask</code> &middot; <code>/direct</code> &middot; <code>/inject</code> &middot; <kbd>Ctrl+Shift+A</kbd></small>';
    h += '</div></div></div>';
    $c.append(h);

    $("#da-opt-on").prop("checked", settings.enabled).on("change", function () { settings.enabled = this.checked; save(); syncBtn(); });
    $("#da-opt-btn").prop("checked", settings.showButton).on("change", function () { settings.showButton = this.checked; save(); syncBtn(); });
    $("#da-opt-floating").prop("checked", settings.floatingMode).on("change", function () {
        settings.floatingMode = this.checked;
        $("#da-floating-opts").toggle(this.checked);
        save();
        if ($("#direct-ask-modal").is(":visible")) applyModalMode();
    });
    $("#da-floating-opts").toggle(settings.floatingMode);
    $("#da-opt-w").val(settings.modalWidth || 660).on("change", function () { settings.modalWidth = Math.max(320, parseInt(this.value, 10) || 660); save(); if (settings.floatingMode && $("#direct-ask-modal").is(":visible")) applyModalMode(); });
    $("#da-opt-h").val(settings.modalHeight || 520).on("change", function () { settings.modalHeight = Math.max(280, parseInt(this.value, 10) || 520); save(); if (settings.floatingMode && $("#direct-ask-modal").is(":visible")) applyModalMode(); });
    $("#da-opt-reset-pos").on("click", function () { settings.modalPosX = -1; settings.modalPosY = -1; save(); if (settings.floatingMode && $("#direct-ask-modal").is(":visible")) applyModalMode(); if (typeof toastr !== "undefined") toastr.info("Position reset."); });
    settings.mainFontSize = normalizeMainFontSize(settings.mainFontSize);
    $("#da-opt-font-size").val(settings.mainFontSize).on("input", function () {
        setMainFontSize(this.value);
    });
    applyMainFontSize();
    $("#da-opt-ctx").prop("checked", settings.useContext).on("change", function () { settings.useContext = this.checked; save(); $("#da-use-ctx").prop("checked", this.checked); updateCtxHint(); });
    $("#da-opt-conv").prop("checked", settings.conversationMode).on("change", function () { settings.conversationMode = this.checked; save(); $("#da-ctxn-row").toggle(this.checked); });
    $("#da-ctxn-row").toggle(settings.conversationMode);
    $("#da-opt-maxctx").val(settings.maxContextMessages).on("input", function () { settings.maxContextMessages = parseInt(this.value, 10); $("#da-ctx-val").text(this.value); save(); });
    $("#da-ctx-val").text(settings.maxContextMessages);
    $("#da-opt-tok-on").prop("checked", !!settings.enforcePromptLimit).on("change", function () { settings.enforcePromptLimit = this.checked; save(); $("#da-tok-row").toggle(this.checked); });
    $("#da-tok-row").toggle(!!settings.enforcePromptLimit);
    $("#da-opt-maxtok").val(settings.maxPromptTokens || 8192).on("change", function () {
        var v = parseInt(this.value, 10);
        if (!isFinite(v) || v < 512) v = 512;
        if (v > 1000000) v = 1000000;
        settings.maxPromptTokens = v;
        this.value = v;
        save();
    });
    $("#da-opt-prompt-ctx").val(settings.promptWithCtx).on("input", function () { settings.promptWithCtx = this.value; save(); });
    $("#da-opt-prompt-noctx").val(settings.promptNoCtx).on("input", function () { settings.promptNoCtx = this.value; save(); });
    $("#da-opt-reset-prompts").on("click", function () {
        settings.promptWithCtx = PROMPT_WITH_CONTEXT; settings.promptNoCtx = PROMPT_NO_CONTEXT;
        $("#da-opt-prompt-ctx").val(PROMPT_WITH_CONTEXT); $("#da-opt-prompt-noctx").val(PROMPT_NO_CONTEXT);
        save(); if (typeof toastr !== "undefined") toastr.info("Prompts reset.");
    });
    renderSettingsShortcuts();
    $(document).on("click", ".da-sc-del", function () { settings.shortcuts.splice(parseInt($(this).attr("data-index"), 10), 1); save(); renderSettingsShortcuts(); renderShortcuts(); });
    $("#da-sc-add-btn").on("click", function () {
        var label = $("#da-sc-add-label").val().trim(), prompt = $("#da-sc-add-prompt").val().trim();
        if (!label || !prompt) { if (typeof toastr !== "undefined") toastr.warning("Fill both fields."); return; }
        var sc = { label: label, prompt: prompt };
        if ($("#da-sc-add-inject").is(":checked")) sc.inject = true;
        settings.shortcuts.push(sc); save();
        $("#da-sc-add-label").val(""); $("#da-sc-add-prompt").val(""); $("#da-sc-add-inject").prop("checked", false);
        renderSettingsShortcuts(); renderShortcuts();
        if (typeof toastr !== "undefined") toastr.success("Shortcut added!");
    });
    $("#da-sc-reset-btn").on("click", function () { settings.shortcuts = cloneShortcuts(DEFAULT_SHORTCUTS); save(); renderSettingsShortcuts(); renderShortcuts(); });
    $("#da-opt-open").on("click", function () { showModal(true); });

    // Visualize preset
    rebuildDAImgPresetDropdown();
    setTimeout(rebuildDAImgPresetDropdown, 2000);
    try { document.addEventListener("autoillustrator:ready", rebuildDAImgPresetDropdown); } catch (e) {}
    $(document).on("change", "#da-opt-viz-preset", function () { settings.visualizePresetId = this.value; save(); });
    $(document).on("click", "#da-viz-preset-refresh", function () {
        rebuildDAImgPresetDropdown();
        if (typeof toastr !== "undefined") toastr.info("Found " + daGetAIPresetsAll().length + " AutoIllustrator preset(s).");
    });
}

function renderSettingsShortcuts() {
    var $l = $("#da-sc-list"); $l.empty();
    if (!settings.shortcuts || !settings.shortcuts.length) { $l.html('<div class="da-sc-empty">No shortcuts.</div>'); return; }
    for (var i = 0; i < settings.shortcuts.length; i++) {
        var sc = settings.shortcuts[i];
        var tag = sc.inject ? ' <span class="da-tag da-tag-inject">INJECT</span>' : '';
        $l.append('<div class="da-sc-item' + (sc.inject ? ' da-sc-item-inject' : '') + '"><div class="da-sc-item-top"><span class="da-sc-item-label">' + esc(sc.label) + tag + '</span><button class="da-sc-del menu_button" data-index="' + i + '" title="Delete">&#x2715;</button></div><div class="da-sc-item-prompt">' + esc(sc.prompt) + '</div></div>');
    }
}

/* ================ SLASH COMMANDS ================ */

async function loadSlashCommands() {
    try {
        var SCP = (await import("../../../slash-commands/SlashCommandParser.js")).SlashCommandParser;
        var SC  = (await import("../../../slash-commands/SlashCommand.js")).SlashCommand;
        var am  = await import("../../../slash-commands/SlashCommandArgument.js");

        SCP.addCommandObject(SC.fromProps({
            name: "ask", callback: async function (_a, v) {
                if (!v || !v.trim() || !settings.enabled) return "";
                showModal(true); addMsg("user", esc(v) + ' <span class="da-tag da-tag-rp">RP</span>');
                var lid = addMsg("assistant", '<span class="da-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></span>');
                try { var r = await askLLM(v); $("#" + lid).data("raw-text", r); $("#" + lid + " .da-msg-content").html(fmt(r)); return r; }
                catch (e) { $("#" + lid + " .da-msg-content").html('<span class="da-error">' + esc(e.message) + '</span>'); return ""; }
            },
            unnamedArgumentList: [am.SlashCommandArgument.fromProps({ description: "Question", typeList: [am.ARGUMENT_TYPE.STRING], isRequired: true })],
            helpString: "Ask the AI directly."
        }));

        SCP.addCommandObject(SC.fromProps({ name: "direct", callback: async function () { showModal(true); return ""; }, helpString: "Open Direct Ask." }));

        SCP.addCommandObject(SC.fromProps({
            name: "inject-event", callback: async function (_a, v) {
                if (!v || !v.trim()) v = "Generate a sudden, dramatic random event that disrupts the current scene.";
                try { var t = await generateNarration(v); await injectToChat(t); if (typeof toastr !== "undefined") toastr.success("Event injected!"); return t; }
                catch (e) { if (typeof toastr !== "undefined") toastr.error(e.message); return ""; }
            },
            unnamedArgumentList: [am.SlashCommandArgument.fromProps({ description: "Event instruction", typeList: [am.ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: "Generate and inject a narrator event."
        }));
    } catch (e) {}
}

/* ================ KEYBOARD ================ */

function bindKeys() {
    $(document).on("keydown.directask", function (e) {
        if (e.ctrlKey && e.shiftKey && e.code === "KeyA") {
            e.preventDefault();
            if (!settings.enabled) return;
            var $m = $("#direct-ask-modal");
            if ($m.is(":visible")) hideModal(); else showModal(true);
        }
    });
}
