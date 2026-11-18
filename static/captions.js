"use strict";

// 브라우저 내장 자막(Q29) — 키·비용 없음.
//  · 말하는 지점: Web Speech API(SpeechRecognition)로 음성을 글자로 바꾼다. Chrome 은 기본적으로 Google 서버에서 인식한다.
//  · 받는 지점: Translator API 로 자기 언어로 번역한다(PC 안에서 처리, 언어 모델은 처음 한 번 내려받음).
// 지원하지 않으면 이유를 돌려주고, 가짜 자막·가짜 번역을 만들지 않는다.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const RECOGNITION_ERRORS = {
  "not-allowed": "마이크 사용이 거부됐습니다 — 주소창 왼쪽 자물쇠에서 마이크를 허용하세요",
  "service-not-allowed": "브라우저가 음성 인식을 막았습니다 — 브라우저 설정·회사 정책을 확인하세요",
  "audio-capture": "음성 인식이 마이크를 찾지 못했습니다",
  "network": "음성 인식 서버에 연결하지 못했습니다 — 인터넷 연결을 확인하세요",
  "language-not-supported": "이 브라우저는 이 언어의 음성 인식을 지원하지 않습니다",
};

// 음성 인식 가능 여부. available() 은 Chrome·Edge 139+ 에만 있어, 없으면 «있다»까지만 판단한다.
async function recognitionSupport(locale) {
  if (!Recognition) {
    return { ok: false, reason: "이 브라우저는 음성 인식을 지원하지 않습니다 — PC 의 Chrome·Edge 최신 버전을 쓰세요" };
  }
  if (typeof Recognition.available === "function") {
    try {
      const result = await Recognition.available({ langs: [locale], processLocally: false });
      if (result === "unavailable") return { ok: false, reason: `이 브라우저는 ${locale} 음성 인식을 지원하지 않습니다` };
    } catch { /* 확인을 못 하면 실제로 시작해 보고 오류로 판단한다 */ }
  }
  return { ok: true, reason: "" };
}

// 번역 가능 여부: "available" | "downloadable" | "downloading" | "unavailable" | "unsupported"
async function translationSupport(from, to) {
  if (from === to) return { state: "available", reason: "" };
  if (!("Translator" in self)) {
    return { state: "unsupported", reason: "이 브라우저에는 번역 기능이 없습니다 — PC 의 Chrome 138·Edge 148 이상이 필요합니다" };
  }
  try {
    const result = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    return { state: result, reason: result === "unavailable" ? `${from}→${to} 번역을 지원하지 않습니다` : "" };
  } catch (error) {
    return { state: "unavailable", reason: `번역 기능 확인 실패(${error.name})` };
  }
}

const translators = new Map(); // "ko>vi" -> Promise<Translator>

// 번역기를 준비한다. 언어 모델을 내려받아야 하면 사용자 클릭 직후에 불러야 한다(브라우저 규칙).
function prepareTranslator(from, to, onProgress) {
  const key = `${from}>${to}`;
  if (translators.has(key)) return translators.get(key);
  const promise = (async () => {
    const support = await translationSupport(from, to);
    if (support.state === "unsupported" || support.state === "unavailable") throw new Error(support.reason);
    return Translator.create({
      sourceLanguage: from,
      targetLanguage: to,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => onProgress && onProgress(key, event.loaded));
      },
    });
  })();
  translators.set(key, promise);
  promise.catch(() => translators.delete(key));  // 실패하면 다음에 다시 시도할 수 있게
  return promise;
}

// { text } 또는 { error }. 같은 언어면 그대로.
async function translateText(text, from, to) {
  if (from === to) return { text };
  try {
    const translator = await prepareTranslator(from, to);
    return { text: await translator.translate(text) };
  } catch (error) {
    return { error: error.message || error.name || "번역 실패" };
  }
}

