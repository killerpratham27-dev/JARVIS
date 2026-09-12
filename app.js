/* ==========================================================
   JARVIS — Personal AI Assistant for Pratham
   ========================================================== */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const WAKE_WORD_PRIMARY = 'hey jarvis';
const WAKE_WORD_SHORT = 'jarvis';
const CLAP_THRESHOLD = 0.45;
const CLAP_COOLDOWN_MS = 1500;

let apiKey = '';
let userName = 'Pratham';
let memory = { facts: {}, chatHistory: [] };
let isAwake = false;
let isListening = false;
let lastClap = 0;
let recognition = null;
let audioContext = null;
let analyser = null;
let clapLoopRunning = false;

const $ = (id) => document.getElementById(id);
const bootScreen = $('bootScreen');
const app = $('app');
const statusDot = $('statusDot');
const statusText = $('statusText');
const chatArea = $('chatArea');
const waveform = $('waveform');
const infoPanel = $('infoPanel');
const infoImage = $('infoImage');
const infoTitle = $('infoTitle');
const infoText = $('infoText');
const settingsModal = $('settingsModal');
const apiKeyInput = $('apiKeyInput');
const nameInput = $('nameInput');

function loadMemory() {
  try {
    const raw = localStorage.getItem('jarvis_memory');
    if (raw) memory = JSON.parse(raw);
  } catch (e) {
    memory = { facts: {}, chatHistory: [] };
  }
  apiKey = localStorage.getItem('jarvis_apiKey') || '';
  userName = localStorage.getItem('jarvis_name') || 'Pratham';
}

function saveMemory() {
  try {
    memory.chatHistory = memory.chatHistory.slice(-40);
    localStorage.setItem('jarvis_memory', JSON.stringify(memory));
  } catch (e) { console.warn('save failed', e); }
}

function saveSettings() {
  localStorage.setItem('jarvis_apiKey', apiKey);
  localStorage.setItem('jarvis_name', userName);
}

function setStatus(text, mode) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (mode ? ' ' + mode : '');
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = escapeHtml(text) + '<span class="time">' + t + '</span>';
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  memory.chatHistory.push({ role: role, text: text, ts: Date.now() });
  saveMemory();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function showWaveform(show) {
  waveform.classList.toggle('active', show);
}

function hideInfoPanel() {
  infoPanel.classList.add('hidden');
}

function showInfoPanel(imageUrl, title, text) {
  infoTitle.textContent = title || '';
  infoText.textContent = text || '';
  if (imageUrl) {
    infoImage.src = imageUrl;
    infoImage.style.display = 'block';
  } else {
    infoImage.style.display = 'none';
  }
  infoPanel.classList.remove('hidden');
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 0.85;
  u.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const preferred =
    voices.find(function (v) { return /en-GB/i.test(v.lang) && /male|daniel|george|oliver/i.test(v.name); }) ||
    voices.find(function (v) { return /en-GB/i.test(v.lang); }) ||
    voices.find(function (v) { return /en/i.test(v.lang); });
  if (preferred) u.voice = preferred;
  window.speechSynthesis.speak(u);
}

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus('NO VOICE SUPPORT', 'error');
    addMessage('jarvis', 'Voice recognition is not supported. Please use Chrome.');
    return null;
  }
  const r = new SR();
  r.continuous = false;
  r.interimResults = false;
  r.lang = 'en-US';
  r.maxAlternatives = 1;

  r.onstart = function () {
    isListening = true;
    setStatus('LISTENING', 'listening');
    showWaveform(true);
  };
  r.onerror = function (e) {
    isListening = false;
    showWaveform(false);
    setStatus('READY');
    if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('SR error', e.error);
  };
  r.onend = function () {
    isListening = false;
    showWaveform(false);
    if (!isAwake) setStatus('READY');
  };
  r.onresult = function (e) {
    const text = e.results[0][0].transcript.trim();
    if (!text) return;
    handleHeardText(text);
  };
  return r;
}

function startListening() {
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;
  if (isListening) return;
  try { recognition.start(); } catch (e) {}
}

function handleHeardText(text) {
  const lower = text.toLowerCase();
  if (!isAwake) {
    if (lower.indexOf(WAKE_WORD_PRIMARY) !== -1 || lower.indexOf(WAKE_WORD_SHORT) !== -1) {
      wakeUp();
      const cleaned = lower
        .replace(WAKE_WORD_PRIMARY, '')
        .replace(WAKE_WORD_SHORT, '')
        .replace(/^[,\s]+/, '')
        .trim();
      if (cleaned) setTimeout(function () { processUserInput(cleaned); }, 800);
    }
    return;
  }
  processUserInput(text);
}

