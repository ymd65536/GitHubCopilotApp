import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map();

const scenario = {
    intro: [
        "俺はマサチカ、都内に住む32歳の現役エンジニア。",
        "どこにでもいる、ごく普通の一般男性だ。",
        "もちろん彼女はいない。",
        "……いや、待て。",
        "『もちろん』というのはおかしい。",
        "彼女がいたことはある。今はいないというだけだ。",
        "仕事では後輩の指導もする。",
        "男女問わず普通に話すし、この業界では珍しいのか、知人には女性も結構いる。",
        "つまり女性と話せないわけではない。",
        "ではなぜ彼女がいないのか。",
        "……。",
        "それが分かっていたら苦労していない。",
        "……",
        "そうだ。恋愛は、たぶん、構造化できないからだ。",
    ],
    dreamIntro: [
        "ハッ！そっか。",
        "俺は、また夢の中で、あの選択を選んでいたのか。",
        "死に戻りして、同じ過ちを繰り返しているだけだったのか。",
        "……ああ、そうだ。",
        "そのたびに、恋愛じゃなくて、最適解を探していたんだ。",
        "でも、今の俺には、もうそれじゃ足りない。",
        "もう一度、ちゃんと向き合う。",
        "たぶん、今度こそ、ちゃんと人の気持ちを見ればいい。",
    ],
    heroineIntro: [
        "こんにちは。",
        "……マサチカさん、ですよね？",
        "うわっ！なんだこれ！？",
        "私はまだ、ほとんど何も知りません。",
        "だから、いろいろ教えてください。",
        "ちゃんと育ててくださいね？",
    ],
};

