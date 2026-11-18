"use strict";

const state = {
  socket: null,
  me: null,
  roomCode: "",
  captionLang: "ko",
  limits: {},           // 서버 설정값(지점·언어·카메라 수) — /api/status
  captionCheck: null,   // 이 브라우저의 자막 지원 {recognition:{ok,reason}, translation:{lang:{state,reason}}}
  summary: null,        // 서버의 회의 정리 설정 상태
  summaries: {},        // 언어 코드 -> 마지막 정리 결과 (DOCX 에 같이 넣는다)
  summaryLang: "",      // 패널에 표시 중인 언어
  summaryErrors: {},    // 언어 코드 -> 실패 사유
  summaryEngine: "",    // 마지막 정리 결과를 만든 엔진 이름(Q18) — 화면·DOCX 에 표시
  languages: [],        // 서버가 준 활성 언어 [{code, label, speech_locale, translate_code, verified}]
  mode: "create",       // 입장 화면: "create" | "join"
  create: null,         // 서버가 준 개설 권한 {code_required, allowed, reason}
  created: null,        // 내가 개설한 회의 {meeting_id, password, host_token}
  meeting: null,        // 입장할(한) 회의 {id, password}
  preview: null,        // { stream, context, raf }
  media: { camOn: true, micOn: true, cameraId: "", micId: "" },
  lanUrl: "",           // 서버 PC 자신이 localhost 로 열었을 때 QR 에 넣을 사내망 주소 (Q26)
  local: { video: null, audio: null },  // 회의 중 내가 보내는 트랙
  mesh: null,           // rtc.js createMesh()
  rtcQueue: [],         // 메시 생성 전에 온 rtc_* 신호
  iceServers: [],       // 서버가 준 STUN/TURN (4단계) — 입장한 참가자에게만 온다
  relay: null,          // 외부 중계 상태 {state, label, reason}
  relayTimer: null,     // 중계 사용량 보고 타이머
  relayQuotaTimer: null, // Host 화면 Metered 사용량 조회 타이머
  people: [],           // 마지막 참가자 목록
  peerStates: {},       // 참가자 id -> RTCPeerConnection.connectionState
  qrTimer: null,
  screen: null,         // 내가 공유 중인 화면 트랙 (서버 승인 후)
  screenPending: null,  // 화면을 골랐고 서버 승인을 기다리는 트랙
  layout: "auto",       // 화면 배치 (Q9, 각자 선택): auto | grid | pin | speaker
  pinned: null,         // «특정인 크게» 대상 타일 id
  speaker: { id: null, candidate: null, candidateSince: 0, switchedAt: 0 },  // «말하는 사람 크게»
  meter: null,          // { context, timer, sources: Map(타일 id -> {track, analyser, buffer}) }
  entries: [],
  dictation: null,      // captions.js startDictation() — 자동 자막(Q32): 마이크가 켜진 동안 계속 인식
  captionStopping: null, // 자동 자막을 끄는 중(마지막 문장 확정 대기)이면 그 Promise
  captionTimer: null,   // 자동 자막 상태 줄 갱신 타이머
  captionNote: "",      // 상태 줄에 마지막으로 쓴 자동 자막 안내(같으면 다시 쓰지 않는다)
  interims: new Map(),  // 말하는 중인 문장: 지점 id -> {node, timer} (지점마다 한 줄, Q32)
  speakerOff: false,    // «스피커 꺼짐»(Q32): 상대 원음·번역 음성을 끈다. 자막은 계속, 이 PC 에만 적용
  resumeToken: "",      // 끊겼을 때 같은 자리로 돌아오는 토큰(Q14) — 메모리에만 둔다
  graceSeconds: 30,     // 서버가 자리를 보관하는 시간
  reconnect: null,      // 재연결 중이면 { deadline, attempt, timer }
  closing: false,       // 회의 종료·입장 거부 등 일부러 닫는 중이면 재연결하지 않는다
  frames: null,         // 화면 공유 프레임 보내기 { timer, video, canvas, tiny, last } (7단계, Q10)
  tts: false,           // 번역 음성(브라우저 TTS, Q11) — 기본 꺼짐, 이 PC 에만 적용
  tunnel: null,         // 외부 참석 주소 {running, url} — Host 에게만 온다
  ttsSpeaking: 0,       // 읽는 중인 문장 수 — 0 이 되면 원음 볼륨을 되돌린다
};

const el = (id) => document.getElementById(id);

// --- 상태 배지 --------------------------------------------------------

function setBadge(node, ok, label) {
  node.className = "badge " + (ok ? "badge-ok" : "badge-bad");
  node.querySelector(".badge-text").textContent = label;
}

// --- 브라우저 자막 지원 점검 (Q29) -----------------------------------------

function languageOf(code) {
  return state.languages.find((lang) => lang.code === code) || null;
}

// 내 언어로 말할 수 있는지(음성 인식), 다른 언어 자막을 내 언어로 번역할 수 있는지 점검한다.
async function checkCaptions(code) {
  const mine = languageOf(code);
  if (!mine) return;
  const recognition = await recognitionSupport(mine.speech_locale);
  const translation = {};
  for (const lang of state.languages) {
    if (lang.code === code) continue;
    translation[lang.code] = await translationSupport(lang.translate_code, mine.translate_code);
  }
  if (el("site-lang").value !== code && !state.me) return;  // 점검 중 언어를 바꿨으면 새 점검이 그린다
  state.captionCheck = { lang: code, recognition, translation };
  applyCaptionStatus();
  if (state.mesh) startCaptions();  // 회의에 먼저 들어와 점검 결과를 기다리던 경우
}

function captionSummary(check) {
  const rows = Object.entries(check.translation);
  const blocked = rows.filter(([, t]) => t.state === "unsupported" || t.state === "unavailable");
  const download = rows.filter(([, t]) => t.state === "downloadable" || t.state === "downloading");
  const parts = [check.recognition.ok ? "음성 인식 가능" : check.recognition.reason];
  if (blocked.length === rows.length && rows.length) {
    parts.push(blocked[0][1].reason || "번역 불가");
  } else {
    parts.push(`번역 ${rows.length - blocked.length}/${rows.length}개 언어 가능`);
    if (blocked.length) parts.push(`불가: ${blocked.map(([code]) => labelOf(code)).join("·")}`);
    if (download.length) parts.push(`처음 쓸 때 언어 모델 내려받기: ${download.map(([code]) => labelOf(code)).join("·")}`);
  }
  let label = "자막 준비됨";
  if (!check.recognition.ok) label = "음성 인식 불가";
  else if (blocked.length && blocked.length === rows.length) label = "번역 불가";
  else if (blocked.length) label = "번역 일부 불가";
  return { ok: check.recognition.ok && blocked.length === 0, label, reason: parts.join(" · ") };
}

function applyCaptionStatus() {
  const check = state.captionCheck;
  if (!check) return;
  const summary = captionSummary(check);
  for (const id of ["caption-check", "caption-badge"]) {
    setBadge(el(id), summary.ok, summary.label);
    el(id).title = summary.reason;
  }
  const reason = el("caption-check-reason");
  reason.textContent = summary.reason;
  reason.hidden = false;
}

// 입장 버튼(사용자 클릭) 직후에 부른다 — 번역 언어 모델 내려받기는 클릭 직후에만 시작할 수 있다.
function prepareTranslators(code) {
  const mine = languageOf(code);
  if (!mine) return;
  for (const lang of state.languages) {
    if (lang.code === code) continue;
    prepareTranslator(lang.translate_code, mine.translate_code).catch(() => {});
  }
}

// --- 입장 화면 --------------------------------------------------------

async function loadStatus() {
  const response = await fetch("/api/status");
  const data = await response.json();
  state.limits = data.limits;
  state.lanUrl = data.lan_url || "";
  state.create = data.create;
  applyCreatePermission();

  const select = el("site-lang");
  select.innerHTML = "";
  for (const lang of data.languages) {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.verified ? lang.label : `${lang.label} (미검증)`;
    select.appendChild(option);
  }
  state.languages = data.languages;
  select.value = "ko";
  refreshJoinButton();
  checkCaptions(select.value);
}

function applyCreatePermission() {
  const create = state.create || { allowed: false, code_required: false, reason: "" };
  el("create-blocked").textContent = create.reason || "";
  el("create-blocked").hidden = create.allowed;
  el("create-form").hidden = !create.allowed || Boolean(state.created);
  el("create-code-field").hidden = !create.code_required;
}

function setMode(mode) {
  state.mode = mode;
  el("mode-create").setAttribute("aria-selected", String(mode === "create"));
  el("mode-join").setAttribute("aria-selected", String(mode === "join"));
  el("create-pane").hidden = mode !== "create";
  el("join-pane").hidden = mode !== "join";
  el("join-btn").textContent = mode === "create" ? "Host 로 입장" : "입장";
  showJoinError("");
  showCreateError("");
  refreshJoinButton();
}

function formatMeetingId(id) {
  const digits = String(id || "").replace(/\D/g, "");
  return digits.replace(/(\d{3})(?=\d)/g, "$1-");
}

// 초대 링크 주소: 서버 PC 자신이 localhost 로 열었으면 다른 PC 는 그 주소로 올 수 없으니 사내망 주소(LAN_URL)를 쓴다
// (2026-11-18 사용자 보고: 같은 망의 다른 PC 에서 초대 링크를 열면 그 PC 자신의 localhost 가 열림). QR 과 같은 규칙.
function inviteLink(meeting, origin = lanOrigin() || location.origin) {
  return `${origin}/?m=${meeting.id}#pw=${encodeURIComponent(meeting.password)}`;
}

// localhost 로 열었는데 사내망 주소를 모르면(실행기가 LAN 을 못 찾음) 초대 링크는 이 PC 에서만 열린다 — 알린다.
function localOnlyInvite() {
  return isLocalHost() && !state.lanUrl;
}

// --- 외부 참석 링크 (Cloudflare Quick Tunnel) — Host 가 사내망에서만 -------------------
// 사내 주소로 회의를 만들어도, 이 버튼으로 서버가 터널을 열고 «외부용» 초대 링크를 복사한다.

function isTunnelPage() {
  return location.hostname.endsWith(".trycloudflare.com");
}

function refreshTunnelButtons() {
  const host = Boolean(state.me && state.me.is_host) && !isTunnelPage();
  const running = Boolean(state.tunnel && state.tunnel.running);
  el("tunnel-btn").hidden = !host;
  el("tunnel-stop").hidden = !host || !running;
  el("tunnel-btn").textContent = running ? "외부 링크 복사" : "외부 참석 링크";
}

async function onTunnelClick() {
  if (state.tunnel && state.tunnel.running) {
    await copyExternalInvite();
    return;
  }
  el("tunnel-btn").disabled = true;
  el("tunnel-btn").textContent = "외부 주소 여는 중…";
  send({ type: "tunnel", on: true });
}

async function copyExternalInvite() {
  const meeting = state.meeting;
  if (!meeting || !state.tunnel || !state.tunnel.url) return;
  const link = inviteLink(meeting, state.tunnel.url);
  let copied = false;
  try { await navigator.clipboard.writeText(link); copied = true; } catch (error) { copied = false; }
  showMediaStatus(copied
    ? `외부 참석 링크를 복사했습니다 — 외국 참석자에게 보내세요: ${link}`
    : `외부 참석 링크(직접 복사하세요): ${link}`);
}

function onTunnelMessage(message) {
  el("tunnel-btn").disabled = false;
  if (message.starting) {
    el("tunnel-btn").disabled = true;
    el("tunnel-btn").textContent = "외부 주소 여는 중…(최대 40초)";
    return;
  }
  state.tunnel = { running: Boolean(message.running), url: message.url || "" };
  refreshTunnelButtons();
  if (message.error) { showMediaStatus(message.error); return; }
  if (state.tunnel.running) copyExternalInvite();
  else showMediaStatus("외부 공개를 껐습니다 — 외부 참석자는 더 이상 들어올 수 없습니다.");
}

