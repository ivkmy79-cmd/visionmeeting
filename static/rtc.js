"use strict";

// P2P 메시 연결 — 지점 PC 와 휴대폰 카메라가 같이 쓴다.
// 규칙: 나중에 들어온 쪽이 기존 참가자 각각에게 offer 를 보낸다(양쪽 동시 offer 방지).
// 서버(/ws)는 rtc_offer·rtc_answer·rtc_ice 를 대상 한 곳에만 그대로 전달한다.

// 상대 종류에 따라 주고받을 것을 정한다. 휴대폰 카메라는 영상 송신만, 지점은 카메라 영상을 받기만 한다.
function mediaPlan(myKind, peerKind) {
  if (myKind === "camera") return { video: "sendonly" };
  if (peerKind === "camera") return { video: "recvonly" };
  return { audio: "sendrecv", video: "sendrecv" };
}

const PATH_CHECK_MS = 5000;  // 연결 경로(직접/중계) 확인 간격

// 중계 «음성만»(Q31, Cloudflare 900 GB) 때 공유 화면은 1초에 1장·낮은 속도로만 보낸다.
const RELAY_SCREEN_FPS = 1;
const RELAY_SCREEN_BITRATE = 150000;

function createMesh({ myKind, send, localTrack, onTrack, onState, onRelay, iceServers }) {
  const peers = new Map(); // id -> { pc, kind, stream, pendingIce, relayed, usage, initiator }
  let scales = { base: 1, relay: 1 };  // 송신 해상도 배율: 직접 연결 / 중계 연결
  let policy = { audioOnly: false, screen: false };  // 중계 연결 상대에게 영상을 보낼지(Q31)
  let servers = iceServers || [];      // 새 연결에 쓸 STUN/TURN — 중계 서비스가 바뀌면 setIceServers 로 바뀐다(Q34)
  let relayBytes = 0;                  // 내 중계(TURN) 할당으로 오간 바이트 — 아직 서버에 보고하지 않은 몫
  const monitor = setInterval(checkPaths, PATH_CHECK_MS);

  function open(id, kind) {
    const pc = new RTCPeerConnection({ iceServers: servers });
    const peer = { pc, kind, stream: new MediaStream(), pendingIce: [], relayed: false, usage: { pairId: "", bytes: 0 }, initiator: false };
    peers.set(id, peer);
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: "rtc_ice", to: id, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      peer.stream.addTrack(event.track);
      onTrack(id, peer.stream);
    };
    pc.onconnectionstatechange = () => onState(id, pc.connectionState);
    return peer;
  }

  async function flushIce(peer) {
    for (const candidate of peer.pendingIce.splice(0)) {
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  // 나중에 들어온 쪽: offer 를 만든다.
  async function call(id, kind) {
    if (peers.has(id)) return;
    const peer = open(id, kind);
    peer.initiator = true;  // 다시 연결할 때도 offer 를 건 쪽이 다시 건다(양쪽 동시 offer 방지)
    const plan = mediaPlan(myKind, kind);
    for (const media of ["audio", "video"]) {
      if (!plan[media]) continue;
      const track = plan[media].startsWith("send") ? localTrack(media) : null;
      // 트랙이 없어도 자리(transceiver)를 만들어 두면 나중에 replaceTrack 만으로 켤 수 있다.
      peer.pc.addTransceiver(track || media, { direction: plan[media] });
    }
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    send({ type: "rtc_offer", to: id, sdp: peer.pc.localDescription.toJSON() });
  }

  // 먼저 있던 쪽: offer 에 answer 한다.
  async function answer(message) {
    const old = peers.get(message.from);
    if (old) old.pc.close();
    const peer = open(message.from, message.from_kind);
    await peer.pc.setRemoteDescription(message.sdp);
    const plan = mediaPlan(myKind, message.from_kind);
    for (const transceiver of peer.pc.getTransceivers()) {
      const media = transceiver.receiver.track.kind;
      const direction = plan[media] || "inactive";
      transceiver.direction = direction;
      if (direction.startsWith("send")) await transceiver.sender.replaceTrack(localTrack(media));
    }
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    send({ type: "rtc_answer", to: message.from, sdp: peer.pc.localDescription.toJSON() });
    await flushIce(peer);
  }

  async function handle(message) {
    try {
      if (message.type === "rtc_offer") {
        await answer(message);
      } else if (message.type === "rtc_answer") {
        const peer = peers.get(message.from);
        if (!peer) return;
        await peer.pc.setRemoteDescription(message.sdp);
        await flushIce(peer);
      } else if (message.type === "rtc_ice") {
        const peer = peers.get(message.from);
        if (!peer || !message.candidate) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate).catch(() => {});
        else peer.pendingIce.push(message.candidate);
      }
    } catch (error) {
      onState(message.from, "failed");
      console.warn("[rtc] 연결 신호 처리 실패", message.type, error);
    }
  }

  function peerSenders(peer, media) {
    return peer.pc.getTransceivers()
      .filter((t) => t.receiver.track.kind === media && t.direction && t.direction.startsWith("send"))
      .map((t) => t.sender);
  }

  function senders(media) {
    return [...peers.values()].flatMap((peer) => peerSenders(peer, media));
  }

  // 회의 중 장치 전환: 연결을 끊지 않고 보내는 트랙만 바꾼다.
  async function replaceTrack(media, track) {
    await Promise.all(senders(media).map((sender) => sender.replaceTrack(track).catch(() => {})));
  }

  async function applyScale(peer) {
    const scale = peer.relayed ? Math.max(scales.base, scales.relay) : scales.base;
    const limited = peer.relayed && policy.audioOnly;
    // 음성만: 카메라 영상은 보내지 않고(active=false), 공유 화면은 1초 1장·낮은 속도(Q31).
    const want = {
      scale, active: !limited || policy.screen,
      fps: limited && policy.screen ? RELAY_SCREEN_FPS : undefined,
      bitrate: limited && policy.screen ? RELAY_SCREEN_BITRATE : undefined,
    };
    for (const sender of peerSenders(peer, "video")) {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) continue;
      const enc = params.encodings[0];
      if (enc.scaleResolutionDownBy === want.scale && (enc.active !== false) === want.active
          && enc.maxFramerate === want.fps && enc.maxBitrate === want.bitrate) continue;
      enc.scaleResolutionDownBy = want.scale;
      enc.active = want.active;
      if (want.fps === undefined) delete enc.maxFramerate; else enc.maxFramerate = want.fps;
      if (want.bitrate === undefined) delete enc.maxBitrate; else enc.maxBitrate = want.bitrate;
      await sender.setParameters(params).catch(() => {});
    }
  }

  // 송신 해상도 배율. base = 직접 연결(4곳이면 2, Q2), relay = 중계 연결 상대(360p, Q3·Q4). 1 = 원본.
  async function setVideoScale(base, relay = base) {
    scales = { base, relay };
    await Promise.all([...peers.values()].map(applyScale));
  }

  // 중계 연결 상대에게 «음성만» 보낼지(Q31 900 GB). screen = 지금 공유 화면을 보내는 중인지.
  async function setRelayPolicy(next) {
    policy = { audioOnly: Boolean(next.audioOnly), screen: Boolean(next.screen) };
    await Promise.all([...peers.values()].map(applyScale));
  }

  // 중계 서비스가 바뀌면(Q34) 새 STUN/TURN 으로 다시 연결한다. 처음 offer 를 건 쪽만 다시 건다 —
  // 받는 쪽은 새 offer 가 오면 answer() 가 옛 연결을 닫고 새 정보로 만든다.
  function setIceServers(list) {
    servers = list || [];
  }

  function reconnectAll() {
    for (const [id, peer] of [...peers]) {
      if (!peer.initiator) continue;
      drop(id);
      call(id, peer.kind).catch((error) => console.warn("[rtc] 다시 연결 실패", error));
    }
  }

  // 지금 쓰는 후보 쌍을 읽어 중계 여부와 내 중계 할당의 바이트를 구한다.
  async function pathOf(peer) {
    const report = await peer.pc.getStats();
    const byId = new Map();
    report.forEach((stat) => byId.set(stat.id, stat));
    let pair = null;
    report.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId) pair = byId.get(stat.selectedCandidatePairId) || pair;
    });
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId) || {};
    const remote = byId.get(pair.remoteCandidateId) || {};
    return {
      relayed: local.candidateType === "relay" || remote.candidateType === "relay",
      // 상대 쪽 중계는 상대가 보고한다(같은 바이트를 두 번 세지 않게 내 할당만 센다).
      localRelay: local.candidateType === "relay",
      pairId: pair.id,
      bytes: (pair.bytesSent || 0) + (pair.bytesReceived || 0),
    };
  }

  async function checkPaths() {
    for (const [id, peer] of peers) {
      if (peer.pc.connectionState !== "connected") continue;
      const path = await pathOf(peer).catch(() => null);
      if (!path) continue;
      if (path.localRelay) {
        const delta = path.pairId === peer.usage.pairId ? path.bytes - peer.usage.bytes : path.bytes;
        if (delta > 0) relayBytes += delta;
      }
      peer.usage = { pairId: path.pairId, bytes: path.bytes };
      if (path.relayed !== peer.relayed) {
        peer.relayed = path.relayed;
        await applyScale(peer);
        if (onRelay) onRelay(id, path.relayed);
      }
    }
  }

  function takeRelayBytes() {
    const bytes = Math.round(relayBytes);
    relayBytes = 0;
    return bytes;
  }

  function drop(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.pc.close();
    peers.delete(id);
  }

  // 참가자 목록에서 사라진 상대의 연결을 닫는다.
  function sync(ids) {
    for (const id of [...peers.keys()]) if (!ids.includes(id)) drop(id);
  }

  function closeAll() {
    clearInterval(monitor);
    for (const id of [...peers.keys()]) drop(id);
  }

  return {
    call, handle, replaceTrack, setVideoScale, setRelayPolicy, setIceServers, reconnectAll, sync, drop, closeAll, takeRelayBytes,
    has: (id) => peers.has(id),
    relayed: (id) => Boolean(peers.get(id) && peers.get(id).relayed),
  };
}