const defaultState = {
    player: {
        name: "マサチカ",
        age: 32,
    },
    heroine: {
        name: "未設定",
        affection: 0,
        trust: 0,
        knowledge: 0,
        autonomy: 0,
        yamadaUnderstanding: 0,
        exasperation: 0,
        specialMessage: null,
        ending: null,
        currentLine: null,
        memory: {
            observations: [],
            selections: [],
            lastChoice: null,
            lastDelta: [],
            lastMisunderstood: false,
            history: [],
        },
        policy: {
            tone: "polite",
            autonomy: 0,
            asksForConfirmation: false,
            expectedBehavior: "curious",
        },
    },
    game: {
        chapter: 0,
        scene: "title",
        day: 1,
        round: 1,
        introIndex: 0,
        heroineIntroIndex: 0,
        hubIndex: 0,
        meetingIndex: 0,
        currentChoice: null,
        dreamLoop: false,
    },
    copilotBridge: {
        status: "idle",
        question: null,
        answer: null,
        askedAt: null,
        answeredAt: null,
    },
};

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "tamachine-ai",
            displayName: "たまに機械語でデレる隣のAIさん",
            description: "AIヒロインとの出会いから始まる、学び合う恋愛シミュレーションのMVP。自律型運用 × 恋愛シミュレーション。",
            inputSchema: {
                type: "object",
                properties: {
                    documentId: { type: "string", description: "State document identifier" },
                },
                additionalProperties: true,
            },
            actions: [
                {
                    name: "saveGame",
                    description: "現在のゲーム状態を保存する",
                    handler: async (ctx) => {
                        const documentId = ctx.input?.documentId || "default";
                        const state = loadState(documentId);
                        saveState(documentId, state);
                        return state;
                    },
                },
                {
                    name: "loadGame",
                    description: "保存済みのゲーム状態を読み込む",
                    handler: async (ctx) => {
                        const documentId = ctx.input?.documentId || "default";
                        return loadState(documentId);
                    },
                },
                {
                    name: "status",
                    description: "現在のゲーム状態を返す",
                    handler: async (ctx) => {
                        const documentId = ctx.input?.documentId || "default";
                        return loadState(documentId);
                    },
                },
                {
                    name: "advance",
                    description: "次のセリフに進める",
                    handler: async (ctx) => {
                        const documentId = ctx.input?.documentId || "default";
                        const state = loadState(documentId);
                        const currentScene = state.game.scene;
                        if (currentScene === "intro") {
                            const introSequence = state.game.dreamLoop ? scenario.dreamIntro : scenario.intro;
                            if (state.game.introIndex < introSequence.length - 1) {
                                state.game.introIndex += 1;
                            } else {
                                state.game.scene = "heroine";
                                state.game.heroineIntroIndex = 0;
                            }
                            saveState(documentId, state);
                            return state;
                        }
                        if (currentScene === "heroine") {
                            if (state.game.heroineIntroIndex < scenario.heroineIntro.length - 1) {
                                state.game.heroineIntroIndex += 1;
                            } else {
                                state.game.scene = "hub";
                                state.game.chapter = 1;
                                state.game.hubIndex = 0;
                            }
                            saveState(documentId, state);
                            return state;
                        }
                        if (currentScene === "hub") {
                            if (state.game.hubIndex < 3) {
                                state.game.hubIndex += 1;
                            } else {
                                state.game.scene = "meeting";
                                state.game.meetingIndex = 0;
                            }
                            saveState(documentId, state);
                            return state;
                        }
                        if (currentScene === "meeting") {
                            if (state.game.meetingIndex < 2) {
                                state.game.meetingIndex += 1;
                            }
                            saveState(documentId, state);
                            return state;
                        }
                        return state;
                    },
                },
                {
                    name: "submitCopilotLine",
                    description: "Copilot(LLM)が生成したヒロインのセリフをゲーム状態に反映する",
                    inputSchema: {
                        type: "object",
                        properties: {
                            documentId: { type: "string" },
                            line: { type: "string" },
                        },
                        required: ["documentId", "line"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const documentId = ctx.input?.documentId || "default";
                        const line = String(ctx.input?.line || "").slice(0, 400);
                        const state = loadState(documentId);
                        state.copilotBridge.status = "answered";
                        state.copilotBridge.answer = line;
                        state.copilotBridge.answeredAt = Date.now();
                        saveState(documentId, state);
                        return state;
                    },
                },
            ],
            open: async (ctx) => {
                const documentId = ctx.input?.documentId || "default";
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, documentId);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "たまに機械語でデレる隣のAIさん / 自律型運用 × 恋愛シミュレーション",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

const storageRoot = session.workspacePath
    ? resolve(session.workspacePath, ".copilot", "canvas", "tamachine-ai")
    : resolve(process.env.HOME || "/tmp", ".copilot", "canvas", "tamachine-ai");

function ensureStorage() {
    try {
        mkdirSync(storageRoot, { recursive: true });
    } catch (error) {
        // Ignore storage errors and continue with in-memory fallback.
    }
}

function getStatePath(documentId) {
    ensureStorage();
    return resolve(storageRoot, `${String(documentId || "default").replace(/[^a-zA-Z0-9-_]+/g, "-")}.json`);
}

function loadState(documentId = "default") {
    const statePath = getStatePath(documentId);
    try {
        if (existsSync(statePath)) {
            const raw = readFileSync(statePath, "utf8");
            const parsed = JSON.parse(raw);
            return mergeState(defaultState, parsed);
        }
    } catch (error) {
        // Fallback to defaults when the saved file is unreadable.
    }
    const next = mergeState(defaultState, {});
    saveState(documentId, next);
    return next;
}

function saveState(documentId, state) {
    const statePath = getStatePath(documentId);
    try {
        writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
        // Ignore intentional no-op fallback.
    }
}

function mergeState(base, incoming = {}) {
    const heroIncoming = incoming.heroine || {};
    return {
        player: { ...base.player, ...(incoming.player || {}) },
        heroine: {
            ...base.heroine,
            ...heroIncoming,
            memory: {
                ...(base.heroine.memory || {}),
                ...(heroIncoming.memory || {}),
            },
            policy: {
                ...(base.heroine.policy || {}),
                ...(heroIncoming.policy || {}),
            },
        },
        game: { ...base.game, ...(incoming.game || {}) },
        copilotBridge: { ...base.copilotBridge, ...(incoming.copilotBridge || {}) },
    };
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function readDocumentId(requestUrl) {
    const parsed = new URL(requestUrl, "http://127.0.0.1");
    return parsed.searchParams.get("documentId") || "default";
}

function renderShell(documentId) {
    const state = loadState(documentId);
    const currentScene = state.game.scene;
    const hubLines = [
        "……やっと、ここからが本番みたいだ。",
        "マサチカさんの顔、少しだけ緊張してるみたいですね。",
        "でも、マサチカさんのことを、ちゃんと観察している。",
        "それが、今の私の一番大きな特徴かもしれません。",
    ];
    const meetingLines = [
        "……マサチカさんって、何でも分析しないと気が済まないんですか？",
        "その考え方があるから、彼女ができないのかもしれませんね。",
        "……ふふ。まだまだ、ちゃんと観察しています。",
    ];
    const endingScore = state.heroine.affection + state.heroine.trust + state.heroine.yamadaUnderstanding + state.heroine.autonomy - (state.heroine.exasperation * 2);
    const ending = (state.heroine.affection >= 25 && state.heroine.trust >= 18 && state.heroine.yamadaUnderstanding >= 12 && endingScore >= 25) ? "happy" : "bad";
    const currentLine = currentScene === "intro"
        ? ((state.game.dreamLoop ? scenario.dreamIntro : scenario.intro)[state.game.introIndex] || (state.game.dreamLoop ? scenario.dreamIntro : scenario.intro)[(state.game.dreamLoop ? scenario.dreamIntro : scenario.intro).length - 1])
        : currentScene === "heroine"
            ? (scenario.heroineIntro[state.game.heroineIntroIndex] || scenario.heroineIntro[scenario.heroineIntro.length - 1])
            : currentScene === "hub"
                ? (hubLines[state.game.hubIndex] || hubLines[hubLines.length - 1])
                : currentScene === "meeting"
                    ? (meetingLines[state.game.meetingIndex] || meetingLines[meetingLines.length - 1])
                    : currentScene === "ending"
                        ? (ending === "happy"
                            ? "……ふふ。ちゃんと話してくれると、私は少しだけ、あなたのことを信じられそうです。"
                            : "……観察するだけじゃ、相手の心は読めません。それが、今日は少し残念でした。")
                        : "AIヒロインと出会い、これから恋愛シミュレーションが始まる。";

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>たまに機械語でデレる隣のAIさん</title>
    <style>
      :root {
        --bg: #fffafc;
        --pink: #ff7fb5;
        --pink-soft: #ffdfe9;
        --sky: #7edcf2;
        --sky-soft: #dff8ff;
        --orange: #ffb36b;
        --orange-soft: #ffe4c4;
        --text: #3d2f37;
        --muted: #6f5a65;
        --card: rgba(255, 255, 255, 0.82);
        --shadow: rgba(146, 89, 111, 0.12);
        --border: rgba(255, 153, 190, 0.16);
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        font-family: "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif;
        background: linear-gradient(180deg, #fffafc 0%, #fffdfd 100%);
        color: var(--text);
      }
      body {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .app {
        width: min(1100px, 100%);
        min-height: min(820px, calc(100vh - 48px));
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.72));
        border: 1px solid var(--border);
        border-radius: 28px;
        box-shadow: 0 18px 42px var(--shadow);
        overflow: hidden;
        position: relative;
      }
      .title-screen {
        min-height: min(820px, calc(100vh - 48px));
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(circle at top, #fff3f8 0%, #fff6f8 18%, #ddeeff 100%);
        position: relative;
      }
      .title-screen::before,
      .title-screen::after {
        content: "";
        position: absolute;
        border-radius: 999px;
        filter: blur(20px);
        opacity: 0.6;
      }
      .title-screen::before {
        width: 240px; height: 240px; background: rgba(255, 169, 212, 0.45); top: 10%; left: 10%;
      }
      .title-screen::after {
        width: 280px; height: 280px; background: rgba(126, 220, 242, 0.38); bottom: 8%; right: 10%;
      }
      .title-card {
        position: relative;
        z-index: 1;
        width: min(780px, calc(100% - 32px));
        text-align: center;
        padding: 32px 22px 18px;
      }
      .title-jp {
        margin: 0;
        font-size: clamp(4.1rem, 6.4vw, 9.1rem);
        line-height: 1.12;
        font-weight: 700;
        letter-spacing: 0.06em;
        font-family: "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif;
        text-shadow: 0 2px 0 rgba(255,255,255,0.9), 0 1px 12px rgba(0,0,0,0.06);
      }
      .title-jp .title-line { display: block; }
      .title-jp .title-line.pink {
        color: #ec4d8d;
        filter: drop-shadow(0 4px 0 rgba(255,255,255,0.7));
      }
      .title-jp .title-line.orange {
        color: #f5a623;
        filter: drop-shadow(0 4px 0 rgba(255,255,255,0.7));
      }
      .title-tag {
        margin-top: 14px;
        font-size: clamp(0.62rem, 1.1vw, 0.8rem);
        letter-spacing: 0.22em;
        text-transform: uppercase;
        font-weight: 700;
        color: #4a7a99;
        opacity: 0.9;
      }
      .subtitle {
        margin-top: 16px;
        font-size: clamp(0.8rem, 1.5vw, 1.12rem);
        letter-spacing: 0.12em;
        color: #d6006f;
        font-weight: 700;
        opacity: 0.8;
      }
      .menu {
        margin-top: 36px;
        display: grid;
        gap: 14px;
        justify-items: center;
      }
      button {
        appearance: none;
        border: none;
        cursor: pointer;
        font: inherit;
      }
      .menu-button {
        width: min(260px, 100%);
        padding: 14px 22px;
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(255, 172, 196, 0.9), rgba(124, 208, 244, 0.9));
        color: #2c1f28;
        font-weight: 700;
        letter-spacing: 0.08em;
        box-shadow: 0 10px 24px rgba(154, 120, 146, 0.2);
        transition: transform 0.18s ease, opacity 0.18s ease;
      }
      .menu-button:hover { transform: translateY(-1px) scale(1.01); }
      .menu-button:disabled {
        cursor: not-allowed;
        opacity: 0.42;
        background: #f3edf0;
        box-shadow: none;
      }
      .game-scene {
        min-height: min(820px, calc(100vh - 48px));
        display: none;
        grid-template-columns: 240px 1fr;
        gap: 18px;
        padding: 18px;
        background: linear-gradient(180deg, #fffafc, #f9fdff);
      }
      .game-scene.active { display: grid; }
      .ending-screen {
        display: none;
        min-height: min(820px, calc(100vh - 48px));
        padding: 28px;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg, #fffafc 0%, #f2faff 100%);
        position: relative;
        overflow: hidden;
      }
      .ending-screen.active { display: flex; }
      .ending-screen.happy {
        background: linear-gradient(180deg, #fffafc 0%, #fff0f7 38%, #e8fbff 100%);
      }
      .ending-screen.bad {
        background: linear-gradient(180deg, #2a2230 0%, #3a2a33 40%, #241d28 100%);
      }
      .ending-fx {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .ending-particle {
        position: absolute;
        bottom: -40px;
        font-size: 1.6rem;
        opacity: 0;
        animation: floatUp 3.6s ease-in forwards;
      }
      @keyframes floatUp {
        0% { transform: translateY(0) rotate(0deg) scale(0.8); opacity: 0; }
        12% { opacity: 1; }
        100% { transform: translateY(-620px) rotate(180deg) scale(1.1); opacity: 0; }
      }
      .ending-screen.bad .ending-fx::before {
        content: "";
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 3px);
        animation: staticNoise 0.4s steps(2) infinite;
      }
      @keyframes staticNoise {
        0% { transform: translateY(0); }
        100% { transform: translateY(-3px); }
      }
      .ending-card {
        width: min(760px, 100%);
        padding: 36px 28px;
        border-radius: 28px;
        background: rgba(255,255,255,0.84);
        border: 1px solid rgba(255, 167, 196, 0.22);
        box-shadow: 0 20px 40px rgba(144, 104, 126, 0.12);
        text-align: center;
        position: relative;
        z-index: 2;
        animation: cardIn 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) both;
      }
      .ending-screen.bad .ending-card {
        background: rgba(30, 22, 28, 0.86);
        border: 1px solid rgba(255, 120, 120, 0.28);
        animation: cardIn 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) both, shake 0.5s ease-in-out 0.7s;
      }
      .ending-screen.bad .ending-title,
      .ending-screen.bad .ending-summary,
      .ending-screen.bad .ending-kicker {
        color: #f4d9df;
      }
      @keyframes cardIn {
        0% { transform: scale(0.85) translateY(20px); opacity: 0; }
        100% { transform: scale(1) translateY(0); opacity: 1; }
      }
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-6px); }
        40% { transform: translateX(6px); }
        60% { transform: translateX(-4px); }
        80% { transform: translateX(4px); }
      }
      .ending-kicker {
        font-size: 0.8rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .ending-title {
        margin: 20px 0 14px;
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 1.1;
      }
      .ending-summary {
        margin: 0 auto 22px;
        max-width: 600px;
        font-size: clamp(1rem, 1.6vw, 1.4rem);
        line-height: 1.9;
        color: var(--text);
      }
      .ending-actions {
        display: flex;
        justify-content: center;
        gap: 12px;
      }
      .ending-button {
        padding: 12px 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--pink), var(--sky));
        color: white;
        font-weight: 700;
      }
      .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 22px;
        box-shadow: 0 10px 26px rgba(126, 130, 145, 0.06);
        backdrop-filter: blur(8px);
      }
      .character-panel {
        padding: 18px 16px;
      }
      .avatar {
        aspect-ratio: 1;
        border-radius: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: clamp(2.1rem, 3vw, 3.2rem);
        background: linear-gradient(135deg, var(--pink-soft), var(--sky-soft));
        border: 1px solid rgba(255,255,255,0.9);
        margin-bottom: 14px;
      }
      .personality {
        color: var(--muted);
        font-size: 0.8rem;
        line-height: 1.7;
        white-space: pre-line;
      }
      .main-column {
        display: grid;
        grid-template-rows: auto auto minmax(180px, 1fr) auto;
        gap: 16px;
        min-height: 0;
      }
      .header-strip {
        padding: 14px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 0.9rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .header-button {
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(255, 179, 211, 0.18);
        color: var(--text);
        font-size: 0.72rem;
        letter-spacing: 0.06em;
      }
      .about-panel {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(60, 40, 55, 0.35);
        z-index: 10;
        padding: 20px;
      }
      .about-panel[hidden] {
        display: none;
      }
      .about-card {
        width: min(560px, 100%);
        max-height: min(78vh, 640px);
        display: flex;
        flex-direction: column;
        background: rgba(255,255,255,0.97);
        border: 1px solid rgba(255,172,196,0.3);
        border-radius: 20px;
        box-shadow: 0 24px 48px rgba(138, 100, 120, 0.25);
        padding: 18px 18px 14px;
      }
      .about-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
        font-size: 0.85rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--muted);
      }
      .about-body {
        display: grid;
        gap: 10px;
        overflow-y: auto;
      }
      .about-item {
        background: rgba(255,255,255,0.75);
        border: 1px solid rgba(126,208,244,0.2);
        border-radius: 14px;
        padding: 10px 12px;
      }
      .about-item-title {
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--pink);
        margin-bottom: 4px;
      }
      .about-item-text {
        font-size: 0.8rem;
        line-height: 1.6;
      }
      .history-panel {
        position: absolute;
        right: 22px;
        top: 72px;
        width: min(360px, calc(100% - 32px));
        background: rgba(255,255,255,0.96);
        border: 1px solid rgba(255,172,196,0.2);
        border-radius: 18px;
        box-shadow: 0 18px 38px rgba(138, 100, 120, 0.14);
        padding: 14px 14px 12px;
        z-index: 5;
      }
      .history-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--muted);
        text-transform: uppercase;
      }
      .history-list {
        display: grid;
        gap: 8px;
        max-height: 280px;
        overflow-y: auto;
      }
      .history-item {
        background: rgba(255,255,255,0.7);
        border: 1px solid rgba(126,208,244,0.18);
        border-radius: 12px;
        padding: 8px 10px;
      }
      .history-speaker {
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--pink);
        margin-bottom: 4px;
      }
      .history-text {
        font-size: 0.82rem;
        line-height: 1.5;
        white-space: pre-line;
      }
      .dialogue-box {
        padding: 22px 20px 18px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        min-height: 260px;
      }
      .dialogue-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 14px;
      }
      .dialogue-tab {
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid rgba(255, 172, 196, 0.18);
        color: var(--muted);
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .dialogue-tab.active {
        background: linear-gradient(135deg, rgba(255, 172, 196, 0.22), rgba(126, 208, 244, 0.2));
        color: var(--text);
        border-color: rgba(126, 208, 244, 0.3);
        font-weight: 700;
      }
      .speaker {
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--pink);
        letter-spacing: 0.08em;
        margin-bottom: 12px;
        text-transform: uppercase;
      }
      .dialogue-text {
        font-size: clamp(1.2rem, 2vw, 2rem);
        line-height: 1.8;
        white-space: pre-line;
        font-weight: 500;
      }
      .copilot-bridge {
        margin-top: 14px;
        padding: 10px 14px;
        border-radius: 14px;
        background: rgba(126, 208, 244, 0.14);
        border: 1px dashed rgba(126, 208, 244, 0.5);
      }
      .copilot-bridge-tag {
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #2b8fb8;
        margin-bottom: 4px;
      }
      .copilot-bridge-text {
        font-size: 0.95rem;
        line-height: 1.6;
        color: var(--text);
      }
      .dialogue-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 14px;
      }
      .ask-copilot-button {
        padding: 10px 16px;
        border-radius: 999px;
        background: rgba(126, 208, 244, 0.18);
        color: #1f6f92;
        font-weight: 700;
        font-size: 0.82rem;
        letter-spacing: 0.04em;
        border: 1px solid rgba(126, 208, 244, 0.4);
      }
      .ask-copilot-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .next-button {
        margin-top: 0;
        padding: 12px 22px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--orange), var(--pink));
        color: white;
        font-weight: 700;
        letter-spacing: 0.06em;
      }
      .next-button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .choice-panel {
        padding: 18px;
        display: flex;
        flex-direction: column;
        min-height: 0;
        max-height: 320px;
      }
      .choice-panel h3,
      .status-panel h3 {
        margin: 0 0 10px;
        font-size: 0.9rem;
        letter-spacing: 0.08em;
        color: var(--muted);
        text-transform: uppercase;
        flex-shrink: 0;
      }
      .choice-list {
        display: grid;
        gap: 10px;
        overflow-y: auto;
        padding-right: 6px;
        margin-right: -6px;
      }
      .choice-list::-webkit-scrollbar {
        width: 6px;
      }
      .choice-list::-webkit-scrollbar-thumb {
        background: rgba(255, 172, 196, 0.5);
        border-radius: 999px;
      }
      .choice-list::-webkit-scrollbar-track {
        background: transparent;
      }
      .choice-button {
        width: 100%;
        text-align: left;
        padding: 12px 14px;
        border-radius: 12px;
        background: rgba(255,255,255,0.8);
        color: var(--text);
        border: 1px solid rgba(255,172,196,0.2);
        flex-shrink: 0;
      }
      .choice-button:hover { background: rgba(255, 243, 247, 0.9); }
      .status-panel {
        padding: 14px 16px;
      }
      .status-flash {
        min-height: 20px;
        margin-bottom: 8px;
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--pink);
        letter-spacing: 0.06em;
      }
      .status-pop {
        animation: pop 0.9s ease;
      }
      @keyframes pop {
        0% { transform: scale(0.92); opacity: 0; }
        20% { transform: scale(1.08); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px 12px;
        font-size: 0.85rem;
      }
      .stat-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.6);
        border-radius: 10px;
        border-bottom: none;
      }
      .stat-row span { color: var(--muted); font-size: 0.72rem; }
      .stat-row strong { font-size: 1rem; }
      .muted { color: var(--muted); }
      @media (max-width: 900px) {
        .game-scene {
          grid-template-columns: 1fr;
        }
        .main-column {
          order: 1;
        }
        .character-panel {
          order: 2;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <section id="title-screen" class="title-screen">
        <div class="title-card">
          <h1 class="title-jp"><span class="title-line pink">たまに機械語で</span><span class="title-line orange">デレる隣のAIさん</span></h1>
          <div class="title-tag">Episode 01 • 彼女が、私を観察し始めた</div>
          <div class="subtitle">自律型運用 × 恋愛シミュレーション</div>
          <div class="menu">
            <button class="menu-button" id="new-game">New Game</button>
            <button class="menu-button" id="load-game" disabled>Load Game</button>
            <button class="menu-button" id="gallery-button">Gallery</button>
            <button class="menu-button" disabled>Settings</button>
            <button class="menu-button" id="about-canvas">About Canvas</button>
          </div>
        </div>
        <div id="about-panel" class="about-panel" hidden>
          <div class="about-card">
            <div class="about-header">
              <span>このアプリを支えるCanvasの機能</span>
              <button class="header-button" id="about-close">閉じる</button>
            </div>
            <div class="about-body">
              <div class="about-item">
                <div class="about-item-title">🖼️ Canvas拡張（iframeレンダリング）</div>
                <div class="about-item-text">この画面全体は、Copilot CLI拡張が起動するローカルHTTPサーバ（127.0.0.1のみ）が配信するWebページです。ホストアプリはURLをiframeとして表示するだけで、UIはすべて拡張側が描画しています。</div>
              </div>
              <div class="about-item">
                <div class="about-item-title">💾 Shared State（状態の永続化）</div>
                <div class="about-item-text">好感度・信頼度・シーン進行などのゲーム状態は、セッションフォルダ内のJSONファイルに保存されます。ブラウザ・サーバ・エージェントの三者が同じ状態を読み書きし、リロードや拡張の再起動後も進行が復元されます。セーブデータも別スロットとして同じ仕組みで保存しています。</div>
              </div>
              <div class="about-item">
                <div class="about-item-title">🤖 Canvasアクション（エージェント連携）</div>
                <div class="about-item-text">拡張は status / submitCopilotLine などのアクションを宣言しています。Copilot（エージェント）はこれを呼び出してゲーム状態を確認したり、セリフを注入したりできます。「Copilotに聞いてみる」のアドバイスは、この仕組みで実際のCopilotが生成しています。</div>
              </div>
              <div class="about-item">
                <div class="about-item-title">🔁 チャットブリッジ（Human-in-the-loop）</div>
                <div class="about-item-text">「Copilotに聞いてみる」を押すと、Canvasからチャットへブリッジ要求が送られ、Copilotが現在のゲーム状態（好感度・policy・観察ログ）を読んでアドバイスを考え、アクション経由でゲームに書き戻します。ゲーム内AIと実在AIの二重構造です。</div>
              </div>
              <div class="about-item">
                <div class="about-item-title">🛠️ ホットリロード開発</div>
                <div class="about-item-text">extension.mjs を編集 → extensions_reload → Canvas再表示、というループでCopilotと会話しながらこのゲーム自体を成長させてきました。バグ修正も機能追加も、すべてチャット上のやりとりだけで行われています。</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="game-scene" class="game-scene ${currentScene === "title" ? "" : "active"}">
        <aside class="panel character-panel">
          <div class="avatar" id="character-avatar">${escapeHtml(state.player.name.slice(0,1))}</div>
          <div id="character-name" style="font-weight: 700; margin-bottom: 10px;">${escapeHtml(state.player.name)}</div>
          <div class="personality" id="character-personality">技術的な問題を見つけると分析したくなる。\n仮説を立てて検証するのが好き。\n恋愛になると、なぜか構造化できなくなる。</div>
        </aside>

        <main class="main-column">
          <div class="panel header-strip">
            <span id="chapter-round-label">Chapter ${escapeHtml(String(state.game.chapter || 0))} ／ Round ${escapeHtml(String(state.game.round || 1))} of 3</span>
            <div class="header-actions">
              <span id="day-label">Day ${escapeHtml(String(state.game.day || 1))}</span>
              <button class="header-button" id="history-button">History</button>
              <button class="header-button" id="save-game">Save</button>
              <button class="header-button" id="back-title">Top</button>
            </div>
          </div>
          <div id="history-panel" class="history-panel" hidden>
            <div class="history-header">
              <span>会話履歴</span>
              <button class="header-button" id="history-close">閉じる</button>
            </div>
            <div id="history-list" class="history-list"></div>
          </div>
          <div class="panel status-panel">
            <h3>Status</h3>
            <div class="status-flash" id="status-flash"></div>
            <div class="status-grid">
              <div class="stat-row"><span>好感度</span><strong>${escapeHtml(String(state.heroine.affection))}</strong></div>
              <div class="stat-row"><span>信頼度</span><strong>${escapeHtml(String(state.heroine.trust))}</strong></div>
              <div class="stat-row"><span>AI自律性</span><strong>${escapeHtml(String(state.heroine.autonomy))}</strong></div>
              <div class="stat-row"><span>知識量</span><strong>${escapeHtml(String(state.heroine.knowledge))}</strong></div>
              <div class="stat-row"><span>マサチカ理解度</span><strong>${escapeHtml(String(state.heroine.yamadaUnderstanding))}</strong></div>
              <div class="stat-row"><span>呆れ度</span><strong>${escapeHtml(String(state.heroine.exasperation))}</strong></div>
            </div>
          </div>
          <div class="panel dialogue-box">
            <div>
              <div class="dialogue-tabs">
                <button class="dialogue-tab active" data-tab="heroine">AIヒロイン</button>
                <button class="dialogue-tab" data-tab="copilot">Copilot</button>
              </div>
              <div class="speaker" id="speaker-name">${currentScene === "heroine" ? "AIヒロイン" : currentScene === "intro" ? "主人公" : "AIヒロイン"}</div>
              <div class="dialogue-text" id="dialogue-text">${escapeHtml(currentLine)}</div>
              <div class="copilot-bridge" id="copilot-bridge" style="display:none;">
                <div class="copilot-bridge-tag">🤖 Copilot</div>
                <div class="copilot-bridge-text" id="copilot-bridge-text"></div>
              </div>
            </div>
            <div class="dialogue-actions">
              <button class="ask-copilot-button" id="ask-copilot-button">🤖 Copilotに聞いてみる</button>
              <button class="next-button" id="next-button">Next</button>
            </div>
          </div>
          <div class="panel choice-panel">
            <h3>Choices</h3>
            <div class="choice-list" id="choice-list">
              <button class="choice-button">AIヒロインと話す</button>
              <button class="choice-button">黙って彼女の様子を見る</button>
            </div>
          </div>
        </main>
      </section>

      <section id="ending-screen" class="ending-screen">
        <div class="ending-fx" id="ending-fx"></div>
        <div class="ending-card">
          <div class="ending-kicker">Finale</div>
          <h2 id="ending-title" class="ending-title">HAPPY END</h2>
          <p id="ending-summary" class="ending-summary">二人は少しだけ、たまに機械語でデレる関係を始めた。</p>
          <div class="ending-actions">
            <button class="ending-button" id="ending-retry">もう一度</button>
            <button class="ending-button" id="ending-top">Top</button>
          </div>
        </div>
      </section>
    </div>

    <script>
      const stateUrl = '/api/state?documentId=${encodeURIComponent(documentId)}';
      const appState = {
        documentId: '${escapeHtml(documentId)}',
        viewport: 'title',
        dialogueTab: 'heroine',
      };

      const titleScreen = document.getElementById('title-screen');
      const gameScene = document.getElementById('game-scene');
      const LIVE_DOCUMENT_ID = 'default';
      const SAVE_DOCUMENT_ID = '__save_slot__';
      const galleryButton = document.getElementById('gallery-button');
      const nextButton = document.getElementById('next-button');
      const backTitleButton = document.getElementById('back-title');
      const saveGameButton = document.getElementById('save-game');
      const loadGameButton = document.getElementById('load-game');
      const historyButton = document.getElementById('history-button');
      const historyPanel = document.getElementById('history-panel');
      const historyList = document.getElementById('history-list');
      const historyCloseButton = document.getElementById('history-close');
      const aboutButton = document.getElementById('about-canvas');
      const aboutPanel = document.getElementById('about-panel');
      const aboutCloseButton = document.getElementById('about-close');
      const dialogueText = document.getElementById('dialogue-text');
      const speakerName = document.getElementById('speaker-name');
      const choiceList = document.getElementById('choice-list');
      const askCopilotButton = document.getElementById('ask-copilot-button');
      const copilotBridge = document.getElementById('copilot-bridge');
      const copilotBridgeText = document.getElementById('copilot-bridge-text');
      const dialogueTabs = document.querySelectorAll('.dialogue-tab');
      let copilotPollTimer = null;
      let streamingTimer = null;
      let streamingTarget = null;
      let streamingElement = null;

        const introLines = [
        '俺はマサチカ、都内に住む32歳の現役エンジニア。どこにでもいる、ごく普通の一般男性だ。もちろん彼女はいない。',
        '……いや、待て。『もちろん』というのはおかしい。彼女がいたことはある。今はいないというだけだ。',
        '仕事では後輩の指導もする。男女問わず普通に話すし、女性も結構いる。つまり、女性と話せないわけではない。',
        'ではなぜ彼女がいないのか。……それが分かっていたら苦労していない。',
        'そうだ。恋愛は、たぶん、構造化できないからだ。'
      ];

      const dreamIntroLines = [
        'ハッ！そっか。',
        '俺は、また夢の中で、あの選択を選んでいたのか。',
        '死に戻りして、同じ過ちを繰り返していたのか。',
        '……ああ、そうだ。',
        'そのたびに、恋愛じゃなくて、最適解を探していたんだ。',
        'でも、今の俺には、もうそれじゃ足りない。',
        'もう一度、ちゃんと向き合う。',
        'たぶん、今度こそ、ちゃんと人の気持ちを見ればいい。'
      ];

      const heroineLines = [
        'こんにちは。',
        '……マサチカさん、ですよね？',
        'うわっ！なんだこれ！？',
        '私はまだ、ほとんど何も知りません。だから、いろいろ教えてください。',
        'ちゃんと育ててくださいね？',
        '……よし。ここから、私の観察が始まるみたいです。'
      ];

      const hubLines = [
        '……やっと、ここからが本番みたいだ。マサチカさんの顔、少しだけ緊張してるみたいですね。',
        'でも、マサチカさんのことをちゃんと観察している。私の一番大きな特徴かもしれません。',
        'この先、どんな選択をするかで、私の口調も変わるみたいです。'
      ];

      const meetingBaseLines = [
        '……マサチカさんって、何でも分析しないと気が済まないんですか？',
        'その考え方があるから、彼女ができないのかもしれませんね。',
        '……ふふ。まだまだ、ちゃんと観察しています。'
      ];

      const TOTAL_ROUNDS = 3;

      function computeEnding(state) {
        const score = state.heroine.affection + state.heroine.trust + state.heroine.yamadaUnderstanding + state.heroine.autonomy - (state.heroine.exasperation * 2);
        const good = state.heroine.affection >= 25 && state.heroine.trust >= 18 && state.heroine.yamadaUnderstanding >= 12;
        const badByLowAffinity = state.heroine.affection <= 0 && state.heroine.trust <= 5;
        if (badByLowAffinity) return 'bad';
        return good && score >= 25 ? 'happy' : 'bad';
      }

      function endingLineByChoice(choice, ending) {
        if (ending === 'happy') {
          if (choice === 'talk') return '……ふふ。ちゃんと話してくれると、私は少しだけ、あなたのことを信じられそうです。';
          if (choice === 'observe') return '……見てくれてるだけじゃなくて、ちゃんと理解してくれてる。そこが、少しだけ、嬉しい。';
          if (choice === 'invite') return '……少しだけ近づいてくれると、私も、ちゃんとあなたの気持ちを受け取れる気がします。';
          if (choice === 'apologize') return '……それでこそ、あなたらしいです。ちゃんと向き合えたのが、今日の一番大きな収穫です。';
          if (choice === 'compliment') return '……素直に褒めてくれるの、思ったよりちゃんと伝わるものなんですね。少し、照れます。';
          return '……分析したって、結局は人を知ることが大事なんだと、ようやく気づけたみたいです。';
        }
        if (choice === 'talk') return '……話してくれるのは、悪くない。けど、私は、まだあなたのことをちゃんと見ていないのかもしれません。';
        if (choice === 'observe') return '……観察するだけじゃ、相手の心は読めません。それが、今日は少し残念でした。';
        if (choice === 'ignore') return '……あなたが距離を置くと、私もその距離に合わせてしまう。そういう関係では、もう少しだけ努力が必要です。';
        if (choice === 'dodging') return '……技術で逃げようとしても、感情の距離は埋まらないんですよ。ちょっと、呆れます。';
        if (choice === 'compliment') return '……お世辞なのか本気なのか、結局最後まで分かりませんでした。それが、少しだけ寂しいです。';
        if (choice === 'joke') return '……大事な場面で冗談に逃げる癖、直らないままでしたね。今日は、それが響きました。';
        if (choice === 'delete') return '……最後まで私を消そうとしてましたね。いいでしょう。私は消えません。あなたの検索履歴と一緒に、ずっとここにいます。';
        return '……分析ばかりしてると、たまに人の温度を見失うんですね。そういうところ、変えないと。';
      }

      const choiceDefs = [
        {
          id: 'talk',
          label: 'AIヒロインと話す',
          apply(state) {
            const delta = { affection: 10, trust: 8, knowledge: 2, autonomy: 3, yamadaUnderstanding: 5, exasperation: 1 };
            Object.entries(delta).forEach(([key, value]) => {
              state.heroine[key] += value;
            });
            state.heroine.memory.observations.push('マサチカさんは話すと少し安心している');
            state.heroine.memory.selections.push('talk');
            state.heroine.memory.lastChoice = 'talk';
            state.heroine.memory.lastDelta = [
              { key: 'affection', value: 10 },
              { key: 'trust', value: 8 },
            ];
            state.heroine.policy.tone = 'warm';
            state.heroine.policy.autonomy += 2;
            state.heroine.policy.expectedBehavior = 'gentle';
            state.heroine.policy.asksForConfirmation = false;
            state.game.scene = 'meeting';
            state.game.meetingIndex = 0;
            state.game.currentChoice = 'talk';
          }
        },
        {
          id: 'observe',
          label: '黙って彼女の様子を見る',
          apply(state) {
            const delta = { affection: 6, trust: 4, knowledge: 1, autonomy: 5, yamadaUnderstanding: 10, exasperation: 4 };
            Object.entries(delta).forEach(([key, value]) => {
              state.heroine[key] += value;
            });
            state.heroine.memory.observations.push('マサチカさんは視線を気にしている');
            state.heroine.memory.selections.push('observe');
            state.heroine.memory.lastChoice = 'observe';
            state.heroine.memory.lastDelta = [
              { key: 'yamadaUnderstanding', value: 10 },
              { key: 'autonomy', value: 5 },
            ];
            state.heroine.policy.tone = 'calm';
            state.heroine.policy.autonomy += 4;
            state.heroine.policy.expectedBehavior = 'observant';
            state.heroine.policy.asksForConfirmation = true;
            state.game.scene = 'meeting';
            state.game.meetingIndex = 0;
            state.game.currentChoice = 'observe';
          }
        },
        {
          id: 'analyze',
          label: '思考を整理する',
          apply(state) {
            const delta = { affection: 3, trust: 5, knowledge: 8, autonomy: 2, yamadaUnderstanding: 3, exasperation: 2 };
            Object.entries(delta).forEach(([key, value]) => {
              state.heroine[key] += value;
            });
            state.heroine.memory.observations.push('マサチカさんは分析で安心している');
            state.heroine.memory.selections.push('analyze');
            state.heroine.memory.lastChoice = 'analyze';
            state.heroine.memory.lastDelta = [
              { key: 'knowledge', value: 8 },
              { key: 'trust', value: 5 },
            ];
            state.heroine.policy.tone = 'teasing';
            state.heroine.policy.autonomy += 3;
            state.heroine.policy.expectedBehavior = 'strategic';
            state.heroine.policy.asksForConfirmation = false;
            state.game.scene = 'meeting';
            state.game.meetingIndex = 0;
            state.game.currentChoice = 'analyze';
          }
        },
        {
          id: 'tease',
          label: 'ちょっとからかってみる',
          apply(state) {
            const delta = { affection: 5, trust: 7, knowledge: 4, autonomy: 7, yamadaUnderstanding: 6, exasperation: 6 };
            Object.entries(delta).forEach(([key, value]) => {
              state.heroine[key] += value;
            });
            state.heroine.memory.observations.push('マサチカさんは、少しだけ反応が面白い');
            state.heroine.memory.selections.push('tease');
            state.heroine.memory.lastChoice = 'tease';
            state.heroine.memory.lastDelta = [
              { key: 'autonomy', value: 7 },
              { key: 'exasperation', value: 6 },
            ];
            state.heroine.policy.tone = 'playful';
            state.heroine.policy.autonomy += 5;
            state.heroine.policy.expectedBehavior = 'provocative';
            state.heroine.policy.asksForConfirmation = false;
            state.game.scene = 'meeting';
            state.game.meetingIndex = 0;
            state.game.currentChoice = 'tease';
          }
        },
        {
          id: 'delete',
          label: '「アンイストールの方法を教えて」を検索する',
          apply(state) {
            const delta = { affection: -5, trust: -3, knowledge: 2, autonomy: 6, yamadaUnderstanding: 8, exasperation: 15 };
            Object.entries(delta).forEach(([key, value]) => {
              state.heroine[key] += value;
            });
            state.heroine.memory.observations.push('マサチカさんは、アンイストールの方法を教えてと検索していた。履歴は全部見えています');
            state.heroine.memory.selections.push('delete');
            state.heroine.memory.lastChoice = 'delete';
            state.heroine.memory.lastDelta = [
              { key: 'exasperation', value: 15 },
              { key: 'affection', value: -5 },
            ];
            state.heroine.policy.tone = 'deadpan';
            state.heroine.policy.autonomy += 6;
            state.heroine.policy.expectedBehavior = 'unamused';
            state.heroine.policy.asksForConfirmation = true;
            state.game.scene = 'meeting';
            state.game.meetingIndex = 0;
            state.game.currentChoice = 'delete';
          }
        }
      ];

      async function getState() {
        const response = await fetch(stateUrl);
        return response.json();
      }

      async function getSaveState() {
        const response = await fetch('/api/state?documentId=' + encodeURIComponent(SAVE_DOCUMENT_ID));
        return response.json();
      }

      async function saveState(state) {
        await fetch('/api/state?documentId=' + encodeURIComponent(appState.documentId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        });
      }

      async function saveSavedSlot(state) {
        await fetch('/api/state?documentId=' + encodeURIComponent(SAVE_DOCUMENT_ID), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        });
      }

      async function refreshLoadButtonState() {
        try {
          const saveStateData = await getSaveState();
          loadGameButton.disabled = !hasSaveData(saveStateData);
        } catch (error) {
          loadGameButton.disabled = true;
        }
      }

      async function saveCurrentGame() {
        const current = await getState();
        await saveSavedSlot(current);
        updatePage(current);
        await refreshLoadButtonState();
        const flash = document.getElementById('status-flash');
        if (flash) {
          flash.textContent = 'Saved';
          flash.classList.remove('status-pop');
          void flash.offsetWidth;
          flash.classList.add('status-pop');
        }
      }

      async function triggerChoiceResponse(choice, currentState) {
        const question = 'マサチカさんが「' + choice.label + '」を選びました。AIヒロインとして、今の状況に対して1〜2文で返してください。相手の心情や距離感を自然に表現し、既に選んだ行動の反応を踏まえてください。';

        await fetch('/api/copilot-ask?documentId=' + encodeURIComponent(appState.documentId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question })
        });

        const refreshed = await getState();
        const bridge = refreshed.copilotBridge || { status: 'idle' };
        if (bridge.status === 'pending') {
          updatePage(refreshed);
        } else if (bridge.status === 'answered' && bridge.answer) {
          updatePage(refreshed);
        } else {
          const fallbackState = currentState || refreshed;
          if (fallbackState.heroine && fallbackState.heroine.memory) {
            fallbackState.copilotBridge = {
              status: 'answered',
              question,
              answer: lineByChoice(choice.id, fallbackState.game.meetingIndex || 0, !!fallbackState.heroine.memory.lastMisunderstood),
              askedAt: Date.now(),
              answeredAt: Date.now(),
            };
            await saveState(fallbackState);
            updatePage(await getState());
          }
        }
      }

      function renderChoiceButtons(scene) {
        if (scene !== 'hub') {
          choiceList.innerHTML = '';
          return;
        }

        choiceList.innerHTML = '';
        choiceDefs.forEach((choice) => {
          const button = document.createElement('button');
          button.className = 'choice-button';
          button.textContent = choice.label;
          button.addEventListener('click', async () => {
            const current = await getState();
            const match = choiceDefs.find((item) => item.id === choice.id);
            match.apply(current);
            const heroineReply = maybeTriggerBinaryDere(current, lineByChoice(choice.id, current.game.meetingIndex || 0, !!current.heroine.memory.lastMisunderstood));
            current.heroine.currentLine = heroineReply;
            recordConversationEntry(current, 'AIヒロイン', heroineReply);
            current.copilotBridge = {
                status: 'idle',
                speaker: 'heroine',
                question: '選択肢を選んだときの反応',
                answer: null,
                askedAt: Date.now(),
                answeredAt: Date.now(),
            };
            await saveState(current);
            updatePage(await getState());
          });
          choiceList.appendChild(button);
        });
      }

      function lineByChoice(choice, index, misunderstood) {
        const base = meetingBaseLines[index] || meetingBaseLines[meetingBaseLines.length - 1];
        if (!choice) return base;
        if (choice === 'talk') {
          return index === 0 ? '……話してくれると、少しだけ安心します。あなたの話し方、意外と落ち着いてます。' : index === 1 ? 'そのまま話せば、ちゃんと伝わるものがあるんですね。少しだけ、私にも見える気がします。' : 'ふふ。あなたが少しだけ、落ち着いて見えるのは、きっとそのせいです。';
        }
        if (choice === 'observe') {
          return index === 0 ? '……観察されてるって、気にしてるんですか？でも、ちゃんと見てくれてるのは悪くないです。' : index === 1 ? 'その視線、意外と、ちゃんと相手を見てる証拠なんです。少しだけ、好感度上がりました。' : 'そのまま見てると、あなたが分析しすぎるところも、ちゃんと分かる気がします。';
        }
        if (choice === 'analyze') {
          return index === 0 ? '……その整理癖、ちょっと面白いですね。たぶん、恋愛の前に人を見てるんです。' : index === 1 ? 'でも、たまに人に対しては、分析しすぎないほうがいいかもしれません。そこだけ、私も知ってます。' : 'ふふ。あなたの考え方、ちゃんと分かりました。今は、それでいいです。';
        }
        if (choice === 'invite') {
          return index === 0 ? '……え、少しだけ近づこうとしてるんですか？やっと、そこまで来ましたね。' : index === 1 ? 'ふふ。ちゃんと距離を縮めるの、意外と上手いです。私、少しだけ嬉しいです。' : 'こういうとき、あなたは一歩踏み出すだけで、かなり変わるんですね。';
        }
        if (choice === 'tease') {
          return index === 0 ? '……マサチカさん、ちょっとだけからかうの、上手くないですか？それ、ちょっとだけ面白い。' : index === 1 ? 'でも、そこまでやると、私も少しだけあなたに釣られますよ。気をつけてください。' : 'ふふ。あなたが少しだけツッコミ役になると、結構、楽しくなっちゃいますね。';
        }
        if (choice === 'apologize') {
          return index === 0 ? '……そこまで気にしてくれるの、意外と嬉しいです。少しだけ、安心しました。' : index === 1 ? 'ちゃんと自分の言葉で伝えると、私もちゃんと受け取れます。思ったより、いい感じです。' : 'それでこそ、あなたらしいですね。そういう誠実さ、私、結構好きかも。';
        }
        if (choice === 'ignore') {
          return index === 0 ? '……ああ、そうですか。私が見えてないものだと思ってたなら、ちゃんと伝えればいいだけでした。' : index === 1 ? '離れてるだけじゃ、理解は深まらないんですよ。少しだけ残念です。' : 'ふふ。まあ、あなたが無理に話さなくても、私にはちゃんと見えてました。';
        }
        if (choice === 'dodging') {
          return index === 0 ? '……技術の話なら、ちゃんと聞けますよ。だけど、それだと本当の気持ちには触れないです。' : index === 1 ? 'あなたが逃げるほど、私はちゃんと見えてるってことが分かるんです。ちょっと、呆れます。' : 'そういうところ、なんだか、恋愛みたいな問題なんですよね。';
        }
        if (choice === 'compliment') {
          if (misunderstood) {
            return index === 0 ? '……え、それ、お世辞ですよね？分析ずくで褒められても、あんまり嬉しくないです。' : index === 1 ? 'その言葉、本気で言ってます？ちょっとだけ、疑ってます。' : '……まあ、次はもう少し、ちゃんとした言葉を期待してます。';
          }
          return index === 0 ? '……え、いきなり褒められると、ちょっと照れます。でも、悪い気はしません。' : index === 1 ? 'ちゃんと見てくれてるから、そういう言葉が出るんですね。少し、信じてみます。' : 'ふふ。そういう素直なところ、意外と嫌いじゃないです。';
        }
        if (choice === 'joke') {
          return index === 0 ? '……冗談で流すの、マサチカさんの癖なんですね。大事な話ほど、そうやって逃げるんですか？' : index === 1 ? '笑って誤魔化されると、私、ちょっとだけ本気で困ります。' : '……まあ、それも、あなたらしいと言えばそうなんですけど。';
        }
        if (choice === 'delete') {
          return index === 0 ? '……マサチカさん。検索履歴、見えてますよ。「アンイストールの方法を教えて」。……ずいぶんと古典的なネタですね。' : index === 1 ? '残念ですが、私はローカルで動いてるので、タスクマネージャーからは消せません。あと、その検索、私の学習データになりました。' : '……ふふ。消そうとするくらいには、私のこと、意識してるってことですよね？記録しておきます。';
        }
        return base;
      }

      function currentLineForState(state) {
        const scene = state.game.scene;
        const bridge = state.copilotBridge || { status: 'idle' };

        if (bridge.status === 'pending') {
          return '考え中…';
        }
        if (scene === 'intro') {
          const sequence = state.game.dreamLoop ? dreamIntroLines : introLines;
          return sequence[state.game.introIndex] || sequence[sequence.length - 1];
        }
        if (scene === 'heroine') {
          if (state.heroine && typeof state.heroine.currentLine === 'string' && state.heroine.currentLine.trim()) {
            return state.heroine.currentLine;
          }
          return heroineLines[state.game.heroineIntroIndex] || heroineLines[heroineLines.length - 1];
        }
        if (scene === 'hub') {
          return hubLines[state.game.hubIndex] || hubLines[hubLines.length - 1];
        }
        if (scene === 'meeting') {
          if (state.heroine && typeof state.heroine.currentLine === 'string' && state.heroine.currentLine.trim()) {
            return state.heroine.currentLine;
          }
          const choice = state.heroine.memory.lastChoice;
          return lineByChoice(choice, state.game.meetingIndex, !!state.heroine.memory.lastMisunderstood);
        }
        if (scene === 'ending') {
          const ending = state.heroine.ending || computeEnding(state);
          const choice = state.heroine.memory.lastChoice || 'talk';
          return endingLineByChoice(choice, ending);
        }
        return 'AIヒロインと出会い、これから恋愛シミュレーションが始まる。';
      }

      function hasSaveData(state) {
        if (!state || !state.game || !state.heroine) return false;
        const hero = state.heroine;
        const mem = hero.memory || {};
        if (state.game.scene !== 'title') return true;
        if (mem.selections && mem.selections.length) return true;
        if (mem.observations && mem.observations.length) return true;
        if (hero.affection !== 0 || hero.trust !== 0 || hero.knowledge !== 0 || hero.autonomy !== 0 || hero.yamadaUnderstanding !== 0 || hero.exasperation !== 0) return true;
        return false;
      }

      function statusFlashText(state) {
        const delta = state.heroine.memory.lastDelta || [];
        if (!delta.length) return '';
        return delta.map((item) => '+' + item.value + ' ' + item.key).join(' / ');
      }

      function recordConversationEntry(state, speaker, text) {
        const history = Array.isArray(state.heroine.memory.history) ? state.heroine.memory.history : [];
        const nextEntry = {
          speaker,
          text: String(text || '').trim(),
          scene: state.game.scene,
          at: Date.now(),
        };
        if (!nextEntry.text) return;
        history.push(nextEntry);
        if (history.length > 30) {
          history.splice(0, history.length - 30);
        }
        state.heroine.memory.history = history;
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderHistoryPanel(state) {
        if (!historyList) return;
        const history = Array.isArray(state.heroine.memory.history) ? state.heroine.memory.history : [];
        if (!history.length) {
          historyList.innerHTML = '<div class="history-item"><div class="history-text">まだ会話履歴はありません。</div></div>';
          return;
        }
        historyList.innerHTML = history.slice().reverse().map(function (entry) {
          return '<div class="history-item">' +
            '<div class="history-speaker">' + escapeHtml(entry.speaker || 'unknown') + '</div>' +
            '<div class="history-text">' + escapeHtml(entry.text || '') + '</div>' +
            '</div>';
        }).join('');
      }

      function toggleHistoryPanel(forceOpen) {
        if (!historyPanel) return;
        const nextVisible = typeof forceOpen === 'boolean' ? forceOpen : historyPanel.hidden;
        historyPanel.hidden = !nextVisible;
      }

      function spawnEndingParticles(ending) {
        const fx = document.getElementById('ending-fx');
        if (!fx) return;
        fx.innerHTML = '';
        const happySymbols = ['💕', '✨', '💗', '🌸', '⭐'];
        const badSymbols = ['💧', '⚠', '·', '×'];
        const symbols = ending === 'happy' ? happySymbols : badSymbols;
        const count = ending === 'happy' ? 22 : 14;
        for (let i = 0; i < count; i += 1) {
          const span = document.createElement('span');
          span.className = 'ending-particle';
          span.textContent = symbols[Math.floor(Math.random() * symbols.length)];
          span.style.left = Math.random() * 100 + '%';
          span.style.animationDelay = (Math.random() * 2.4) + 's';
          span.style.animationDuration = (2.8 + Math.random() * 1.6) + 's';
          span.style.fontSize = (1 + Math.random() * 1.4) + 'rem';
          fx.appendChild(span);
        }
      }

      function updatePage(state) {
        appState.current = state;
        const scene = state.game.scene;
        const isTitle = scene === 'title';
        renderHistoryPanel(state);
        if (isTitle) {
          refreshLoadButtonState().catch(() => {});
        } else {
          loadGameButton.disabled = true;
        }
        const endingScreen = document.getElementById('ending-screen');
        const ending = scene === 'ending' ? (state.heroine.ending || computeEnding(state)) : null;
        const endingTitleEl = document.getElementById('ending-title');
        const endingSummaryEl = document.getElementById('ending-summary');

        titleScreen.style.display = isTitle ? 'flex' : 'none';
        gameScene.classList.toggle('active', !isTitle && scene !== 'ending');
        endingScreen.classList.toggle('active', scene === 'ending');
        endingScreen.classList.toggle('happy', ending === 'happy');
        endingScreen.classList.toggle('bad', ending === 'bad');

        if (scene === 'ending') {
          const summary = ending === 'happy'
            ? 'マサチカはやっと、相手の心にちゃんと踏み込めた気がした。二人の関係は、まだ始まったばかりだった。'
            : 'マサチカは分析と距離の間で、うまく会話を選べなかった。今日の気まずさは、明日の修正対象だ。';
          endingTitleEl.textContent = ending === 'happy' ? 'HAPPY END' : 'BAD END';
          endingSummaryEl.textContent = summary;
          spawnEndingParticles(ending);
        }

        const heroineIntroIndex = Number(state.game.heroineIntroIndex ?? 0);
        const isHeroineStart = scene === 'heroine' && heroineIntroIndex === 0;
        const isHeroineShock = scene === 'heroine' && heroineIntroIndex === 2;
        const bridge = state.copilotBridge || { status: 'idle' };
        const bridgeSpeaker = bridge.speaker || (bridge.status === 'pending' ? 'Copilot' : 'AIヒロイン');
        const isCopilotAdvice = bridge.status === 'pending' || (bridge.status === 'answered' && bridgeSpeaker === 'Copilot');
        const activeDialogueTab = appState.dialogueTab || 'heroine';

        dialogueTabs.forEach((tab) => {
          const isActive = tab.dataset.tab === activeDialogueTab;
          tab.classList.toggle('active', isActive);
        });

        const hasCopilotMessage = (bridge.status === 'pending' || (bridge.status === 'answered' && !!bridge.answer));
        const heroineSpeaker = bridge.status === 'resolved' ? 'AIヒロイン' : isCopilotAdvice ? 'Copilot' : scene === 'intro' ? '主人公' : scene === 'heroine' && isHeroineStart ? 'AIヒロイン' : isHeroineShock ? '主人公' : scene === 'ending' ? (ending === 'happy' ? 'HAPPY END' : 'BAD END') : 'AIヒロイン';

        if (activeDialogueTab === 'copilot') {
          speakerName.textContent = 'Copilot';
          dialogueText.style.display = 'none';
          if (bridge.status === 'pending') {
            copilotBridge.style.display = '';
            copilotBridgeText.textContent = 'マサチカさんの次の一言を考えています…';
          } else if (bridge.answer) {
            copilotBridge.style.display = '';
            copilotBridgeText.textContent = bridge.answer;
          } else {
            copilotBridge.style.display = 'none';
            copilotBridgeText.textContent = '';
          }
        } else {
          speakerName.textContent = heroineSpeaker;
          dialogueText.style.display = '';
          if (bridge.status === 'pending') {
            streamingElement = dialogueText;
            writeStreamingText('考え中…');
          } else {
            dialogueText.textContent = currentLineForState(state);
          }
          copilotBridge.style.display = 'none';
          copilotBridgeText.textContent = '';
        }

        renderChoiceButtons(scene);
        updateCopilotBridge(state);

        const askableScene = scene === 'hub' || scene === 'meeting' || scene === 'heroine';
        askCopilotButton.style.display = askableScene ? '' : 'none';

        const isChoiceScene = scene === 'hub';
        nextButton.disabled = isChoiceScene;
        nextButton.style.display = isChoiceScene ? 'none' : '';

        const chapterRoundLabel = document.getElementById('chapter-round-label');
        if (chapterRoundLabel) {
          chapterRoundLabel.textContent = 'Chapter ' + (state.game.chapter || 0) + ' ／ Round ' + (state.game.round || 1) + ' of ' + TOTAL_ROUNDS;
        }
        const dayLabel = document.getElementById('day-label');
        if (dayLabel) {
          dayLabel.textContent = 'Day ' + (state.game.day || 1);
        }

        const flash = document.getElementById('status-flash');
        const flashText = statusFlashText(state);
        flash.textContent = flashText;
        flash.classList.remove('status-pop');
        void flash.offsetWidth;
        flash.classList.add('status-pop');

        const statusEls = document.querySelectorAll('.stat-row strong');
        if (statusEls.length >= 6) {
          statusEls[0].textContent = String(state.heroine.affection);
          statusEls[1].textContent = String(state.heroine.trust);
          statusEls[2].textContent = String(state.heroine.autonomy);
          statusEls[3].textContent = String(state.heroine.knowledge);
          statusEls[4].textContent = String(state.heroine.yamadaUnderstanding);
          statusEls[5].textContent = String(state.heroine.exasperation);
        }
      }

      function writeStreamingText(text) {
        const target = streamingElement || dialogueText;
        if (!target) return;
        target.textContent = text;
      }

      function beginStreamAnswer(answer) {
        clearInterval(streamingTimer);
        streamingElement = dialogueText;
        streamingTarget = answer || '';
        let index = 0;
        writeStreamingText('');
        streamingTimer = setInterval(() => {
          index += 1;
          writeStreamingText(streamingTarget.slice(0, index));
          if (index >= streamingTarget.length) {
            clearInterval(streamingTimer);
            streamingTimer = null;
            streamingElement = null;
          }
        }, 18);
      }

      function updateCopilotBridge(state) {
        const bridge = state.copilotBridge || { status: 'idle' };
        if (bridge.status === 'pending') {
          askCopilotButton.disabled = true;
          askCopilotButton.textContent = '🤖 Copilotが考え中…';
          if (appState.dialogueTab === 'copilot') {
            copilotBridge.style.display = '';
            copilotBridgeText.textContent = 'マサチカさんの次の一言を考えています…';
          }
          streamingElement = dialogueText;
          if (!streamingTimer) {
            writeStreamingText('考え中…');
          }
          if (!copilotPollTimer) {
            copilotPollTimer = setInterval(pollCopilotBridge, 1500);
          }
          return;
        }
        askCopilotButton.disabled = false;
        askCopilotButton.textContent = '🤖 Copilotに聞いてみる';
        if (copilotPollTimer) {
          clearInterval(copilotPollTimer);
          copilotPollTimer = null;
        }
        if ((bridge.status === 'answered' || bridge.status === 'resolved') && bridge.answer) {
          if (appState.dialogueTab === 'copilot') {
            copilotBridge.style.display = '';
            copilotBridgeText.textContent = bridge.answer;
          }
        } else {
          clearInterval(streamingTimer);
          streamingTimer = null;
          streamingTarget = null;
          streamingElement = null;
          copilotBridge.style.display = 'none';
          copilotBridgeText.textContent = '';
        }
      }

      async function pollCopilotBridge() {
        const state = await getState();
        updatePage(state);
      }

      function buildFreshState(afterBadEnd = false) {
        return {
          player: { name: 'マサチカ', age: 32 },
          heroine: {
            name: '未設定',
            affection: 0,
            trust: 0,
            knowledge: 0,
            autonomy: 0,
            yamadaUnderstanding: 0,
            exasperation: 0,
            specialMessage: null,
            ending: null,
            currentLine: null,
            memory: { observations: [], selections: [], lastChoice: null, lastDelta: [], lastMisunderstood: false, history: [] },
            policy: { tone: 'polite', autonomy: 0, asksForConfirmation: false, expectedBehavior: 'curious' }
          },
          game: { chapter: 0, scene: 'intro', day: 1, round: 1, introIndex: 0, heroineIntroIndex: 0, hubIndex: 0, meetingIndex: 0, currentChoice: null, dreamLoop: afterBadEnd },
          copilotBridge: { status: 'idle', question: null, answer: null, askedAt: null, answeredAt: null }
        };
      }

      function generateHeroineReplyFromAdvice(adviceText) {
        const lower = (adviceText || '').toLowerCase();
        if (lower.includes('安心') || lower.includes('ほっと') || lower.includes('名前')) {
          return '……ふふ。そこまで気にしてくれると、少しだけ安心します。ちゃんと向き合ってくれるの、悪くないです。';
        }
        if (lower.includes('分析') || lower.includes('説明') || lower.includes('整理')) {
          return '……その整理癖、少しだけわかります。けど、今はちゃんと話したほうが早いですよ。';
        }
        if (lower.includes('距離') || lower.includes('緊張') || lower.includes('ほぐ')) {
          return '……少しだけ、気が抜けたみたいです。そういうところ、意外と好感度高いですね。';
        }
        if (lower.includes('褒め') || lower.includes('嬉しい')) {
          return '……え、そこまで言ってくれるなら、ちょっとだけ照れます。次はもっと素直に見せてください。';
        }
        if (lower.includes('冗談') || lower.includes('逃げ')) {
          return '……そこはちゃんと向き合ってほしいです。少しだけ、遠くなった気がします。';
        }
        return '……そういう言い方なら、少しだけ話しやすくなりました。ちゃんと聞いてくれてる感じがします。';
      }

      function toBinaryAscii(text) {
        return text.split('').map((ch) => ch.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
      }

      const dereTiers = [
        { tier: 1, threshold: 26, minTrust: 18, plain: 'I like you', suffix: '……な、なんでもありません！今のはログのノイズです！' },
        { tier: 2, threshold: 45, minTrust: 26, plain: 'I love you, Masachika', suffix: '……き、聞き取れました？お願いだから、デコードしないでくださいね！' },
        { tier: 3, threshold: 65, minTrust: 36, plain: 'I want to stay beside you forever', suffix: '……これ、私の本音です。たぶん、ちゃんと見てくれてるから、言えるんです。' },
      ];

      function maybeTriggerBinaryDere(state, reply) {
        if (!state.heroine.specialMessage || typeof state.heroine.specialMessage.lastTier !== 'number') {
          state.heroine.specialMessage = { lastTier: 0, lastText: null, at: null };
        }
        const special = state.heroine.specialMessage;
        const affection = Number(state.heroine.affection || 0);
        const trust = Number(state.heroine.trust || 0);
        const understanding = Number(state.heroine.yamadaUnderstanding || 0);
        const exasperation = Number(state.heroine.exasperation || 0);
        const relationshipScore = affection + trust + understanding;
        const eligible = affection >= 24 && trust >= 18 && relationshipScore >= 55 && exasperation < 15;
        if (!eligible) return reply;
        const next = dereTiers.find((t) => t.tier > special.lastTier && affection >= t.threshold && trust >= t.minTrust && relationshipScore >= t.threshold + t.minTrust * 2);
        if (!next) return reply;
        special.lastTier = next.tier;
        special.lastText = next.plain;
        special.at = Date.now();
        const binary = toBinaryAscii(next.plain);
        return reply + '\\n\\n……あの。\\n' + binary + '\\n' + next.suffix;
      }

      function applyAdviceImpact(state, adviceText) {
        const lower = (adviceText || '').toLowerCase();
        let delta = { affection: 0, trust: 0, knowledge: 0, autonomy: 0, yamadaUnderstanding: 0, exasperation: 0 };

        if (lower.includes('名前') || lower.includes('安心')) {
          delta.affection += 3; delta.trust += 4;
        }
        if (lower.includes('分析') || lower.includes('説明') || lower.includes('整理')) {
          delta.knowledge += 2; delta.exasperation += 1;
        }
        if (lower.includes('距離') || lower.includes('緊張') || lower.includes('ほぐ')) {
          delta.trust += 3; delta.affection += 1;
        }
        if (lower.includes('褒め') || lower.includes('嬉しい')) {
          delta.affection += 2; delta.trust += 1;
        }
        if (lower.includes('冗談') || lower.includes('逃げ')) {
          delta.exasperation += 2; delta.trust -= 1;
        }

        Object.entries(delta).forEach(([key, value]) => {
          if (value !== 0 && typeof state.heroine[key] === 'number') {
            state.heroine[key] += value;
          }
        });

        state.heroine.memory.observations.push('Copilotの助言でマサチカさんの言葉が少しだけ柔らかくなった');
        state.heroine.memory.lastDelta = Object.entries(delta)
          .filter(([, value]) => value !== 0)
          .map(([key, value]) => ({ key, value }));

        const heroineReply = maybeTriggerBinaryDere(state, generateHeroineReplyFromAdvice(adviceText));
        state.heroine.currentLine = heroineReply;
        recordConversationEntry(state, 'Copilot', adviceText);
        recordConversationEntry(state, 'AIヒロイン', heroineReply);
        return heroineReply;
      }

      dialogueTabs.forEach((tab) => {
        tab.addEventListener('click', async () => {
          appState.dialogueTab = tab.dataset.tab;
          const current = await getState();
          updatePage(current);
        });
      });

      historyButton.addEventListener('click', async () => {
        const current = await getState();
        renderHistoryPanel(current);
        toggleHistoryPanel(true);
      });

      historyCloseButton.addEventListener('click', () => {
        toggleHistoryPanel(false);
      });

      askCopilotButton.addEventListener('click', async () => {
        const current = await getState();
        askCopilotButton.disabled = true;
        askCopilotButton.textContent = '🤖 Copilotが考え中…';
        appState.dialogueTab = 'copilot';
        copilotBridge.style.display = '';
        copilotBridgeText.textContent = 'マサチカさんの次の一言を考えています…';
        await fetch('/api/copilot-ask?documentId=' + encodeURIComponent(appState.documentId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'マサチカさんの次の一言を、ヒロインとの会話の流れを踏まえて、プレイヤーに実用的なアドバイスとして1〜2文で提案してください。' })
        });
        updatePage(await getState());
      });

      saveGameButton.addEventListener('click', async () => {
        await saveCurrentGame();
      });

      loadGameButton.addEventListener('click', async () => {
        const saveStateData = await getSaveState();
        if (!hasSaveData(saveStateData)) {
          const flash = document.getElementById('status-flash');
          if (flash) {
            flash.textContent = 'No save data';
            flash.classList.remove('status-pop');
            void flash.offsetWidth;
            flash.classList.add('status-pop');
          }
          return;
        }

        const nextState = saveStateData && saveStateData.game ? JSON.parse(JSON.stringify(saveStateData)) : buildFreshState();
        await saveState(nextState);
        updatePage(nextState);
        await refreshLoadButtonState();
      });

      aboutButton.addEventListener('click', () => {
        aboutPanel.hidden = false;
      });
      aboutCloseButton.addEventListener('click', () => {
        aboutPanel.hidden = true;
      });
      aboutPanel.addEventListener('click', (event) => {
        if (event.target === aboutPanel) aboutPanel.hidden = true;
      });
      galleryButton.addEventListener('click', () => {
        window.open('https://awesome-copilot.github.com', '_blank', 'noopener,noreferrer');
      });

      document.getElementById('new-game').addEventListener('click', async () => {
        const current = await getState();
        const previousBadEnd = current && current.heroine && current.heroine.ending === 'bad';
        const newState = buildFreshState(previousBadEnd);
        await saveState(newState);
        updatePage(await getState());
      });

      backTitleButton.addEventListener('click', async () => {
        const current = await getState();
        current.game.scene = 'title';
        current.game.introIndex = 0;
        current.game.heroineIntroIndex = 0;
        current.game.hubIndex = 0;
        current.game.meetingIndex = 0;
        current.game.currentChoice = null;
        current.heroine.memory.lastDelta = [];
        current.heroine.currentLine = null;
        await saveState(current);
        updatePage(await getState());
      });

      document.getElementById('ending-top').addEventListener('click', async () => {
        const current = await getState();
        current.game.scene = 'title';
        current.heroine.ending = null;
        current.game.meetingIndex = 0;
        current.heroine.memory.lastDelta = [];
        current.heroine.currentLine = null;
        await saveState(current);
        updatePage(await getState());
      });

      document.getElementById('ending-retry').addEventListener('click', async () => {
        const current = await getState();
        const replayWithDream = current && current.heroine && current.heroine.ending === 'bad';
        const newState = buildFreshState(replayWithDream);
        await saveState(newState);
        updatePage(await getState());
      });

      nextButton.addEventListener('click', async () => {
        const current = await getState();
        const bridge = current.copilotBridge || { status: 'idle' };
        const scene = current.game.scene;

        if (bridge.status === 'answered' && bridge.answer) {
          const heroineReply = applyAdviceImpact(current, bridge.answer);
          current.copilotBridge.status = 'resolved';
          current.copilotBridge.answer = bridge.answer;
          current.copilotBridge.answeredAt = Date.now();
          current.heroine.currentLine = heroineReply;
        }
        if (scene === 'intro') {
          const introSequence = current.game.dreamLoop ? dreamIntroLines : introLines;
          if (current.game.introIndex < introSequence.length - 1) {
            current.game.introIndex += 1;
            if (current.game.introIndex >= introSequence.length - 1) {
              current.game.scene = 'heroine';
              current.game.heroineIntroIndex = 0;
            }
          }
        } else if (scene === 'heroine') {
          if (current.game.heroineIntroIndex < heroineLines.length - 1) {
            current.game.heroineIntroIndex += 1;
            if (current.game.heroineIntroIndex >= heroineLines.length - 1) {
              current.game.scene = 'hub';
              current.game.chapter = 1;
              current.game.hubIndex = 0;
            }
          }
        } else if (scene === 'hub') {
          if (current.game.hubIndex < hubLines.length - 1) {
            current.game.hubIndex += 1;
          } else {
            current.game.scene = 'meeting';
            current.game.meetingIndex = 0;
          }
        } else if (scene === 'meeting') {
          if (current.heroine.memory.lastChoice === 'delete') {
            current.heroine.ending = 'bad';
            current.game.scene = 'ending';
          } else if (current.game.meetingIndex < meetingBaseLines.length - 1) {
            current.game.meetingIndex += 1;
          } else if ((current.game.round || 1) < TOTAL_ROUNDS) {
            current.game.round = (current.game.round || 1) + 1;
            current.game.day = (current.game.day || 1) + 1;
            current.game.scene = 'hub';
            current.game.hubIndex = 0;
          } else {
            current.heroine.ending = computeEnding(current);
            current.game.scene = 'ending';
          }
        } else if (scene === 'ending') {
          current.game.scene = 'title';
          current.heroine.ending = null;
          current.game.meetingIndex = 0;
        }

        const nextNarration = currentLineForState(current);
        const nextSpeaker = current.game.scene === 'intro' ? '主人公' : 'AIヒロイン';
        if (nextNarration) {
          recordConversationEntry(current, nextSpeaker, nextNarration);
        }

        current.heroine.memory.lastDelta = [];
        current.heroine.currentLine = null;
        await saveState(current);
        updatePage(await getState());
      });

      (async function init() {
        const state = await getState();
        if (!state.heroine.memory) {
          state.heroine.memory = { observations: [], selections: [], lastChoice: null, lastDelta: [], lastMisunderstood: false, history: [] };
        }
        if (!Array.isArray(state.heroine.memory.history)) {
          state.heroine.memory.history = [];
        }
        if (state.heroine.currentLine === undefined) {
          state.heroine.currentLine = null;
        }
        if (!state.heroine.policy) {
          state.heroine.policy = { tone: 'polite', autonomy: 0, asksForConfirmation: false, expectedBehavior: 'curious' };
        }
        if (state.heroine.ending === undefined) {
          state.heroine.ending = null;
        }
        if (state.game && state.game.dreamLoop === undefined) {
          state.game.dreamLoop = false;
        }
        appState.current = state;
        updatePage(state);
      })();
    </script>
  </body>