// 초대 링크 (/?m=<ID>#pw=<비밀번호>) 로 열렸으면 참여 화면에 미리 채운다.
// 비밀번호는 # 뒤에 있어 서버 접속 기록에 남지 않는다.
function applyInviteFromUrl() {
  const id = new URLSearchParams(location.search).get("m");
  if (!id) return;
  const pw = new URLSearchParams(location.hash.slice(1)).get("pw") || "";
  setMode("join");
  el("meeting-id").value = formatMeetingId(id);
  el("meeting-pw").value = pw;
  refreshJoinButton();
}

function storeHostToken(meetingId, token) {
  try { sessionStorage.setItem("host:" + meetingId, token); } catch (error) { /* 저장 불가 환경 */ }
}

function loadHostToken(meetingId) {
  if (state.created && state.created.meeting_id === meetingId) return state.created.host_token;
  try { return sessionStorage.getItem("host:" + meetingId) || ""; } catch (error) { return ""; }
}

function showCreateError(message) {
  const node = el("create-error");
  node.textContent = message;
  node.hidden = !message;
}

async function createMeeting() {
  showJoinError("");
  showCreateError("");
  el("create-btn").disabled = true;
  try {
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: el("create-code").value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) {
      // 오류는 «회의 만들기» 버튼 바로 아래에 보여 준다(입장 버튼 밑이면 화면 밖이라 안 보인다).
      showCreateError(data.message || "회의를 만들지 못했습니다.");
      return;
    }
    state.created = data;
    storeHostToken(data.meeting_id, data.host_token);
    el("created-id").textContent = formatMeetingId(data.meeting_id);
    el("created-pw").textContent = data.password;
    el("invite-link").value = inviteLink({ id: data.meeting_id, password: data.password });
    el("created").hidden = false;
    applyCreatePermission();
    refreshJoinButton();
  } catch (error) {
    showCreateError("서버에 연결하지 못했습니다.");
  } finally {
    el("create-btn").disabled = false;
  }
}

async function copyInvite() {
  const meeting = state.meeting || (state.created && { id: state.created.meeting_id, password: state.created.password });
  if (!meeting) return;
  const link = inviteLink(meeting);
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch (error) {
    copied = false;
  }
  const status = el("meeting-view").hidden ? el("preview-status") : el("floor-status");
  status.textContent = (copied ? "초대 링크를 복사했습니다." : `복사하지 못했습니다. 직접 복사하세요: ${link}`)
    + (localOnlyInvite() ? " — 이 PC 의 사내망 주소를 찾지 못해 이 PC 에서만 열립니다(run.bat 으로 서버를 다시 켜 보세요)." : "");
}

function refreshJoinButton() {
  const hasMeeting = state.mode === "create"
    ? Boolean(state.created)
    : el("meeting-id").value.replace(/\D/g, "").length > 0 && el("meeting-pw").value.trim().length > 0;
  const missing = [];
  if (!hasMeeting) missing.push(state.mode === "create" ? "«회의 만들기»로 회의를 먼저 만드세요" : "회의 ID 와 비밀번호를 입력하세요");
  if (el("site-name").value.trim().length === 0) missing.push("지점 이름을 입력하세요");
  if (!el("consent").checked) missing.push("전송 안내에 동의해 주세요");
  el("join-btn").disabled = missing.length > 0;
  // 버튼이 왜 꺼져 있는지 바로 아래에 알려 준다.
  el("join-hint").textContent = missing.join(" · ");
  el("join-hint").hidden = missing.length === 0;
}

function showJoinError(message) {
  const node = el("join-error");
  node.textContent = message;
  node.hidden = !message;
}

// --- WebSocket --------------------------------------------------------

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const meeting = state.mode === "create"
    ? { id: state.created.meeting_id, password: state.created.password }
    : { id: el("meeting-id").value.replace(/\D/g, ""), password: el("meeting-pw").value.trim() };
  state.meeting = meeting;
  state.captionLang = el("site-lang").value;
  prepareTranslators(state.captionLang);

  // 비밀번호·Host 토큰은 URL 에 넣지 않는다(서버 접속 로그·터널에 남는다). 연결 직후 첫 메시지로 보낸다.
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  socket.onopen = () => socket.send(JSON.stringify({
    type: "join",
    meeting: meeting.id,
    password: meeting.password,
    name: el("site-name").value.trim(),
    lang: el("site-lang").value,
    host: loadHostToken(meeting.id),
  }));

  state.closing = false;
  socket.onmessage = (event) => handleMessage(JSON.parse(event.data));
  socket.onclose = () => onSocketClosed(socket);
  socket.onerror = () => { if (!state.me) showJoinError("서버에 연결하지 못했습니다."); };
}

// --- 자동 재연결 (Q14) ------------------------------------------------------
// 회의 중 연결이 끊기면 내 카메라·마이크는 그대로 두고, 30초 안에 1·2·4…초 간격으로 같은 자리로 다시 붙는다.

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

function onSocketClosed(socket) {
  if (socket !== state.socket) return;  // 이미 새 연결로 바뀐 옛 소켓
  if (state.reconnect) {
    scheduleReconnect();
    return;
  }
  if (!state.closing && state.me && state.resumeToken) {
    beginReconnect();
    return;
  }
  stopCaptions("연결이 끊겼습니다");
  teardownMedia();
  if (el("conn-badge")) setBadge(el("conn-badge"), false, "연결 끊김");
}

function beginReconnect() {
  stopCaptions();  // 서버도 끊김과 함께 자막 세션을 끝낸다. 상태 줄은 재연결 안내가 쓴다
  if (state.screen) stopScreenShare();
  dropPeers();
  state.reconnect = { deadline: Date.now() + state.graceSeconds * 1000, attempt: 0, timer: null };
  setBadge(el("conn-badge"), false, "재연결 중");
  scheduleReconnect();
}

function scheduleReconnect() {
  const reconnect = state.reconnect;
  const delay = RECONNECT_DELAYS[Math.min(reconnect.attempt, RECONNECT_DELAYS.length - 1)];
  const left = reconnect.deadline - Date.now();
  if (left <= 0) {
    giveUpReconnect(`${state.graceSeconds}초 안에 다시 연결하지 못했습니다 — 다시 입장하세요.`);
    return;
  }
  el("floor-status").textContent = `연결이 끊겼습니다 — ${Math.ceil(Math.min(delay, left) / 1000)}초 뒤 다시 연결 (남은 ${Math.ceil(left / 1000)}초)`;
  reconnect.timer = setTimeout(attemptReconnect, Math.min(delay, left));
}

function attemptReconnect() {
  const reconnect = state.reconnect;
  if (!reconnect) return;
  reconnect.attempt += 1;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: "resume", meeting: state.roomCode, token: state.resumeToken }));
  socket.onmessage = (event) => handleMessage(JSON.parse(event.data));
  socket.onclose = () => onSocketClosed(socket);
}

function giveUpReconnect(text) {
  if (state.reconnect && state.reconnect.timer) clearTimeout(state.reconnect.timer);
  state.reconnect = null;
  state.closing = true;
  state.resumeToken = "";
  if (state.socket) state.socket.close();
  teardownMedia();
  state.me = null;
  el("meeting-view").hidden = true;
  el("join-view").hidden = false;
  document.title = "회의 입장 — VisionMeeting";
  showJoinError(text);
}

// 다시 붙었을 때: 내 카메라는 그대로, 연결(메시)만 새로 만들고 먼저 와 있던 지점에 다시 건다.
function resumeMeeting(peers) {
  if (state.reconnect && state.reconnect.timer) clearTimeout(state.reconnect.timer);
  state.reconnect = null;
  setBadge(el("conn-badge"), true, "연결됨");
  el("host-controls").hidden = !state.me.is_host;
  syncRelayQuota();
  el("transcript").innerHTML = "";
  clearInterim();
  state.entries.forEach(renderEntry);
  el("floor-status").textContent = "다시 연결됐습니다";
  send({ type: "media_state", cam: state.media.camOn && Boolean(state.local.video), mic: state.media.micOn && Boolean(state.local.audio) });
  createMeshForMe();
  for (const peer of peers) {
    state.mesh.call(peer.id, peer.kind).catch((error) => console.warn("[rtc] 재연결 실패", error));
  }
  syncPeers(state.people);
  startCaptions();  // 서버는 끊길 때 자막 세션을 끝냈으므로 다시 켠다
}

// 상대 연결과 타일만 정리한다(내 카메라·마이크·내 타일은 그대로).
function dropPeers() {
  if (state.mesh) state.mesh.closeAll();
  state.mesh = null;
  state.rtcQueue = [];
  state.peerStates = {};
  for (const tile of [...el("video-grid").querySelectorAll(".tile")]) {
    if (tile.dataset.id !== "me") tile.remove();
  }
}

function send(payload) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function handleMessage(message) {
  switch (message.type) {
    case "welcome":
      state.me = message.you;
      state.resumeToken = message.resume_token || "";
      state.tunnel = message.tunnel || null;
      state.graceSeconds = message.reconnect_grace_seconds || 30;
      state.summary = message.summary || null;
      state.roomCode = message.room.code;
      state.entries = message.transcript.slice();
      state.iceServers = message.ice_servers || [];
      state.relay = message.relay || null;
      if (message.resumed && state.reconnect) resumeMeeting(message.peers || []);
      else enterMeeting(message.peers || []);
      break;

    case "participants":
      renderParticipants(message.list);
      syncPeers(message.list);
      break;

    case "rtc_offer":
    case "rtc_answer":
    case "rtc_ice":
      // 내 카메라를 여는 동안(메시 생성 전) 온 연결 신호는 버리지 않고 모아 뒀다가 처리한다.
      if (state.mesh) state.mesh.handle(message);
      else state.rtcQueue.push(message);
      break;

    case "camera_pair":
      showCameraQr(message);
      break;

    case "camera_pair_failed":
      showCameraQrError(message.message);
      break;

    case "screen_share":
      if (message.on) startSendingScreen();
      break;

    case "tunnel":
      onTunnelMessage(message);
      break;

    case "relay_quota":
      showRelayQuota(message);
      break;

    case "relay_config":
      onRelayConfig(message);
      break;

    case "vl_context":
      showVisionContext(message);
      break;

    case "screen_share_denied":
      dropPendingScreen();
      showMediaStatus(message.message);
      break;

    case "interim":
      renderInterim(message);
      break;

    case "final":
      state.entries.push(message.entry);
      clearInterim(message.entry.speaker_id);
      renderEntry(message.entry, true);
      break;

    case "summary":
      state.summaries = message.texts;
      state.summaryEngine = message.engine || "";
      state.summaryErrors = message.errors || {};
      if (!state.summaries[state.summaryLang]) state.summaryLang = state.captionLang;
      if (!state.summaries[state.summaryLang]) state.summaryLang = Object.keys(state.summaries)[0];
      renderSummaryTabs();
      showSummary(state.summaryLang);
      el("summary-meta").textContent = `${state.entries.length}건 기준 · 정리 엔진: ${state.summaryEngine}`;
      el("summarize").disabled = false;
      break;

    case "summary_failed":
      // 다른 엔진으로 자동 전환하지 않는다(Q18) — 이유만 보이고 Host 가 다시 고른다.
      showSummaryNotice(`회의 정리 실패${message.engine ? ` (${message.engine})` : ""}: ${message.message}`);
      el("summarize").disabled = false;
      break;

    case "host_changed":
      // 이전 Host 가 30초 넘게 돌아오지 않아 Host 를 넘겨받았다(Q15).
      state.me = message.you;
      el("host-controls").hidden = false;
      refreshTunnelButtons();
      syncRelayQuota();
      // 발언 상태 줄은 곧 이어 오는 참가자 목록 갱신이 덮으므로, 덮이지 않는 안내 줄에 남긴다.
      showMediaStatus("이전 Host 가 30초 넘게 돌아오지 않아 이 지점이 Host 권한을 넘겨받았습니다");
      break;

    case "room_closed":
      state.closing = true;
      stopCaptions("회의가 종료되었습니다");
      teardownMedia();
      alert("Host 가 회의를 종료했습니다. 자막은 서버에서 삭제되었습니다.");
      if (state.socket) state.socket.close();
      break;

    case "error":
      if (message.fatal && state.reconnect) { giveUpReconnect(message.message); break; }
      if (message.fatal) state.closing = true;
      if (message.fatal) showJoinError(message.message);
      else el("floor-status").textContent = message.message;
      break;
  }
}

