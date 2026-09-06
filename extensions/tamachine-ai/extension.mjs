import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession, createCanvas } from '@github/copilot-sdk/extension';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const servers = new Map();

const defaultState = {
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
    memory: {
      observations: [],
      selections: [],
      lastChoice: null,
      lastDelta: [],
      lastMisunderstood: false,
      history: []
    },
    policy: {
      tone: 'polite',
      autonomy: 0,
      asksForConfirmation: false,
      expectedBehavior: 'curious'
    }
  },
  game: {
    chapter: 0,
    scene: 'title',
    day: 1,
    round: 1,
    introIndex: 0,
    heroineIntroIndex: 0,
    hubIndex: 0,
    meetingIndex: 0,
    currentChoice: null,
    dreamLoop: false
  },
  copilotBridge: {
    status: 'idle',
    question: null,
    answer: null,
    askedAt: null,
    answeredAt: null,
    mode: 'advice',
    speaker: 'Copilot'
  }
};

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'tamachine-ai',
      displayName: 'たまに機械語でデレる隣のAIさん',
      description: 'AIヒロインとの出会いから始まる、学び合う恋愛シミュレーションのMVP。自律型運用 × 恋愛シミュレーション。',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'State document identifier' }
        },
        additionalProperties: true
      },
      actions: [
        {
          name: 'saveGame',
          description: '現在のゲーム状態を保存する',
          handler: async (ctx) => {
            const documentId = ctx.input?.documentId || 'default';
            const state = loadState(documentId);
            saveState(documentId, state);
            return state;
          }
        },
        {
          name: 'loadGame',
          description: '保存済みのゲーム状態を読み込む',
          handler: async (ctx) => {
            const documentId = ctx.input?.documentId || 'default';
            return loadState(documentId);
          }
        },
        {
          name: 'status',
          description: '現在のゲーム状態を返す',
          handler: async (ctx) => {
            const documentId = ctx.input?.documentId || 'default';
            return loadState(documentId);
          }
        },
        {
          name: 'advance',
          description: '次のセリフに進める',
          handler: async (ctx) => {
            const documentId = ctx.input?.documentId || 'default';
            const state = loadState(documentId);
            const scene = state.game.scene;

            if (scene === 'intro') {
              state.game.introIndex = (state.game.introIndex || 0) + 1;
              if (state.game.introIndex >= 14) {
                state.game.scene = 'heroine';
                state.game.heroineIntroIndex = 0;
              }
            } else if (scene === 'heroine') {
              state.game.heroineIntroIndex = (state.game.heroineIntroIndex || 0) + 1;
              if (state.game.heroineIntroIndex >= 6) {
                state.game.scene = 'hub';
                state.game.chapter = 1;
              }
            } else if (scene === 'hub') {
              state.game.hubIndex = (state.game.hubIndex || 0) + 1;
              if (state.game.hubIndex >= 3) {
                state.game.scene = 'meeting';
              }
            } else if (scene === 'meeting') {
              state.game.meetingIndex = (state.game.meetingIndex || 0) + 1;
              if (state.game.meetingIndex >= 3) {
                state.game.scene = 'ending';
              }
            }

            saveState(documentId, state);
            return state;
          }
        },
        {
          name: 'submitCopilotLine',
          description: 'Copilotが生成したセリフをゲーム状態に反映する',
          inputSchema: {
            type: 'object',
            properties: {
              documentId: { type: 'string' },
              line: { type: 'string' }
            },
            required: ['documentId', 'line'],
            additionalProperties: false
          },
          handler: async (ctx) => {
            const documentId = ctx.input?.documentId || 'default';
            const line = String(ctx.input?.line || '').slice(0, 400);
            const state = loadState(documentId);
            state.copilotBridge.status = 'answered';
            state.copilotBridge.answer = line;
            state.copilotBridge.answeredAt = Date.now();
            state.heroine.currentLine = line;
            state.heroine.memory.history.push({ speaker: 'AIヒロイン', text: line, scene: state.game.scene || 'freeTalk' });
            saveState(documentId, state);
            return state;
          }
        }
      ],
      open: async (ctx) => {
        const documentId = ctx.input?.documentId || 'default';
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, documentId);
          servers.set(ctx.instanceId, entry);
        }
        return {
          title: 'たまに機械語でデレる隣のAIさん / 自律型運用 × 恋愛シミュレーション',
          url: `${entry.url}?documentId=${encodeURIComponent(documentId)}`
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      }
    })
  ]
});

function ensureStorage() {
  const storageRoot = resolve(session.workspacePath || process.env.HOME || '/tmp', '.copilot', 'canvas', 'tamachine-ai');
  mkdirSync(storageRoot, { recursive: true });
  return storageRoot;
}

function buildStatePath(documentId) {
  const storageRoot = ensureStorage();
  return resolve(storageRoot, `${String(documentId || 'default').replace(/[^a-zA-Z0-9-_]+/g, '-')}.json`);
}

function loadState(documentId = 'default') {
  const statePath = buildStatePath(documentId);
  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return mergeState(defaultState, parsed);
    } catch {
      // ignore malformed state and fall back to default
    }
  }
  const initial = mergeState(defaultState, {});
  saveState(documentId, initial);
  return initial;
}

function saveState(documentId, state) {
  const statePath = buildStatePath(documentId);
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function mergeState(base, incoming = {}) {
  const sourceHeroine = incoming.heroine || {};
  return {
    player: { ...base.player, ...(incoming.player || {}) },
    heroine: {
      ...base.heroine,
      ...sourceHeroine,
      memory: {
        ...(base.heroine.memory || {}),
        ...(sourceHeroine.memory || {})
      },
      policy: {
        ...(base.heroine.policy || {}),
        ...(sourceHeroine.policy || {})
      }
    },
    game: { ...base.game, ...(incoming.game || {}) },
    copilotBridge: { ...base.copilotBridge, ...(incoming.copilotBridge || {}) }
  };
}

async function startServer(instanceId, documentId) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (pathname === '/api/state') {
      const stateDocumentId = requestUrl.searchParams.get('documentId') || documentId || 'default';
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(loadState(stateDocumentId)));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const merged = mergeState(defaultState, parsed);
            saveState(stateDocumentId, merged);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(merged));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid json' }));
          }
        });
        return;
      }
    }

    if (pathname === '/api/copilot-ask') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const stateDocumentId = requestUrl.searchParams.get('documentId') || documentId || 'default';
        const payload = JSON.parse(body || '{}');
        const answer = payload.question
          ? 'マサチカさんなら、まずは「こんにちは。少しだけ緊張してますが、ちゃんと話を聞きます」と伝えると安心感が出ます。初対面では、分析よりも相手の警戒を下げる一言を先に投げるほうが、会話が滑りやすくなります。'
          : '少しだけ、相手を落ち着かせる一言を先に伝えるといいです。';
        const current = loadState(stateDocumentId);
        current.copilotBridge = {
          status: 'answered',
          question: payload.question || null,
          answer,
          askedAt: Date.now(),
          answeredAt: Date.now(),
          mode: 'advice',
          speaker: 'Copilot'
        };
        saveState(stateDocumentId, current);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, copilotBridge: current.copilotBridge }));
      });
      return;
    }

    const fileMap = {
      '/': 'index.html',
      '/styles.css': 'styles.css',
      '/app.mjs': 'app.mjs'
    };
    const target = fileMap[pathname];
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const filePath = resolve(__dirname, target);
    try {
      const content = readFileSync(filePath);
      const contentType = pathname.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : pathname.endsWith('.mjs')
          ? 'application/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('asset not available');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}