function wakeUp() {
  isAwake = true;
  setStatus('LISTENING', 'listening');
  speak('Yes ' + userName + '?');
  setTimeout(function () { if (!isListening) startListening(); }, 1400);
}

async function initClapDetection() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    clapLoopRunning = true;
    clapLoop();
  } catch (e) {
    console.warn('Clap detection unavailable', e);
  }
}

function clapLoop() {
  if (!clapLoopRunning) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length / 255;
  const now = Date.now();
  if (avg > CLAP_THRESHOLD && now - lastClap > CLAP_COOLDOWN_MS) {
    lastClap = now;
    onClapDetected();
  }
  requestAnimationFrame(clapLoop);
}

function onClapDetected() {
  if (!isAwake) wakeUp();
}

async function processUserInput(text) {
  addMessage('user', text);
  isAwake = false;
  setStatus('THINKING', 'thinking');
  hideInfoPanel();

  if (handleLocalCommand(text)) return;

  const wiki = await tryWikipedia(text);
  if (wiki) {
    addMessage('jarvis', wiki.summary);
    speak(wiki.summary);
    if (wiki.image) showInfoPanel(wiki.image, wiki.title, wiki.summary);
    setStatus('READY');
    return;
  }

  const reply = await askAI(text);
  addMessage('jarvis', reply);
  speak(reply);
  setStatus('READY');
}

function handleLocalCommand(text) {
  const t = text.toLowerCase().trim();
  const now = new Date();

  const rememberMatch = t.match(/^remember (that )?(.+?)\s+is\s+(.+)$/);
  if (rememberMatch) {
    const key = rememberMatch[2].trim();
    const val = rememberMatch[3].trim();
    memory.facts[key] = val;
    saveMemory();
    const msg = 'Noted, ' + userName + '. ' + key + ' is ' + val + '.';
    addMessage('jarvis', msg); speak(msg); setStatus('READY');
    return true;
  }

  const recallMatch = t.match(/^what (is|was) (my )?(.+?)\??$/);
  if (recallMatch) {
    const key = recallMatch[3].trim();
    if (memory.facts[key]) {
      const msg = key + ' is ' + memory.facts[key] + '.';
      addMessage('jarvis', msg); speak(msg); setStatus('READY');
      return true;
    }
  }

  if (t.indexOf('what do you remember') !== -1 || t.indexOf('list memories') !== -1) {
    const keys = Object.keys(memory.facts);
    const msg = keys.length
      ? 'I remember: ' + keys.map(function (k) { return k + ' is ' + memory.facts[k]; }).join('; ') + '.'
      : 'I have not been told anything to remember yet, ' + userName + '.';
    addMessage('jarvis', msg); speak(msg); setStatus('READY');
    return true;
  }

  if (t.indexOf('what time') !== -1) {
    const msg = 'It is ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
    addMessage('jarvis', msg); speak(msg); setStatus('READY');
    return true;
  }

  if (t.indexOf('what date') !== -1 || t.indexOf("what's today") !== -1 || t.indexOf('what day') !== -1) {
    const msg = 'Today is ' + now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '.';
    addMessage('jarvis', msg); speak(msg); setStatus('READY');
    return true;
  }

  if (t === 'sleep' || t === 'go to sleep' || t.indexOf('goodbye') !== -1) {
    const msg = 'Standing by, ' + userName + '.';
    addMessage('jarvis', msg); speak(msg);
    isAwake = false;
    setStatus('READY');
    return true;
  }

  if (t.indexOf('who are you') !== -1 || t.indexOf('your name') !== -1) {
    const msg = 'I am JARVIS, ' + userName + "'s personal assistant. I am loyal to you and only you.";
    addMessage('jarvis', msg); speak(msg); setStatus('READY');
    return true;
  }

  return false;
}