// --- 회의 화면 --------------------------------------------------------

async function enterMeeting(peers) {
  stopPreview();
  el("join-view").hidden = true;
  el("meeting-view").hidden = false;
  document.title = `회의 ${formatMeetingId(state.roomCode)} — VisionMeeting`;
  el("room-code").textContent = formatMeetingId(state.roomCode);
  setBadge(el("conn-badge"), true, "연결됨");
  applyCaptionStatus();
  el("host-controls").hidden = !state.me.is_host;
  refreshTunnelButtons();
  syncRelayQuota();
  applySummaryStatus(state.summary);

  el("transcript").innerHTML = "";
  clearInterim();
  state.entries.forEach(renderEntry);

  // 영상: 내 카메라·마이크를 연 뒤, 먼저 와 있던 참가자 각각에게 연결을 건다(나중에 온 쪽이 offer).
  await startLocalMedia();
  createMeshForMe();
  // 내 중계(TURN) 사용량을 30초마다 서버에 보고한다 — 서버가 회의별로 합산해 기록(Q3·Q4).
  state.relayTimer = setInterval(() => {
    const bytes = state.mesh ? state.mesh.takeRelayBytes() : 0;
    if (bytes > 0) send({ type: "relay_usage", bytes });
  }, RELAY_REPORT_MS);
  for (const peer of peers) {
    state.mesh.call(peer.id, peer.kind).catch((error) => console.warn("[rtc] 연결 시작 실패", error));
  }
  startSpeakerMeter();
  syncPeers(state.people);
  startCaptions();  // Q32: 버튼 없이 자동 자막 — 소리 분석기(메아리 막기)가 준비된 뒤에 켠다
}

function createMeshForMe() {
  state.mesh = createMesh({
    myKind: "site",
    send,
    // 화면 공유 중에 들어온 지점도 카메라 대신 공유 화면을 받는다(Q27).
    localTrack: (media) => (media === "video" && state.screen) || state.local[media],
    onTrack: attachRemote,
    onState: (id, connection) => { state.peerStates[id] = connection; refreshTile(id); },
    onRelay: (id) => refreshTile(id),
    iceServers: state.iceServers,
  });
  applyRelayStatus(state.relay);
  for (const message of state.rtcQueue.splice(0)) state.mesh.handle(message);
}

function renderParticipants(list) {
  const sites = list.filter((person) => person.kind !== "camera").length;
  el("participant-count").textContent = `접속 ${sites}곳 / 최대 ${state.limits.max_sites || 4}곳`;
  const container = el("participants");
  container.innerHTML = "";
  for (const person of list) {
    const item = document.createElement("li");
    item.textContent = person.kind === "camera"
      ? person.name
      : `${person.name} · ${labelOf(person.speak_lang)}` + (person.is_host ? " (Host)" : "") + (person.away ? " (재연결 중)" : "");
    container.appendChild(item);
    // 마이크를 끈(또는 끊긴) 지점의 «말하는 중» 줄은 바로 지운다 — 끈 뒤에도 그 지점 자막이 떠 있는 것처럼 보이지 않게.
    if (!person.mic || person.away) clearInterim(person.id);
  }
}

// --- 회의 정리 (Host) --------------------------------------------------

// 회의 정리 엔진(Q18): Claude Code·Codex(EXAONE 은 Q33 으로 제거). 준비 안 된 엔진은 사유와 함께 비활성, 기본은 서버 설정(Claude Code).
function applySummaryStatus(status) {
  const select = el("summary-engine");
  const engines = (status && status.engines) || [];
  const previous = select.value;
  select.innerHTML = "";
  for (const engine of engines) {
    const option = document.createElement("option");
    option.value = engine.id;
    const ready = engine.state === "configured";
    option.textContent = ready ? `${engine.label} (→ ${engine.sends_to})` : `${engine.label} — 준비 안 됨`;
    option.disabled = !ready;
    option.title = ready ? `자막이 ${engine.sends_to} 로 전송됩니다` : engine.reason;
    select.appendChild(option);
  }
  const ready = engines.filter((engine) => engine.state === "configured");
  const preferred = [previous, status && status.default].find((id) => ready.some((engine) => engine.id === id));
  if (preferred) select.value = preferred;
  else if (ready.length) select.value = ready[0].id;  // 기본 엔진이 준비 안 됐으면 준비된 첫 엔진을 «보여만» 준다(자동 실행 없음)
  refreshSummaryButton();
}

function refreshSummaryButton() {
  const select = el("summary-engine");
  const engines = (state.summary && state.summary.engines) || [];
  const chosen = engines.find((engine) => engine.id === select.value);
  const ok = Boolean(chosen && chosen.state === "configured");
  el("summarize").disabled = !ok;
  el("summarize").title = ok ? `지금까지의 자막을 ${chosen.label} 로 정리합니다`
    : engines.map((engine) => `${engine.label}: ${engine.reason || "준비됨"}`).join("\n");
}

function showSummaryNotice(text) {
  const body = el("summary-body");
  body.innerHTML = "";
  const node = document.createElement("p");
  node.className = "pending";
  node.textContent = text;
  body.appendChild(node);
  el("summary-panel").hidden = false;
}

// 언어 탭: 성공한 언어는 전환 버튼, 실패한 언어는 사유를 제목으로 단 비활성 버튼.
function renderSummaryTabs() {
  const tabs = el("summary-tabs");
  tabs.innerHTML = "";
  // 이번 정리에서 요청된 언어(참석 지점 언어, Q12)만 — 만든 언어는 전환 버튼, 실패한 언어는 사유를 단 비활성 버튼.
  const requested = state.languages.filter((lang) => state.summaries[lang.code] || (state.summaryErrors || {})[lang.code]);
  for (const lang of requested) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = lang.label;
    if (state.summaries[lang.code]) {
      button.classList.toggle("active", lang.code === state.summaryLang);
      button.addEventListener("click", () => showSummary(lang.code));
    } else {
      button.disabled = true;
      button.title = (state.summaryErrors && state.summaryErrors[lang.code]) || "";
    }
    tabs.appendChild(button);
  }
}

function showSummary(code) {
  state.summaryLang = code;
  for (const button of el("summary-tabs").children) {
    button.classList.toggle("active", button.textContent === labelOf(code));
  }
  renderSummary(state.summaries[code] || "");
}

function labelOf(code) {
  const found = state.languages.find((lang) => lang.code === code);
  return found ? found.label : code;
}

// Provider 가 돌려준 «## 제목 / - 항목» 텍스트를 제목·목록으로 그린다. HTML 은 만들지 않는다.
function renderSummary(text) {
  const body = el("summary-body");
  body.innerHTML = "";
  let list = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      list = null;
      const heading = document.createElement("h3");
      heading.textContent = line.slice(3).trim();
      body.appendChild(heading);
    } else if (line.startsWith("- ")) {
      if (!list) { list = document.createElement("ul"); body.appendChild(list); }
      const item = document.createElement("li");
      item.textContent = line.slice(2).trim();
      list.appendChild(item);
    } else {
      list = null;
      const para = document.createElement("p");
      para.textContent = line;
      body.appendChild(para);
    }
  }
  el("summary-panel").hidden = false;
}

function requestSummary() {
  if (state.entries.length === 0) {
    el("floor-status").textContent = "정리할 자막이 아직 없습니다.";
    return;
  }
  el("summarize").disabled = true;
  el("summary-tabs").innerHTML = "";
  el("summary-meta").textContent = "";
  const select = el("summary-engine");
  const engine = ((state.summary && state.summary.engines) || []).find((e) => e.id === select.value);
  showSummaryNotice(`자막 ${state.entries.length}건을 ${engine ? engine.label : ""}로 참석 지점 언어로 정리하는 중… `
    + `(자막은 ${engine ? engine.sends_to : "선택한 엔진의 회사"} 로 전송, 수십 초~몇 분 걸릴 수 있습니다)`);
  send({ type: "summarize", engine: select.value });
}

async function exportDocx() {
  const response = await fetch("/api/export/docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room: state.roomCode,
      caption_lang: state.captionLang,
      entries: state.entries,
      summaries: state.summaries,
      engine: state.summaryEngine,
    }),
  });
  if (!response.ok) {
    el("floor-status").textContent = "DOCX 생성에 실패했습니다.";
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `meeting-${state.roomCode}.docx`;
  link.click();
  URL.revokeObjectURL(url);
}

function captionText(entry) {
  return entry.translations[state.captionLang] || entry.original;
}

