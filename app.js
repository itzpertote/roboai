const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const apiBaseStorageKey = "robo-api-base";
const apiBase = resolveApiBase();

const i18n = {
  tr: {
    ready: "Hazır",
    listening: "Dinliyorum",
    thinking: "Düşünüyorum",
    speaking: "Konuşuyorum",
    unsupported: "Ses tanıma bu tarayıcıda yok.",
    placeholder: "Mesaj yaz",
    send: "Gönder",
    clear: "Temizle",
    apiReady: "API bağlı",
    apiDemo: "Yerel",
    apiError: "API hata",
    subtitleReady: "Robo AI hazır.",
    user: "Sen",
    assistant: "Robo AI",
    mic: "Mikrofon",
    empty: "Bir mesaj yaz veya mikrofonu aç.",
    transcriptLow: "Altyazı kontrol edildi",
    transcriptLive: "Canlı altyazı",
    language: "TR"
  },
  en: {
    ready: "Ready",
    listening: "Listening",
    thinking: "Thinking",
    speaking: "Speaking",
    unsupported: "Speech recognition is not available in this browser.",
    placeholder: "Type a message",
    send: "Send",
    clear: "Clear",
    apiReady: "API ready",
    apiDemo: "Local",
    apiError: "API error",
    subtitleReady: "Robo AI is ready.",
    user: "You",
    assistant: "Robo AI",
    mic: "Microphone",
    empty: "Type a message or open the microphone.",
    transcriptLow: "Subtitle checked",
    transcriptLive: "Live subtitle",
    language: "MIX"
  }
};

const elements = {
  shell: document.querySelector(".shell"),
  micButton: document.querySelector("#micButton"),
  sendButton: document.querySelector("#sendButton"),
  clearButton: document.querySelector("#clearButton"),
  composer: document.querySelector("#composer"),
  textInput: document.querySelector("#textInput"),
  subtitle: document.querySelector("#subtitle"),
  stateText: document.querySelector("#stateText"),
  confidenceText: document.querySelector("#confidenceText"),
  apiStatus: document.querySelector("#apiStatus"),
  messages: document.querySelector("#messages"),
  segments: [...document.querySelectorAll("[data-lang]")]
};

let language = localStorage.getItem("robo-language") || "tr";
let recognition = null;
let recognizing = false;
let audioContext = null;
let analyser = null;
let micStream = null;
let levelAnimation = null;
let speakingTimer = null;
let history = [];
let apiReachable = false;
let apiPillState = "demo";
let availableVoices = [];
let voicesLoaded = false;

boot();

function boot() {
  primeVoices();
  setLanguage(language);
  configureRecognition();
  bindEvents();
  refreshApiStatus();
  setState("idle");
}

function bindEvents() {
  elements.micButton.addEventListener("click", toggleMic);
  elements.clearButton.addEventListener("click", clearConversation);
  elements.composer.addEventListener("submit", event => {
    event.preventDefault();
    submitText(elements.textInput.value);
  });

  for (const segment of elements.segments) {
    segment.addEventListener("click", () => setLanguage(segment.dataset.lang));
  }
}

function setLanguage(nextLanguage) {
  language = nextLanguage === "en" ? "en" : "tr";
  localStorage.setItem("robo-language", language);
  document.documentElement.lang = language;
  synth?.cancel();
  stopSyntheticSpeechLevel();

  for (const segment of elements.segments) {
    segment.classList.toggle("is-active", segment.dataset.lang === language);
  }

  const copy = i18n[language];
  elements.textInput.placeholder = copy.placeholder;
  elements.sendButton.textContent = copy.send;
  elements.clearButton.textContent = copy.clear;
  elements.micButton.setAttribute("aria-label", copy.mic);
  elements.confidenceText.textContent = copy.language;

  if (!elements.subtitle.dataset.locked) {
    elements.subtitle.textContent = copy.subtitleReady;
  }

  updateApiPill(apiPillState);
  configureRecognition();
}

function configureRecognition() {
  if (!SpeechRecognition) {
    elements.micButton.disabled = true;
    elements.micButton.title = i18n[language].unsupported;
    return;
  }

  if (recognition && recognizing) {
    recognition.stop();
  }

  recognition = new SpeechRecognition();
  recognition.lang = language === "tr" ? "tr-TR" : "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    recognizing = true;
    elements.micButton.classList.add("is-recording");
    setState("listening");
    startAudioLevel();
  };

  recognition.onend = () => {
    recognizing = false;
    elements.micButton.classList.remove("is-recording");
    stopAudioLevel();
    if (elements.shell.dataset.state === "listening") {
      setState("idle");
    }
  };

  recognition.onerror = () => {
    recognizing = false;
    elements.micButton.classList.remove("is-recording");
    setState("idle");
  };

  recognition.onresult = event => {
    let interim = "";
    let finalText = "";
    let confidence = 0;

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = sanitizeTranscript(result[0].transcript);

      if (result.isFinal) {
        finalText += transcript;
        confidence = result[0].confidence || 0;
      } else {
        interim += transcript;
      }
    }

    if (interim) {
      elements.subtitle.dataset.locked = "true";
      elements.subtitle.textContent = interim;
      elements.confidenceText.textContent = i18n[language].transcriptLive;
    }

    if (finalText) {
      const checked = sanitizeTranscript(finalText);
      elements.subtitle.textContent = checked;
      elements.confidenceText.textContent = confidence
        ? `${Math.round(confidence * 100)}%`
        : i18n[language].transcriptLow;
      submitText(checked);
    }
  };
}

