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
  // Eski hata veren primeVoices(); satırını buradan tamamen kaldırdık!
  
  setupDOM();
  setupSpeechRecognition();
  
  // Eğer sisteminde default olarak apiBase varsa bağla, yoksa local moda al
  if (apiBase) {
    checkApiStatus();
  } else {
    setApiStatus("demo");
  }
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
  const searchQuery = getWebSearchQuery(message);

  try {
    if (searchQuery) {
      const reply = await searchWeb(searchQuery);
      elements.subtitle.textContent = reply;
      updateApiPill("demo");
      speak(reply);
      return;
    }

    const reply = clientDemoReply(message);
    addMessage("assistant", reply);
    elements.subtitle.textContent = reply;
    updateApiPill("demo");
    speak(reply);
  } catch (error) {
    const copy = searchQuery
      ? (language === "tr"
        ? `Web araması çalışmadı: ${error.message}`
        : `Web search did not work: ${error.message}`)
      : (language === "tr"
        ? "Yerel çekirdek şu an cevap üretemedi. Biraz daha kısa yazıp tekrar dener misin?"
        : "The local core could not answer right now. Try a shorter message and send it again.");
    addMessage("assistant", copy);
    elements.subtitle.textContent = copy;
    updateApiPill("demo");
    setState("idle");
  } finally {
    setBusy(false);
  }
}