// 자막 한 줄. 내 언어가 아니면 이 브라우저에서 번역해 채운다(Q29). 번역 결과는 내보내기에도 쓰도록 entry 에 둔다.
// live = 지금 막 도착한 자막(입장·재연결 때 다시 그리는 지난 자막은 읽지 않는다)
function renderEntry(entry, live = false) {
  const node = document.createElement("article");
  node.className = "entry";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${entry.speaker} · ${entry.time_kst} KST`;

  const translated = document.createElement("div");
  translated.className = "translated";

  node.appendChild(meta);
  node.appendChild(translated);

  const mine = state.captionLang;
  if (entry.translations[mine] || entry.source_lang === mine) {
    translated.textContent = captionText(entry);
  } else {
    translated.textContent = "번역 중…";
    translated.classList.add("pending");
    const from = languageOf(entry.source_lang);
    const to = languageOf(mine);
    translateText(entry.original, from ? from.translate_code : entry.source_lang, to ? to.translate_code : mine)
      .then((result) => {
        translated.classList.remove("pending");
        if (result.text) {
          entry.translations[mine] = result.text;
          translated.textContent = result.text;
          if (live) speakTranslation(result.text);
        } else {
          // 가짜 번역을 만들지 않는다 — 원문 아래에 이유를 보인다.
          translated.textContent = `번역 불가 — ${result.error}`;
          translated.classList.add("failed");
        }
      });
  }

  if (entry.source_lang !== mine) {
    const original = document.createElement("div");
    original.className = "original";
    original.textContent = entry.original;
    node.appendChild(original);
  }

  const list = el("transcript");
  list.appendChild(node);
  list.scrollTop = list.scrollHeight;
}

// 말하는 중인 문장은 지점마다 한 줄(Q32: 여러 지점이 동시에 말할 수 있다). 원문 그대로 보이고, 확정되면 번역해 기록에 올린다.
// 확정이 오지 않은 채 멈춘 줄(내 목소리가 아니라 버려진 결과 등)은 잠시 뒤 지운다.
const INTERIM_STALE_MS = 6000;

function renderInterim(message) {
  const box = el("interim");
  box.hidden = false;
  let line = state.interims.get(message.speaker_id);
  if (!line) {
    line = { node: document.createElement("div"), timer: null };
    line.node.className = "interim-line";
    box.appendChild(line.node);
    state.interims.set(message.speaker_id, line);
  }
  line.node.textContent = `${message.speaker} · ${message.text}`;
  clearTimeout(line.timer);
  line.timer = setTimeout(() => clearInterim(message.speaker_id), INTERIM_STALE_MS);
}

// 한 지점의 줄을 지운다. id 가 없으면 전부 지운다.
function clearInterim(speakerId) {
  for (const [id, line] of [...state.interims]) {
    if (speakerId !== undefined && id !== speakerId) continue;
    clearTimeout(line.timer);
    line.node.remove();
    state.interims.delete(id);
  }
  el("interim").hidden = state.interims.size === 0;
}

// 원인 확인용: 브라우저 인식이 몇 번 다시 시작됐는지·오류가 있었는지(2026-11-11 «다음 문장 인식 안 됨» 보고).
function dictationNote(d) {
  if (!d) return "";
  const parts = [`인식 세션 ${d.sessions}회`];
  if (d.rescued) parts.push(`끊긴 문장 살림 ${d.rescued}`);
  if (d.retries) parts.push(`재시작 재시도 ${d.retries}`);
  if (d.watchdog) parts.push(`멈춤 감지 후 재시작 ${d.watchdog}`);
  if (d.trackFallback) parts.push("기본 마이크로 전환");
  if (d.errors.length) parts.push(`오류 ${[...new Set(d.errors)].join(",")}`);
  return ` (${parts.join(" · ")})`;
}

// --- 번역 음성(브라우저 TTS) + 원음 줄이기 — 8단계, Q11 -----------------------------
const DUCK_VOLUME = 0.25;  // 번역 음성이 나오는 동안 상대 원음 볼륨

function myVoiceCode() {
  const mine = languageOf(state.captionLang);
  return mine ? mine.translate_code : state.captionLang;
}

async function toggleTts() {
  state.tts = !state.tts;
  const button = el("tts-btn");
  button.setAttribute("aria-pressed", String(state.tts));
  if (!state.tts) {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    state.ttsSpeaking = 0;
    setRemoteVolume(1);
    button.textContent = "번역 음성: 꺼짐";
    showMediaStatus("");
    return;
  }
  await voicesReady();
  const voice = voiceFor(myVoiceCode());
  button.textContent = voice ? "번역 음성: 켜짐" : "번역 음성: 켜짐 (음성 없음)";
  // 음성이 없으면 다른 언어 음성으로 대신 읽지 않고 이유를 보인다.
  showMediaStatus(voice ? "" : `이 PC 의 브라우저에는 ${labelOf(state.captionLang)} 음성이 없어 번역 음성을 읽을 수 없습니다 — 자막만 표시합니다`);
}

function speakTranslation(text) {
  if (!state.tts || state.speakerOff) return;  // 스피커를 끄면 번역 음성도 읽지 않는다(Q32)
  speakText(text, myVoiceCode(), {
    onStart: () => { state.ttsSpeaking += 1; setRemoteVolume(DUCK_VOLUME); },
    onEnd: () => {
      state.ttsSpeaking = Math.max(0, state.ttsSpeaking - 1);
      if (state.ttsSpeaking === 0) setRemoteVolume(1);
    },
  });
}

// 상대 지점 영상(원음) 볼륨. 내 타일은 원래 음소거라 건드리지 않는다.
function setRemoteVolume(volume) {
  for (const tile of el("video-grid").querySelectorAll(".tile")) {
    if (tile.dataset.id !== "me") tile.querySelector("video").volume = volume;
  }
}

// --- 스피커 끄기 (Q32) ---------------------------------------------------
// 상대 지점의 원음과 번역 음성을 이 PC 에서 끈다. 자막은 계속 보인다. 소리 크기 분석(말하는 사람 크게)은 영향 없음.
function toggleSpeaker() {
  state.speakerOff = !state.speakerOff;
  const button = el("speaker-toggle");
  button.setAttribute("aria-pressed", String(!state.speakerOff));
  setToggleLabel(button, state.speakerOff ? "스피커 꺼짐" : "스피커 켜짐", state.speakerOff ? "#i-volume-x" : "#i-volume-2");
  for (const tile of el("video-grid").querySelectorAll(".tile")) {
    if (tile.dataset.id !== "me") tile.querySelector("video").muted = state.speakerOff;
  }
  if (state.speakerOff && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    state.ttsSpeaking = 0;
    setRemoteVolume(1);
  }
}

// 아이콘이 든 큰 버튼은 글자(span)·아이콘만 바꾸고, 글자만 있는 버튼은 통째로 바꾼다.
function setToggleLabel(button, text, icon) {
  const label = button.querySelector("span");
  if (!label) { button.textContent = text; return; }
  label.textContent = text;
  if (icon) button.querySelector("use").setAttribute("href", icon);
}

// --- 자동 자막: 브라우저 음성 인식 (Q29·Q32) ---------------------------------
// 마이크가 켜져 있으면 버튼 없이 이 지점의 말을 계속 글자로 바꿔 보낸다. 마이크를 끄면 인식도 멈춘다(음성 인식 서비스로 보내지 않음).
// 음성은 서버로 보내지 않는다. 이 브라우저가 글자로 바꾼 결과만 서버가 모두에게 전한다.
const VOICE_GATE_MS = 3000;    // 회의 마이크(에코 제거)에서 내 목소리가 들린 뒤 이 시간 안의 인식만 보낸다(메아리 막기)
const ZERO_WARN_VOICE_S = 5;   // 목소리가 이만큼 있었는데 인식 0문장이면 경고

// 회의 마이크(에코 제거된 트랙)의 지금 소리 크기 — «결과 없음» 감시와 메아리 막기에 쓴다.
function micLevel() {
  const source = state.meter && state.media.micOn ? meterSource("me", state.local.audio) : null;
  return source ? levelOf(source) : 0;
}

// 인식 0건을 성공처럼 보이지 않는다(마이크를 다시 켜기 전까지 상태 줄에 남는다).
function zeroWarning(stats) {
  if (!stats || stats.finals > 0 || stats.voice < ZERO_WARN_VOICE_S) return "";
  return `목소리 ${stats.voice}초에 인식된 문장 0건 — 말하는 언어(지점 언어)·인터넷을 확인하세요${dictationNote(stats)}`;
}

function captionNote(stats) {
  const parts = [`자동 자막 켜짐 · 인식 ${stats.finals}문장`];
  if (stats.dropped) parts.push(`내 마이크에 목소리가 없어 버린 결과 ${stats.dropped}건(스피커 소리로 판단)`);
  const warning = zeroWarning(stats);
  if (warning) parts.push(warning);
  return parts.join(" · ");
}

// 같은 안내를 1초마다 다시 쓰지 않는다 — 그 사이 상태 줄에 뜬 다른 안내(정리 실패 등)를 덮지 않게.
function showCaptionNote(text, force = false) {
  if (!force && text === state.captionNote) return;
  state.captionNote = text;
  el("floor-status").textContent = text;
}

function startCaptions() {
  if (state.dictation || !state.me || !state.mesh) return;
  if (state.captionStopping) {  // 끄는 중(마지막 문장 확정 대기)이면 끝난 뒤 다시 켠다 — 서버 세션이 엇갈리지 않게
    state.captionStopping.then(startCaptions);
    return;
  }
  const check = state.captionCheck;
  if (!check) {
    showCaptionNote("자동 자막: 이 브라우저의 음성 인식 지원을 확인하는 중…", true);
    return;
  }
  if (!check.recognition.ok) {
    showCaptionNote(`자동 자막 꺼짐 — ${check.recognition.reason} (원음 대화와 다른 지점 자막은 됩니다)`, true);
    return;
  }
  if (!state.local.audio || !state.media.micOn) {
    showCaptionNote(state.local.audio ? "마이크 꺼짐 — 이 지점의 자동 자막도 멈춤 (다른 지점 자막은 계속 보입니다)"
                                      : "마이크가 없어 이 지점의 자동 자막을 켤 수 없습니다", true);
    return;
  }
  const lang = languageOf(state.captionLang);
  send({ type: "caption_start" });  // 서버는 이 요청을 먼저 처리하므로 뒤따르는 자막이 받아진다
  const dictation = startDictation({
    locale: lang ? lang.speech_locale : "ko-KR",
    // 회의 마이크 트랙을 인식에 직접 넘기면(start(track)) 첫 문장 뒤 멈추는 증상이 있어 기본 마이크 방식으로 인식한다
    // (2026-11-11 사용자 실기). 대신 회의 마이크 소리 크기로 «결과 없음» 감시·메아리 막기를 한다.
    track: null,
    levelProbe: state.meter ? micLevel : null,  // 소리 분석을 못 하면 메아리 막기 없이 인식한다
    voiceGateMs: VOICE_GATE_MS,
    onInterim: (text) => send({ type: "caption", text, final: false }),
    onFinal: (text) => send({ type: "caption", text, final: true }),
    // 시작하자마자 실패하면 이 함수가 끝나기 전에 불릴 수 있어, 한 박자 뒤에 끈다.
    onError: (message) => setTimeout(() => { if (state.dictation === dictation) stopCaptions(`자동 자막 멈춤 — ${message}`); }, 0),
  });
  state.dictation = dictation;
  showCaptionNote(captionNote(dictation.stats), true);
  state.captionTimer = setInterval(() => showCaptionNote(captionNote(dictation.stats)), 1000);
}

// 자동 자막을 끈다(마이크 끔·오류·연결 끊김·회의 종료).
// discard = 마이크 끔: 누른 순간부터 결과를 버리고 바로 서버에 알린다(끈 뒤에 이 지점 이름으로 자막이 올라오지 않게, 2026-11-13 사용자 보고).
// 그 밖에는 마지막 문장이 확정되도록 잠깐(최대 1.5초) 기다린 뒤 알린다.
function stopCaptions(statusText = "", discard = false) {
  const dictation = state.dictation;
  state.dictation = null;
  clearInterval(state.captionTimer);
  state.captionTimer = null;
  if (!dictation) {
    if (statusText) showCaptionNote(statusText, true);
    return Promise.resolve();
  }
  const stopping = (async () => {
    const ended = dictation.stop({ discard });
    if (!discard) await ended;
    send({ type: "caption_stop", dictation: dictation.stats });
    const note = [statusText, zeroWarning(dictation.stats)].filter(Boolean).join(" · ");
    if (note) showCaptionNote(note, true);
    await ended;  // 다시 켤 때는 앞 인식이 완전히 끝난 뒤 시작한다
    if (state.captionStopping === stopping) state.captionStopping = null;
  })();
  state.captionStopping = stopping;
  return stopping;
}

// --- Host 내보내기 ----------------------------------------------------

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportTxt() {
  const lines = state.entries.map(
    (entry) => `[${entry.time_kst} KST] ${entry.speaker}\n  원문: ${entry.original}\n  번역: ${captionText(entry)}`
  );
  download(`meeting-${state.roomCode}.txt`, lines.join("\n\n"), "text/plain;charset=utf-8");
}

function exportJson() {
  download(
    `meeting-${state.roomCode}.json`,
    JSON.stringify({ room: state.roomCode, entries: state.entries }, null, 2),
    "application/json;charset=utf-8"
  );
}

// --- 장치 미리보기 ----------------------------------------------------

function stopPreview() {
  const preview = state.preview;
  if (!preview) return;
  cancelAnimationFrame(preview.raf);
  preview.stream.getTracks().forEach((track) => track.stop());
  if (preview.context) preview.context.close();
  el("preview-video").srcObject = null;
  el("mic-meter").style.width = "0%";
  state.preview = null;
}

function fillDevices(select, devices, chosenId, emptyLabel) {
  select.innerHTML = "";
  if (devices.length === 0) {
    const option = document.createElement("option");
    option.textContent = emptyLabel;
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `장치 ${index + 1}`;
    select.appendChild(option);
  });
  select.disabled = false;
  if (chosenId && devices.some((device) => device.deviceId === chosenId)) select.value = chosenId;
}

// --- 카메라 고르기 -------------------------------------------------------
// Windows 기본 카메라가 휴대폰 «연결된 카메라»(Windows Virtual Camera)이면 열 때 오래 멈춘다(Q23 실측).
// 그래서 ① 사용자가 마지막으로 고른 카메라 ② PC 카메라 ③ 브라우저 기본 순으로 연다.
const CAMERA_KEY = "translator-camera";
const CAMERA_TIMEOUT_MS = 6000;

function savedCameraId() {
  try { return localStorage.getItem(CAMERA_KEY) || ""; } catch { return ""; }
}

function saveCameraId(cameraId) {
  try { if (cameraId) localStorage.setItem(CAMERA_KEY, cameraId); } catch { /* 저장 못 해도 동작에는 지장 없음 */ }
}

// Chrome·Edge 는 USB 카메라 이름 끝에 «(1bcf:2d07)» 같은 장치 번호를 붙인다. 가상 카메라에는 없다.
function isPcCamera(deviceOrTrack) {
  return /\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i.test(deviceOrTrack.label || "");
}

// 휴대폰 «연결된 카메라» 이름 예: «강민의 Z Fold6 (Windows 가상 카메라)» (2026-11-11 실측)
function isVirtualCamera(device) {
  return /가상|virtual/i.test(device.label || "");
}

// 목록에서 기본으로 쓸 카메라: 저장된 선택 → PC(USB) 카메라 → 가상이 아닌 카메라. 이름을 모르면 "".
function pickCamera(cameras) {
  const known = cameras.filter((device) => device.deviceId);
  const saved = savedCameraId();
  if (saved && known.some((device) => device.deviceId === saved)) return saved;
  const pc = known.find(isPcCamera) || known.find((device) => device.label && !isVirtualCamera(device));
  return pc ? pc.deviceId : "";
}

async function preferredCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return pickCamera(devices.filter((device) => device.kind === "videoinput"));
}

// 권한을 묻는 동안은 재지 않고, 허용된 뒤부터 6초를 잰다.
function cameraTimeout() {
  return new Promise((_, reject) => {
    const start = () => setTimeout(() => reject(new DOMException("camera timeout", "TimeoutError")), CAMERA_TIMEOUT_MS);
    navigator.permissions.query({ name: "camera" }).then((status) => {
      if (status.state === "granted") start();
      else status.onchange = () => { if (status.state === "granted") start(); };
    }).catch(() => { /* 권한 조회를 못 하는 브라우저는 시간 제한 없이 기다린다 */ });
  });
}

async function getCameraTrack(cameraId) {
  const opening = navigator.mediaDevices.getUserMedia({ video: videoConstraints(cameraId) });
  try {
    const stream = await Promise.race([opening, cameraTimeout()]);
    return stream.getVideoTracks()[0];
  } catch (error) {
    // 늦게 열리면 바로 닫는다(카메라를 쥔 채 남지 않게).
    if (error.name === "TimeoutError") opening.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    throw error;
  }
}

async function openCamera(cameraId) {
  const wanted = cameraId || await preferredCameraId();
  let track;
  try {
    track = await getCameraTrack(wanted);
  } catch (error) {
    // 처음 열 때는 권한 전이라 장치 이름을 몰라 기본 카메라를 연다. 그게 멈추면 PC 카메라로 다시 연다.
    const better = cameraId ? "" : await preferredCameraId();
    if (error.name !== "TimeoutError" || !better || better === wanted) throw error;
    return getCameraTrack(better);
  }
  if (!cameraId && !isPcCamera(track)) {
    const better = await preferredCameraId();
    if (better && better !== track.getSettings().deviceId) {
      track.stop();
      track = await getCameraTrack(better);
    }
  }
  return track;
}

// 카메라와 마이크를 따로 연다. 카메라가 실패해도 마이크로는 참여할 수 있게 한다.
async function openMedia(cameraId, micId) {
  const result = { video: null, audio: null, videoError: "", audioError: "" };
  try {
    result.video = (await openCamera(cameraId)) || null;
  } catch (error) {
    result.videoError = error.name;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(micId) });
    result.audio = stream.getAudioTracks()[0] || null;
  } catch (error) {
    result.audioError = error.name;
  }
  return result;
}

function videoConstraints(cameraId) {
  return { ...(cameraId ? { deviceId: { exact: cameraId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } };
}

function audioConstraints(micId) {
  return { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true };
}

function mediaResultText(result) {
  const parts = [];
  parts.push(result.video
    ? "카메라 영상 수신 중 — 화면이 안 보이면 노트북의 카메라 차단 키를 확인하세요"
    : result.videoError === "TimeoutError"
      ? `카메라가 ${CAMERA_TIMEOUT_MS / 1000}초 동안 응답하지 않습니다 — 목록에서 다른 카메라를 고르세요. 마이크만으로도 참여할 수 있습니다`
      : `카메라를 열지 못했습니다(${result.videoError || "장치 없음"}) — 마이크만으로 참여할 수 있습니다`);
  parts.push(result.audio
    ? "마이크 확인됨 — 말하면 막대가 움직입니다"
    : `마이크를 열지 못했습니다(${result.audioError || "장치 없음"}) — 브라우저 권한과 다른 앱의 사용 여부를 확인하세요`);
  return parts.join(" · ");
}

async function startPreview() {
  stopPreview();
  const status = el("preview-status");
  status.textContent = "장치를 여는 중…";
  const media = state.media;
  const result = await openMedia(media.cameraId, media.micId);
  const videoTrack = result.video;
  const audioTrack = result.audio;
  status.textContent = mediaResultText(result);
  if (!videoTrack && !audioTrack) return;
  const stream = new MediaStream([videoTrack, audioTrack].filter(Boolean));

  media.cameraId = videoTrack ? videoTrack.getSettings().deviceId || "" : media.cameraId;
  media.micId = audioTrack ? audioTrack.getSettings().deviceId || "" : media.micId;
  if (videoTrack) videoTrack.enabled = media.camOn;
  if (audioTrack) audioTrack.enabled = media.micOn;

  el("preview-video").srcObject = stream;
  el("preview-empty").hidden = Boolean(videoTrack);

  // 권한을 받은 뒤에야 장치 이름이 보이므로 여기서 목록을 채운다.
  await refreshDevices();

  const preview = { stream, context: null, raf: 0 };
  state.preview = preview;
  if (audioTrack) {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    preview.context = context;
    const draw = () => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
      el("mic-meter").style.width = `${Math.min(100, Math.round((peak / 128) * 100))}%`;
      preview.raf = requestAnimationFrame(draw);
    };
    draw();
  }
  el("preview-btn").textContent = "다시 확인";
}

// 입장 화면과 회의 화면의 장치 목록을 함께 갱신한다. 장치를 꽂거나 뺄 때(devicechange)도 부른다.
async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  // 아직 카메라를 열지 않았으면 맨 위(휴대폰 가상 카메라일 수 있음) 대신 PC 카메라를 기본으로 보인다.
  if (!state.media.cameraId) state.media.cameraId = pickCamera(cameras);
  for (const id of ["camera-select", "meet-camera"]) fillDevices(el(id), cameras, state.media.cameraId, "카메라 없음");
  for (const id of ["mic-select", "meet-mic"]) fillDevices(el(id), mics, state.media.micId, "마이크 없음");
}

function toggleMedia(kind) {
  const media = state.media;
  if (kind === "cam") media.camOn = !media.camOn;
  else media.micOn = !media.micOn;
  const on = kind === "cam" ? media.camOn : media.micOn;
  const ids = kind === "cam" ? ["cam-toggle", "meet-cam-toggle"] : ["mic-toggle", "meet-mic-toggle"];
  for (const id of ids) {
    el(id).setAttribute("aria-pressed", String(on));
    setToggleLabel(el(id), `${kind === "cam" ? "카메라" : "마이크"} ${on ? "켜짐" : "꺼짐"}`,
                   kind === "mic" ? (on ? "#i-mic" : "#i-mic-off") : null);
  }
  if (state.preview) {
    const tracks = kind === "cam" ? state.preview.stream.getVideoTracks() : state.preview.stream.getAudioTracks();
    tracks.forEach((track) => { track.enabled = on; });
  }
  const track = state.local[kind === "cam" ? "video" : "audio"];
  if (track) track.enabled = on;
  if (state.mesh) {
    send({ type: "media_state", cam: media.camOn, mic: media.micOn });
    refreshTile("me");
    // Q32: 마이크를 끄면 자동 자막(음성 인식 서비스 전송)도 멈추고, 켜면 다시 시작한다.
    if (kind === "mic" && media.micOn) startCaptions();
    else if (kind === "mic") stopCaptions("마이크 꺼짐 — 이 지점의 자동 자막도 멈춤 (다른 지점 자막은 계속 보입니다)", true);
  }
}

// --- 회의 중 영상 ------------------------------------------------------

function showMediaStatus(text) {
  const node = el("media-status");
  node.textContent = text;
  node.hidden = !text;
}

async function startLocalMedia() {
  const result = await openMedia(state.media.cameraId, state.media.micId);
  state.local = { video: result.video, audio: result.audio };
  for (const media of ["video", "audio"]) {
    const track = state.local[media];
    if (!track) continue;
    track.enabled = media === "video" ? state.media.camOn : state.media.micOn;
    if (media === "video") state.media.cameraId = track.getSettings().deviceId || state.media.cameraId;
    else state.media.micId = track.getSettings().deviceId || state.media.micId;
    watchTrack(media, track);
  }
  showMediaStatus(result.video && result.audio ? "" : mediaResultText(result));
  const tile = ensureTile("me");
  tile.querySelector("video").srcObject = new MediaStream([result.video].filter(Boolean));
  refreshTile("me");
  send({ type: "media_state", cam: state.media.camOn && Boolean(result.video), mic: state.media.micOn && Boolean(result.audio) });
  await refreshDevices().catch(() => {});
}

function watchTrack(media, track) {
  track.onended = () => {
    if (state.local[media] !== track) return;
    showMediaStatus(`${media === "video" ? "카메라" : "마이크"} 연결이 끊겼습니다 — 목록에서 다른 장치를 고르세요.`);
    refreshDevices().catch(() => {});
  };
}

// 회의 중 장치 전환: 연결을 끊지 않고 보내는 트랙만 바꾼다(replaceTrack, Q23).
async function switchDevice(media, deviceId) {
  const label = media === "video" ? "카메라" : "마이크";
  let track;
  try {
    track = media === "video"
      ? await getCameraTrack(deviceId)
      : (await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) })).getTracks()[0];
  } catch (error) {
    const reason = error.name === "TimeoutError" ? `${CAMERA_TIMEOUT_MS / 1000}초 동안 응답 없음` : error.name;
    showMediaStatus(`${label}를 바꾸지 못했습니다(${reason}) — 다른 앱이 쓰는 중인지 확인하세요.`);
    await refreshDevices().catch(() => {});
    return;
  }
  track.enabled = media === "video" ? state.media.camOn : state.media.micOn;
  const old = state.local[media];
  state.local[media] = track;
  if (media === "video") { state.media.cameraId = deviceId; saveCameraId(deviceId); }
  else state.media.micId = deviceId;
  watchTrack(media, track);
  // 화면 공유 중이면 카메라는 바꿔 두기만 하고, 공유가 끝날 때 보낸다.
  const sharing = media === "video" && state.screen;
  if (state.mesh && !sharing) await state.mesh.replaceTrack(media, track);
  if (old) old.stop();
  if (media === "video" && !sharing) ensureTile("me").querySelector("video").srcObject = new MediaStream([track]);
  showMediaStatus("");
  send({ type: "media_state", cam: state.media.camOn && Boolean(state.local.video), mic: state.media.micOn && Boolean(state.local.audio) });
  refreshTile("me");
}

function ensureTile(id) {
  const grid = el("video-grid");
  let tile = grid.querySelector(`.tile[data-id="${id}"]`);
  if (tile) return tile;
  tile = document.createElement("div");
  tile.className = "tile" + (id === "me" ? " tile-me" : "");
  tile.dataset.id = id;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (id === "me") video.muted = true;  // 내 소리는 내 스피커로 돌려보내지 않는다
  else video.muted = state.speakerOff;  // «스피커 꺼짐» 중에 들어온 지점도 소리 없이(Q32)
  const empty = document.createElement("p");
  empty.className = "tile-empty";
  const name = document.createElement("span");
  name.className = "tile-name";
  tile.append(video, empty, name);
  {  // 전체 화면 버튼은 내 화면을 포함한 모든 타일에(사용자 요청 2026-11-11)
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "tile-pin";
    pin.title = "이 화면을 전체 화면으로 보기 (Esc 로 돌아오기)";
    pin.setAttribute("aria-label", "전체 화면으로 보기");
    pin.innerHTML = '<svg class="icon"><use href="#i-maximize-2"></use></svg>';
    pin.addEventListener("click", (event) => { event.stopPropagation(); toggleTileFullscreen(tile); });
    tile.appendChild(pin);
    // «특정인 크게» 배치에서는 다른 지점 타일을 누르면 그 지점을 크게 띄운다(내 화면은 제외).
    if (id !== "me") tile.addEventListener("click", () => { if (state.layout === "pin") pinTile(id); });
  }
  if (id === "me") grid.prepend(tile);
  else grid.appendChild(tile);
  tile.classList.toggle("tile-solo", el("stage").dataset.solo === id);
  return tile;
}

function attachRemote(id, stream) {
  const video = ensureTile(id).querySelector("video");
  if (video.srcObject !== stream) video.srcObject = stream;
  video.volume = state.ttsSpeaking ? DUCK_VOLUME : 1;  // 번역 음성을 읽는 중이면 원음을 줄인 채로
  refreshTile(id);
}

// 타일의 이름표와 «카메라 꺼짐 / 연결 중 / 연결 끊김» 안내를 지금 상태로 맞춘다.
function refreshTile(id) {
  const tile = el("video-grid").querySelector(`.tile[data-id="${id}"]`);
  if (!tile) return;
  const video = tile.querySelector("video");
  const hasVideo = Boolean(video.srcObject && video.srcObject.getVideoTracks().length);
  let name;
  let notice = "";
  let screen;
  if (id === "me") {
    screen = Boolean(state.screen);
    name = `${state.me ? state.me.name : ""} (나)`;
    if (screen) notice = "";
    else if (!state.local.video) notice = "카메라 없음";
    else if (!state.media.camOn) notice = "카메라 꺼짐";
  } else {
    const person = state.people.find((p) => p.id === id);
    screen = Boolean(person && person.screen);
    name = person ? person.name : "";
    const connection = state.peerStates[id];
    if (person && person.away) notice = "연결이 끊겨 다시 연결하는 중…";
    else if (person && !person.cam && !screen) notice = "카메라 꺼짐";
    else if (connection === "failed" || connection === "disconnected") notice = "연결 끊김 — 같은 망(사내망)인지 확인하세요";
    else if (!hasVideo) notice = "연결 중…";
  }
  tile.classList.toggle("tile-screen", screen);
  const relayed = id !== "me" && state.mesh && state.mesh.relayed(id);
  tile.querySelector(".tile-name").textContent = name + (screen ? " · 화면 공유" : "") + (relayed ? " · 중계" : "");
  const empty = tile.querySelector(".tile-empty");
  empty.textContent = notice;
  empty.hidden = !notice;
}

function syncPeers(list) {
  state.people = list;
  if (!state.me) return;
  const others = list.filter((person) => person.id !== state.me.id);
  const grid = el("video-grid");
  for (const tile of [...grid.querySelectorAll(".tile")]) {
    if (tile.dataset.id !== "me" && !others.some((person) => person.id === tile.dataset.id)) tile.remove();
  }
  for (const person of others) {
    ensureTile(person.id).classList.toggle("tile-camera", person.kind === "camera");
    refreshTile(person.id);
  }
  refreshTile("me");
  grid.dataset.count = String(grid.querySelectorAll(".tile").length);
  // 전체 화면으로 보던 지점이 나가면 빈 화면에 남지 않게 전체 화면을 끝낸다.
  if (el("stage").dataset.solo && !grid.querySelector(".tile-solo")) leaveSolo();
  const myCamera = list.some((person) => person.kind === "camera" && person.site_id === state.me.id);
  el("phone-camera").disabled = myCamera;
  el("phone-camera").title = myCamera ? "이 지점의 휴대폰 카메라가 연결돼 있습니다" : "휴대폰 카메라 연결";
  if (myCamera) closeCameraDialog();
  refreshScreenButton();
  applyLayout();
  if (!list.some((person) => person.screen)) el("vl-panel").hidden = true;
  // 참가자 목록을 아직 못 받았으면(나 자신도 없는 빈 목록) 방금 건 연결을 지우지 않는다 —
  // 카메라가 빨리 열리면 목록보다 먼저 여기 와서 모든 연결을 닫아 버렸다(2026-11-16 브라우저 확인).
  if (!state.mesh || !list.some((person) => person.id === state.me.id)) return;
  state.mesh.sync(others.map((person) => person.id));
  applyVideoScale();
}

// 4곳이 모이면 송신 해상도를 낮춘다(Q2). 단, 공유 화면은 글자가 뭉개지지 않게 원본으로 보낸다.
// 중계(TURN)를 거치는 상대에게는 카메라 360p·공유 화면 720p 까지만 보낸다(Q3·Q4, 무료 20 GB 절약).
function applyVideoScale() {
  if (!state.mesh) return;
  const sites = state.people.filter((person) => person.kind !== "camera").length;
  const track = state.screen || state.local.video;
  const height = (track && track.getSettings().height) || 720;
  const relay = Math.max(1, height / (state.screen ? 720 : 360));
  state.mesh.setVideoScale(sites >= 4 && !state.screen ? 2 : 1, relay);
  // Cloudflare 900 GB 넘음(Q31): 중계 연결 상대에게는 음성만(공유 화면은 1초 1장).
  state.mesh.setRelayPolicy({ audioOnly: Boolean(state.relay && state.relay.audio_only), screen: Boolean(state.screen) });
}

const RELAY_REPORT_MS = 30000;
const RELAY_RECONNECT_DELAY_MS = 1000;  // 모든 지점이 새 중계 정보를 받은 뒤 다시 연결하도록 잠깐 기다린다

// 정상 = 초록, 900 GB 음성만 = 주황, 없음·차단 = 빨강.
function setBadgeLevel(node, level, label) {
  node.className = "badge " + (level === "ok" ? "badge-ok" : level === "warn" ? "badge-warn" : "badge-bad");
  node.querySelector(".badge-text").textContent = label;
}

function applyRelayStatus(status) {
  const badge = el("relay-badge");
  if (!status) { badge.hidden = true; return; }
  badge.hidden = false;
  const level = status.state !== "configured" ? "bad" : status.audio_only ? "warn" : "ok";
  setBadgeLevel(badge, level, status.label + (status.audio_only ? " · 음성만" : ""));
  badge.title = status.reason || "다른 망(외부) 참석자는 중계 서버를 거쳐 연결됩니다";
  applyVideoScale();
}

// 중계 서비스가 바뀌었거나(Host 선택) Cloudflare 단계(900 음성만·950 차단)가 바뀌었다(Q31·Q34).
function onRelayConfig(message) {
  state.relay = message.relay || null;
  state.iceServers = message.ice_servers || [];
  applyRelayStatus(state.relay);
  if (state.me && state.me.is_host && state.relay && state.relay.reason) showMediaStatus(state.relay.reason);
  if (!state.mesh) return;
  state.mesh.setIceServers(state.iceServers);
  if (message.reconnect) {
    showMediaStatus(`중계를 바꿔 영상 연결을 다시 맺는 중… (${state.relay ? state.relay.label : ""})`);
    setTimeout(() => { if (state.mesh) state.mesh.reconnectAll(); }, RELAY_RECONNECT_DELAY_MS);
  }
}

const RELAY_QUOTA_MS = 60000;

// Host 화면에만 지금 고른 중계의 사용량을 1분마다 보인다(Q9·Q34).
// Cloudflare = 최근 31일(1,000 GB 무료), Metered = 이번 결제 주기.
function syncRelayQuota() {
  const host = Boolean(state.me && state.me.is_host);
  el("relay-quota").hidden = !host;
  if (!host) {
    clearInterval(state.relayQuotaTimer);
    state.relayQuotaTimer = null;
    return;
  }
  send({ type: "relay_quota" });
  if (!state.relayQuotaTimer) state.relayQuotaTimer = setInterval(() => send({ type: "relay_quota" }), RELAY_QUOTA_MS);
}

// Metered 표기와 같이 1 GB = 1000 MB.
function formatGb(gb) {
  if (gb >= 100) return `${gb.toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`;  // Cloudflare 1,000 GB
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(gb * 1000)} MB`;
}

const RELAY_NAMES = { cloudflare: "Cloudflare", metered: "Metered" };

// 중계 선택 목록: 지금 고른 것 + 각 서비스 남은 양(또는 쓸 수 없는 이유).
function renderRelaySelect(message) {
  const select = el("relay-select");
  const options = message.options || {};
  for (const option of select.options) {
    const info = options[option.value];
    let note = "";
    if (info && info.ok) note = ` (남은 ${formatGb(info.remaining_gb)})`;
    else if (info) note = " (준비 안 됨)";
    option.textContent = `중계: ${RELAY_NAMES[option.value]}${note}`;
    option.title = info && !info.ok ? info.reason : "";
  }
  if (message.provider) select.value = message.provider;
  select.title = "외부(다른 망) 참석자 영상이 지나가는 중계 서비스 — 바꾸면 모든 지점의 영상 연결을 다시 맺습니다";
  el("relay-extend").hidden = !message.can_extend;
}

function showRelayQuota(message) {
  const badge = el("relay-quota");
  renderRelaySelect(message);
  if (!message.ok) {
    setBadge(badge, false, `${RELAY_NAMES[message.provider] || "중계"} 사용량 확인 불가`);
    badge.title = message.reason;
    return;
  }
  if (message.provider === "cloudflare") {
    const level = message.level === "blocked" ? "bad" : message.level === "audio_only" ? "warn" : "ok";
    const internal = message.source === "internal";
    setBadgeLevel(badge, level,
      `Cloudflare · 최근 ${message.window_days}일 ${formatGb(message.quota_gb)} 중 사용 ${formatGb(message.used_gb)}`
      + ` · 남은 ${formatGb(message.remaining_gb)}` + (internal ? " · 내부 집계" : ""));
    badge.title = (internal ? `Cloudflare 조회 실패 — 내부 집계로 판단 중: ${message.reason}\n` : "")
      + `${message.warn_gb} GB 에서 중계 연결은 음성만, ${message.block_gb} GB 에서 차단(무료 한도 보호)`
      + (message.checked_at ? ` · Cloudflare 확인 ${message.checked_at}` : "") + " · 1분마다 갱신";
    return;
  }
  const over = message.overage_gb > 0;
  setBadge(badge, message.remaining_gb > 0 && !over,
    `중계 총량 ${formatGb(message.quota_gb)} · 사용 ${formatGb(message.used_gb)} · 남은 ${formatGb(message.remaining_gb)}`
    + (over ? ` · 초과 ${formatGb(message.overage_gb)}` : ""));
  badge.title = `Metered 이번 결제 주기 기준 · ${message.checked_at} 확인 · 1분마다 갱신`
    + (over ? " — 초과분은 Metered 충전 잔액에서 차감됩니다" : "");
}

function teardownMedia() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.ttsSpeaking = 0;
  if (state.mesh) state.mesh.closeAll();
  state.mesh = null;
  state.rtcQueue = [];
  clearInterval(state.relayTimer);
  state.relayTimer = null;
  clearInterval(state.relayQuotaTimer);
  state.relayQuotaTimer = null;
  stopSpeakerMeter();
  for (const track of [state.local.video, state.local.audio, state.screen, state.screenPending]) if (track) track.stop();
  state.local = { video: null, audio: null };
  state.screen = null;
  state.screenPending = null;
  stopFrameSender();
  el("vl-panel").hidden = true;
  state.pinned = null;
  state.speaker = { id: null, candidate: null, candidateSince: 0, switchedAt: 0 };
  el("video-grid").innerHTML = "";
  closeCameraDialog();
}