async function toggleMic() {
  if (!recognition || recognizing) {
    recognition?.stop();
    return;
  }

  try {
    recognition.start();
  } catch {
    setState("idle");
  }
}

async function submitText(rawText) {
  const message = sanitizeTranscript(rawText);
  if (!message) {
    pulseSubtitle(i18n[language].empty);
    return;
  }

  elements.textInput.value = "";
  addMessage("user", message);
  elements.subtitle.dataset.locked = "true";
  elements.subtitle.textContent = message;
  setState("thinking");
  setBusy(true);

  try {
    const reply = clientDemoReply(message);
    addMessage("assistant", reply);
    elements.subtitle.textContent = reply;
    updateApiPill("demo");
    speak(reply);
  } catch (error) {
    const copy = language === "tr"
      ? "Yerel çekirdek şu an cevap üretemedi. Biraz daha kısa yazıp tekrar dener misin?"
      : "The local core could not answer right now. Try a shorter message and send it again.";
    addMessage("assistant", copy);
    elements.subtitle.textContent = copy;
    updateApiPill("demo");
    setState("idle");
  } finally {
    setBusy(false);
  }
}

function addMessage(role, text) {
  const clean = sanitizeTranscript(text);
  if (!clean) {
    return;
  }

  history.push({ role, text: clean });
  history = history.slice(-12);

  const message = document.createElement("article");
  message.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? i18n[language].user : i18n[language].assistant;

  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = clean;

  message.append(label, body);
  elements.messages.append(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function speak(text) {
  if (!synth || !text) {
    setState("idle");
    return;
  }

  synth.cancel();
  const spokenLanguage = "tr-TR";
  const speechText = prepareSpeechText(text, language);
  const utterance = new SpeechSynthesisUtterance(speechText);
  utterance.lang = spokenLanguage;
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.volume = 1;

  const voice = await chooseVoice(spokenLanguage);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  utterance.onstart = () => {
    setState("speaking");
    startSyntheticSpeechLevel();
  };

  utterance.onend = () => {
    stopSyntheticSpeechLevel();
    setState("idle");
  };

  utterance.onerror = () => {
    stopSyntheticSpeechLevel();
    setState("idle");
  };

  synth.speak(utterance);
}

async function chooseVoice(lang) {
  const voices = await getVoices();
  const target = lang.toLowerCase();
  const base = target.slice(0, 2);
  const scored = voices
    .map(voice => ({ voice, score: scoreVoice(voice, target, base) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.voice
    || null;
}

function primeVoices() {
  if (!synth) {
    return;
  }

  const updateVoices = () => {
    availableVoices = synth.getVoices();
    voicesLoaded = availableVoices.length > 0;
  };

  updateVoices();

  if ("onvoiceschanged" in synth) {
    synth.onvoiceschanged = updateVoices;
  }
}

function getVoices() {
  if (!synth) {
    return Promise.resolve([]);
  }

  availableVoices = synth.getVoices();
  if (availableVoices.length || voicesLoaded) {
    return Promise.resolve(availableVoices);
  }

  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      availableVoices = synth.getVoices();
      resolve(availableVoices);
    }, 900);

    synth.onvoiceschanged = () => {
      window.clearTimeout(timeout);
      availableVoices = synth.getVoices();
      voicesLoaded = availableVoices.length > 0;
      resolve(availableVoices);
    };
  });
}

function scoreVoice(voice, target, base) {
  const voiceLang = voice.lang.toLowerCase();
  const voiceName = voice.name.toLowerCase();

  if (voiceLang === target) {
    return 100;
  }

  if (voiceLang.startsWith(`${base}-`)) {
    return 80;
  }

  if (base === "en" && voiceName.includes("english")) {
    return 65;
  }

  if (base === "tr" && (voiceName.includes("turkish") || voiceName.includes("turk"))) {
    return 65;
  }

  return voiceLang.startsWith(base) ? 50 : 0;
}

function prepareSpeechText(text, lang) {
  if (lang === "en") {
    return phoneticizeEnglishSentence(text);
  }

  let spoken = ` ${text} `;

  const replacements = [
    [/\bRobo AI\b/gi, "Robo ey ay"],
    [/\bOpenAI\b/gi, "Open ey ay"],
    [/\bOpenRouter\b/gi, "Open rautır"],
    [/\bGitHub\b/gi, "githab"],
    [/\bCloudflare\b/gi, "klaud fler"],
    [/\bWorker\b/gi, "vörkır"],
    [/\bAPI\b/gi, "ey pi ay"],
    [/\bAI\b/gi, "ey ay"],
    [/\bGPT\b/gi, "ci pi ti"],
    [/\bCSS\b/gi, "si es es"],
    [/\bJS\b/gi, "cey es"],
    [/\bHTML\b/gi, "eyç ti em el"],
    [/\bHTTPS\b/gi, "eyç ti ti pi es"],
    [/\bHTTP\b/gi, "eyç ti ti pi"],
    [/\bURL\b/gi, "yu ar el"],
    [/\bEN\b/g, "i en"],
    [/\bTR\b/g, "te re"],
    [/\bChrome\b/gi, "krom"],
    [/\bEdge\b/g, "eç"],
    [/\bPages\b/g, "peyciz"],
    [/\bGit\b/g, "git"],
    [/\blocal\b/gi, "lokal"],
    [/\bcore\b/gi, "kor"],
    [/\bvoice\b/gi, "voys"],
    [/\btext\b/gi, "tekst"],
    [/\bsubtitle\b/gi, "sab taytıl"],
    [/\bbrowser\b/gi, "brauzır"],
    [/\bcache\b/gi, "keş"],
    [/\bdeploy\b/gi, "diploy"],
    [/\bmodel\b/gi, "model"],
    [/\bmini\b/gi, "mini"],
    [/\bfree\b/gi, "fri"]
  ];

  for (const [pattern, replacement] of replacements) {
    spoken = spoken.replace(pattern, replacement);
  }

  spoken = spoken.replace(/\b[A-Z]{2,}\b/g, word => spellAcronymForTurkish(word));

  return spoken
    .replace(/\s+/g, " ")
    .trim();
}

function phoneticizeEnglishSentence(text) {
  return String(text || "")
    .replace(/[A-Za-z][A-Za-z0-9.+#'-]*/g, word => phoneticizeEnglishWord(word))
    .replace(/\s+/g, " ")
    .trim();
}

function phoneticizeEnglishWord(word) {
  const exact = englishPhoneticDictionary[word.toLowerCase()];
  if (exact) {
    return exact;
  }

  if (/^[A-Z]{2,}$/.test(word)) {
    return spellAcronymForTurkish(word);
  }

  const suffix = word.match(/([.,!?;:]+)$/)?.[1] || "";
  const core = suffix ? word.slice(0, -suffix.length) : word;
  const lower = core.toLowerCase();

  if (!/[a-z]/.test(lower)) {
    return word;
  }

  let spoken = lower
    .replace(/tion\b/g, "şın")
    .replace(/sion\b/g, "jın")
    .replace(/ough/g, "of")
    .replace(/augh/g, "af")
    .replace(/ph/g, "f")
    .replace(/sh/g, "ş")
    .replace(/ch/g, "ç")
    .replace(/th/g, "d")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kv")
    .replace(/x/g, "ks")
    .replace(/oo/g, "u")
    .replace(/ee/g, "i")
    .replace(/ea/g, "i")
    .replace(/ai/g, "ey")
    .replace(/ay/g, "ey")
    .replace(/oa/g, "ou")
    .replace(/ow/g, "au")
    .replace(/ou/g, "au")
    .replace(/ie/g, "ay")
    .replace(/igh/g, "ay")
    .replace(/er\b/g, "ır")
    .replace(/or\b/g, "ır")
    .replace(/ing\b/g, "ing")
    .replace(/ed\b/g, "d")
    .replace(/c([eiy])/g, "s$1")
    .replace(/c/g, "k")
    .replace(/j/g, "c")
    .replace(/w/g, "v")
    .replace(/y\b/g, "i")
    .replace(/y/g, "y")
    .replace(/a/g, "e")
    .replace(/i/g, "i")
    .replace(/u/g, "u");

  return `${spoken}${suffix}`;
}

const englishPhoneticDictionary = {
  a: "e",
  about: "ebaut",
  active: "ektiv",
  advice: "edvays",
  age: "eyc",
  ai: "ey ay",
  all: "ol",
  am: "em",
  an: "en",
  and: "end",
  answer: "ensır",
  answering: "ensıring",
  api: "ey pi ay",
  are: "ar",
  as: "ez",
  ask: "esk",
  assistant: "asistant",
  available: "aveylıbıl",
  bad: "bed",
  be: "bi",
  because: "bikoz",
  bot: "bot",
  browser: "brauzır",
  build: "bild",
  built: "bilt",
  but: "bat",
  by: "bay",
  can: "ken",
  cannot: "ken nat",
  caught: "kot",
  chat: "çet",
  check: "çek",
  choose: "çuz",
  clear: "klir",
  coded: "kodıd",
  color: "kalır",
  commands: "komends",
  continue: "kontinyu",
  core: "kor",
  css: "si es es",
  date: "deyt",
  design: "dizayn",
  did: "did",
  digital: "dijitıl",
  do: "du",
  does: "daz",
  english: "ingliş",
  enough: "inaf",
  feel: "fiıl",
  features: "fiçırs",
  free: "fri",
  freshly: "freşli",
  full: "ful",
  get: "get",
  github: "githab",
  give: "giv",
  got: "gat",
  greetings: "gritings",
  has: "hez",
  have: "hev",
  hear: "hiyır",
  hello: "helo",
  help: "help",
  here: "hiyır",
  hi: "hay",
  how: "hau",
  html: "eyç ti em el",
  i: "ay",
  if: "if",
  in: "in",
  interface: "intırfeys",
  is: "iz",
  it: "it",
  joke: "couk",
  language: "lengvic",
  let: "let",
  like: "layk",
  limited: "limitıd",
  listen: "lisın",
  local: "lokal",
  me: "mi",
  microphone: "maykrofon",
  mode: "moud",
  model: "model",
  my: "may",
  name: "neym",
  needs: "nidz",
  not: "nat",
  now: "nau",
  of: "ov",
  on: "on",
  one: "van",
  openai: "open ey ay",
  openrouter: "open rautır",
  or: "or",
  orb: "orb",
  page: "peyc",
  pages: "peyciz",
  passed: "past",
  question: "kuestçın",
  questions: "kuestçınz",
  ready: "redi",
  reply: "riplay",
  robo: "robo",
  run: "ran",
  running: "raning",
  safe: "seyf",
  say: "sey",
  see: "si",
  sentence: "sentıns",
  short: "şort",
  site: "sayt",
  slow: "slou",
  small: "smol",
  so: "sou",
  speech: "spiç",
  subtitle: "sab taytıl",
  subtitles: "sab taytılz",
  suggest: "sacest",
  sure: "şur",
  system: "sistım",
  talk: "tok",
  text: "tekst",
  that: "det",
  the: "dı",
  this: "dis",
  time: "taym",
  to: "tu",
  today: "tudey",
  together: "tugethır",
  try: "tray",
  turkish: "törkiş",
  turns: "törnz",
  ui: "yu ay",
  understand: "andırstend",
  up: "ap",
  use: "yuz",
  used: "yuzd",
  user: "yuzır",
  voice: "voys",
  want: "vant",
  weather: "vedır",
  welcome: "velkam",
  what: "vat",
  when: "ven",
  who: "hu",
  why: "vay",
  with: "vid",
  without: "vidaut",
  works: "vörks",
  would: "vud",
  write: "rayt",
  you: "yu",
  your: "yor"
};

function spellAcronymForTurkish(word) {
  const names = {
    A: "a",
    B: "be",
    C: "se",
    D: "de",
    E: "e",
    F: "ef",
    G: "ge",
    H: "ha",
    I: "ay",
    J: "cey",
    K: "ka",
    L: "el",
    M: "em",
    N: "en",
    O: "o",
    P: "pe",
    Q: "kü",
    R: "ar",
    S: "es",
    T: "te",
    U: "yu",
    V: "vi",
    W: "dabılyu",
    X: "iks",
    Y: "vay",
    Z: "zed"
  };

  return word
    .split("")
    .map(letter => names[letter.toUpperCase()] || letter)
    .join(" ");
}

async function startAudioLevel() {
  stopAudioLevel();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      setOrbLevel(Math.min(1, average / 90));
      levelAnimation = requestAnimationFrame(tick);
    };

    tick();
  } catch {
    setOrbLevel(0.42);
  }
}

function stopAudioLevel() {
  if (levelAnimation) {
    cancelAnimationFrame(levelAnimation);
  }

  levelAnimation = null;
  if (audioContext) {
    audioContext.close();
  }

  if (micStream) {
    for (const track of micStream.getTracks()) {
      track.stop();
    }
  }

  audioContext = null;
  analyser = null;
  micStream = null;
  if (elements.shell.dataset.state !== "speaking") {
    setOrbLevel(0);
  }
}

function startSyntheticSpeechLevel() {
  stopSyntheticSpeechLevel();
  let step = 0;
  speakingTimer = window.setInterval(() => {
    step += 1;
    const wave = (Math.sin(step * 0.8) + 1) / 2;
    const jitter = (Math.sin(step * 1.7) + 1) / 6;
    setOrbLevel(Math.min(1, 0.28 + wave * 0.5 + jitter));
  }, 90);
}

function stopSyntheticSpeechLevel() {
  if (speakingTimer) {
    window.clearInterval(speakingTimer);
  }

  speakingTimer = null;
  setOrbLevel(0);
}

function setOrbLevel(level) {
  elements.shell.style.setProperty("--level", String(level.toFixed(3)));
}

function setState(state) {
  elements.shell.dataset.state = state;
  const copy = i18n[language];
  const label = {
    idle: copy.ready,
    listening: copy.listening,
    thinking: copy.thinking,
    speaking: copy.speaking
  }[state] || copy.ready;

  elements.stateText.textContent = label;
}

function setBusy(isBusy) {
  elements.sendButton.disabled = isBusy;
  elements.textInput.disabled = isBusy;
}

function clearConversation() {
  history = [];
  elements.messages.replaceChildren();
  elements.subtitle.dataset.locked = "";
  elements.subtitle.textContent = i18n[language].subtitleReady;
  elements.confidenceText.textContent = i18n[language].language;
  setState("idle");
}

function sanitizeTranscript(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
}

function pulseSubtitle(text) {
  elements.subtitle.dataset.locked = "true";
  elements.subtitle.textContent = text;
  window.setTimeout(() => {
    if (!history.length) {
      elements.subtitle.textContent = i18n[language].subtitleReady;
      elements.subtitle.dataset.locked = "";
    }
  }, 1600);
}

async function refreshApiStatus() {
  apiReachable = false;
  updateApiPill("demo");
}

function updateApiPill(state) {
  const copy = i18n[language];
  apiPillState = state;
  elements.apiStatus.className = `api-pill ${state}`;
  elements.apiStatus.textContent = {
    ready: copy.apiReady,
    demo: copy.apiDemo,
    error: copy.apiError
  }[state] || "API";
}

function resolveApiBase() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeApiBase(params.get("api"));

  if (fromQuery) {
    localStorage.setItem(apiBaseStorageKey, fromQuery);
    return fromQuery;
  }

  localStorage.removeItem(apiBaseStorageKey);
  return "";
}