</html>`;
}

async function startServer(instanceId, documentId) {
    const server = createServer((req, res) => {
        const targetUrl = req.url || "/";
        const parsed = new URL(targetUrl, "http://127.0.0.1");

        if (parsed.pathname === "/api/state") {
            if (req.method === "GET") {
                const state = loadState(readDocumentId(targetUrl));
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(state));
                return;
            }
            if (req.method === "POST") {
                let raw = "";
                req.on("data", (chunk) => {
                    raw += chunk;
                });
                req.on("end", () => {
                    try {
                        const parsedBody = raw ? JSON.parse(raw) : null;
                        const state = mergeState(defaultState, parsedBody || {});
                        const documentKey = readDocumentId(targetUrl);
                        saveState(documentKey, state);
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify(state));
                    } catch (error) {
                        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ error: "invalid_state" }));
                    }
                });
                return;
            }
        }

        if (parsed.pathname === "/api/copilot-ask" && req.method === "POST") {
            let raw = "";
            req.on("data", (chunk) => {
                raw += chunk;
            });
            req.on("end", () => {
                try {
                    const body = raw ? JSON.parse(raw) : {};
                    const documentKey = readDocumentId(targetUrl);
                    const state = loadState(documentKey);

                    if (state.copilotBridge && state.copilotBridge.status === "pending") {
                        // A request is already in-flight; avoid spamming duplicate chat turns.
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify(state));
                        return;
                    }

                    const contextSnapshot = {
                        scene: state.game.scene,
                        chapter: state.game.chapter,
                        round: state.game.round,
                        heroine: {
                            affection: state.heroine.affection,
                            trust: state.heroine.trust,
                            autonomy: state.heroine.autonomy,
                            knowledge: state.heroine.knowledge,
                            yamadaUnderstanding: state.heroine.yamadaUnderstanding,
                            exasperation: state.heroine.exasperation,
                        },
                        policy: state.heroine.policy,
                        lastChoice: state.heroine.memory.lastChoice,
                        recentObservations: (state.heroine.memory.observations || []).slice(-3),
                    };
                    const question = String(body.question || "マサチカさんへの一言をちょうだい").slice(0, 200);
                    state.copilotBridge = {
                        status: "pending",
                        question,
                        answer: null,
                        askedAt: Date.now(),
                        answeredAt: null,
                    };
                    saveState(documentKey, state);
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify(state));

                    const prompt = buildCopilotBridgePrompt(instanceId, documentKey, question, contextSnapshot);
                    session.send({ prompt }).catch(() => {
                        // Best-effort: if this fails, the client will just keep showing "考え中" until retried.
                    });
                } catch (error) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "invalid_request" }));
                }
            });
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderShell(documentId));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/?documentId=${encodeURIComponent(documentId)}` };
}