function addMessage(role, text, options = {}) {
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

  if (Array.isArray(options.results) && options.results.length) {
    const list = document.createElement("div");
    list.className = "search-results";

    for (const result of options.results) {
      const link = document.createElement("a");
      link.className = "search-result";
      link.href = result.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const title = document.createElement("span");
      title.className = "search-title";
      title.textContent = result.title;

      const snippet = document.createElement("span");
      snippet.className = "search-snippet";
      snippet.textContent = result.snippet;

      link.append(title, snippet);
      list.append(link);
    }

    body.append(list);
  }

  message.append(label, body);
  elements.messages.append(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function prepareSpeechText(text, lang) {
  if (lang === "en") {
    return text; // İngilizce ise kelimeleri asla bozma, orijinal bırak
  }

  let spoken = ` ${text} `;
  spoken = spoken.replace(/ai/gi, "ey ay");
  spoken = spoken.replace(/ui/gi, "yu ay");
  spoken = spoken.replace(/io/gi, "yo");
  spoken = spoken.replace(/🤖/g, " robot ");
  spoken = spoken.replace(/✨/g, " yıldız ");
  spoken = spoken.replace(/🔥/g, " ateş ");
  spoken = spoken.replace(/💻/g, " bilgisayar ");
  spoken = spoken.replace(/🚀/g, " roket ");

  // Fonksiyonu burada güvenli bir şekilde kapatıyoruz:
  return spoken
    .replace(/\s+/g, " ")
    .trim();
} // <-- Bu parantez fonksiyonu kapatarak aşağıdaki kodları korur!

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
  of: "of",
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
  let raw = String(value || "").trim().replace(/\/+$/, "");

  if (!raw) {
    return "";
  }

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
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

function getWebSearchQuery(message) {
  const original = sanitizeTranscript(message);
  const normalized = normalizeForIntent(original);
  const startPatterns = [
    "webde ara",
    "web de ara",
    "internette ara",
    "google da ara",
    "googleda ara",
    "arama yap",
    "search web for",
    "search for"
  ];

  for (const pattern of startPatterns) {
    const normalizedPattern = normalizeForIntent(pattern);
    if (normalized.startsWith(normalizedPattern)) {
      const query = original.split(/\s+/).slice(pattern.split(/\s+/).length).join(" ").replace(/^[:,-]+/, "").trim();
      return query.length >= 2 ? query : "";
    }
  }

  const trailing = normalized.match(/(.+)\s+(?:webde|internette|googleda|google da)\s+ara$/);
  if (trailing) {
    return trailing[1].trim();
  }

  return "";
}

async function searchWeb(query) {
  if (!apiBase) {
    const reply = language === "tr"
      ? "Web araması için Cloudflare Worker bağlantısı gerekiyor. Siteyi bir kez ?api=https://worker-adresin.workers.dev ile açmalısın."
      : "Web search needs the Cloudflare Worker connection. Open the site once with ?api=https://your-worker.workers.dev.";
    addMessage("assistant", reply);
    return reply;
  }

  const searching = language === "tr"
    ? `Web'de arıyorum: ${query}`
    : `Searching the web for: ${query}`;
  elements.subtitle.textContent = searching;

  const response = await fetch(apiUrl("/api/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, language })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Search failed");
  }

  const reply = data.summary || (language === "tr" ? "Arama tamamlandı." : "Search complete.");
  addMessage("assistant", reply, { results: data.results || [] });
  return reply;
}

function localBrainReply(message, lang) {
  const text = normalizeForIntent(message);
  const now = new Date();
  const mathAnswer = solveSimpleMath(text, lang);
  const definitionAnswer = answerDefinitionQuestion(message, text, lang);

  if (mathAnswer) {
    return mathAnswer;
  }

  if (definitionAnswer) {
    return definitionAnswer;
  }

  if (hasAny(text, ["merhaba", "selam", "slm", "robo", "hello", "hi", "hey", "good morning", "good evening"])) {
    return lang === "tr"
      ? "Merhaba. Ben Robo AI. Yerel çekirdeğim açık; sorunu cümle halinde yaz, anlamaya çalışayım."
      : "Hello. I am Robo AI. My local core is active; write your question as a sentence and I will try to understand it.";
  }

  if (hasAny(text, ["tesekkur", "sagol", "tsk", "thanks", "thank you"])) {
    return lang === "tr"
      ? "Rica ederim. Başka bir şeye ihtiyacın olursa buradayım."
      : "You are welcome. Just let me know if you need any help.";
  }

  if (hasAny(text, ["gorusuruz", "bye", "goodbye", "hoscakal", "bb"])) {
    return lang === "tr"
      ? "Görüşürüz. Tekrar konuşmak istersen buradayım."
      : "Goodbye. If you want to talk again, I'm here.";
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
      ? "Dili üstteki TR ve MIX düğmelerinden değiştirebilirsin. Değiştirince mikrofon dili ve okuma sesi de ona göre ayarlanır. MIX İngilizcedir ama size ses Türkçe seslendiriciden gelir."
      : "Use the TR and EN buttons at the top to change language. The microphone language and voice output follow that setting. MIX is English but the speaker will talk with Turkish accent.";
  }

  if (hasAny(text, ["ses", "okuma", "erkek", "kadin", "voice", "read aloud", "male", "female"])) {
    return lang === "tr"
      ? "Üzgünüm sesim sadece Türkçe ve daha yüksek sesle konuşamam. İngilizce konuşabilsem de Türkçe şivesiyle."
      : "I have only Turkish voice available and I can not read aloud. I can talk English but with Turkish accent.";
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

  if (hasAny(text, ["saka", "fikra", "joke", "funny"])) {
    return lang === "tr"
      ? "Küçük bir yazılımcı şakası: Kod çalışıyorsa dokunma; çalışmıyorsa önce noktalı virgüle bak."
      : "A tiny developer joke: if it works, do not touch it; if it does not, check the semicolon first.";
  }

  if (hasAny(text, ["moralim bozuk", "uzuldum", "kotu hissediyorum", "canim sikildi", "sad", "upset", "feel bad"])) {
    return lang === "tr"
      ? "Üzgün hissetmen normal. Biraz yavaşlayalım: derin bir nefes al."
      : "It is okay to feel bad. Let us slow down: take a deep breath.";
  }

  if (hasAny(text, ["oner", "ne yapayim", "fikir ver", "advice", "suggest", "idea"])) {
    return lang === "tr"
      ? "Kısa önerim: Kodlama yap! Bu hep çok eğlenceli olmuştır."
      : "My short advice: Code! It is really fun.";
  }

  if (hasAny(text, ["renk", "tasarim", "orb", "color", "design"])) {
    return lang === "tr"
      ? "Tasarımda koyu arka plan, turkuaz enerji rengi ve konuşmaya tepki veren bir küre kullanıyorum. Bu yüzden arayüz daha futuristik görünüyor."
      : "The design uses a dark background, cyan energy color, and a voice-reactive orb, which gives the interface a futuristic feel.";
  }

  if (hasAny(text, ["guvenli mi", "gizlilik", "privacy", "safe", "secure"])) {
    return lang === "tr"
      ? "Tamamen güvenli bir yapay zekayım. Sadece konuşmamızı sen ve ben görebiliriz. Sayfayı yenilediğinde veya temizleye bastığında da sohbetimiz silinir."
      : "I am a completely secure AI. Only you and I can see our conversation. Our chat will be deleted when you refresh the page or press clear.";
  }

  if (hasAny(text, ["kac yasindasin", "yas", "how old", "age"])) {
    return lang === "tr"
      ? "Bir yaşım yok; sadece dijital bir asistanım. Ama bugün kendimi yeni derlenmiş gibi hissediyorum."
      : "I do not have an age; I am a digital assistant. But today I feel freshly built.";
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
      ? "Plan: Önce hedef belirle, model oluştur, uygula!"
      : "Plan: define the goal, create a model or prototype, apply!";
  }

  if (hasAny(text, ["kod", "javascript", "html", "css", "code"])) {
    return lang === "tr"
      ? "HTML dosyası web sitesinin iskeletidir. CSS dosyası sanattır, JS ise beynidir."
      : "HTML file is the skeleton of the website. CSS file is the art, JS is brain.";
  }

  if (hasAny(text, ["hata", "bug", "error", "problem"])) {
    return lang === "tr"
      ? "Hata çözmek için önce ekrandaki mesajı aynen oku, sonra hangi adımda olduğunu söyle. Genelde bu projede sorunlar cache, dosya yolu, mikrofon izni veya eski app.js yüzünden çıkıyor."
      : "To debug, read the exact error message and say which step you are on. In this project, issues usually come from cache, file paths, microphone permission, or an old app.js.";
  }

  if (hasAny(text, ["neden", "why"])) {
    return lang === "tr"
      ? "Neyin nedeni? Eğer cümlende belirttiysen üzgünüm. Henüz geliştirme aşamasında olduğum için cümle ayırt etmede o kadar iyi değilim."
      : "The reason for what? I'm sorry if you mentioned it in your sentence. I'm not very good at distinguishing between sentences yet, as I'm still in the development phase.";
  }

  if (hasAny(text, ["nasil", "how"])) {
    return lang === "tr"
      ? "Genel yol şu: ilgili dosyayı güncelle, GitHub'a yükle, Pages deploy'unun bitmesini bekle, sonra sayfayı Ctrl+F5 ile yenile. Eski dosya kalırsa değişiklik görünmez."
      : "General path: update the file, upload it to GitHub, wait for Pages deployment, then refresh with Ctrl+F5. If an old file is cached, the change will not appear.";
  }

  if (isAboutRoboContext(text) && hasAny(text, ["ne", "what"])) {
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

function answerDefinitionQuestion(originalMessage, text, lang) {
  const subject = extractDefinitionSubject(originalMessage, text);
  if (!subject) {
    return "";
  }

  const key = normalizeForIntent(subject);
  const known = definitionKnowledge[key] || Object.entries(definitionKnowledge)
    .find(([name]) => key.includes(name) || name.includes(key))?.[1];

  if (known) {
    return lang === "tr" ? known.tr : known.en;
  }

  return lang === "tr"
    ? `${subject} için kısa tanım: Bu bir kavram, nesne ya da konu olabilir. Yerel bilgimde özel tanımı yok; web araması bağlıysa "webde ara ${subject}" diyerek güncel bilgi aratabilirsin.`
    : `Short definition for ${subject}: it may be a concept, object, or topic. I do not have a specific local definition for it; if web search is connected, say "search for ${subject}".`;
}

function extractDefinitionSubject(originalMessage, text) {
  const patterns = [
    /(.+?)\s+(?:nedir|ne demek|ne anlama gelir)\??$/,
    /(?:nedir|ne demek)\s+(.+?)\??$/,
    /what is\s+(.+?)\??$/,
    /what are\s+(.+?)\??$/,
    /define\s+(.+?)\??$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return restoreSubjectCasing(originalMessage, match[1]);
    }
  }

  return "";
}

function restoreSubjectCasing(originalMessage, normalizedSubject) {
  const originalWords = sanitizeTranscript(originalMessage).replace(/[?!.]+$/, "").split(/\s+/);
  const normalizedWords = normalizeForIntent(normalizedSubject).split(/\s+/);
  const matched = originalWords.filter(word => normalizedWords.includes(normalizeForIntent(word)));
  return (matched.length ? matched.join(" ") : normalizedSubject).trim();
}

function isAboutRoboContext(text) {
  return hasAny(text, ["robo", "robo ai", "bu site", "site", "uygulama", "asistan", "assistant", "this app", "this site"]);
}

const definitionKnowledge = {
  // --- ÖNCEKİ KELİMELERİNİZ (İLK İSTEDİKLERİNİZ) ---
  domates: {
    tr: "Domates, genelde sebze gibi kullanılan ama botanik olarak meyve sayılan kırmızı, sulu bir bitki ürünüdür. Salatada, yemekte, sosta ve salçada çok kullanılır.",
    en: "A tomato is a red, juicy plant fruit that is commonly used like a vegetable. It is used in salads, meals, sauces, and paste."
  },
  tomato: {
    tr: "Domates, genelde sebze gibi kullanılan ama botanik olarak meyve sayılan kırmızı, sulu bir bitki ürünüdür. Salatada, yemekte, sosta ve salçada çok kullanılır.",
    en: "A tomato is a red, juicy plant fruit that is commonly used like a vegetable. It is used in salads, meals, sauces, and paste."
  },
  api: {
    tr: "API, iki yazılımın birbiriyle konuşmasını sağlayan arayüzdür. Bir site API sayesinde başka bir servisten veri veya cevap alabilir.",
    en: "An API is an interface that lets two software systems talk to each other. A site can use an API to get data or responses from another service."
  },
  "github pages": {
    tr: "GitHub Pages, HTML, CSS ve JavaScript dosyalarını ücretsiz statik web sitesi olarak yayınlayan GitHub özelliğidir.",
    en: "GitHub Pages is a GitHub feature that publishes HTML, CSS, and JavaScript files as a free static website."
  },
  "robo ai": {
    tr: "Robo AI, bu projede çalışan sesli web asistanıdır. Konuşmayı yazıya çevirir, yerel cevap üretir ve cevabı sesli okur.",
    en: "Robo AI is the voice web assistant in this project. It converts speech to text, creates local replies, and reads them aloud."
  },
  AI: {
    tr: "AI, bilgisayarların öğrenme, anlama, karar verme veya içerik üretme gibi insan benzeri görevleri yapmasını sağlayan teknolojilerin genel adıdır.",
    en: "Artificial intelligence is the general name for technologies that let computers perform human-like tasks such as learning, understanding, deciding, or generating content."
  },
  "yapay zeka": {
    tr: "Yapay zeka, bilgisayarların öğrenme, anlama, karar verme veya içerik üretme gibi insan benzeri görevleri yapmasını sağlayan teknolojilerin genel adıdır.",
    en: "Artificial intelligence is the general name for technologies that let computers perform human-like tasks such as learning, understanding, deciding, or generating content."
  },
  internet: {
    tr: "İnternet, dünya genelindeki bilgisayarların ve sunucuların birbirine bağlı olduğu büyük ağ sistemidir.",
    en: "The internet is the global network system that connects computers and servers around the world."
  },
  tarayici: {
    tr: "Tarayıcı, web sitelerini açmak için kullanılan uygulamadır. Chrome, Edge, Firefox ve Safari buna örnektir.",
    en: "A browser is an app used to open websites. Chrome, Edge, Firefox, and Safari are examples."
  },
  browser: {
    tr: "Browser, web sitelerini açmak için kullanılan uygulamadır. Chrome, Edge, Firefox ve Safari buna örnektir.",
    en: "A browser is an app used to open websites. Chrome, Edge, Firefox, and Safari are examples."
  },
  mikrofon: {
    tr: "Mikrofon, sesi elektriksel veya dijital sinyale çeviren giriş cihazıdır. Robo AI bunu konuşmanı yazıya çevirmek için kullanır.",
    en: "A microphone is an input device that turns sound into an electrical or digital signal. Robo AI uses it to convert speech to text."
  },
  microphone: {
    tr: "Mikrofon, sesi elektriksel veya dijital sinyale çeviren giriş cihazıdır. Robo AI bunu konuşmanı yazıya çevirmek için kullanır.",
    en: "A microphone is an input device that turns sound into an electrical or digital signal. Robo AI uses it to convert speech to text."
  },
  cache: {
    tr: "Cache, tarayıcının dosyaları daha hızlı açmak için saklamasıdır. Eski dosya kalırsa Ctrl+F5 ile yenilemek işe yarar.",
    en: "Cache is stored browser data used to load files faster. If an old file stays cached, Ctrl+F5 can help refresh it."
  },

  // --- TEKNOLOJİ VE YAZILIM KELİMELERİ ---
  bilgisayar: {
    tr: "Bilgisayar, verileri alan, işleyen, saklayan ve sonuç üreten elektronik bir cihazdır. Günümüzde iş, eğlence ve iletişim için vazgeçilmezdir.",
    en: "A computer is an electronic device that receives, processes, stores, and produces data results. Today, it is indispensable for work, entertainment, and communication."
  },
  computer: {
    tr: "Bilgisayar, verileri alan, işleyen, saklayan ve sonuç üreten elektronik bir cihazdır. Günümüzde iş, eğlence ve iletişim için vazgeçilmezdir.",
    en: "A computer is an electronic device that receives, processes, stores, and produces data results. Today, it is indispensable for work, entertainment, and communication."
  },
  "yazilim": {
    tr: "Yazılım, bilgisayarın veya akıllı cihazların ne yapacağını söyleyen kodlar, programlar ve komutlar bütünüdür.",
    en: "Software is the collection of codes, programs, and instructions that tell a computer or smart device what to do."
  },
  software: {
    tr: "Yazılım, bilgisayarın veya akıllı cihazların ne yapacağını söyleyen kodlar, programlar ve komutlar bütünüdür.",
    en: "Software is the collection of codes, programs, and instructions that tell a computer or smart device what to do."
  },
  "web sitesi": {
    tr: "Web sitesi, internet üzerinde belirli bir alan adı altında toplanmış, birbiriyle bağlantılı web sayfalarının bütünüdür.",
    en: "A website is a collection of interconnected web pages grouped under a specific domain name on the internet."
  },
  websitesi: {
    tr: "Web sitesi, internet üzerinde belirli bir alan adı altında toplanmış, birbiriyle bağlantılı web sayfalarının bütünüdür.",
    en: "A website is a collection of interconnected web pages grouped under a specific domain name on the internet."
  },
  "veritabani": {
    tr: "Veritabanı, bilgilerin düzenli ve hızlı erişilebilir bir şekilde dijital ortamda saklandığı sistemdir.",
    en: "A database is a system where information is stored digitally in an organized and quickly accessible manner."
  },
  "veri tabani": {
    tr: "Veritabanı, bilgilerin düzenli hızlı erişilebilir bir şekilde dijital ortamda saklandığı sistemdir.",
    en: "A database is a system where information is stored digitally in an organized and quickly accessible manner."
  },
  bulut: {
    tr: "Bulut, verilerin kendi bilgisayarında değil, internet üzerindeki güçlü sunucularda saklanması ve işlenmesi teknolojisidir.",
    en: "Cloud is the technology where data is stored and processed on powerful servers over the internet instead of your own computer."
  },
  cloud: {
    tr: "Bulut, verilerin kendi bilgisayarında değil, internet üzerindeki güçlü sunucularda saklanması ve işlenmesi teknolojisidir.",
    en: "Cloud is the technology where data is stored and processed on powerful servers over the internet instead of your own computer."
  },
  sunucu: {
    tr: "Sunucu, internet üzerindeki web sitelerini veya verileri saklayan ve diğer bilgisayarların erişimine sunan güçlü bilgisayardır.",
    en: "A server is a powerful computer that stores websites or data on the internet and makes them accessible to other computers."
  },
  server: {
    tr: "Sunucu, internet üzerindeki web sitelerini veya verileri saklayan ve diğer bilgisayarların erişimine sunan güçlü bilgisayardır.",
    en: "A server is a powerful computer that stores websites or data on the internet and makes them accessible to other computers."
  },
  "sifre": {
    tr: "Şifre, hesapların ve kişisel verilerin güvenliğini sağlamak için kullanılan gizli kelime veya karakter dizisidir.",
    en: "A password is a secret word or character string used to ensure the security of accounts and personal data."
  },
  password: {
    tr: "Şifre, hesapların ve kişisel verilerin güvenliğini sağlamak için kullanılan gizli kelime veya karakter dizisidir.",
    en: "A password is a secret word or character string used to ensure the security of accounts and personal data."
  },
  "akilli telefon": {
    tr: "Akıllı telefon, sadece arama yapmakla kalmayıp internete bağlanan, uygulamalar çalıştıran ve bilgisayar gibi işlev gören cep telefonudur.",
    en: "A smartphone is a mobile phone that not only makes calls but also connects to the internet, runs apps, and functions like a computer."
  },
  "smartphone": {
    tr: "Akıllı telefon, sadece arama yapmakla kalmayıp internete bağlanan, uygulamalar çalıştıran ve bilgisayar gibi işlev gören cep telefonudur.",
    en: "A smartphone is a mobile phone that not only makes calls but also connects to the internet, runs apps, and functions like a computer."
  },
  uygulama: {
    tr: "Uygulama, telefon veya bilgisayarlarda belirli bir işi yapmak (oyun oynamak, sohbet etmek vb.) için yüklenen programlardır.",
    en: "An application (app) is a program installed on phones or computers to perform a specific task (playing games, chatting, etc.)."
  },
  app: {
    tr: "Uygulama, telefon veya bilgisayarlarda belirli bir işi yapmak (oyun oynamak, sohbet etmek vb.) için yüklenen programlardır.",
    en: "An application (app) is a program installed on phones or computers to perform a specific task (playing games, chatting, etc.)."
  },
  kodlama: {
    tr: "Kodlama, bilgisayara belirli görevleri yerine getirmesi için yazılı talimatlar verme sürecidir.",
    en: "Coding is the process of giving written instructions to a computer to perform specific tasks."
  },
  coding: {
    tr: "Kodlama, bilgisayara belirli görevleri yerine getirmesi için yazılı talimatlar verme sürecidir.",
    en: "Coding is the process of giving written instructions to a computer to perform specific tasks."
  },
  "sosyal medya": {
    tr: "Sosyal medya, insanların internet üzerinden içerik paylaştığı, iletişim kurduğu ve etkileşime girdiği platformların genel adıdır.",
    en: "Social media is the general name for platforms where people share content, communicate, and interact over the internet."
  },
  "social media": {
    tr: "Sosyal medya, insanların internet üzerinden içerik paylaştığı, iletişim kurduğu ve etkileşime girdiği platformların genel adıdır.",
    en: "Social media is the general name for platforms where people share content, communicate, and interact over the internet."
  },
  ekran: {
    tr: "Ekran, bilgisayar, telephone veya televizyondaki görüntüleri ve bilgileri gözle görmemizi sağlayan paneldir.",
    en: "A screen is the panel that allows us to visually see images and information on a computer, phone, or television."
  },
  screen: {
    tr: "Ekran, bilgisayar, telephone veya televizyondaki görüntüleri ve bilgileri gözle görmemizi sağlayan paneldir.",
    en: "A screen is the panel that allows us to visually see images and information on a computer, phone, or television."
  },
  klavye: {
    tr: "Klavye, üzerinde harf ve sayılar bulunan, bilgisayara yazı yazmayı ve komut vermeyi sağlayan giriş cihazıdır.",
    en: "A keyboard is an input device with letters and numbers that allows typing and giving commands to a computer."
  },
  keyboard: {
    tr: "Klavye, üzerinde harf ve sayılar bulunan, bilgisayara yazı yazmayı ve komut vermeyi sağlayan giriş cihazıdır.",
    en: "A keyboard is an input device with letters and numbers that allows typing and giving commands to a computer."
  },
  fare: {
    tr: "Fare, bilgisayar ekranındaki imleci hareket ettirmeye ve tıklayarak seçim yapmaya yarayan cihazdır.",
    en: "A mouse is a device used to move the cursor on the computer screen and make selections by clicking."
  },
  mouse: {
    tr: "Fare, bilgisayar ekranındaki imleci hareket ettirmeye ve tıklayarak seçim yapmaya yarayan cihazdır.",
    en: "A mouse is a device used to move the cursor on the computer screen and make selections by clicking."
  },
  "arama motoru": {
    tr: "Arama motoru, internetteki bilgileri, siteleri veya görselleri anahtar kelimelerle bulmamızı sağlayan sistemdir; Google gibi.",
    en: "A search engine is a system, like Google, that allows us to find information, sites, or images on the internet using keywords."
  },
  "e-posta": {
    tr: "E-posta, internet üzerinden dijital olarak mektup, dosya veya mesaj gönderme ve alma yöntemidir.",
    en: "E-mail is a method of sending and receiving letters, files, or messages digitally over the internet."
  },
  "e-mail": {
    tr: "E-posta, internet üzerinden dijital olarak mektup, dosya veya mesaj gönderme ve alma yöntemidir.",
    en: "E-mail is a method of sending and receiving letters, files, or messages digitally over the internet."
  },
  eposta: {
    tr: "E-posta, internet üzerinden dijital olarak mektup, dosya veya mesaj gönderme ve alma yöntemidir.",
    en: "E-mail is a method of sending and receiving letters, files, or messages digitally over the internet."
  },
  "yapay zeka modeli": {
    tr: "Yapay zeka modeli, büyük verilerle eğitilmiş ve belirli görevleri (yazı yazma, resim tanıma vb.) yapabilen akıllı algoritmadır.",
    en: "An AI model is a smart algorithm trained with big data that can perform specific tasks like writing text or recognizing images."
  },
  link: {
    tr: "Link, bir web sayfasına veya dosyaya tıklayarak gitmeyi sağlayan internet adresidir; bağlantı da denir.",
    en: "A link is an internet address that allows you to navigate to a web page or file by clicking; also called a hyperlink."
  },
  "baglanti": {
    tr: "Bağlantı, bir web sayfasına veya dosyaya tıklayarak gitmeyi sağlayan internet adresidir; link de denir.",
    en: "A connection or link is an internet address that allows you to navigate to a web page or file by clicking."
  },
  indir: {
    tr: "İndir, internetteki bir dosyayı, resmi veya programı kendi bilgisayarına veya telefonuna kaydetme işlemidir.",
    en: "Download is the process of saving a file, image, or program from the internet onto your own computer or phone."
  },
  download: {
    tr: "İndir, internetteki bir dosyayı, resmi veya programı kendi bilgisayarına veya telefonuna kaydetme işlemidir.",
    en: "Download is the process of saving a file, image, or program from the internet onto your own computer or phone."
  },
  "yukle": {
    tr: "Yükle, kendi cihazındaki bir dosyayı internete göndermek (upload) veya bir programı cihaza kurmak (install) anlamına gelir.",
    en: "Upload/Install means sending a file from your device to the internet (upload) or setting up a program on your device (install)."
  },
  install: {
    tr: "Yükle, kendi cihazındaki bir dosyayı internete göndermek (upload) veya bir programı cihaza kurmak (install) anlamına gelir.",
    en: "Upload/Install means sending a file from your device to the internet (upload) or setting up a program on your device (install)."
  },
  "open source": {
    tr: "Açık kaynak, kodları herkes tarafından görülebilen, değiştirilebilen ve ücretsiz olarak dağıtılabilen yazılımlardır.",
    en: "Open source refers to software whose code is visible, modifiable, and distributable by anyone for free."
  },
  "acik kaynak": {
    tr: "Açık kaynak, kodları herkes tarafından görülebilen, değiştirilebilen ve ücretsiz olarak dağıtılabilen yazılımlardır.",
    en: "Open source refers to software whose code is visible, modifiable, and distributable by anyone for free."
  },
  frontend: {
    tr: "Frontend, bir web sitesinin veya uygulamanın kullanıcının doğrudan gördüğü ve etkileşime girdiği ön yüz tasarımı ve kodlarıdır.",
    en: "Frontend refers to the user interface design and code of a website or app that the user directly sees and interacts with."
  },
  backend: {
    tr: "Backend, bir web sitesinin görünmeyen arka kısmıdır; veri tabanı işlemleri, kullanıcı kontrolleri ve sunucu mantığı burada çalışır.",
    en: "Backend is the unseen background of a website; database operations, user controls, and server logic run here."
  },

  // --- GÜNDELİK HAYAT KELİMELERİ ---
  kahve: {
    tr: "Kahve, kavrulmuş kahve çekirdeklerinden yapılan, dünyada çok popüler olan kafeinli ve enerji verici bir sıcak içecektir.",
    en: "Coffee is a popular caffeinated and energizing hot drink made from roasted coffee beans."
  },
  cofee: {
    tr: "Kahve, kavrulmuş kahve çekirdeklerinden yapılan, dünyada çok popüler olan kafeinli ve enerji verici bir sıcak içecektir.",
    en: "Coffee is a popular caffeinated and energizing hot drink made from roasted coffee beans."
  },
  "cay": {
    tr: "Çay, çay bitkisinin yapraklarının demlenmesiyle yapılan, Türk kültüründe sabah kahvaltısından akşam sohbetlerine kadar çok önemli bir yeri olan sıcak içecektir.",
    en: "Tea is a hot beverage made by brewing tea plant leaves, holding a very important place in Turkish culture from breakfast to evening chats."
  },
  tea: {
    tr: "Çay, çay bitkisinin yapraklarının demlenmesiyle yapılan, Türk kültüründe sabah kahvaltısından akşam sohbetlerine kadar çok önemli bir yeri olan sıcak içecektir.",
    en: "Tea is a hot beverage made by brewing tea plant leaves, holding a very important place in Turkish culture from breakfast to evening chats."
  },
  araba: {
    tr: "Araba, insanları veya yükleri taşımak için kullanılan, genellikle dört tekerlekli ve motorlu kara ulaşım aracıdır.",
    en: "A car is a motor vehicle, usually with four wheels, used on roads to transport people or cargo."
  },
  car: {
    tr: "Araba, insanları veya yükleri taşımak için kullanılan, genellikle dört tekerlekli ve motorlu kara ulaşım aracıdır.",
    en: "A car is a motor vehicle, usually with four wheels, used on roads to transport people or cargo."
  },
  kitap: {
    tr: "Kitap, bir konuyu açıklayan veya bir hikaye anlatan, basılı ya da dijital sayfaların bir araya gelmesiyle oluşan eserdir.",
    en: "A book is a work formed by printed or digital pages bound together, explaining a subject or telling a story."
  },
  book: {
    tr: "Kitap, bir konuyu açıklayan veya bir hikaye anlatan, basılı ya da dijital sayfaların bir araya gelmesiyle oluşan eserdir.",
    en: "A book is a work formed by printed or digital pages bound together, explaining a subject or telling a story."
  },
  ev: {
    tr: "Ev, insanların içinde yaşadığı, barındığı, güvende hissettiği ve dinlendiği bina veya yaşam alanıdır.",
    en: "A house or home is a building or living space where people live, shelter, feel safe, and rest."
  },
  house: {
    tr: "Ev, insanların içinde yaşadığı, barındığı, güvende hissettiği ve dinlendiği bina veya yaşam alanıdır.",
    en: "A house or home is a building or living space where people live, shelter, feel safe, and rest."
  },
  yemek: {
    tr: "Yemek, insanların enerji almak ve hayatta kalmak için tükettiği, pişirilmiş veya çiğ besinlerin genel adıdır.",
    en: "Food or meal is the general name for cooked or raw nutrients that people consume to gain energy and survive."
  },
  food: {
    tr: "Yemek, insanların enerji almak ve hayatta kalmak için tükettiği, pişirilmiş veya çiğ besinlerin genel adıdır.",
    en: "Food or meal is the general name for cooked or raw nutrients that people consume to gain energy and survive."
  },
  su: {
    tr: "Su, tüm canlıların yaşaması için en temel ihtiyaç olan, kokusuz ve tatsız sıvı maddedir.",
    en: "Water is an odorless and tasteless liquid substance, which is the most basic need for all living things to survive."
  },
  water: {
    tr: "Su, tüm canlıların yaşaması için en temel ihtiyaç olan, kokusuz ve tatsız sıvı maddedir.",
    en: "Water is an odorless and tasteless liquid substance, which is the most basic need for all living things to survive."
  },
  para: {
    tr: "Para, mal ve hizmet satın almak, borçları ödemek için dünya genelinde kullanılan resmi değişim ve değer ölçme aracıdır.",
    en: "Money is an official medium of exchange and measure of value used worldwide to buy goods and services and pay debts."
  },
  money: {
    tr: "Para, mal ve hizmet satın almak, borçları ödemek için dünya genelinde kullanılan resmi değişim ve değer ölçme aracıdır.",
    en: "Money is an official medium of exchange and measure of value used worldwide to buy goods and services and pay debts."
  },
  okul: {
    tr: "Okul, öğrencilerin eğitim gördüğü, yeni bilgiler öğrendiği ve sosyalleştiği eğitim kurumudur.",
    en: "A school is an educational institution where students receive education, learn new information, and socialize."
  },
  school: {
    tr: "Okul, öğrencilerin eğitim gördüğü, yeni bilgiler öğrendiği ve sosyalleştiği eğitim kurumudur.",
    en: "A school is an educational institution where students receive education, learn new information, and socialize."
  },
  "is": {
    tr: "İş, geçimi sağlamak veya bir ürün/hizmet üretmek amacıyla yapılan, emek ve zaman harcanan her türlü aktivitedir.",
    en: "Work or job is any activity spent with effort and time to earn a living or produce a product/service."
  },
  "work": {
    tr: "İş, geçimi sağlamak veya bir ürün/hizmet üretmek amacıyla yapılan, emek ve zaman harcanan her türlü aktivitedir.",
    en: "Work or job is any activity spent with effort and time to earn a living or produce a product/service."
  },
  meslek: {
    tr: "Meslek, bir kişinin hayatını kazanmak için yaptığı, genellikle özel bir eğitim veya beceri gerektiren uzmanlık alanıdır.",
    en: "A profession or occupation is a field of expertise that a person does to earn a living, usually requiring special training or skill."
  },
  occupation: {
    tr: "Meslek, bir kişinin hayatını kazanmak için yaptığı, genellikle özel bir eğitim veya beceri gerektiren uzmanlık alanıdır.",
    en: "A profession or occupation is a field of expertise that a person does to earn a living, usually requiring special training or skill."
  },
  arkadas: {
    tr: "Arkadaş, sevgi, saygı ve güven bağıyla birbirine bağlı olan, birlikte vakit geçirmekten keyif alınan yakındır.",
    en: "A friend is a close person bound by love, respect, and trust, with whom spending time together is enjoyed."
  },
  friend: {
    tr: "Arkadaş, sevgi, saygı ve güven bağıyla birbirine bağlı olan, birlikte vakit geçirmekten keyif alınan yakındır.",
    en: "A friend is a close person bound by love, respect, and trust, with whom spending time together is enjoyed."
  },
  aile: {
    tr: "Aile, aralarında kan bağı veya evlilik ilişkisi bulunan, genellikle aynı evde yaşayan en küçük toplumsal birimdir.",
    en: "A family is the smallest social unit, connected by blood or marriage, usually living in the same house."
  },
  family: {
    tr: "Aile, aralarında kan bağı veya evlilik ilişkisi bulunan, genellikle aynı evde yaşayan en küçük toplumsal birimdir.",
    en: "A family is the smallest social unit, connected by blood or marriage, usually living in the same house."
  },
  hava: {
    tr: "Hava, dünyayı saran ve nefes almamızı sağlayan gaz karışımıdır; günlük hayatta sıcaklık, yağmur gibi hava durumunu ifade etmek için de kullanılır.",
    en: "Air is the gas mixture surrounding the earth that lets us breathe; in daily life, it also refers to weather conditions like temperature or rain."
  },
  air: {
    tr: "Hava, dünyayı saran ve nefes almamızı sağlayan gaz karışımıdır; günlük hayatta sıcaklık, yağmur gibi hava durumunu ifade etmek için de kullanılır.",
    en: "Air is the gas mixture surrounding the earth that lets us breathe; in daily life, it also refers to weather conditions like temperature or rain."
  },
  "hava durumu": {
    tr: "Hava durumu, atmosferin belirli bir yerdeki kısa süreli güneşli, yağmurlu, rüzgarlı veya karlı olma halidir.",
    en: "Weather is the short-term state of the atmosphere in a specific place, such as being sunny, rainy, windy, or snowy."
  },
  "weather": {
    tr: "Hava durumu, atmosferin belirli bir yerdeki kısa süreli güneşli, yağmurlu, rüzgarlı veya karlı olma halidir.",
    en: "Weather is the short-term state of the atmosphere in a specific place, such as being sunny, rainy, windy, or snowy."
  },
  "muzik": {
    tr: "Müzik, duygu ve düşüncelerin sesler aracılığıyla estetik ve ritmik bir şekilde ifade edilmesi sanatıdır.",
    en: "Music is the art of expressing emotions and thoughts through sounds in an aesthetic and rhythmic way."
  },
  "musik": {
    tr: "Müzik, duygu ve düşüncelerin sesler aracılığıyla estetik ve ritmik bir şekilde ifade edilmesi sanatıdır.",
    en: "Music is the art of expressing emotions and thoughts through sounds in an aesthetic and rhythmic way."
  },
  film: {
    tr: "Film, bir hikayeyi anlatmak için hareketli görüntüler ve sesler kullanılarak hazırlanan sinema eseridir.",
    en: "A movie or film is a cinematic work made using moving images and sounds to tell a story."
  },
  movie: {
    tr: "Film, bir hikayeyi anlatmak için hareketli görüntüler ve sesler kullanılarak hazırlanan sinema eseridir.",
    en: "A movie or film is a cinematic work made using moving images and sounds to tell a story."
  },
  spor: {
    tr: "Spor, fiziksel gelişimi sağlamak, eğlenmek veya yarışmak amacıyla belirli kurallara göre yapılan beden hareketleridir.",
    en: "Sport refers to physical activities done according to certain rules for physical development, entertainment, or competition."
  },
  sport: {
    tr: "Spor, fiziksel gelişimi sağlamak, eğlenmek veya yarışmak amacıyla belirli kurallara göre yapılan beden hareketleridir.",
    en: "Sport refers to physical activities done according to certain rules for physical development, entertainment, or competition."
  },
  kedi: {
    tr: "Kedi, evlerde çok sık beslenen, uykucu, oyuncu ve sevimli küçük memeli evcil hayvandır.",
    en: "A cat is a small, sleepy, playful, and cute carnivorous mammal commonly kept as a pet in homes."
  },
  cat: {
    tr: "Kedi, evlerde çok sık beslenen, uykucu, oyuncu ve sevimli küçük memeli evcil hayvandır.",
    en: "A cat is a small, sleepy, playful, and cute carnivorous mammal commonly kept as a pet in homes."
  },
  "kopek": {
    tr: "Köpek, insanlara sadakati ve koruyuculuğu ile bilinen, evlerde veya bahçelerde beslenen popüler bir evcil hayvandır.",
    en: "A dog is a popular domestic animal kept in homes or gardens, known for its loyalty and protectiveness to humans."
  },
  "dog": {
    tr: "Köpek, insanlara sadakati ve koruyuculuğu ile bilinen, evlerde veya bahçelerde beslenen popüler bir evcil hayvandır.",
    en: "A dog is a popular domestic animal kept in homes or gardens, known for its loyalty and protectiveness to humans."
  },
  "alisveris": {
    tr: "Alışveriş, ihtiyaç duyulan yiyecek, giysi veya eşyaları para karşılığında mağazalardan veya internetten alma işidir.",
    en: "Shopping is the act of buying needed food, clothes, or goods from stores or the internet in exchange for money."
  },
  shopping: {
    tr: "Alışveriş, ihtiyaç duyulan yiyecek, giysi veya eşyaları para karşılığında mağazalardan veya internetten alma işidir.",
    en: "Shopping is the act of buying needed food, clothes, or goods from stores or the internet in exchange for money."
  },
  tatil: {
    tr: "Tatil, işe veya okula ara verilerek dinlenmek, eğlenmek veya yeni yerler görmek için ayrılan serbest zamandır.",
    en: "A vacation or holiday is free time taken off from work or school to rest, have fun, or see new places."
  },
  holiday: {
    tr: "Tatil, işe veya okula ara verilerek dinlenmek, eğlenmek veya yeni yerler görmek için ayrılan serbest zamandır.",
    en: "A vacation or holiday is free time taken off from work or school to rest, have fun, or see new places."
  },
  vacation: {
    tr: "Tatil, işe veya okula ara verilerek dinlenmek, eğlenmek veya yeni yerler görmek için ayrılan serbest zamandır.",
    en: "A vacation or holiday is free time taken off from work or school to rest, have fun, or see new places."
  },
  saat: {
    tr: "Saat, zamanı ölçmeye yarayan alettir veya günün hangi anında olduğumuzu belirten zaman dilimidir.",
    en: "A clock/watch is a device used to measure time, or an hour representing a specific point in the day."
  },
  clock: {
    tr: "Saat, zamanı ölçmeye yarayan alettir veya günün hangi anında olduğumuzu belirten zaman dilimidir.",
    en: "A clock/watch is a device used to measure time, or an hour representing a specific point in the day."
  },
  watch: {
    tr: "Saat, zamanı ölçmeye yarayan alettir veya günün hangi anında olduğumuzu belirten zaman dilimidir.",
    en: "A clock/watch is a device used to measure time, or an hour representing a specific point in the day."
  },
  "gundelik hayat": {
    tr: "Gündelik hayat, bir insanın her gün rutin olarak yaptığı sıradan işleri, alışkanlıkları ve yaşam biçimidir.",
    en: "Daily life refers to the ordinary tasks, habits, and lifestyle that a person does routinely every day."
  }
};

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