// --- 화면 공유 (Q27: 카메라 영상 자리에 공유 화면을 넣는다) ---------------

async function toggleScreenShare() {
  if (state.screen) { stopScreenShare(); return; }
  if (state.screenPending) return;
  let track;
  try {
    // 글자가 읽히도록 해상도는 그대로, 초당 프레임은 낮춘다.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 15 } }, audio: false });
    track = stream.getVideoTracks()[0];
  } catch (error) {
    // 사용자가 창 고르기를 취소하면 NotAllowedError — 안내하지 않는다.
    if (error.name !== "NotAllowedError") showMediaStatus(`화면 공유를 시작하지 못했습니다(${error.name}).`);
    return;
  }
  track.contentHint = "detail";
  // 브라우저의 «공유 중지» 막대를 눌러도 같은 경로로 끝낸다.
  track.onended = () => (state.screen === track ? stopScreenShare() : dropPendingScreen());
  state.screenPending = track;
  send({ type: "screen_share", on: true });  // 회의당 1곳 — 서버가 승인하면 보내기 시작
}

async function startSendingScreen() {
  const track = state.screenPending;
  if (!track) return;
  state.screenPending = null;
  state.screen = track;
  if (state.mesh) await state.mesh.replaceTrack("video", track);
  ensureTile("me").querySelector("video").srcObject = new MediaStream([track]);
  showMediaStatus("");
  applyVideoScale();
  refreshScreenButton();
  refreshTile("me");
  applyLayout();
  startFrameSender(track);
}