// 받아쓰기. Chrome 은 쉬는 틈·네트워크 사정으로 인식을 스스로 끝내므로, 멈출 때까지 다시 시작한다.
// 2026-11-11 사용자 보고(«첫 문장 뒤 다음 문장이 잘 인식되지 않음») 대응:
//  ① 세션이 끝날 때 확정되지 않은 문장이 남아 있으면 버리지 않고 확정으로 올린다.
//  ② 다시 시작이 «아직 끝나는 중»(InvalidStateError)으로 거절되면 잠시 뒤 다시 시도한다(전에는 그대로 꺼져 있었음).
//  ③ 회의 마이크 트랙으로 시작한 세션이 곧바로 끝나기를 반복하면 기본 마이크로 바꾼다.
//  ④ 세션 수·오류를 stats 로 남겨 화면에 보인다(원인 확인용).
//  ⑤ 마이크에 목소리가 들어오는데 결과가 4초 넘게 없으면 인식이 멈춘 것으로 보고 다시 시작한다(감시 장치).
//     2026-11-11 재보고(«첫 문장 뒤 다음 문장 인식 못 함»): 세션이 끝나지도 결과를 내지도 않는 정지 상태 대응.
//  ⑥ 메아리 막기(Q32 자동 자막): voiceGateMs 를 주면, 회의 마이크(에코 제거된 트랙, levelProbe)에서 목소리가 들린 뒤
//     그 시간 안에 온 결과만 내보낸다. 스피커로 나온 상대 목소리를 인식기(기본 마이크)가 듣고 내 말로 올리는 것을 막는다.
//     버린 건수(dropped)와 목소리 시간(voice, 초)을 stats 에 남겨 화면·서버 로그에 보인다(조용히 버리지 않는다).
const QUICK_END_MS = 1000;      // 이보다 짧게 끝난 세션은 «바로 끝남»
const STALL_MS = 4000;          // 목소리가 있는데 이만큼 결과가 없으면 «멈춤»
const VOICE_LEVEL = 0.02;       // 마이크 RMS 이 값 이상이면 목소리로 본다(실기 조정 대상)
const WATCH_MS = 250;
const QUICK_END_LIMIT = 3;      // 바로 끝남이 이만큼 이어지면 마이크 방식을 바꾼다

