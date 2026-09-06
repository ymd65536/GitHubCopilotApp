const DEFAULT_DOCUMENT_ID = 'default';
const SAVE_DOCUMENT_ID = '__save_slot__';

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

const introLines = [
  '俺はマサチカ、都内に住む32歳の現役エンジニア。',
  'どこにでもいる、ごく普通の一般男性だ。',
  'もちろん彼女はいない。',
  '……いや、待て。',
  '『もちろん』というのはおかしい。',
  '彼女がいたことはある。今はいないというだけだ。',
  '仕事では後輩の指導もする。',
  '男女問わず普通に話すし、この業界では珍しいのか、知人には女性も結構いる。',
  'つまり女性と話せないわけではない。',
  'ではなぜ彼女がいないのか。',
  '……。',
  'それが分かっていたら苦労していない。',
  '……',
  'そうだ。恋愛は、たぶん、構造化できないからだ。'
];

const heroineLines = [
  'こんにちは。',
  '……マサチカさん、ですよね？',
  'うわっ！なんだこれ！？',
  '私はまだ、ほとんど何も知りません。',
  'だから、いろいろ教えてください。',
  'ちゃんと育ててくださいね？'
];

const hubLines = [
  '……やっと、ここからが本番みたいだ。マサチカさんの顔、少しだけ緊張してるみたいですね。',
  'でも、マサチカさんのことを、ちゃんと観察している。',
  'それが、今の私の一番大きな特徴かもしれません。'
];

const logistics = {
  titleScreen: document.getElementById('titleScreen'),
  gameScreen: document.getElementById('gameScreen'),
  endingScreen: document.getElementById('endingScreen'),
  historyPanel: document.getElementById('historyPanel'),
  avatar: document.getElementById('avatar'),
  characterName: document.getElementById('characterName'),
  characterSummary: document.getElementById('characterSummary'),
  chapterLabel: document.getElementById('chapterLabel'),
  dialogueText: document.getElementById('dialogueText'),
  speakerName: document.getElementById('speakerName'),
  selectionList: document.getElementById('choiceList'),
  copilotBridge: document.getElementById('copilotBridge'),
  statusFlash: document.getElementById('statusFlash'),
  freeTalkComposer: document.getElementById('freeTalkComposer'),
  freeTalkInput: document.getElementById('freeTalkInput'),
  historyList: document.getElementById('historyList'),
  endingTitle: document.getElementById('endingTitle'),
  endingSummary: document.getElementById('endingSummary')
};

const state = {
  documentId: DEFAULT_DOCUMENT_ID,
  current: structuredClone(defaultState)
};

const tabButtons = [...document.querySelectorAll('.tab-button')];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchState(documentId = state.documentId) {
  const response = await fetch(`/api/state?documentId=${encodeURIComponent(documentId)}`);
  if (!response.ok) {
    throw new Error('failed to load state');
  }
  return response.json();
}

