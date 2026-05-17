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
    apiDemo: "Demo",
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
    apiDemo: "Demo",
    apiError: "API error",
    subtitleReady: "Robo AI is ready.",
    user: "You",
    assistant: "Robo AI",
    mic: "Microphone",
    empty: "Type a message or open the microphone.",
    transcriptLow: "Subtitle checked",
    transcriptLive: "Live subtitle",
    language: "EN"
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
let apiReachable = null;
let apiPillState = "demo";

boot();

function boot() {
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
    if (apiReachable === false && !apiBase) {
      const reply = clientDemoReply(message);
      addMessage("assistant", reply);
      elements.subtitle.textContent = reply;
      updateApiPill("demo");
      speak(reply);
      return;
    }

    const response = await fetch(apiUrl("/api/robo"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        language,
        history: history.slice(-8)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "API error");
    }

    const reply = sanitizeTranscript(data.reply || "");
    addMessage("assistant", reply);
    elements.subtitle.textContent = reply;
    apiReachable = true;
    updateApiPill(data.demo ? "demo" : "ready");
    speak(reply);
  } catch (error) {
    if (!apiBase) {
      apiReachable = false;
      const reply = clientDemoReply(message);
      addMessage("assistant", reply);
      elements.subtitle.textContent = reply;
      updateApiPill("demo");
      speak(reply);
      return;
    }

    const copy = language === "tr"
      ? `Bağlantı sorunu: ${error.message}`
      : `Connection issue: ${error.message}`;
    addMessage("assistant", copy);
    elements.subtitle.textContent = copy;
    updateApiPill("error");
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

function speak(text) {
  if (!synth || !text) {
    setState("idle");
    return;
  }

  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language === "tr" ? "tr-TR" : "en-US";
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.volume = 1;

  const voice = chooseVoice(utterance.lang);
  if (voice) {
    utterance.voice = voice;
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

function chooseVoice(lang) {
  const voices = synth.getVoices();
  const base = lang.toLowerCase().slice(0, 2);
  return voices.find(voice => voice.lang.toLowerCase() === lang.toLowerCase())
    || voices.find(voice => voice.lang.toLowerCase().startsWith(base))
    || null;
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
  try {
    const response = await fetch(apiUrl("/api/status"));
    if (!response.ok) {
      throw new Error("status");
    }

    const data = await response.json();
    apiReachable = true;
    updateApiPill(data.apiReady ? "ready" : "demo");
  } catch {
    apiReachable = false;
    updateApiPill(apiBase ? "error" : "demo");
  }
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

  return normalizeApiBase(localStorage.getItem(apiBaseStorageKey));
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
  const text = message.toLocaleLowerCase(lang === "tr" ? "tr-TR" : "en-US");
  const now = new Date();

  if (matchesAny(text, ["merhaba", "selam", "slm", "hello", "hi", "hey"])) {
    return lang === "tr"
      ? "Merhaba. Ben Robo AI. API olmadan kendi yerel çekirdeğimle çalışıyorum; kısa sorulara, komutlara ve sohbetlere cevap verebilirim."
      : "Hello. I am Robo AI. Without an API, I run on my local core and can answer short questions, commands, and simple chats.";
  }

  if (matchesAny(text, ["saat", "kaç", "time"])) {
    return lang === "tr"
      ? `Şu an saat ${now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}.`
      : `It is ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
  }

  if (matchesAny(text, ["tarih", "bugün", "date", "today"])) {
    return lang === "tr"
      ? `Bugünün tarihi ${now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}.`
      : `Today is ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`;
  }

  if (matchesAny(text, ["adın", "kimsin", "who are you", "your name"])) {
    return lang === "tr"
      ? "Ben Robo AI. Sesini yazıya çeviren, ekranda altyazı gösteren ve cevaplarını sesli okuyabilen yerel bir asistanım."
      : "I am Robo AI, a local assistant that turns speech into text, shows subtitles, and reads replies aloud.";
  }

  if (matchesAny(text, ["ne yapabilirsin", "özellik", "yetenek", "what can you do", "features"])) {
    return lang === "tr"
      ? "Mikrofonu dinleyebilirim, konuşmanı altyazıya çevirebilirim, Türkçe ve İngilizce cevap verebilirim, basit soruları yerel olarak yanıtlayabilirim ve konuşurken orb animasyonunu hareket ettirebilirim."
      : "I can listen through the microphone, turn speech into subtitles, answer in Turkish or English, handle simple questions locally, and animate the orb while speaking.";
  }

  if (matchesAny(text, ["github", "pages", "site", "yayınla", "deploy"])) {
    return lang === "tr"
      ? "GitHub Pages için public klasörü yayınlanır. Bu sürüm API olmadan da çalışır; gerçek büyük model istersen bir API veya sunucuda çalışan model gerekir."
      : "For GitHub Pages, the public folder is published. This version works without an API, but a larger real model needs an API or a hosted model.";
  }

  if (matchesAny(text, ["api", "openrouter", "openai", "key"])) {
    return lang === "tr"
      ? "API kullanmadan çalışabilirim, ama bu yerel çekirdek sınırlıdır. Büyük dil modeli gibi yaratıcı ve derin cevaplar için bir modelin bir yerde çalışması gerekir."
      : "I can work without an API, but this local core is limited. For creative and deep answers like a large language model, a model must run somewhere.";
  }

  if (text.endsWith("?") || matchesAny(text, ["neden", "nasıl", "what", "why", "how"])) {
    return lang === "tr"
      ? "Bunu yerel çekirdeğimle kesin cevaplayamam. Kısa bir komut, saat, tarih, kendimi tanıtma veya proje hakkında bir şey sorarsan cevaplayabilirim."
      : "I cannot answer that confidently with my local core. Ask a short command, time, date, identity, or project question and I can help.";
  }

  return lang === "tr"
    ? `Seni duydum: "${message}". Şu an kendi yerel zekamla çalışıyorum; daha basit veya net bir soru sorarsan cevaplamaya çalışırım.`
    : `I heard: "${message}". I am running on my local intelligence right now; ask a simpler or clearer question and I will try to answer.`;
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => text.includes(pattern));
}