function normalizeApiBase(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

function apiUrl(path) {
  return `${apiBase}${path}`;
}

function clientDemoReply(message) {
  return localBrainReply(message, language);
}

function localBrainReply(message, lang) {
  const text = normalizeForIntent(message);
  const now = new Date();
  const mathAnswer = solveSimpleMath(text, lang);

  if (mathAnswer) {
    return mathAnswer;
  }

  if (hasAny(text, ["merhaba", "selam", "slm", "sa", "hello", "hi", "hey", "good morning", "good evening"])) {
    return lang === "tr"
      ? "Merhaba. Ben Robo AI. Yerel çekirdeğim açık; sorunu cümle halinde yaz, anlamaya çalışayım."
      : "Hello. I am Robo AI. My local core is active; write your question as a sentence and I will try to understand it.";
  }

  if (hasAny(text, ["tesekkur", "sag ol", "eyvallah", "thanks", "thank you"])) {
    return lang === "tr"
      ? "Rica ederim. Buradayım, devam edebiliriz."
      : "You are welcome. I am here, we can continue.";
  }

  if (hasAny(text, ["gorusuruz", "bye", "goodbye", "cikis", "kapat"])) {
    return lang === "tr"
      ? "Görüşürüz. Tekrar konuşmak istersen mikrofon veya mesaj kutusu hazır."
      : "Goodbye. If you want to talk again, the microphone and text box are ready.";
  }

  if (hasAny(text, ["saat", "kac oldu", "time", "what time"])) {
    return lang === "tr"
      ? `Şu an saat ${now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}.`
      : `It is ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
  }

  if (hasAny(text, ["tarih", "bugun", "hangi gun", "date", "today", "day is it"])) {
    return lang === "tr"
      ? `Bugünün tarihi ${now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}.`
      : `Today is ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`;
  }

  if (hasAny(text, ["adin", "ismin", "kimsin", "nesin", "who are you", "your name", "what are you"])) {
    return lang === "tr"
      ? "Ben Robo AI. Sesini yazıya çeviren, altyazı gösteren, cevaplarını sesli okuyan ve API olmadan temel soruları yerel cevaplayan bir asistanım."
      : "I am Robo AI, a local assistant that turns speech into text, shows subtitles, and reads replies aloud.";
  }

  if (hasAny(text, ["seni kim", "kim yapti", "kim kodladi", "kodlayan", "yaratici", "creator", "who made", "who coded"])) {
    return lang === "tr"
      ? "Ben ItzPertoTe tarafından kodlandım."
      : "I was coded by ItzPertoTe.";
  }

  if (hasAny(text, ["ne yapabilirsin", "ozellik", "yetenek", "komut", "yardim", "help", "features", "what can you do", "commands"])) {
    return lang === "tr"
      ? "Şunları anlayabilirim: selamlaşma, saat, tarih, kim olduğum, beni kimin kodladığı, özelliklerim, GitHub Pages, mikrofon sorunları, dil değiştirme, basit matematik, kısa öneri, şaka, moral desteği ve API/yerel çalışma farkı."
      : "I can understand greetings, time, date, who I am, who coded me, my features, GitHub Pages, microphone issues, language switching, simple math, short advice, jokes, encouragement, and the difference between local and API mode.";
  }

  if (hasAny(text, ["turkce konus", "tr ye gec", "ingilizce konus", "en ye gec", "change language", "speak english", "speak turkish"])) {
    return lang === "tr"
      ? "Dili üstteki TR ve EN düğmelerinden değiştirebilirsin. Değiştirince mikrofon dili ve okuma sesi de ona göre ayarlanır."
      : "Use the TR and EN buttons at the top to change language. The microphone language and voice output follow that setting.";
  }

  if (hasAny(text, ["ses", "okuma", "erkek", "kadin", "voice", "read aloud", "male", "female"])) {
    return lang === "tr"
      ? "Ses tarayıcının yüklü seslerine bağlıdır. EN seçiliyken İngilizce ses bulursam onu kullanırım; yoksa tarayıcı varsayılan sese düşebilir."
      : "The voice depends on the voices installed in your browser. In EN mode I pick an English voice when available; otherwise the browser may fall back to its default voice.";
  }

  if (hasAny(text, ["mikrofon", "duymuyor", "sesimi almiyor", "permission", "microphone", "mic not working"])) {
    return lang === "tr"
      ? "Mikrofon çalışmıyorsa tarayıcı izinlerini kontrol et, sayfayı yenile ve HTTPS üzerinden açtığından emin ol. GitHub Pages zaten HTTPS kullanır."
      : "If the microphone is not working, check browser permissions, refresh the page, and make sure the site is opened over HTTPS. GitHub Pages already uses HTTPS.";
  }

  if (hasAny(text, ["github", "pages", "site", "yayinla", "deploy", "css yuklenmedi", "js yuklenmedi"])) {
    return lang === "tr"
      ? "GitHub Pages için public klasörü yayınlanır. CSS veya JS yüklenmezse genelde dosya yolu ya da tarayıcı cache sorunudur; index.html dosyasındaki sürüm etiketi bunu yenilemek için var."
      : "For GitHub Pages, the public folder is published. If CSS or JS does not load, it is usually a path or cache issue; the version tag in index.html helps refresh it.";
  }

  if (hasAny(text, ["api", "openrouter", "openai", "key", "quota", "billing"])) {
    return lang === "tr"
      ? "Şu an yerel moddayım, API kullanmıyorum. API bağlanırsa daha geniş cevaplar verebilirim; yerel mod ise hızlı, ücretsiz ve sınırlıdır."
      : "I am in local mode right now and I am not using an API. With an API I can give broader answers; local mode is fast, free, and limited.";
  }

  if (hasAny(text, ["hava", "weather", "rain", "yagmur"])) {
    return lang === "tr"
      ? "Canlı hava durumunu API olmadan bilemem. Ama şehir adını ve gözlemini yazarsan kıyafet veya plan önerisi yapabilirim."
      : "I cannot know live weather without an API. But if you tell me the city and what you see outside, I can suggest clothing or plans.";
  }

  if (hasAny(text, ["saka", "komik", "joke", "funny"])) {
    return lang === "tr"
      ? "Küçük bir yazılımcı şakası: Kod çalışıyorsa dokunma; çalışmıyorsa önce noktalı virgüle bak."
      : "A tiny developer joke: if it works, do not touch it; if it does not, check the semicolon first.";
  }

  if (hasAny(text, ["moralim bozuk", "uzuldum", "kotu hissediyorum", "canim sikildi", "sad", "upset", "feel bad"])) {
    return lang === "tr"
      ? "Üzgün hissetmen normal. Biraz yavaşlayalım: derin bir nefes al, tek bir küçük şeyi seç, onu beraber sadeleştirelim."
      : "It is okay to feel bad. Let us slow down: take a breath, choose one small thing, and we can simplify it together.";
  }

  if (hasAny(text, ["oner", "ne yapayim", "fikir ver", "advice", "suggest", "idea"])) {
    return lang === "tr"
      ? "Kısa önerim: önce hedefi tek cümle yap, sonra en küçük çalışan parçayı kur. Robo AI için bu parça: arayüz, mikrofon, yerel cevap ve sesli okuma."
      : "My short advice: make the goal one sentence, then build the smallest working piece. For Robo AI that piece is UI, microphone, local reply, and voice output.";
  }

  if (hasAny(text, ["renk", "tasarim", "orb", "color", "design"])) {
    return lang === "tr"
      ? "Tasarımda koyu arka plan, turkuaz enerji rengi ve konuşmaya tepki veren orb kullanıyorum. Bu yüzden arayüz daha futuristik görünüyor."
      : "The design uses a dark background, cyan energy color, and a voice-reactive orb, which gives the interface a futuristic feel.";
  }

  if (hasAny(text, ["guvenli mi", "gizlilik", "privacy", "safe", "secure"])) {
    return lang === "tr"
      ? "Yerel modda yazdığın metin dış API’ye gönderilmez. Mikrofon metne tarayıcı tarafından çevrilir; tarayıcının kendi ses tanıma sistemi yine izin gerektirir."
      : "In local mode, your typed text is not sent to an external API. Speech recognition is handled by the browser and still requires microphone permission.";
  }

  if (hasAny(text, ["kac yasindasin", "yas", "how old", "age"])) {
    return lang === "tr"
      ? "Bir yaşım yok; bu projede çalışan dijital bir asistanım. Ama bugün kendimi yeni derlenmiş gibi hissediyorum."
      : "I do not have an age; I am a digital assistant running in this project. But today I feel freshly built.";
  }

  if (hasAny(text, ["beni duyuyor musun", "duydun mu", "can you hear me", "did you hear"])) {
    return lang === "tr"
      ? "Evet, mesajını aldım. Mikrofonla konuştuysan altyazı kısmında yakaladığım metni de görebilirsin."
      : "Yes, I got your message. If you used the microphone, you can also see the captured text in the subtitle area.";
  }

  if (hasAny(text, ["test", "deneme", "calisiyor mu", "working"])) {
    return lang === "tr"
      ? "Test başarılı. Yerel çekirdek cevap üretiyor, arayüz aktif ve sesli okuma hazır."
      : "Test passed. The local core is replying, the interface is active, and voice output is ready.";
  }

  if (hasAny(text, ["ozetle", "summary", "summarize"])) {
    return lang === "tr"
      ? "Kısa özet: Robo AI şu an ana sitede API olmadan yerel çalışıyor; ses, altyazı, iki dil ve temel cümle anlama var."
      : "Short summary: Robo AI now runs locally on the main site without an API; it has voice, subtitles, two languages, and basic sentence understanding.";
  }

  if (hasAny(text, ["nasil calisiyorsun", "nasil calisir", "how do you work", "how does this work"])) {
    return lang === "tr"
      ? "Şöyle çalışıyorum: tarayıcı sesini yazıya çeviriyor, ben yazıyı yerel niyet kurallarıyla analiz ediyorum, uygun cevabı seçiyorum ve sonra cevabı sesli okuyorum."
      : "I work like this: the browser turns speech into text, I analyze the text with local intent rules, choose a reply, and then read it aloud.";
  }

  if (hasAny(text, ["neden api yok", "niye api yok", "why no api", "without api"])) {
    return lang === "tr"
      ? "API yok çünkü ana sitede ücretsiz ve güvenli çalışması hedeflendi. API anahtarı siteye koyulursa herkes görebilir; bu yüzden yerel çekirdek kullanıyorum."
      : "There is no API because the main site is meant to run free and safely. If an API key is placed in the site, anyone can see it, so I use a local core.";
  }

  if (hasAny(text, ["akilli misin", "zeki misin", "are you smart", "intelligent"])) {
    return lang === "tr"
      ? "Tam büyük model kadar esnek değilim, ama sabit cevap veren basit bir bot da değilim. Cümledeki niyeti yakalayıp yerel kurallarla cevap üretmeye çalışıyorum."
      : "I am not as flexible as a full large model, but I am not just a fixed reply bot either. I detect the intent and answer with local rules.";
  }

  if (hasAny(text, ["ne demek", "anlami ne", "what means", "what does", "meaning"])) {
    return explainMeaning(text, lang);
  }

  if (hasAny(text, ["avantaj", "dezavantaj", "iyi mi", "kotu mu", "pros", "cons", "better"])) {
    return lang === "tr"
      ? "Kısa değerlendirme: yerel mod ücretsiz, hızlı ve anahtar istemez; dezavantajı cevaplarının sınırlı olmasıdır. API modu daha zeki olur ama kredi ve güvenli proxy ister."
      : "Short take: local mode is free, fast, and needs no key; its downside is limited answers. API mode is smarter but needs credits and a safe proxy.";
  }

  if (hasAny(text, ["plan yap", "adim adim", "step by step", "make a plan"])) {
    return lang === "tr"
      ? "Plan: önce hedefi netleştir, sonra en küçük çalışan sürümü yap, sonra ses ve dil hatalarını düzelt, en son GitHub Pages'e yükleyip Ctrl+F5 ile test et."
      : "Plan: define the goal, build the smallest working version, fix voice and language issues, then upload to GitHub Pages and test with Ctrl+F5.";
  }

  if (hasAny(text, ["kod", "javascript", "html", "css", "code"])) {
    return lang === "tr"
      ? "Bu proje üç ana dosyayla çalışıyor: HTML yapıyı kuruyor, CSS orb ve arayüzü çiziyor, JavaScript mikrofonu, yerel zekayı ve sesli okumayı yönetiyor."
      : "This project runs with three main files: HTML builds the structure, CSS draws the orb and interface, and JavaScript controls the microphone, local brain, and voice output.";
  }

  if (hasAny(text, ["hata", "bug", "error", "sorun", "problem"])) {
    return lang === "tr"
      ? "Hata çözmek için önce ekrandaki mesajı aynen oku, sonra hangi adımda olduğunu söyle. Genelde bu projede sorunlar cache, dosya yolu, mikrofon izni veya eski app.js yüzünden çıkıyor."
      : "To debug, read the exact error message and say which step you are on. In this project, issues usually come from cache, file paths, microphone permission, or an old app.js.";
  }

  if (hasAny(text, ["neden", "why"])) {
    return lang === "tr"
      ? "Muhtemel neden: yerel web uygulamalarında çoğu davranış tarayıcı izni, dosya yolu, cache veya seçili dil durumuna bağlıdır. Sorunun hangi ekranda olduğunu söylersen daha net yönlendirebilirim."
      : "Likely reason: in local web apps, most behavior depends on browser permissions, file paths, cache, or selected language state. Tell me the screen and I can guide more clearly.";
  }

  if (hasAny(text, ["nasil", "how"])) {
    return lang === "tr"
      ? "Genel yol şu: ilgili dosyayı güncelle, GitHub'a yükle, Pages deploy'unun bitmesini bekle, sonra sayfayı Ctrl+F5 ile yenile. Eski dosya kalırsa değişiklik görünmez."
      : "General path: update the file, upload it to GitHub, wait for Pages deployment, then refresh with Ctrl+F5. If an old file is cached, the change will not appear.";
  }

  if (hasAny(text, ["ne", "what"])) {
    return lang === "tr"
      ? "Bunu bağlama göre cevaplayayım: Robo AI şu an sesli, iki modlu ve API'siz çalışan bir web asistanı. Daha özel bir şey sorarsan daha net cevap veririm."
      : "In context: Robo AI is currently a voice-enabled, two-mode, API-free web assistant. Ask something more specific and I will answer more directly.";
  }

  if (isQuestion(text)) {
    return lang === "tr"
      ? answerGenericQuestion(message, lang)
      : answerGenericQuestion(message, lang);
  }

  return lang === "tr"
    ? `Seni duydum: "${message}". Yerel çekirdeğim bunu genel sohbet olarak algıladı. İstersen soru, komut, hesap, site, mikrofon, dil veya tasarım hakkında yaz.`
    : `I heard: "${message}". My local core treated this as general chat. You can ask about questions, commands, math, the site, microphone, language, or design.`;
}

function normalizeForIntent(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^\p{L}\p{N}+\-*/=,.? ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, patterns) {
  return patterns.some(pattern => text.includes(normalizeForIntent(pattern)));
}

function isQuestion(text) {
  return text.endsWith("?")
    || hasAny(text, ["ne", "neden", "nasil", "nereye", "nerede", "kim", "kac", "hangi", "what", "why", "how", "where", "who", "when", "which"]);
}

function solveSimpleMath(text, lang) {
  const expressionMatch = text.match(/(-?\d+(?:[.,]\d+)?)\s*([+\-*/])\s*(-?\d+(?:[.,]\d+)?)/);
  if (!expressionMatch) {
    return "";
  }

  const left = Number(expressionMatch[1].replace(/,/g, "."));
  const operator = expressionMatch[2];
  const right = Number(expressionMatch[3].replace(/,/g, "."));

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return "";
  }

  if (operator === "/" && right === 0) {
    return lang === "tr"
      ? "Sıfıra bölme yapamam; matematik buna izin vermez."
      : "I cannot divide by zero; math does not allow it.";
  }

  const result = {
    "+": left + right,
    "-": left - right,
    "*": left * right,
    "/": left / right
  }[operator];

  const formatted = Number.isInteger(result) ? String(result) : result.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const expression = `${left} ${operator} ${right}`;
  return lang === "tr"
    ? `${expression.replace("*", " çarpı ").replace("/", " bölü ")} sonucu ${formatted}.`
    : `${expression} equals ${formatted}.`;
}

function explainMeaning(text, lang) {
  if (hasAny(text, ["api"])) {
    return lang === "tr"
      ? "API, iki yazılımın birbiriyle konuşması için kullanılan arayüz demektir. Robo AI'de API olursa site dışarıdaki bir modele soru gönderebilir."
      : "An API is an interface that lets two pieces of software talk to each other. In Robo AI, an API can send questions to an external model.";
  }

  if (hasAny(text, ["cache"])) {
    return lang === "tr"
      ? "Cache, tarayıcının dosyaları hız için saklamasıdır. Bazen eski app.js kalır; Ctrl+F5 bu yüzden işe yarar."
      : "Cache means the browser stores files for speed. Sometimes an old app.js stays loaded; that is why Ctrl+F5 helps.";
  }

  if (hasAny(text, ["github pages", "pages"])) {
    return lang === "tr"
      ? "GitHub Pages, statik web sitelerini ücretsiz yayınlayan GitHub özelliğidir. HTML, CSS ve JS dosyalarını internete açar."
      : "GitHub Pages is GitHub's free static website hosting. It publishes HTML, CSS, and JS files online.";
  }

  return lang === "tr"
    ? "Anlam sorusu yakaladım. Hangi kelimeyi sorduğunu daha net yazarsan kısa bir açıklama yaparım."
    : "I detected a meaning question. Write the exact word more clearly and I will explain it briefly.";
}

function answerGenericQuestion(message, lang) {
  return lang === "tr"
    ? `Buna kısa cevap vereyim: "${message}" için elimdeki yerel bilgiyle en mantıklı yol, konuyu küçük parçalara ayırmak ve önce görünen hatayı ya da hedefi netleştirmek. İstersen bunu adım adım açabilirim.`
    : `Short answer: for "${message}", the best local answer is to break the topic into small parts and first clarify the visible error or goal. I can walk through it step by step.`;
}