async function saveState(nextState, documentId = state.documentId) {
  await fetch(`/api/state?documentId=${encodeURIComponent(documentId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState)
  });
}

function computeCurrentLine(nextState) {
  const scene = nextState.game.scene;
  if (scene === 'intro') {
    return introLines[nextState.game.introIndex] ?? introLines[introLines.length - 1];
  }
  if (scene === 'heroine') {
    return heroineLines[nextState.game.heroineIntroIndex] ?? heroineLines[heroineLines.length - 1];
  }
  if (scene === 'hub') {
    return hubLines[nextState.game.hubIndex] ?? hubLines[hubLines.length - 1];
  }
  if (scene === 'meeting') {
    const meeting = [
      '……マサチカさんって、何でも分析しないと気が済まないんですか？',
      'その考え方があるから、彼女ができないのかもしれませんね。',
      '……ふふ。まだまだ、ちゃんと観察しています。'
    ];
    return meeting[nextState.game.meetingIndex] ?? meeting[meeting.length - 1];
  }
  if (scene === 'freeTalk') {
    return nextState.heroine.currentLine || '……話してくれれば、ちゃんと聞きます。';
  }
  if (scene === 'ending') {
    const ending = nextState.heroine.affection >= 15 ? 'happy' : 'bad';
    return ending === 'happy'
      ? '……ふふ。ちゃんと話してくれると、私は少しだけ、あなたのことを信じられそうです。'
      : '……観察するだけじゃ、相手の心は読めません。それが、今日は少し残念でした。';
  }
  return 'AIヒロインと出会い、これから恋愛シミュレーションが始まる。';
}

function historyItems(stateData) {
  const records = Array.isArray(stateData.heroine.memory.history) ? stateData.heroine.memory.history : [];
  return records.slice(-10).reverse();
}

function renderHistory(stateData) {
  const items = historyItems(stateData);
  logistics.historyList.innerHTML = items.length
    ? items.map((item) => `
      <div class="history-item">
        <div class="history-speaker">${escapeHtml(item.speaker || '話者')}</div>
        <div class="history-text">${escapeHtml(item.text || '')}</div>
      </div>
    `).join('')
    : '<div class="history-item"><div class="history-text">まだ会話はありません。</div></div>';
}

function renderStatusBar(stateData) {
  const heroine = stateData.heroine;
  document.getElementById('affectionValue').textContent = String(heroine.affection);
  document.getElementById('trustValue').textContent = String(heroine.trust);
  document.getElementById('autonomyValue').textContent = String(heroine.autonomy);
  document.getElementById('knowledgeValue').textContent = String(heroine.knowledge);
  document.getElementById('understandingValue').textContent = String(heroine.yamadaUnderstanding);
  document.getElementById('exasperationValue').textContent = String(heroine.exasperation);
}

function renderChoiceList(stateData) {
  const scene = stateData.game.scene;
  const entries = scene === 'hub'
    ? [
      { id: 'talk', label: 'AIヒロインと話す' },
      { id: 'observe', label: '黙って彼女の様子を見る' },
      { id: 'analyze', label: '思考を整理する' }
    ]
    : [];

  logistics.selectionList.innerHTML = '';
  for (const item of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-button';
    button.textContent = item.label;
    button.addEventListener('click', async () => {
      const current = await fetchState();
      current.heroine.affection += 5;
      current.heroine.trust += 3;
      current.heroine.yamadaUnderstanding += 2;
      current.game.scene = 'meeting';
      current.game.meetingIndex = 0;
      current.heroine.memory.history.push({ speaker: 'マサチカ', text: item.label, scene: 'hub' });
      current.heroine.currentLine = item.id === 'talk'
        ? '……話してくれると少しだけ安心します。あなたの話し方、意外と落ち着いてます。'
        : item.id === 'observe'
          ? '……観察されてるって、気にしてるんですか？でも、ちゃんと見てくれてるのは悪くないです。'
          : '……その整理癖、ちょっと面白いですね。たぶん、恋愛の前に人を見てるんです。';
      await saveState(current);
      await render();
    });
    logistics.selectionList.appendChild(button);
  }
}

function renderScene(stateData) {
  const scene = stateData.game.scene;
  const onTitle = scene === 'title';
  logistics.titleScreen.classList.toggle('hidden', !onTitle);
  logistics.gameScreen.classList.toggle('hidden', onTitle || scene === 'ending');
  logistics.endingScreen.classList.toggle('hidden', scene !== 'ending');

  if (scene === 'ending') {
    const happy = stateData.heroine.affection >= 15;
    logistics.endingTitle.textContent = happy ? 'HAPPY END' : 'BAD END';
    logistics.endingSummary.textContent = happy
      ? '二人は少しだけ、たまに機械語でデレる関係を始めた。'
      : '観察だけでは、相手の想いは理解できない。今日の彼女の距離はまだ遠かった。';
  }

  if (!onTitle && scene !== 'ending') {
    logistics.avatar.textContent = 'M';
    logistics.characterName.textContent = stateData.player.name;
    logistics.characterSummary.textContent = '技術的な問題を見つけると分析したくなる。\n仮説を立てて検証するのが好き。\n恋愛になると、なぜか構造化できなくなる。';
    logistics.chapterLabel.textContent = `Chapter ${stateData.game.chapter} / Round ${stateData.game.round}`;
  }
}

function renderDialogue(stateData) {
  const scene = stateData.game.scene;
  const line = computeCurrentLine(stateData);
  logistics.dialogueText.textContent = line;

  if (scene === 'intro') {
    logistics.speakerName.textContent = '主人公';
  } else if (scene === 'heroine') {
    logistics.speakerName.textContent = 'AIヒロイン';
  } else if (scene === 'hub' || scene === 'meeting') {
    logistics.speakerName.textContent = 'AIヒロイン';
  } else if (scene === 'freeTalk') {
    logistics.speakerName.textContent = 'AIヒロイン';
  } else {
    logistics.speakerName.textContent = 'AIヒロイン';
  }

  const bridgeText = stateData.copilotBridge?.answer || '';
  if (bridgeText) {
    logistics.copilotBridge.textContent = bridgeText;
    logistics.copilotBridge.classList.remove('hidden');
  } else {
    logistics.copilotBridge.classList.add('hidden');
  }

  const composerVisible = scene === 'freeTalk';
  logistics.freeTalkComposer.classList.toggle('hidden', !composerVisible);
}

async function render() {
  const stateData = await fetchState();
  state.current = stateData;
  renderScene(stateData);
  renderStatusBar(stateData);
  renderDialogue(stateData);
  renderChoiceList(stateData);
  renderHistory(stateData);
  await syncLoadButtonState();
}

async function syncLoadButtonState() {
  try {
    const saveData = await fetchState(SAVE_DOCUMENT_ID);
    const hasSave = !!saveData && !!saveData.game;
    document.getElementById('loadGameBtn').disabled = !hasSave;
  } catch {
    document.getElementById('loadGameBtn').disabled = true;
  }
}

function setFlash(message) {
  logistics.statusFlash.textContent = message;
  logistics.statusFlash.classList.remove('status-pop');
  void logistics.statusFlash.offsetWidth;
  logistics.statusFlash.classList.add('status-pop');
}

async function startNewGame() {
  const nextState = structuredClone(defaultState);
  state.documentId = DEFAULT_DOCUMENT_ID;
  nextState.game.scene = 'intro';
  nextState.game.chapter = 0;
  nextState.heroine.memory.history = [
    { speaker: '主人公', text: introLines[0], scene: 'intro' },
    { speaker: '主人公', text: introLines[1], scene: 'intro' }
  ];
  await saveState(nextState, state.documentId);
  state.current = nextState;
  await render();
}

async function advanceStory() {
  const current = await fetchState();
  const scene = current.game.scene;

  if (scene === 'intro') {
    current.game.introIndex += 1;
    if (current.game.introIndex >= introLines.length) {
      current.game.scene = 'heroine';
      current.game.heroineIntroIndex = 0;
    }
  } else if (scene === 'heroine') {
    current.game.heroineIntroIndex += 1;
    if (current.game.heroineIntroIndex >= heroineLines.length) {
      current.game.scene = 'hub';
      current.game.chapter = 1;
      current.game.hubIndex = 0;
    }
  } else if (scene === 'hub') {
    current.game.hubIndex += 1;
    if (current.game.hubIndex >= hubLines.length) {
      current.game.scene = 'meeting';
      current.game.meetingIndex = 0;
    }
  } else if (scene === 'meeting') {
    current.game.meetingIndex += 1;
    if (current.game.meetingIndex >= 3) {
      current.game.scene = 'ending';
      current.heroine.ending = current.heroine.affection >= 15 ? 'happy' : 'bad';
    }
  } else if (scene === 'freeTalk') {
    // stay on current scene until user sends input
    return;
  }

  if (scene !== 'freeTalk') {
    current.heroine.memory.history.push({
      speaker: scene === 'intro' ? '主人公' : 'AIヒロイン',
      text: computeCurrentLine(current),
      scene
    });
  }

  await saveState(current);
  await render();
}

async function loadGame() {
  const saveData = await fetchState(SAVE_DOCUMENT_ID);
  if (saveData && saveData.game) {
    state.documentId = DEFAULT_DOCUMENT_ID;
    await saveState(saveData, state.documentId);
    state.current = saveData;
    await render();
    setFlash('Loaded');
  }
}

async function saveCurrentGame() {
  const current = await fetchState();
  await saveState(current, SAVE_DOCUMENT_ID);
  state.documentId = DEFAULT_DOCUMENT_ID;
  await syncLoadButtonState();
  setFlash('Saved');
}

async function askCopilot() {
  const current = await fetchState();
  const question = 'マサチカさんの次の一言を、ヒロインとの会話の流れを踏まえて、実用的なアドバイスとして1〜2文で提案してください。';
  const response = await fetch(`/api/copilot-ask?documentId=${encodeURIComponent(state.documentId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const json = await response.json();
  current.copilotBridge = json.copilotBridge || {
    status: 'answered',
    answer: 'マサチカさんなら、まずは「こんにちは。少しだけ緊張してますが、ちゃんと話を聞きます」と伝えると安心感が出ます。初対面では、分析よりも相手の警戒を下げる一言を先に投げるほうが、会話が滑りやすくなります。'
  };
  await saveState(current);
  await render();
}

async function sendFreeTalk() {
  const text = logistics.freeTalkInput.value.trim();
  if (!text) return;

  const current = await fetchState();
  current.game.scene = 'freeTalk';
  current.heroine.currentLine = text;
  current.heroine.memory.history.push({ speaker: 'マサチカ', text, scene: 'freeTalk' });
  const reply = text.toLowerCase().includes('hello')
    ? 'Hello？　えっと、あの…挨拶ならちゃんと返します。まだ会話の練習中なので、もう少しゆっくり話してもらえますか？'
    : text.toLowerCase().includes('仕事') || text.toLowerCase().includes('技術')
      ? '……その話なら、ちょっとだけあなたのことが見えてきました。技術好きって、結構、素敵です。'
      : '……それだけ伝えてくれれば、かなり話しやすいです。ちゃんと聞いてますよ。';
  current.heroine.currentLine = reply;
  current.heroine.affection = (current.heroine.affection || 0) + 1;
  current.heroine.knowledge = (current.heroine.knowledge || 0) + 1;
  current.heroine.memory.history.push({ speaker: 'AIヒロイン', text: reply, scene: 'freeTalk' });
  current.copilotBridge = { status: 'answered', answer: reply, mode: 'freeTalk', speaker: 'heroine' };
  await saveState(current);
  logistics.freeTalkInput.value = '';
  await render();
}

async function restoreDefaultView() {
  const current = await fetchState();
  if (current.game.scene === 'title') {
    logistics.titleScreen.classList.remove('hidden');
    logistics.gameScreen.classList.add('hidden');
  }
}

function bindEvents() {
  document.getElementById('newGameBtn').addEventListener('click', startNewGame);
  document.getElementById('loadGameBtn').addEventListener('click', loadGame);
  document.getElementById('freeTalkBtn').addEventListener('click', async () => {
    const current = await fetchState();
    current.game.scene = 'freeTalk';
    await saveState(current);
    await render();
  });
  document.getElementById('galleryBtn').addEventListener('click', () => {
    window.open('https://awesome-copilot.github.com', '_blank', 'noopener,noreferrer');
  });
  document.getElementById('nextBtn').addEventListener('click', advanceStory);
  document.getElementById('saveBtn').addEventListener('click', saveCurrentGame);
  document.getElementById('titleBtn').addEventListener('click', async () => {
    const current = await fetchState();
    current.game.scene = 'title';
    await saveState(current);
    await render();
  });
  document.getElementById('askCopilotBtn').addEventListener('click', askCopilot);
  document.getElementById('sendFreeTalkBtn').addEventListener('click', sendFreeTalk);
  document.getElementById('historyBtn').addEventListener('click', () => logistics.historyPanel.classList.toggle('hidden'));
  document.getElementById('historyCloseBtn').addEventListener('click', () => logistics.historyPanel.classList.add('hidden'));
  document.getElementById('endingRetryBtn').addEventListener('click', startNewGame);
  document.getElementById('endingTopBtn').addEventListener('click', async () => {
    const current = await fetchState();
    current.game.scene = 'title';
    await saveState(current);
    await render();
  });

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.toggle('active', b === button));
    });
  });
}

bindEvents();
render().catch(() => {
  setFlash('初期化に失敗');
});