function startDictation({ locale, track, levelProbe, voiceGateMs = 0, onInterim, onFinal, onError, onSpeech }) {
  const recognition = new Recognition();
  recognition.lang = locale;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  let active = true;
  let lastInterim = "";
  let ended = null;  // stop() 이 기다리는 끝 신호
  let useTrack = Boolean(track);
  let sessionStart = 0;
  let quickEnds = 0;
  const stats = { sessions: 0, finals: 0, rescued: 0, retries: 0, watchdog: 0, dropped: 0, voice: 0,
                  trackFallback: false, trackInput: Boolean(track), errors: [] };
  let lastResultAt = 0;
  let lastVoiceAt = -Infinity;
  let voiceStartAt = 0;  // 1초 넘게 조용하다가 다시 목소리가 시작된 시각
  let voiceMs = 0;
  const gated = Boolean(voiceGateMs && levelProbe);
  let discarding = false;  // stop({discard}) 뒤: 늦게 오는 결과·남은 임시 문장을 내보내지 않는다(마이크 끔)

  function emitFinal(text) {
    if (discarding) return;
    stats.finals += 1;
    onFinal(text);
  }

  // ⑥ 회의 마이크에서 방금 내 목소리가 있었는가(메아리 막기를 안 쓰면 늘 참)
  function voiceIsMine() {
    return !gated || performance.now() - lastVoiceAt <= voiceGateMs;
  }

  recognition.onresult = (event) => {
    if (discarding) return;
    lastResultAt = performance.now();
    const mine = voiceIsMine();
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (text && mine) emitFinal(text);
        else if (text) stats.dropped += 1;
        lastInterim = "";
      } else {
        interim += result[0].transcript;
      }
    }
    interim = interim.trim();
    if (!mine) {
      lastInterim = "";  // 내 목소리가 아닌 임시 문장은 보이지도, 끝날 때 확정으로 살리지도 않는다
      return;
    }
    if (interim && interim !== lastInterim) {
      lastInterim = interim;
      onInterim(interim);
    }
  };
  recognition.onspeechstart = () => { if (onSpeech) onSpeech(); };
  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;  // 조용함·중지는 오류가 아니다
    stats.errors.push(event.error);
    if (event.error === "network" && active && stats.errors.length <= 3) return;  // 일시 끊김은 onend 에서 다시 시작
    active = false;
    onError(RECOGNITION_ERRORS[event.error] || `음성 인식 오류(${event.error})`);
  };
  recognition.onend = () => {
    // ① 세션이 확정 없이 끝났으면 마지막 임시 문장을 확정으로 올린다(마이크를 꺼서 버리는 중이면 올리지 않는다).
    if (lastInterim && !discarding) {
      stats.rescued += 1;
      emitFinal(lastInterim);
      lastInterim = "";
    }
    if (!active) {
      if (ended) ended();
      return;
    }
    // ③ 바로 끝나기를 반복하면 회의 마이크 트랙 대신 기본 마이크로 시작한다.
    quickEnds = performance.now() - sessionStart < QUICK_END_MS ? quickEnds + 1 : 0;
    if (quickEnds >= QUICK_END_LIMIT && useTrack) {
      useTrack = false;
      stats.trackFallback = true;
      quickEnds = 0;
    } else if (quickEnds >= QUICK_END_LIMIT * 2) {
      active = false;
      onError("음성 인식이 계속 바로 끝납니다 — 마이크·인터넷 연결을 확인하세요");
      return;
    }
    begin();
  };

  function begin(attempt = 0) {
    if (!active) return;
    try {
      if (useTrack && track && track.readyState === "live") recognition.start(track);
      else recognition.start();
      stats.sessions += 1;
      sessionStart = performance.now();
      lastResultAt = sessionStart;
    } catch (error) {
      if (error.name === "InvalidStateError" && attempt < 5) {
        // ② 앞 세션이 아직 끝나는 중 — 잠시 뒤 다시(전에는 여기서 조용히 멈췄다).
        stats.retries += 1;
        setTimeout(() => begin(attempt + 1), 150);
        return;
      }
      active = false;
      stats.errors.push(`start:${error.name}`);
      onError(`음성 인식을 시작하지 못했습니다(${error.name})`);
    }
  }
  begin();

  // ⑤ 감시 장치: 목소리가 4초 넘게 이어지는데(말 시작·마지막 결과 중 늦은 쪽 기준) 결과가 없을 때만 끊고 다시 시작한다.
  //    쉬었다가 다시 말을 시작하는 순간에는 끊지 않는다(정상 인식을 끊으면 문장 앞부분이 사라진다).
  const watchdog = levelProbe ? setInterval(() => {
    if (!active) return;
    const now = performance.now();
    if (levelProbe() >= VOICE_LEVEL) {
      if (now - lastVoiceAt > 1000) voiceStartAt = now;
      lastVoiceAt = now;
      voiceMs += WATCH_MS;
      stats.voice = Math.floor(voiceMs / 1000);
    }
    const speaking = now - lastVoiceAt < 500;
    if (speaking && now - Math.max(voiceStartAt, lastResultAt) > STALL_MS) {
      stats.watchdog += 1;
      lastResultAt = now;
      try { recognition.abort(); } catch { /* onend 가 다시 시작한다 */ }
    }
  }, WATCH_MS) : null;

  return {
    stats,
    // 마지막 문장의 확정 결과가 도착하도록 끝날 때까지(최대 1.5초) 기다린다.
    // discard = 마이크 끔: 지금부터 오는 결과(말하던 문장의 늦은 확정 포함)는 버린다 — 끈 뒤에 그 지점 자막이 올라오지 않게.
    stop({ discard = false } = {}) {
      active = false;
      if (discard) discarding = true;
      if (watchdog) clearInterval(watchdog);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (lastInterim && !discarding) { stats.rescued += 1; emitFinal(lastInterim); lastInterim = ""; }
          resolve();
        }, 1500);
        ended = () => { clearTimeout(timer); resolve(); };
        try { recognition.stop(); } catch { clearTimeout(timer); resolve(); }
      });
    },
  };
}

// --- 번역 음성(브라우저 TTS) — 8단계, Q11 ---------------------------------------
// 이 PC 의 브라우저에 그 언어 음성이 없으면 null(«음성 없음» 표시). 가짜로 다른 언어 음성으로 읽지 않는다.
function voiceFor(code) {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  const matching = voices.filter((voice) => voice.lang && voice.lang.toLowerCase().split(/[-_]/)[0] === code.toLowerCase());
  return matching.find((voice) => voice.localService) || matching[0] || null;
}

// 음성 목록은 늦게 채워지므로(voiceschanged) 준비될 때까지 최대 3초 기다린다.
function voicesReady() {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  if (speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { speechSynthesis.removeEventListener("voiceschanged", done); resolve(); };
    speechSynthesis.addEventListener("voiceschanged", done);
    setTimeout(done, 3000);
  });
}

// 읽기 시작·끝을 알려 원음 줄이기에 쓴다. 음성이 없으면 false.
function speakText(text, code, { onStart, onEnd } = {}) {
  const voice = voiceFor(code);
  if (!voice) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.onstart = () => { if (onStart) onStart(); };
  utterance.onend = utterance.onerror = () => { if (onEnd) onEnd(); };
  speechSynthesis.speak(utterance);
  return true;
}