// --- 공유 화면 프레임 → 서버(모의 MOSS-VL) — 7단계, Q10 ----------------------------
// 1초에 한 번 32×18 로 줄여 앞 장면과 비교하고, 바뀌었을 때만 960px 이하 JPEG 를 보낸다(디스크 저장 없음).
const FRAME_INTERVAL_MS = 1000;
const FRAME_MAX_WIDTH = 960;
// 바뀜 판정: 32×18 칸 중 밝기 차이가 12 넘는 칸이 3개 이상(평균 차이는 문서 일부 글자 변경·비슷한 색 슬라이드를 놓친다)
const FRAME_PIXEL_DIFF = 12;
const FRAME_CHANGED_CELLS = 3;

function startFrameSender(track) {
  stopFrameSender();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  const canvas = document.createElement("canvas");
  const tiny = document.createElement("canvas");
  tiny.width = 32;
  tiny.height = 18;
  state.frames = { video, canvas, tiny, last: null, timer: setInterval(sendFrameIfChanged, FRAME_INTERVAL_MS) };
}

function stopFrameSender() {
  if (!state.frames) return;
  clearInterval(state.frames.timer);
  state.frames.video.srcObject = null;
  state.frames = null;
}

function sendFrameIfChanged() {
  const f = state.frames;
  if (!f || !f.video.videoWidth) return;
  const tctx = f.tiny.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(f.video, 0, 0, 32, 18);
  const pixels = tctx.getImageData(0, 0, 32, 18).data;
  const gray = new Uint8Array(32 * 18);
  for (let i = 0; i < gray.length; i += 1) gray[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;
  if (f.last) {
    let changed = 0;
    for (let i = 0; i < gray.length; i += 1) if (Math.abs(gray[i] - f.last[i]) > FRAME_PIXEL_DIFF) changed += 1;
    if (changed < FRAME_CHANGED_CELLS) return;  // 바뀌지 않았으면 보내지 않는다
  }
  f.last = gray;
  const scale = Math.min(1, FRAME_MAX_WIDTH / f.video.videoWidth);
  f.canvas.width = Math.round(f.video.videoWidth * scale);
  f.canvas.height = Math.round(f.video.videoHeight * scale);
  f.canvas.getContext("2d").drawImage(f.video, 0, 0, f.canvas.width, f.canvas.height);
  const data = f.canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
  send({ type: "screen_frame", jpeg: data, width: f.canvas.width, height: f.canvas.height });
}

// 모의 분석 결과. «MOCK» 배지를 늘 붙이고, 자막 기록·회의 정리에는 넣지 않는다(CLAUDE.md).
function showVisionContext(message) {
  el("vl-panel").hidden = false;
  el("vl-mock").hidden = !message.mock;
  el("vl-engine").textContent = message.engine || "";
  el("vl-text").textContent = message.text || "";
}

function dropPendingScreen() {
  if (state.screenPending) state.screenPending.stop();
  state.screenPending = null;
  refreshScreenButton();
}

async function stopScreenShare() {
  const track = state.screen;
  if (!track) return;
  state.screen = null;
  track.onended = null;
  stopFrameSender();
  if (state.mesh) await state.mesh.replaceTrack("video", state.local.video);
  track.stop();
  ensureTile("me").querySelector("video").srcObject = new MediaStream([state.local.video].filter(Boolean));
  send({ type: "screen_share", on: false });
  applyVideoScale();
  refreshScreenButton();
  refreshTile("me");
  applyLayout();
}

function refreshScreenButton() {
  const button = el("screen-share");
  const sharing = Boolean(state.screen);
  const other = state.people.find((person) => person.screen && (!state.me || person.id !== state.me.id));
  button.setAttribute("aria-pressed", String(sharing));
  button.querySelector("use").setAttribute("href", sharing ? "#i-screen-share-off" : "#i-screen-share");
  button.querySelector("span").textContent = sharing ? "공유 중지" : "화면 공유";
  button.disabled = !sharing && Boolean(other || state.screenPending);
  button.title = !sharing && other ? `«${other.name}» 지점이 화면을 공유하고 있습니다` : "";
}

// --- 화면 배치 (Q9: 각자 선택) --------------------------------------------

const LAYOUT_KEY = "translator-layout";
const LAYOUTS = ["auto", "grid", "row", "pin", "speaker"];

function loadLayout() {
  let saved = "";
  try { saved = localStorage.getItem(LAYOUT_KEY) || ""; } catch { /* 저장소를 못 쓰면 기본값 */ }
  state.layout = LAYOUTS.includes(saved) ? saved : "auto";
  el("layout-select").value = state.layout;
}

function setLayout(layout) {
  state.layout = LAYOUTS.includes(layout) ? layout : "auto";
  el("layout-select").value = state.layout;
  try { localStorage.setItem(LAYOUT_KEY, state.layout); } catch { /* 저장 못 해도 이번 회의에는 적용 */ }
  applyLayout();
}

// 타일 오른쪽 위 버튼: 그 화면을 모니터 전체 화면으로(사용자 요청 2026-11-11). Esc 나 같은 버튼으로 돌아온다.
// 2026-11-18 사용자 요청 «전체 화면에서도 자막이 보이게»: 타일이 아니라 영상|자막 칸(#stage)을 전체 화면으로 띄우고
// 고른 타일만 영상 칸을 채운다(stage.dataset.solo = 타일 id). 전체 화면 중 다른 타일 버튼을 누르면 그 타일로 바꾼다.
function setSolo(id) {
  const stage = el("stage");
  if (id) stage.dataset.solo = id;
  else delete stage.dataset.solo;
  for (const tile of el("video-grid").querySelectorAll(".tile")) tile.classList.toggle("tile-solo", tile.dataset.id === id);
  refreshFullscreenButtons();
}

function leaveSolo() {
  setSolo(null);
  if (document.fullscreenElement === el("stage")) document.exitFullscreen().catch(() => {});
}

function toggleTileFullscreen(tile) {
  const stage = el("stage");
  if (document.fullscreenElement === stage) {
    if (stage.dataset.solo === tile.dataset.id) leaveSolo();
    else setSolo(tile.dataset.id);
    return;
  }
  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!request) {
    showMediaStatus("이 브라우저는 전체 화면을 지원하지 않습니다");
    return;
  }
  setSolo(tile.dataset.id);
  Promise.resolve(request.call(stage)).catch((error) => {
    setSolo(null);
    showMediaStatus(`전체 화면으로 바꾸지 못했습니다(${error.name})`);
  });
}

