"use strict";

// 휴대폰 보조 카메라 (Q23~Q26): 지점 PC 의 QR 로 열린다. 영상 송신만 하고 소리·받는 영상은 없다.

const el = (id) => document.getElementById(id);

const cam = {
  socket: null,
  mesh: null,
  track: null,
  facing: "environment",  // 현장을 비추는 용도라 후면으로 시작한다
  ended: false,
  wakeLock: null,
};

function setStatus(text) {
  el("cam-status").textContent = text;
}

function setConn(ok, label) {
  const badge = el("cam-conn");
  badge.className = "badge " + (ok ? "badge-ok" : "badge-bad");
  badge.querySelector(".badge-text").textContent = label;
}

async function openCamera(facing) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  return stream.getVideoTracks()[0];
}

function showTrack(track) {
  const video = el("cam-video");
  video.srcObject = new MediaStream([track]);
  video.classList.toggle("mirrored", cam.facing === "user");
  el("cam-empty").hidden = true;
}

function send(payload) {
  if (cam.socket && cam.socket.readyState === WebSocket.OPEN) cam.socket.send(JSON.stringify(payload));
}

async function start() {
  const params = new URLSearchParams(location.hash.slice(1));
  const meeting = params.get("m") || "";
  const token = params.get("t") || "";
  // 주소창·방문 기록에 연결 코드가 남지 않게 지운다.
  history.replaceState(null, "", location.pathname);
  if (!meeting || !token) {
    finish("지점 PC 의 «휴대폰 카메라 연결» QR 을 휴대폰 카메라로 찍어 주세요.");
    return;
  }
  if (!navigator.mediaDevices) {
    finish("이 주소에서는 카메라를 쓸 수 없습니다. https 주소로 열렸는지 확인하세요.");
    return;
  }
  setStatus("카메라를 여는 중…");
  try {
    cam.track = await openCamera(cam.facing);
  } catch (error) {
    // 아직 서버에 접속하지 않았으므로 연결 코드는 그대로 유효하다.
    finish(`카메라를 열지 못했습니다(${error.name}) — 카메라 권한을 허용한 뒤 같은 QR 을 다시 찍으세요(5분 이내).`);
    return;
  }
  showTrack(cam.track);
  connect(meeting, token);
  keepAwake();
}

function connect(meeting, token) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  cam.socket = socket;
  setStatus("회의에 연결하는 중…");
  socket.onopen = () => socket.send(JSON.stringify({ type: "join_camera", meeting, token }));
  socket.onmessage = (event) => handle(JSON.parse(event.data));
  socket.onclose = () => {
    if (!cam.ended) finish("연결이 끊겼습니다. 다시 연결하려면 지점 PC 에서 QR 을 새로 띄우세요.");
  };
}

// Cloudflare 900 GB 넘음(Q31): 중계로 연결된 지점에는 휴대폰 영상을 보내지 않는다.
function applyRelay(relay) {
  if (cam.mesh) cam.mesh.setRelayPolicy({ audioOnly: Boolean(relay && relay.audio_only), screen: false });
}

function handle(message) {
  switch (message.type) {
    case "welcome":
      setConn(true, "연결됨");
      setStatus(`영상을 보내는 중 — 화면 이름 «${message.you.name}»`);
      el("cam-flip").disabled = false;
      el("cam-leave").disabled = false;
      cam.mesh = createMesh({
        myKind: "camera",
        send,
        localTrack: () => cam.track,
        onTrack: () => {},
        onState: (id, connection) => {
          if (connection === "failed") setStatus("일부 지점과 연결하지 못했습니다 — 지점 PC 와 같은 망(Wi-Fi)인지 확인하세요.");
        },
        iceServers: message.ice_servers || [],
      });
      applyRelay(message.relay);
      // 다른 망에서 중계로 연결되면 그 사용량도 30초마다 보고한다(Q3·Q4).
      cam.relayTimer = setInterval(() => {
        const bytes = cam.mesh ? cam.mesh.takeRelayBytes() : 0;
        if (bytes > 0) send({ type: "relay_usage", bytes });
      }, 30000);
      for (const peer of message.peers) {
        cam.mesh.call(peer.id, peer.kind).catch((error) => console.warn("[rtc] 연결 시작 실패", error));
      }
      break;

    case "relay_config":
      // 중계 서비스가 바뀌었거나 Cloudflare 단계가 바뀌었다(Q31·Q34). 처음 offer 를 건 연결만 다시 건다.
      if (!cam.mesh) break;
      cam.mesh.setIceServers(message.ice_servers || []);
      applyRelay(message.relay);
      if (message.reconnect) setTimeout(() => { if (cam.mesh) cam.mesh.reconnectAll(); }, 1000);
      break;

    case "participants":
      if (cam.mesh) cam.mesh.sync(message.list.filter((person) => person.kind !== "camera").map((person) => person.id));
      break;

    case "rtc_offer":
    case "rtc_answer":
    case "rtc_ice":
      if (cam.mesh) cam.mesh.handle(message);
      break;

    case "room_closed":
      finish("회의가 종료되었습니다.");
      break;

    case "error":
      if (message.fatal) finish(message.message);
      break;
  }
}

// 휴대폰에 따라 카메라 두 대를 동시에 못 여는 경우가 있어, 먼저 닫고 연다. 실패하면 원래 카메라로 되돌린다.
async function flip() {
  const previous = cam.facing;
  const next = previous === "environment" ? "user" : "environment";
  el("cam-flip").disabled = true;
  if (cam.track) cam.track.stop();
  try {
    cam.track = await openCamera(next);
    cam.facing = next;
  } catch (error) {
    setStatus(`카메라를 바꾸지 못했습니다(${error.name}).`);
    cam.track = await openCamera(previous).catch(() => null);
  }
  if (cam.track) {
    showTrack(cam.track);
    if (cam.mesh) await cam.mesh.replaceTrack("video", cam.track);
  }
  el("cam-flip").disabled = cam.ended;
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator) cam.wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    // 지원하지 않거나 거부됨 — 안내 문구로 대신한다.
  }
}

function finish(text) {
  cam.ended = true;
  clearInterval(cam.relayTimer);
  if (cam.mesh) cam.mesh.closeAll();
  cam.mesh = null;
  if (cam.socket) cam.socket.close();
  if (cam.track) cam.track.stop();
  cam.track = null;
  if (cam.wakeLock) cam.wakeLock.release().catch(() => {});
  el("cam-video").srcObject = null;
  el("cam-empty").hidden = false;
  el("cam-empty").textContent = "영상을 보내지 않는 중";
  el("cam-flip").disabled = true;
  el("cam-leave").disabled = true;
  setConn(false, "연결 끊김");
  setStatus(text);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const next = theme === "dark" ? "밝은 화면으로" : "어두운 화면으로";
  for (const button of document.querySelectorAll(".theme-toggle")) {
    button.querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    button.setAttribute("aria-label", next);
    button.title = next;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
  document.querySelector(".theme-toggle").addEventListener("click", () => {
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem("translator-theme", theme); } catch (error) { /* 저장 불가 환경 */ }
    applyTheme(theme);
  });
  el("cam-flip").addEventListener("click", flip);
  el("cam-leave").addEventListener("click", () => finish("연결을 끊었습니다. 다시 연결하려면 지점 PC 에서 QR 을 새로 띄우세요."));
  // 화면이 다시 켜지면 화면 꺼짐 방지를 다시 요청한다(꺼질 때 자동 해제되므로).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !cam.ended) keepAwake();
  });
  start();
});