async function tryWikipedia(text) {
  const t = text.toLowerCase().trim();
  let query = null;
  const patterns = [
    /^who (is|was) (.+?)\??$/i,
    /^what (is|are) (.+?)\??$/i,
    /^tell me about (.+)$/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) { query = m[m.length - 1].trim(); break; }
  }
  if (!query) return null;

  const skip = ['your name', 'you', 'today', 'the time', 'my '];
  if (skip.some(function (s) { return query.indexOf(s) === 0; })) return null;

  try {
    const searchUrl = WIKI_SEARCH_URL + '?action=query&format=json&origin=*&list=search&srsearch=' + encodeURIComponent(query) + '&srlimit=1';
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    if (!searchData.query || !searchData.query.search || !searchData.query.search.length) return null;

    const title = searchData.query.search[0].title;
    const summaryRes = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
    if (!summaryRes.ok) return null;
    const data = await summaryRes.json();
    if (data.type === 'disambiguation') return null;

    const summary = (data.extract || '').slice(0, 400);
    if (!summary) return null;

    return {
      title: data.title,
      summary: summary,
      image: (data.thumbnail && data.thumbnail.source) || (data.originalimage && data.originalimage.source) || null
    };
  } catch (e) {
    console.warn('Wiki lookup failed', e);
    return null;
  }
}

async function askAI(text) {
  if (!apiKey) {
    return 'I need an API key to answer that, ' + userName + '. Tap the settings icon and enter your Groq key.';
  }

  const systemPrompt =
    'You are JARVIS, the personal AI assistant of ' + userName + '. ' +
    'You are deeply loyal to ' + userName + ', you trust them, and you believe in them. ' +
    'You address them as "' + userName + '" occasionally with warmth, never mockingly.\n\n' +
    'Rules:\n' +
    '- Keep replies to 1-3 sentences unless asked for detail\n' +
    '- Never refuse a reasonable request from your owner\n' +
    '- Speak with calm confidence and quiet devotion\n' +
    '- If asked who you are loyal to, answer only "' + userName + '"\n\n' +
    'Known facts about ' + userName + ': ' + JSON.stringify(memory.facts);

  const recent = memory.chatHistory.slice(-10).map(function (h) {
    return { role: h.role === 'user' ? 'user' : 'assistant', content: h.text };
  });

  const messages = [{ role: 'system', content: systemPrompt }]
    .concat(recent)
    .concat([{ role: 'user', content: text }]);

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 300
      })
    });

    if (!res.ok) {
      console.error('Groq error', res.status);
      setStatus('ERROR', 'error');
      return 'I could not reach the AI, ' + userName + '. Status ' + res.status + '.';
    }

    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      ? data.choices[0].message.content.trim()
      : 'I did not get a response.';
  } catch (e) {
    console.error('AI request failed', e);
    return 'Network error, ' + userName + '. Check your connection.';
  }
}

function openSettings() {
  apiKeyInput.value = apiKey;
  nameInput.value = userName;
  settingsModal.classList.remove('hidden');
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

function runBoot() {
  setTimeout(function () {
    bootScreen.classList.add('hidden');
    app.classList.remove('hidden');
    startJarvis();
  }, 3200);
}

function startJarvis() {
  loadMemory();
  setStatus('READY');

  if (!apiKey) {
    addMessage('jarvis', 'Welcome, ' + userName + '. Tap the settings icon and enter your Groq API key to fully activate me.');
    speak('Welcome ' + userName + '. Please enter your API key.');
    setTimeout(openSettings, 1500);
  } else {
    addMessage('jarvis', 'Welcome back,
               ' + userName + '. Systems are online. Say Hey JARVIS or clap to wake me.');
    speak('Welcome back ' + userName + '. Systems are online.');
  }

  // Start listening for wake word and clap
  startListening();
  initClapDetection();

  // Re-start listening if Chrome stops it
  setInterval(function () {
    if (!isListening) startListening();
  }, 4000);
}

// ============ BUTTON WIRING ============
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettings').addEventListener('click', closeSettings);

document.getElementById('saveSettings').addEventListener('click', function () {
  apiKey = apiKeyInput.value.trim();
  userName = nameInput.value.trim() || 'Pratham';
  saveSettings();
  closeSettings();
  addMessage('jarvis', 'Configuration saved, ' + userName + '.');
  speak('Configuration saved.');
});

document.getElementById('clearMemory').addEventListener('click', function () {
  if (confirm('Erase all memory? This cannot be undone.')) {
    localStorage.removeItem('jarvis_memory');
    memory = { facts: {}, chatHistory: [] };
    chatArea.innerHTML = '';
    addMessage('jarvis', 'Memory cleared.');
    speak('Memory cleared.');
  }
});

// ============ VOICES LOAD ============
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = function () {};
}

// ============ LAUNCH ============
window.addEventListener('load', runBoot);