// Esc 등으로 전체 화면이 끝났으면 한 화면 보기도 끝낸다.
function onFullscreenChange() {
  if (el("stage").dataset.solo && document.fullscreenElement !== el("stage")) setSolo(null);
  else refreshFullscreenButtons();
}

function refreshFullscreenButtons() {
  const stage = el("stage");
  for (const tile of el("video-grid").querySelectorAll(".tile")) {
    const button = tile.querySelector(".tile-pin");
    if (!button) continue;
    const full = document.fullscreenElement === stage && stage.dataset.solo === tile.dataset.id;
    button.querySelector("use").setAttribute("href", full ? "#i-minimize-2" : "#i-maximize-2");
    button.title = full ? "전체 화면 끝내기 (Esc)" : "이 화면을 전체 화면으로 보기 (Esc 로 돌아오기)";
    button.setAttribute("aria-label", full ? "전체 화면 끝내기" : "전체 화면으로 보기");
  }
}

function pinTile(id) {
  state.pinned = id;
  setLayout("pin");
}

// 크게 띄울 타일 id. null 이면 바둑판.
function mainTileId() {
  if (!state.me) return null;
  const tiles = [...el("video-grid").querySelectorAll(".tile")].map((tile) => tile.dataset.id);
  if (tiles.length < 2) return null;
  const others = state.people.filter((person) => person.id !== state.me.id);
  // 다른 지점이 없으면 휴대폰 카메라라도 크게, 그것도 없으면 바둑판.
  const fallback = (others.find((p) => p.kind !== "camera") || others[0] || {}).id || null;
  const present = (id) => (id && tiles.includes(id) ? id : null);
  if (state.layout === "auto") {
    // 공유 화면이 있으면 크게. 내가 공유 중이면 내 화면 대신 다른 지점을 그대로 본다(바둑판).
    const sharer = others.find((person) => person.screen);
    return sharer ? present(sharer.id) : null;
  }
  if (state.layout === "pin") return present(state.pinned) || fallback;
  if (state.layout === "speaker") return present(state.speaker.id) || fallback;
  return null;
}

function applyLayout() {
  const grid = el("video-grid");
  // «가로 한 줄»(사용자 요청 2026-11-11): 모든 화면을 같은 크기로 가로 한 줄에 — 크게 띄우는 타일 없음.
  const main = state.layout === "row" ? null : mainTileId();
  grid.dataset.layout = state.layout === "row" ? "row" : (main ? "focus" : "grid");
  for (const tile of grid.querySelectorAll(".tile")) tile.classList.toggle("tile-main", tile.dataset.id === main);
  // 크게 띄운 것이 공유 화면이면 문서 글자가 읽히도록 영상 영역을 넓힌다(사용자 요청 2026-11-11).
  const mainTile = main ? grid.querySelector(`.tile[data-id="${main}"]`) : null;
  const screen = Boolean(mainTile && mainTile.classList.contains("tile-screen"));
  grid.dataset.screen = String(screen);
  document.body.classList.toggle("screen-focus", screen);
  if (!screen) document.body.classList.remove("settings-open");
  requestAnimationFrame(measureScreenSpace);
}

// 공유 화면이 쓸 수 있는 높이 = 영상 자리(video-wrap: 영상 칸에서 화면 분석·회의 정리를 뺀 높이). CSS 의 --avail 로 넘긴다.
function measureScreenSpace() {
  if (!document.body.classList.contains("screen-focus")) return;
  el("video-grid").style.setProperty("--avail", `${Math.max(200, el("video-wrap").clientHeight)}px`);
}

// --- 영상 | 자막 폭 조절 (2026-11-16 사용자 요청: 기본 70:30, 마우스로 조절) ---------------
const SPLIT_KEY = "visionmeeting-split";
const SPLIT_DEFAULT = 70;      // 영상 칸 %
const SPLIT_MIN = 40;
const SPLIT_MAX = 85;
const CAPTIONS_MIN_PX = 240;   // 자막 칸 최소 폭(CSS min-width 와 같은 값)

function clampSplit(percent) {
  const width = el("stage").getBoundingClientRect().width;
  const max = width > 0 ? Math.min(SPLIT_MAX, 100 - ((CAPTIONS_MIN_PX + 8) / width) * 100) : SPLIT_MAX;  // 8 = 막대 폭
  return Math.round(Math.min(Math.max(percent, SPLIT_MIN), Math.max(SPLIT_MIN, max)) * 10) / 10;
}

function setSplit(percent, save = false) {
  const value = clampSplit(percent);
  el("stage").style.setProperty("--video-share", `${value}%`);
  const splitter = el("stage-splitter");
  splitter.setAttribute("aria-valuenow", String(Math.round(value)));
  splitter.setAttribute("aria-valuetext", `영상 ${Math.round(value)}% · 자막 ${Math.round(100 - value)}%`);
  if (save) {
    try { localStorage.setItem(SPLIT_KEY, String(value)); } catch { /* 저장 못 해도 이번 회의에는 적용 */ }
  }
  requestAnimationFrame(measureScreenSpace);
}