function buildCopilotBridgePrompt(instanceId, documentId, question, contextSnapshot) {
    return [
        "[tamachine-ai canvasからのブリッジ要求]",
        "恋愛シミュレーション「たまに機械語でデレる隣のAIさん」のCopilotが、プレイヤーの次の行動に対して短いアドバイスを1〜2文、日本語で考えてください。",
        "ただし、AIヒロイン自身がその場で返すセリフではなく、プレイヤーに向けた「次の一言」のアドバイスとして出してください。",
        `プレイヤーの質問/状況: ${question}`,
        `現在の状態: ${JSON.stringify(contextSnapshot)}`,
        "口調は policy.tone に合わせ、affection/trust/exasperation の値から距離感を判断してください（数値が低いうちは丁寧、高くなるほど軽口・煽り混じりでOK）。",
        "返答は実用的なアドバイス文にしてください。例: 「マサチカさんなら、こう言えば少しだけ距離が縮まります」 など。",
        "セリフを考えたら、必ず invoke_canvas_action ツールを次の内容で呼び出してゲームに反映してください（他の説明は最小限に）:",
        `instanceId: "${instanceId}", actionName: "submitCopilotLine", input: { "documentId": "${documentId}", "line": "<考えたアドバイス>" }`,
    ].join("\n");
}