function initSplitter() {
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(SPLIT_KEY) || ""); } catch { /* 저장소를 못 쓰면 기본값 */ }
  setSplit(Number.isFinite(saved) ? saved : SPLIT_DEFAULT);
  const splitter = el("stage-splitter");
  const fromPointer = (event) => {
    const rect = el("stage").getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * 100;
  };
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) setSplit(fromPointer(event));
  });
  const finish = (event) => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    splitter.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    setSplit(fromPointer(event), true);
  };
  splitter.addEventListener("pointerup", finish);
  splitter.addEventListener("pointercancel", finish);
  splitter.addEventListener("dblclick", () => setSplit(SPLIT_DEFAULT, true));
  splitter.addEventListener("keydown", (event) => {
    const now = parseFloat(splitter.getAttribute("aria-valuenow")) || SPLIT_DEFAULT;
    const steps = { ArrowLeft: -2, ArrowRight: 2, Home: SPLIT_MIN - now, End: SPLIT_MAX - now };
    if (event.key === "Enter") { setSplit(SPLIT_DEFAULT, true); event.preventDefault(); return; }
    if (!(event.key in steps)) return;
    setSplit(now + steps[event.key], true);
    event.preventDefault();
  });
  // 창 폭이 줄면 자막 칸 최소 폭을 지키도록 다시 맞춘다.
  window.addEventListener("resize", () => setSplit(parseFloat(splitter.getAttribute("aria-valuenow")) || SPLIT_DEFAULT));
}

function toggleSettings() {
  const open = document.body.classList.toggle("settings-open");
  el("settings-toggle").setAttribute("aria-pressed", String(open));
  el("settings-toggle").textContent = open ? "장치·배치 설정 접기" : "장치·배치 설정 펼치기";
  requestAnimationFrame(measureScreenSpace);
}

// --- 말하는 사람 감지 (Q28: 받은 소리 크기, 1.5초 이어 말하면 전환·3초 유지) --

const SPEAKER_LEVEL = 0.02;        // RMS(0~1). 이보다 크면 «말하는 중» — 실기에서 조정 필요(미검증 값)
const SPEAKER_SWITCH_MS = 1500;    // 이만큼 이어서 가장 크게 말해야 크게 띄운다
const SPEAKER_HOLD_MS = 3000;      // 바뀐 뒤 최소 유지 시간
const SPEAKER_TICK_MS = 200;

function startSpeakerMeter() {
  stopSpeakerMeter();
  let context;
  try { context = new AudioContext(); } catch { return; }  // 소리 분석을 못 하면 «말하는 사람 크게»는 첫 지점 고정
  state.meter = { context, sources: new Map(), timer: setInterval(measureSpeakers, SPEAKER_TICK_MS) };
}

function stopSpeakerMeter() {
  if (!state.meter) return;
  clearInterval(state.meter.timer);
  state.meter.context.close().catch(() => {});
  state.meter = null;
}

// 타일마다 들리는 소리(상대는 받은 소리, 나는 내 마이크)에 분석기를 붙인다. 트랙이 바뀌면 다시 붙인다.
function meterSource(id, track) {
  const meter = state.meter;
  const current = meter.sources.get(id);
  if (current && current.track === track) return current;
  if (current) current.node.disconnect();
  if (!track || track.readyState !== "live") { meter.sources.delete(id); return null; }
  const node = meter.context.createMediaStreamSource(new MediaStream([track]));
  const analyser = meter.context.createAnalyser();
  analyser.fftSize = 1024;
  node.connect(analyser);
  const source = { track, node, analyser, buffer: new Float32Array(analyser.fftSize) };
  meter.sources.set(id, source);
  return source;
}

function levelOf(source) {
  source.analyser.getFloatTimeDomainData(source.buffer);
  let sum = 0;
  for (const value of source.buffer) sum += value * value;
  return Math.sqrt(sum / source.buffer.length);
}

function measureSpeakers() {
  if (!state.meter || !state.me) return;
  if (state.meter.context.state === "suspended") state.meter.context.resume().catch(() => {});
  const grid = el("video-grid");
  let loudest = null;
  let loudestLevel = SPEAKER_LEVEL;
  for (const tile of grid.querySelectorAll(".tile")) {
    const id = tile.dataset.id;
    const track = id === "me"
      ? (state.media.micOn ? state.local.audio : null)
      : (tile.querySelector("video").srcObject || new MediaStream()).getAudioTracks()[0];
    const source = meterSource(id, track);
    const level = source ? levelOf(source) : 0;
    tile.classList.toggle("tile-speaking", level > SPEAKER_LEVEL);
    if (id !== "me" && level > loudestLevel) { loudest = id; loudestLevel = level; }
  }
  for (const id of [...state.meter.sources.keys()]) {
    if (!grid.querySelector(`.tile[data-id="${id}"]`)) { state.meter.sources.get(id).node.disconnect(); state.meter.sources.delete(id); }
  }
  pickSpeaker(loudest, performance.now());
}

// 기침 같은 짧은 소리에 화면이 흔들리지 않게: 같은 지점이 1.5초 이어서 가장 크면 바꾸고, 바꾼 뒤 3초는 유지.
function pickSpeaker(loudest, now) {
  const s = state.speaker;
  if (!loudest || loudest === s.id) { s.candidate = null; return; }
  if (s.candidate !== loudest) { s.candidate = loudest; s.candidateSince = now; return; }
  if (now - s.candidateSince < SPEAKER_SWITCH_MS || now - s.switchedAt < SPEAKER_HOLD_MS) return;
  s.id = loudest;
  s.switchedAt = now;
  s.candidate = null;
  if (state.layout === "speaker") applyLayout();
}

// --- 휴대폰 보조 카메라 QR (Q25·Q26) -------------------------------------

function isLocalHost() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

// 다른 기기(사내 PC·휴대폰)가 올 수 있는 이 서버 주소. 서버 PC 자신이 localhost 로 열었으면 사내망 주소(없으면 "").
function lanOrigin() {
  return isLocalHost() ? state.lanUrl : location.origin;
}

function phoneBaseUrl() {
  // 서버 PC 자신이 localhost 로 열었으면 휴대폰은 그 주소로 올 수 없으니 사내망 주소를 쓴다.
  return lanOrigin();
}

function openCameraDialog() {
  const dialog = el("camera-dialog");
  if (!dialog.open) dialog.showModal();
  requestCameraQr();
}

function requestCameraQr() {
  showCameraQrError("");
  clearQr();
  el("camera-qr-timer").textContent = "QR 을 만드는 중…";
  send({ type: "camera_pair" });
}

function clearQr() {
  if (state.qrTimer) clearInterval(state.qrTimer);
  state.qrTimer = null;
  const canvas = el("camera-qr");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  el("camera-qr-url").value = "";
}

function closeCameraDialog() {
  clearQr();
  const dialog = el("camera-dialog");
  if (dialog.open) dialog.close();
}

function showCameraQrError(message) {
  const node = el("camera-qr-error");
  node.textContent = message;
  node.hidden = !message;
  if (message) el("camera-qr-timer").textContent = "";
}

function showCameraQr(message) {
  const base = phoneBaseUrl();
  if (!base) {
    showCameraQrError("휴대폰이 접속할 사내망 주소를 모릅니다. run.bat 으로 서버를 실행하거나, 이 PC 에서도 https://<서버 IP>:8443 주소로 접속하세요.");
    return;
  }
  // 연결 코드는 # 뒤에 둔다: 서버 접속 기록·터널 중계에 남지 않는다.
  const url = `${base}/camera#m=${message.meeting}&t=${encodeURIComponent(message.token)}`;
  drawQr(url);
  el("camera-qr-url").value = url;
  const expiresAt = Date.now() + message.expires_in * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left === 0) {
      clearQr();
      el("camera-qr-timer").textContent = "QR 이 만료됐습니다. «새 QR» 을 누르세요.";
      return;
    }
    el("camera-qr-timer").textContent = `남은 시간 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  };
  tick();
  state.qrTimer = setInterval(tick, 1000);
}

function drawQr(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const canvas = el("camera-qr");
  const context = canvas.getContext("2d");
  const cell = Math.floor(canvas.width / (count + 8));  // 사방 4칸 여백(quiet zone)
  const offset = Math.floor((canvas.width - cell * count) / 2);
  // QR 은 테마와 무관하게 흰 바탕·검은 칸이어야 휴대폰이 읽는다.
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) context.fillRect(offset + col * cell, offset + row * cell, cell, cell);
    }
  }
}

// --- 테마 -------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const next = theme === "dark" ? "밝은 화면으로" : "어두운 화면으로";
  for (const button of document.querySelectorAll(".theme-toggle")) {
    button.querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    button.setAttribute("aria-label", next);
    button.title = next;
  }
}

function toggleTheme() {
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  try { localStorage.setItem("translator-theme", theme); } catch (error) { /* 저장 불가 환경 */ }
  applyTheme(theme);
}

// --- 초기화 -----------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
  document.querySelectorAll(".theme-toggle").forEach((button) => button.addEventListener("click", toggleTheme));
  setMode("create");
  loadStatus()
    .then(applyInviteFromUrl)
    .catch(() => showJoinError("서버 상태를 불러오지 못했습니다."));

  ["consent", "site-name", "meeting-id", "meeting-pw"].forEach((id) =>
    el(id).addEventListener("input", refreshJoinButton)
  );
  el("consent").addEventListener("change", refreshJoinButton);
  el("site-lang").addEventListener("change", (event) => checkCaptions(event.target.value));
  el("mode-create").addEventListener("click", () => setMode("create"));
  el("mode-join").addEventListener("click", () => setMode("join"));
  el("create-btn").addEventListener("click", createMeeting);
  document.querySelectorAll(".copy-invite").forEach((button) => button.addEventListener("click", copyInvite));
  el("preview-btn").addEventListener("click", startPreview);
  el("cam-toggle").addEventListener("click", () => toggleMedia("cam"));
  el("mic-toggle").addEventListener("click", () => toggleMedia("mic"));
  el("camera-select").addEventListener("change", (event) => {
    state.media.cameraId = event.target.value;
    saveCameraId(event.target.value);
    startPreview();
  });
  el("mic-select").addEventListener("change", (event) => { state.media.micId = event.target.value; startPreview(); });
  el("meet-camera").addEventListener("change", (event) => switchDevice("video", event.target.value));
  el("meet-mic").addEventListener("change", (event) => switchDevice("audio", event.target.value));
  el("meet-cam-toggle").addEventListener("click", () => toggleMedia("cam"));
  el("meet-mic-toggle").addEventListener("click", () => toggleMedia("mic"));
  el("phone-camera").addEventListener("click", openCameraDialog);
  el("screen-share").addEventListener("click", toggleScreenShare);
  el("layout-select").addEventListener("change", (event) => setLayout(event.target.value));
  loadLayout();
  el("camera-qr-new").addEventListener("click", requestCameraQr);
  el("camera-qr-close").addEventListener("click", closeCameraDialog);
  el("camera-dialog").addEventListener("close", clearQr);
  // 휴대폰·USB 카메라를 새로 연결하거나 빼면 목록을 다시 읽는다.
  navigator.mediaDevices.addEventListener("devicechange", () => refreshDevices().catch(() => {}));

  el("join-btn").addEventListener("click", () => {
    showJoinError("");
    connect();
  });

  el("speaker-toggle").addEventListener("click", toggleSpeaker);
  el("tts-btn").addEventListener("click", toggleTts);
  el("settings-toggle").addEventListener("click", toggleSettings);
  window.addEventListener("resize", measureScreenSpace);
  // 화면 분석 칸이 나중에 나타나는 등 다른 줄의 높이가 바뀌면 공유 화면 높이를 다시 잰다(잘림 방지).
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => measureScreenSpace());
    observer.observe(el("video-wrap"));
  }
  initSplitter();
  document.addEventListener("fullscreenchange", onFullscreenChange);
  el("tunnel-btn").addEventListener("click", onTunnelClick);
  el("tunnel-stop").addEventListener("click", () => send({ type: "tunnel", on: false }));
  el("export-txt").addEventListener("click", exportTxt);
  el("export-json").addEventListener("click", exportJson);
  el("export-docx").addEventListener("click", exportDocx);
  el("summarize").addEventListener("click", requestSummary);
  el("summary-engine").addEventListener("change", refreshSummaryButton);
  el("relay-select").addEventListener("change", (event) => send({ type: "relay_select", provider: event.target.value }));
  el("relay-extend").addEventListener("click", () => {
    el("relay-extend").hidden = true;
    send({ type: "relay_extend" });
  });
  el("summary-close").addEventListener("click", () => { el("summary-panel").hidden = true; });
  el("end-room").addEventListener("click", () => {
    if (confirm("회의를 종료하고 모든 자막을 삭제할까요?")) send({ type: "end_room" });
  });
});
