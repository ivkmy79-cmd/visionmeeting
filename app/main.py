"""FastAPI 진입점 - 회의방 WebSocket 라우팅."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import ipaddress
import json
import logging
from contextlib import asynccontextmanager
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Mapping, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import LANGUAGES, active_languages, is_active, load_settings
from .export_docx import build_minutes_docx
from .providers.relay import (
    PUBLIC_STUN, build_cloudflare_relay, build_cloudflare_usage, build_metered_usage, build_relay_provider,
)
from .relay_budget import AUDIO_ONLY, BLOCK_GB, BLOCKED, WARN_GB, RelayBudget
from .providers.summary import ENGINE_ORDER, SummaryUnavailable, build_summary_engines
from .providers.vision import Frame, MockVisionProvider
from .tunnel import TunnelError, TunnelManager, find_cloudflared
from .rooms import (
    CAMERA, CAMERA_TOKEN_TTL_SECONDS, KST, SITE, JoinError, LanguageLimitError,
    Participant, Room, RoomManager, now_kst_label,
)

class KstFormatter(logging.Formatter):
    """서버 시간대와 무관하게 로그 시각을 KST 로 남긴다."""

    def formatTime(self, record, datefmt=None):  # noqa: N802 (logging API)
        stamp = datetime.fromtimestamp(record.created, KST)
        return stamp.strftime(datefmt or "%Y-%m-%d %H:%M:%S KST")


logging.basicConfig(level=logging.INFO)
for _handler in logging.getLogger().handlers:
    _handler.setFormatter(KstFormatter("%(asctime)s %(levelname)s %(message)s"))
logger = logging.getLogger("visionmeeting")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

settings = load_settings()
summary_engines = build_summary_engines(settings)


def summary_status() -> dict:
    """회의 정리 엔진 목록(Q18). 준비 안 된 엔진은 사유와 함께 — 화면 드롭다운이 비활성으로 보인다."""
    engines = [summary_engines[engine_id].status() for engine_id in ENGINE_ORDER]
    default = settings.summary_engine if settings.summary_engine in summary_engines else "claude"
    return {"engines": engines, "default": default}
relay_provider = build_relay_provider(settings)  # Metered
metered_usage = build_metered_usage(settings)
cloudflare_relay = build_cloudflare_relay(settings)
relay_budget = RelayBudget(build_cloudflare_usage(settings),
                           Path(settings.relay_usage_file or BASE_DIR / "data" / "relay_usage.json"),
                           cloudflare_relay.config_error())
RELAY_CHOICES = ("cloudflare", "metered")
RELAY_NAMES = {"cloudflare": "Cloudflare", "metered": "Metered"}
RELAY_CHECK_SECONDS = 300  # Host 화면이 없어도 서버가 5분마다 Cloudflare 사용량을 확인한다(Q34)
relay_applied: Dict[str, object] = {"key": None}  # 마지막으로 회의들에 적용한 (Cloudflare 사용 가능, 단계)
quota_tasks: set = set()  # Host 화면 중계 사용량 조회·단계 적용 태스크(끝나면 스스로 빠진다)
vision_provider = MockVisionProvider()
tunnel = TunnelManager(find_cloudflared())
relay_total_bytes = 0  # 서버 기동 후 누적 중계 사용량(모든 회의)
if settings.credentials_error:
    # 키 파일을 못 읽으면 회의 정리·중계가 «값 없음»으로 보이므로 원인을 시작 로그에 남긴다.
    logger.warning("[config] %s", settings.credentials_error)
if settings.summary_engine not in summary_engines:
    # 예: 예전 .env 의 SUMMARY_PROVIDER=exaone(Q33 제거). 조용히 바꾸지 않고 사실을 남긴다.
    logger.warning("[config] SUMMARY_PROVIDER=%s 는 없는 엔진입니다 — 기본 claude 로 표시합니다.",
                   settings.summary_engine)
if settings.relay_default not in RELAY_CHOICES:
    logger.warning("[config] RELAY_PROVIDER=%s 는 없는 중계입니다 — 기본 cloudflare 로 씁니다.", settings.relay_default)
DEFAULT_RELAY = settings.relay_default if settings.relay_default in RELAY_CHOICES else "cloudflare"
manager = RoomManager()

# WebSocket 연결 후 join 메시지를 기다리는 시간
JOIN_TIMEOUT_SECONDS = 10
# 브라우저끼리 주고받는 연결 신호(SDP·ICE). 서버는 내용을 해석하지 않고 대상에게만 전달한다.
RTC_TYPES = ("rtc_offer", "rtc_answer", "rtc_ice")

# (방 코드, 지점 id) -> 자동 자막 세션 건수(Q32). 마이크가 켜진 지점마다 하나씩, 동시에 여럿 가능하다.
caption_sessions: Dict[tuple, dict] = {}
# 끊긴 지점의 자리를 보관하는 시간(Q14). 지나면 퇴장 처리하고, Host 였으면 이양한다(Q15).
RECONNECT_GRACE_SECONDS = 30
# (방 코드, 참가자 id) -> 자리 보관 만료 태스크
away_tasks: Dict[tuple, asyncio.Task] = {}
# 방 코드 -> 공유 화면 분석 상태. 대기열은 1칸(pending)이고 새 프레임이 오면 대체한다(CLAUDE.md).
vision_states: Dict[str, dict] = {}
SCREEN_FRAME_MAX_BYTES = 300 * 1024  # 축소 JPEG 한 장 상한(브라우저가 960px 이하로 줄여 보낸다)
# 방 코드 -> 진행 중인 회의 정리 태스크 (중복 요청 방지)
summary_tasks: Dict[str, asyncio.Task] = {}

@asynccontextmanager
async def lifespan(_app):
    watcher = asyncio.create_task(watch_relay_budget())
    yield
    watcher.cancel()
    await tunnel.stop()  # 서버가 끝나면 외부 참석 주소(터널)도 함께 닫는다


app = FastAPI(title="VisionMeeting", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def revalidate_pages(request: Request, call_next):
    """화면 파일은 매번 바뀌었는지 확인하게 한다. 지시가 없으면 브라우저가 옛 app.js 를
    계속 써서 새 index.html 과 엇갈린다(2026-11-11 실측). 바뀌지 않았으면 ETag 로 304 만 오간다."""
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/camera", "/help") or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/camera")
async def camera_page() -> FileResponse:
    """휴대폰 보조 카메라 페이지. 연결 코드는 URL 의 # 뒤에 있어 서버로 오지 않는다."""
    return FileResponse(STATIC_DIR / "camera.html")


@app.get("/help")
async def help_page() -> FileResponse:
    """프로그램 안 사용 설명서. 숫자(지점 수·발언 시간 등)는 페이지가 /api/status 에서 읽는다."""
    return FileResponse(STATIC_DIR / "help.html")


def is_external(client_host: Optional[str], headers: Mapping[str, str]) -> bool:
    """사내망 밖에서 온 요청인지 판단한다.

    Cloudflare Quick Tunnel 로 들어온 요청은 cloudflared 가 서버 PC 에서 중계하므로
    접속 주소가 127.0.0.1 로 보인다. 그래서 Cloudflare 가 붙이는 헤더를 먼저 본다.
    주소를 해석할 수 없으면 안전하게 외부로 취급한다.
    """
    if headers.get("cf-connecting-ip") or headers.get("cf-ray"):
        return True
    try:
        address = ipaddress.ip_address(client_host or "")
    except ValueError:
        return True
    return not (address.is_loopback or address.is_private)


def create_permission(client_host: Optional[str], headers: Mapping[str, str]) -> dict:
    """회의 개설 가능 여부. UI 가 그대로 표시하므로 사유 문구를 함께 준다."""
    if settings.room_passcode:
        return {"code_required": True, "allowed": True, "reason": ""}
    if is_external(client_host, headers):
        return {
            "code_required": False, "allowed": False,
            "reason": "외부 주소에서는 회의를 개설할 수 없습니다. 서버의 .env 에 ROOM_PASSCODE(개설 코드)가 비어 있습니다.",
        }
    return {"code_required": False, "allowed": True, "reason": ""}


def language_labels(codes) -> str:
    return "·".join(LANGUAGES[code].label if code in LANGUAGES else code for code in codes)


@app.get("/api/status")
async def status(request: Request) -> JSONResponse:
    client_host = request.client.host if request.client else None
    external = is_external(client_host, request.headers)
    return JSONResponse(
        {
            # 사내망 주소는 사내에서 온 요청에만 알려 준다(휴대폰 QR 용, Q26).
            "lan_url": "" if external else settings.lan_url,
            "summary": summary_status(),
            "create": create_permission(client_host, request.headers),
            # 자막은 브라우저가 만든다(Q29): 음성 인식 로케일·번역 코드를 화면에 넘긴다.
            "languages": [
                {"code": lang.code, "label": lang.label, "speech_locale": lang.speech_locale,
                 "translate_code": lang.translate_code, "verified": lang.verified}
                for lang in active_languages()
            ],
            "limits": {
                "max_sites": settings.max_sites,
                "max_languages": settings.max_languages,
                "max_cameras": settings.max_cameras,
            },
        }
    )


@app.post("/api/meetings")
async def create_meeting(request: Request) -> JSONResponse:
    """회의를 개설한다. 비밀번호·Host 토큰은 응답으로 한 번만 주고 로그에 남기지 않는다."""
    client_host = request.client.host if request.client else None
    permission = create_permission(client_host, request.headers)
    if not permission["allowed"]:
        return JSONResponse({"message": permission["reason"]}, status_code=403)
    if settings.room_passcode:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, ValueError):
            payload = {}
        code = str((payload or {}).get("code") or "").strip()
        if not hmac.compare_digest(code, settings.room_passcode):
            logger.warning("[meeting] 개설 거부 - 개설 코드 불일치 (접속=%s)", client_host)
            return JSONResponse({"message": "개설 코드가 올바르지 않습니다."}, status_code=403)
    room = manager.create()
    room.relay_choice = DEFAULT_RELAY
    logger.info("[meeting] 개설 - 회의=%s 외부=%s 현재 회의 수=%d 중계=%s",
                room.code, is_external(client_host, request.headers), len(manager.rooms), room.relay_choice)
    return JSONResponse({
        "meeting_id": room.code,
        "password": room.password,
        "host_token": room.host_token,
    })


@app.post("/api/export/docx")
async def export_docx(request: Request) -> Response:
    """브라우저가 보낸 자막·정리 결과를 DOCX 로 변환해 돌려준다. 서버에 남기지 않는다."""
    payload = await request.json()
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return JSONResponse({"message": "entries 목록이 필요합니다."}, status_code=400)
    room_code = str(payload.get("room") or "meeting")[:12]
    caption_lang = str(payload.get("caption_lang") or "ko")
    raw_summaries = payload.get("summaries")
    summaries = {
        str(code): text for code, text in (raw_summaries or {}).items()
        if isinstance(text, str) and text.strip()
    } if isinstance(raw_summaries, dict) else {}
    engine = str(payload.get("engine") or "")[:40]
    data = build_minutes_docx(room_code, entries, caption_lang, summaries, now_kst_label(), engine)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="meeting-{room_code}.docx"'},
    )


# --- 전송 helper -------------------------------------------------------

async def send_json(participant: Participant, payload: dict) -> None:
    if participant.connection is None:
        return
    try:
        await participant.connection.send_json(payload)
    except Exception:
        # 이미 끊긴 연결. 정리는 각 연결의 finally 가 담당한다.
        logger.debug("[ws] 전송 실패 - %s", participant.name)


async def broadcast(room: Room, payload: dict) -> None:
    for participant in list(room.participants.values()):
        await send_json(participant, payload)


def peers_for(room: Room, participant: Participant) -> list:
    """새로 들어온 참가자가 연결 신호(offer)를 보낼 상대. 카메라끼리·끊겨 있는 지점은 빼다."""
    return [
        {"id": p.id, "kind": p.kind} for p in room.participants.values()
        if p.id != participant.id and p.away_since is None
        and not (participant.kind == CAMERA and p.kind == CAMERA)
    ]


async def broadcast_participants(room: Room) -> None:
    await broadcast(
        room,
        {
            "type": "participants",
            "list": [p.public() for p in room.participants.values()],
        },
    )


# --- 자동 자막 (Q32) -----------------------------------------------------
# 마이크가 켜진 지점마다 브라우저가 음성 인식을 하고(Q29), 서버는 지점별 건수만 센다. 동시에 여러 지점이 말해도 된다.

CAPTION_MAX_CHARS = 1000  # 자막 한 줄 상한. 넘으면 잘라서 받는다(비정상 입력 방어)
VOICE_WARN_SECONDS = 3    # 목소리가 이만큼 있었는데 확정 0건이면 WARNING


def start_captions(room: Room, participant: Participant) -> None:
    """지점 브라우저가 자동 자막을 켰다(입장·마이크 켬·재연결). 이미 켜져 있으면 그대로 둔다."""
    key = (room.code, participant.id)
    if key in caption_sessions:
        return
    caption_sessions[key] = {"name": participant.name, "interim": 0, "final": 0, "chars": 0, "muted": 0}
    logger.info("[captions] 자동 자막 시작 - 방=%s 지점=%s", room.code, participant.name)


def end_captions(room: Room, participant: Participant, reason: str, dictation=None) -> None:
    """자동 자막 종료 경로는 이 함수 하나로 모은다(마이크 끔·연결 끊김·재연결·회의 종료)."""
    session = caption_sessions.pop((room.code, participant.id), None)
    if session is None:
        return
    voice = log_dictation(room, participant, dictation)
    logger.info(
        "[captions] 자동 자막 종료 - 방=%s 지점=%s 사유=%s interim=%d건 final=%d건 글자=%d 마이크꺼진뒤버림=%d건",
        room.code, session["name"], reason, session["interim"], session["final"], session["chars"], session["muted"],
    )
    if session["final"] == 0 and (session["interim"] > 0 or voice >= VOICE_WARN_SECONDS):
        # 인식 결과 0건을 성공으로 보지 않는다 — 목소리·임시 문장은 있었는데 확정이 없었다.
        logger.warning("[captions] 확정 인식 0건 - 방=%s 지점=%s interim=%d건 목소리=%d초",
                       room.code, session["name"], session["interim"], voice)


DICTATION_FIELDS = ("sessions", "finals", "rescued", "retries")
DICTATION_OPTIONAL = ("watchdog", "dropped", "voice")


def log_dictation(room: Room, participant: Participant, stats) -> int:
    """지점 브라우저의 인식 통계(세션 재시작·목소리 없이 와서 버린 결과·목소리 시간) — 원인 확인용.
    숫자·짧은 오류 이름만 남긴다. 목소리 초(voice)를 돌려준다(통계가 없거나 형식이 틀리면 0)."""
    if not isinstance(stats, dict):
        return 0
    numbers = {name: stats.get(name) for name in DICTATION_FIELDS}
    numbers.update({name: stats.get(name, 0) for name in DICTATION_OPTIONAL})
    if not all(isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 100000
               for value in numbers.values()):
        return 0
    raw_errors = stats.get("errors") if isinstance(stats.get("errors"), list) else []
    errors = sorted({e for e in raw_errors[:20] if isinstance(e, str) and len(e) <= 40
                     and all(ch.isalnum() or ch in "-_:" for ch in e)})
    logger.info("[captions] 브라우저 인식 - 방=%s 지점=%s 세션=%d 확정=%d 끊긴문장살림=%d 재시작재시도=%d 멈춤재시작=%d "
                "목소리없어버림=%d 목소리=%d초 마이크전환=%s 오류=%s",
                room.code, participant.name, numbers["sessions"], numbers["finals"], numbers["rescued"],
                numbers["retries"], numbers["watchdog"], numbers["dropped"], numbers["voice"],
                bool(stats.get("trackFallback")), ",".join(errors) or "없음")
    return numbers["voice"]


async def handle_caption(room: Room, participant: Participant, message: dict) -> None:
    """지점 브라우저가 보낸 인식 결과. 자동 자막을 켠 지점 것만 받는다(나머지는 조용히 버린다)."""
    session = caption_sessions.get((room.code, participant.id))
    if session is None:
        return
    if not participant.mic:
        # 마이크를 끈 지점의 자막은 받지 않는다(2026-11-13 사용자 보고: 끈 뒤에도 그 지점 이름으로 자막).
        # 브라우저는 media_state(마이크 꺼짐)를 먼저 보내므로, 끄기 직전 말의 늦은 인식 결과도 여기서 막힌다.
        session["muted"] += 1
        return
    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return
    text = text.strip()[:CAPTION_MAX_CHARS]
    if message.get("final") is True:
        session["final"] += 1
        session["chars"] += len(text)
        entry = room.append_final(participant, text, {participant.speak_lang: text})
        await broadcast(room, {"type": "final", "entry": entry})
    else:
        session["interim"] += 1
        await broadcast(room, {
            "type": "interim", "speaker": participant.name, "speaker_id": participant.id,
            "source_lang": participant.speak_lang, "text": text,
        })


# --- WebSocket ---------------------------------------------------------

@app.websocket("/ws")
async def meeting_socket(websocket: WebSocket) -> None:
    await websocket.accept()

    async def refuse(problem: str) -> None:
        await websocket.send_json({"type": "error", "message": problem, "fatal": True})
        await websocket.close()

    # 비밀번호·Host 토큰을 URL 에 넣으면 uvicorn 접속 로그와 터널 중계에 그대로 남는다.
    # 그래서 연결 직후 첫 메시지({"type":"join", ...})로만 받는다.
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=JOIN_TIMEOUT_SECONDS)
        join = json.loads(raw)
    except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect, KeyError, RuntimeError):
        join = None
    if isinstance(join, dict) and join.get("type") == "join_camera":
        await camera_socket(websocket, join, refuse)
        return
    if isinstance(join, dict) and join.get("type") == "resume":
        await resume_socket(websocket, join, refuse)
        return
    if not isinstance(join, dict) or join.get("type") != "join":
        await refuse("입장 정보를 받지 못했습니다. 페이지를 새로고침하세요.")
        return
    meeting_id = str(join.get("meeting") or "").strip()
    password = str(join.get("password") or "").strip()
    name = str(join.get("name") or "").strip()[:30]
    lang = str(join.get("lang") or "").strip()
    host_token = str(join.get("host") or "").strip()

    if not meeting_id or not password:
        await refuse("회의 ID 와 비밀번호를 입력하세요.")
        return
    if not name:
        await refuse("지점 이름을 입력하세요.")
        return
    if not is_active(lang):
        await refuse("지원하지 않는 언어입니다.")
        return

    room = manager.get(meeting_id)
    # 없는 회의와 틀린 비밀번호를 같은 문구로 답해 회의 ID 존재 여부를 알려 주지 않는다.
    # 오답 횟수로 입장을 막지 않는다(사용자 결정 2026-11-11). 건수만 남기고 값은 남기지 않는다.
    if room is None or not room.password_matches(password):
        if room is not None:
            room.wrong_password_count += 1
            logger.warning("[ws] 비밀번호 불일치 - 회의=%s 누적=%d건", room.code, room.wrong_password_count)
        else:
            logger.warning("[ws] 없는 회의 ID 로 입장 시도")
        await refuse("회의 ID 또는 비밀번호가 올바르지 않습니다.")
        return

    if relay_blocks_external(room, websocket):
        await refuse(RELAY_BLOCKED_JOIN)
        return
    as_host = room.is_host_token(host_token)
    try:
        room.check_admission(lang, settings.max_sites, settings.max_languages, as_host)
    except LanguageLimitError as error:
        await refuse(
            f"이 회의는 이미 {error.limit}개 언어({language_labels(error.languages)})를 쓰고 있어 "
            f"{language_labels([lang])} 지점은 들어올 수 없습니다."
        )
        return
    except JoinError as error:
        await refuse(str(error))
        return

    participant = room.add_participant(name, lang, lang, websocket, is_host=as_host)
    logger.info("[ws] 입장 - 회의=%s 지점=%s 언어=%s host=%s 접속=%d곳",
                room.code, name, lang, participant.is_host, len(room.participants))
    await send_welcome(websocket, room, participant)
    await broadcast_participants(room)
    await serve_participant(websocket, room, participant)


async def send_welcome(websocket: WebSocket, room: Room, participant: Participant, resumed: bool = False) -> None:
    ice_servers, relay = await relay_for(room)
    await websocket.send_json(
        {
            "type": "welcome",
            "you": participant.public(),
            "room": {"code": room.code},
            "summary": summary_status(),
            "transcript": room.transcript,
            "peers": peers_for(room, participant),
            "ice_servers": ice_servers,
            "relay": relay,
            # 끊겼을 때 같은 자리로 돌아오는 토큰(Q14). 본인에게만 보낸다(참가자 목록에는 없음).
            "resume_token": participant.resume_token,
            "tunnel": tunnel.status() if participant.is_host else None,
            "reconnect_grace_seconds": RECONNECT_GRACE_SECONDS,
            "resumed": resumed,
        }
    )


async def resume_socket(websocket: WebSocket, join: dict, refuse) -> None:
    """끊겼던 지점의 재연결(Q14). 30초 안에 같은 토큰으로 오면 같은 자리(id·Host 여부)로 돌아온다."""
    room = manager.get(str(join.get("meeting") or ""))
    participant = room.find_by_resume_token(str(join.get("token") or "")) if room is not None else None
    if room is None or participant is None or participant.kind != SITE:
        logger.warning("[ws] 재연결 거부 - 자리 없음(만료·종료·잘못된 토큰)")
        await refuse(f"자리 보관 시간({RECONNECT_GRACE_SECONDS}초)이 지났거나 회의가 끝났습니다. 다시 입장하세요.")
        return
    if relay_blocks_external(room, websocket):
        await refuse(RELAY_BLOCKED_JOIN)
        return
    task = away_tasks.pop((room.code, participant.id), None)
    if task is not None and not task.done():
        task.cancel()
    old = participant.connection
    if old is not None:
        # 서버가 끊김을 아직 모르는 사이(반쯤 끊긴 연결) 다시 붙은 경우 — 새 연결로 넘기고 옛 연결은 닫는다.
        # 자동 자막은 새 연결이 다시 켠다(caption_start).
        end_captions(room, participant, "disconnected")
        participant.screen = False
    room.resume(participant, websocket)
    if old is not None:
        try:
            await old.close()
        except Exception:
            logger.debug("[ws] 옛 연결 닫기 실패 - %s", participant.name)
    logger.info("[ws] 재연결 - 회의=%s 지점=%s host=%s", room.code, participant.name, participant.is_host)
    await send_welcome(websocket, room, participant, resumed=True)
    await broadcast_participants(room)
    await serve_participant(websocket, room, participant)


async def camera_socket(websocket: WebSocket, join: dict, refuse) -> None:
    """휴대폰 보조 카메라 입장. 지점 PC 가 띄운 QR 의 일회용 연결 코드로만 들어온다(Q25)."""
    room = manager.get(str(join.get("meeting") or ""))
    if room is None:
        logger.warning("[camera] 없는 회의로 카메라 연결 시도")
        await refuse("연결 코드가 만료됐거나 이미 사용됐습니다. 지점 PC 에서 QR 을 새로 띄우세요.")
        return
    if relay_blocks_external(room, websocket):
        await refuse(RELAY_BLOCKED_JOIN)
        return
    try:
        site = room.redeem_camera_token(str(join.get("token") or ""), settings.max_cameras)
    except JoinError as error:
        logger.warning("[camera] 연결 거부 - 회의=%s 사유=%s", room.code, error)
        await refuse(str(error))
        return
    camera = room.add_camera(site, websocket)
    ice_servers, relay = await relay_for(room)
    logger.info("[camera] 연결 - 회의=%s 지점=%s 카메라=%d대",
                room.code, site.name, len(room.cameras()))
    await websocket.send_json({
        "type": "welcome",
        "you": camera.public(),
        "room": {"code": room.code},
        "peers": peers_for(room, camera),
        "ice_servers": ice_servers,
        "relay": relay,
    })
    await broadcast_participants(room)
    await serve_participant(websocket, room, camera)


RELAY_REPORT_MAX_BYTES = 10 * 1024 ** 3  # 한 번 보고에 10 GB 초과는 잘못된 값으로 버린다


def add_relay_usage(room: Room, value) -> None:
    global relay_total_bytes
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= RELAY_REPORT_MAX_BYTES:
        return
    room.relay_bytes += value
    relay_total_bytes += value
    if room.relay_choice == "cloudflare":
        # Cloudflare 조회가 늦거나 실패해도 내부 집계로 900/950 GB 를 판단한다(Q34 ⑥⑦).
        relay_budget.add(value)
        if relay_key() != relay_applied["key"]:
            spawn(apply_relay_level())


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    quota_tasks.add(task)
    task.add_done_callback(quota_tasks.discard)


# --- 중계 선택·무료 한도 지킴이 (Q31·Q34) ---------------------------------------

RELAY_BLOCKED_JOIN = ("이 회의의 외부 중계(Cloudflare)가 무료 한도 보호로 차단되어 외부에서는 들어올 수 없습니다. "
                      "Host 에게 중계를 Metered 로 바꿔 달라고 요청하세요.")


def connection_external(connection) -> bool:
    if connection is None:
        return False
    client_host = connection.client.host if connection.client else None
    return is_external(client_host, connection.headers)


def relay_key() -> tuple:
    return (not relay_budget.unavailable_reason(), relay_budget.level())


def relay_blocks_external(room: Room, connection) -> bool:
    """950 GB 차단 중인 Cloudflare 회의에는 외부 접속을 받지 않는다(Q31)."""
    return room.relay_choice == "cloudflare" and relay_budget.level() == BLOCKED and connection_external(connection)


async def relay_for(room: Room) -> tuple:
    """(브라우저에 줄 iceServers, 상태). 상태에는 값이 아니라 서비스·단계·사유만 넣는다."""
    choice = room.relay_choice
    name = RELAY_NAMES[choice]
    level = relay_budget.level() if choice == "cloudflare" else "ok"
    status = {"provider": choice, "level": level, "extended": room.relay_extended,
              "audio_only": level == AUDIO_ONLY and not room.relay_extended}
    if choice == "metered":
        servers, metered = await relay_provider.ice_servers()
        label = f"외부 중계 준비됨 · {name}" if metered["state"] == "configured" else f"외부 중계 없음 · {name}"
        return servers, {**metered, **status, "label": label}
    reason = relay_budget.unavailable_reason()
    if reason:
        return list(PUBLIC_STUN), {**status, "state": "unconfigured", "label": f"외부 중계 없음 · {name}",
                                   "reason": f"Cloudflare 준비 안 됨 — {reason} Host 가 중계를 Metered 로 바꿀 수 있습니다."}
    if level == BLOCKED:
        return list(PUBLIC_STUN), {**status, "state": "blocked", "label": f"외부 중계 차단 · {name}",
                                   "reason": f"Cloudflare 최근 31일 중계 사용량이 {BLOCK_GB} GB 에 닿아 무료 한도 보호로 "
                                             "차단했습니다. Host 가 중계를 Metered 로 바꿀 수 있습니다."}
    servers, error = await cloudflare_relay.ice_servers()
    if error:
        return list(PUBLIC_STUN), {**status, "state": "unconfigured", "label": f"외부 중계 없음 · {name}",
                                   "reason": error}
    reason = ""
    if status["audio_only"]:
        reason = (f"Cloudflare 최근 31일 중계 사용량이 {WARN_GB} GB 를 넘어 중계 연결은 음성만 보냅니다"
                  f"(화면 공유는 1초에 1장). {BLOCK_GB} GB 에서 차단됩니다.")
    return servers, {**status, "state": "configured", "label": f"외부 중계 준비됨 · {name}", "reason": reason}


async def push_relay_config(room: Room, reconnect: bool) -> None:
    """회의 참가자 모두(휴대폰 카메라 포함)에게 새 중계 정보를 보낸다. reconnect 면 영상 연결을 다시 맺는다."""
    ice_servers, relay = await relay_for(room)
    await broadcast(room, {"type": "relay_config", "ice_servers": ice_servers, "relay": relay, "reconnect": reconnect})


async def disconnect_external(room: Room) -> None:
    for person in list(room.participants.values()):
        if person.connection is None or not connection_external(person.connection):
            continue
        logger.warning("[relay] 무료 한도 보호 - 외부 참석자 연결 끊음 - 회의=%s 이름=%s", room.code, person.name)
        await send_json(person, {"type": "error", "fatal": True, "message": RELAY_BLOCKED_JOIN})
        try:
            await person.connection.close()
        except Exception:
            logger.debug("[relay] 외부 연결 닫기 실패 - %s", person.name)


async def apply_relay_level() -> None:
    """Cloudflare 사용 가능 여부·단계(정상/900 음성만/950 차단)가 바뀌었을 때 회의들에 적용한다."""
    key = relay_key()
    previous = relay_applied["key"]
    relay_applied["key"] = key
    if previous == key:
        return
    usable, level = key
    used_gb = relay_budget.used_bytes() / 1e9
    if previous is None:
        if level != "ok":
            logger.warning("[relay] 기동 시 Cloudflare 단계=%s (최근 31일 %.1f GB)", level, used_gb)
        return
    logger.warning("[relay] Cloudflare 단계 변경 - 사용가능=%s→%s 단계=%s→%s 최근 31일=%.1f GB",
                   previous[0], usable, previous[1], level, used_gb)
    newly_blocked = level == BLOCKED and previous[1] != BLOCKED
    if newly_blocked and tunnel.running:
        logger.warning("[relay] 무료 한도 보호 - 외부 참석 링크(터널)를 닫습니다")
        await tunnel.stop()
    usable_before = previous[0] and previous[1] != BLOCKED
    usable_now = usable and level != BLOCKED
    for room in list(manager.rooms.values()):
        if room.relay_choice != "cloudflare" or room.closed:
            continue
        if level != AUDIO_ONLY:
            room.relay_extended = False
        if newly_blocked:
            await disconnect_external(room)
        await push_relay_config(room, reconnect=usable_before != usable_now)


async def watch_relay_budget() -> None:
    """서버 기동 직후 한 번, 이후 5분마다 Cloudflare 사용량을 읽어 단계를 적용한다."""
    while True:
        try:
            await relay_budget.refresh()
            await apply_relay_level()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[relay] Cloudflare 사용량 확인 중 오류")
        await asyncio.sleep(RELAY_CHECK_SECONDS)


def option_summary(result: dict) -> dict:
    """중계 선택 목록 옆에 붙일 «남은 양» 또는 사유."""
    if not result.get("ok"):
        return {"ok": False, "reason": result.get("reason", "")}
    return {"ok": True, "remaining_gb": result.get("remaining_gb"), "level": result.get("level", "ok")}


def log_relay_usage(room: Room) -> None:
    """회의별 중계 사용량 기록. 마지막 보고(최대 30초) 뒤의 사용량은 빠질 수 있다."""
    logger.info("[relay] 회의 중계 사용량 - 회의=%s 이번 회의=%.1f MB 서버 기동 후 누적=%.1f MB",
                room.code, room.relay_bytes / 1024 ** 2, relay_total_bytes / 1024 ** 2)


async def serve_participant(websocket: WebSocket, room: Room, participant: Participant) -> None:
    """입장 후 수신 루프와 퇴장 정리. 지점·카메라 공통."""
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                continue  # 음성은 서버로 보내지 않는다(브라우저 인식, Q29)

            text = message.get("text")
            if text is None:
                continue
            await handle_command(room, participant, text)
    except WebSocketDisconnect:
        pass
    finally:
        if participant.connection is websocket:  # 재연결로 새 연결에 넘어갔으면 옛 연결은 정리하지 않는다
            await connection_lost(room, participant)


# --- 외부 참석 주소(Cloudflare Quick Tunnel) — Host 가 화면에서 켜고 끈다 ---------------

async def send_relay_quota(room: Room, participant: Participant) -> None:
    """지금 고른 중계의 사용량을 요청한 Host 에게만 보낸다(숫자만, 키는 서버 밖으로 나가지 않음).
    Cloudflare = 최근 31일(Q34), Metered = 이번 결제 주기. 선택 목록용으로 두 서비스의 남은 양도 함께."""
    metered = await metered_usage.current()
    cloudflare = relay_budget.status()
    current = cloudflare if room.relay_choice == "cloudflare" else metered
    can_extend = (room.relay_choice == "cloudflare" and relay_budget.level() == AUDIO_ONLY
                  and not room.relay_extended and not connection_external(participant.connection))
    await send_json(participant, {
        "type": "relay_quota", **current, "provider": room.relay_choice,
        "extended": room.relay_extended, "can_extend": can_extend,
        "options": {"cloudflare": option_summary(cloudflare), "metered": option_summary(metered)},
    })


async def handle_tunnel(room: Room, participant: Participant, on: bool) -> None:
    connection = participant.connection
    if not participant.is_host:
        await send_json(participant, {"type": "tunnel", "running": tunnel.running, "error": "외부 참석 링크는 Host 만 열 수 있습니다."})
        return
    client_host = connection.client.host if connection is not None and connection.client else None
    if connection is None or is_external(client_host, connection.headers):
        await send_json(participant, {"type": "tunnel", "running": tunnel.running,
                                      "error": "외부 참석 링크는 사내망에서 접속한 Host 만 열고 닫을 수 있습니다."})
        return
    if not on:
        await tunnel.stop()
        await send_json(participant, {"type": "tunnel", "running": False, "url": ""})
        return
    if not settings.room_passcode:
        # 개설 코드 없이 열면 인터넷의 누구나 회의를 만들 수 있다(CLAUDE.md «외부망 접속»).
        await send_json(participant, {"type": "tunnel", "running": False,
                                      "error": "서버 .env 에 ROOM_PASSCODE(개설 코드)가 비어 있어 외부에 열 수 없습니다."})
        return
    if room.relay_choice == "cloudflare" and relay_budget.level() == BLOCKED:
        await send_json(participant, {"type": "tunnel", "running": False,
                                      "error": "Cloudflare 중계가 무료 한도 보호로 차단 중입니다 — 중계를 Metered 로 바꾼 뒤 여세요."})
        return
    await send_json(participant, {"type": "tunnel", "running": False, "starting": True})
    try:
        url = await tunnel.start(connection.url.port or 8443)
    except TunnelError as error:
        await send_json(participant, {"type": "tunnel", "running": False, "error": str(error)})
        return
    await send_json(participant, {"type": "tunnel", "running": True, "url": url})


# --- 공유 화면 → 모의 MOSS-VL (7단계, Q10) -----------------------------------

def decode_frame(message: dict):
    """브라우저가 보낸 축소 JPEG(base64). 형식·크기가 맞지 않으면 None."""
    data = message.get("jpeg")
    width, height = message.get("width"), message.get("height")
    if not isinstance(data, str) or len(data) > SCREEN_FRAME_MAX_BYTES * 4 // 3 + 4:
        return None
    if not all(isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 4096 for v in (width, height)):
        return None
    try:
        jpeg = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not jpeg.startswith(b"\xff\xd8") or len(jpeg) > SCREEN_FRAME_MAX_BYTES:
        return None
    return jpeg, width, height


async def receive_screen_frame(room: Room, participant: Participant, message: dict) -> None:
    """공유 중인 지점의 프레임만 받는다. 대기열 1칸 — 처리 중에 온 새 프레임이 대기 프레임을 대체한다."""
    if not participant.screen:
        return
    decoded = decode_frame(message)
    if decoded is None:
        logger.warning("[vl] 프레임 거부(형식·크기) - 회의=%s 지점=%s", room.code, participant.name)
        return
    jpeg, width, height = decoded
    vs = vision_states.setdefault(room.code, {"received": 0, "replaced": 0, "processed": 0,
                                             "pending": None, "task": None, "sharer": participant.name})
    vs["received"] += 1
    if vs["pending"] is not None:
        vs["replaced"] += 1  # 처리 못 한 옛 프레임은 버린다(최신 화면만 의미가 있다)
    vs["pending"] = (jpeg, Frame(seq=vs["received"], width=width, height=height, size=len(jpeg), sharer=participant.name))
    if vs["task"] is None or vs["task"].done():
        vs["task"] = asyncio.create_task(vision_worker(room, vs))


async def vision_worker(room: Room, vs: dict) -> None:
    while vs["pending"] is not None:
        jpeg, frame = vs["pending"]
        vs["pending"] = None
        result = await vision_provider.analyze(jpeg, frame)
        del jpeg  # 프레임은 저장하지 않는다
        vs["processed"] += 1
        if vision_states.get(room.code) is not vs:
            return  # 그 사이 공유가 끝났다
        # 모의 결과는 반드시 mock 표시. 회의 정리(요약) 입력에는 넣지 않는다(자막 기록과 따로 둔다).
        await broadcast(room, {"type": "vl_context", "mock": bool(result.get("mock", True)),
                               "engine": result.get("engine", ""), "text": result.get("text", ""),
                               "sharer": frame.sharer, "seq": frame.seq})


def end_vision(room: Room) -> None:
    """공유가 끝나면 대기 프레임을 버리고 건수를 남긴다."""
    vs = vision_states.pop(room.code, None)
    if vs is None:
        return
    vs["pending"] = None
    task = vs.get("task")
    if task is not None and not task.done():
        task.cancel()
    logger.info("[vl] 공유 화면 분석 종료 - 회의=%s 지점=%s 수신=%d 대체=%d 처리=%d (모의 MOSS-VL)",
                room.code, vs["sharer"], vs["received"], vs["replaced"], vs["processed"])


async def connection_lost(room: Room, participant: Participant) -> None:
    """연결이 끊겼을 때. 자동 자막은 바로 끝내고(Q14·Q32), 지점은 자리를 30초 보관, 휴대폰 카메라는 바로 퇴장."""
    end_captions(room, participant, "disconnected")
    if participant.screen:
        end_vision(room)
    if participant.kind == SITE and not room.closed and room.code in manager.rooms:
        room.mark_away(participant.id)
        logger.info("[ws] 연결 끊김 - 회의=%s 지점=%s 자리 보관 %d초", room.code, participant.name,
                    RECONNECT_GRACE_SECONDS)
        away_tasks[(room.code, participant.id)] = asyncio.create_task(expire_away(room, participant))
        await broadcast_participants(room)
        return
    await leave_room(room, participant)


async def expire_away(room: Room, participant: Participant) -> None:
    await asyncio.sleep(RECONNECT_GRACE_SECONDS)
    away_tasks.pop((room.code, participant.id), None)
    if participant.away_since is None or room.participants.get(participant.id) is not participant:
        return  # 그 사이 돌아왔다
    logger.info("[ws] 자리 보관 만료 - 회의=%s 지점=%s", room.code, participant.name)
    await leave_room(room, participant)


async def leave_room(room: Room, participant: Participant) -> None:
    """최종 퇴장. 휴대폰 카메라를 같이 내보내고, Host 였으면 이양하고(Q15), 빈 방은 지운다."""
    room.remove_participant(participant.id)
    logger.info(
        "[ws] 퇴장 - 방=%s 이름=%s 남은=%d명",
        room.code, participant.name, len(room.participants),
    )
    # 지점이 나가면 그 지점의 휴대폰 카메라도 내보낸다.
    for camera in room.cameras_of(participant.id):
        await send_json(camera, {
            "type": "error", "fatal": True,
            "message": "연결된 지점이 회의에서 나갔습니다.",
        })
        try:
            await camera.connection.close()
        except Exception:
            logger.debug("[camera] 연결 종료 실패 - %s", camera.name)
    if participant.is_host:
        new_host = room.transfer_host()
        if new_host is not None:
            logger.info("[room] Host 이양 - 회의=%s %s → %s", room.code, participant.name, new_host.name)
            await send_json(new_host, {"type": "host_changed", "you": new_host.public()})
    if room.is_empty():
        task = summary_tasks.pop(room.code, None)
        if task is not None and not task.done():
            task.cancel()
        end_vision(room)
        log_relay_usage(room)
        manager.close(room.code)
        logger.info("[room] 빈 방 제거 - %s (자막 메모리에서 삭제)", room.code)
    else:
        await broadcast_participants(room)


async def run_summary(room: Room, participant: Participant, engine_id: str) -> None:
    """자막 스냅샷을 참석 지점 언어로 요약해 요청자에게만 돌려준다(Q12). 결과는 서버에 남기지 않는다.
    Host 가 고른 엔진만 쓴다 — 실패해도 다른 엔진으로 자동 전환하지 않는다(Q18)."""
    engine = summary_engines[engine_id]
    snapshot = list(room.transcript)
    languages = room.caption_languages()  # 참석 지점들의 언어만(Q12)
    started = time.monotonic()
    results = await asyncio.gather(
        *(engine.summarize(snapshot, code) for code in languages),
        return_exceptions=True,
    )
    texts: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    for code, result in zip(languages, results):
        if isinstance(result, SummaryUnavailable):
            errors[code] = str(result)
        elif isinstance(result, BaseException):
            logger.error("[summary] 실패 - 방=%s 언어=%s", room.code, code, exc_info=result)
            errors[code] = "회의 정리에 실패했습니다."
        else:
            texts[code] = result
    logger.info("[summary] 회의 정리 - 방=%s 요청자=%s 엔진=%s 자막=%d건 성공=%s 실패=%s 소요=%.1f초",
                room.code, participant.name, engine.label, len(snapshot), list(texts), list(errors),
                time.monotonic() - started)
    if not texts:
        await send_json(participant, {"type": "summary_failed", "engine": engine.label,
                                      "message": next(iter(errors.values()))})
        return
    await send_json(participant, {"type": "summary", "engine": engine.label, "texts": texts, "errors": errors})


async def handle_command(room: Room, participant: Participant, raw: str) -> None:
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        await send_json(participant, {"type": "error", "message": "잘못된 메시지 형식"})
        return

    kind = message.get("type")

    if kind in RTC_TYPES:
        target = room.participants.get(str(message.get("to") or ""))
        if target is None or target.id == participant.id:
            return  # 이미 나간 상대. 브라우저가 참가자 목록으로 정리한다.
        relay = {"type": kind, "from": participant.id, "from_kind": participant.kind}
        if kind == "rtc_ice":
            relay["candidate"] = message.get("candidate")
        else:
            relay["sdp"] = message.get("sdp")
        await send_json(target, relay)
        return

    if kind == "relay_usage":
        # 각 PC 가 자기 중계(TURN) 할당으로 오간 바이트 증가분을 보낸다. 합계 = Metered 사용량 근사(Q3·Q4).
        add_relay_usage(room, message.get("bytes"))
        return

    if participant.kind == CAMERA:
        # 휴대폰 카메라는 영상 연결 신호·중계 사용량만 주고받는다.
        await send_json(participant, {"type": "error", "message": "휴대폰 카메라에서는 할 수 없는 요청입니다."})
        return

    if kind == "media_state":
        participant.cam = bool(message.get("cam"))
        participant.mic = bool(message.get("mic"))
        await broadcast_participants(room)

    elif kind == "screen_share":
        # 화면 공유는 회의당 1곳. 나가면 참가자째 지워지므로 따로 풀 필요가 없다.
        on = bool(message.get("on"))
        if on:
            other = next((p for p in room.participants.values() if p.screen and p.id != participant.id), None)
            if other is not None:
                await send_json(participant, {
                    "type": "screen_share_denied",
                    "message": f"«{other.name}» 지점이 화면을 공유하고 있습니다. 공유가 끝난 뒤 다시 시도하세요.",
                })
                return
        if participant.screen != on:
            participant.screen = on
            logger.info("[screen] 공유 %s - 회의=%s 지점=%s", "시작" if on else "종료", room.code, participant.name)
            if not on:
                end_vision(room)
        await send_json(participant, {"type": "screen_share", "on": on})
        await broadcast_participants(room)

    elif kind == "screen_frame":
        await receive_screen_frame(room, participant, message)

    elif kind == "tunnel":
        await handle_tunnel(room, participant, message.get("on") is True)

    elif kind == "relay_quota":
        if not participant.is_host:
            await send_json(participant, {"type": "error", "message": "중계 사용량은 Host 만 볼 수 있습니다."})
            return
        # Metered 응답(최대 5초)을 기다리는 동안 이 소켓의 수신 루프가 막히지 않게 태스크로 돌린다.
        spawn(send_relay_quota(room, participant))

    elif kind == "relay_select":
        if not participant.is_host:
            await send_json(participant, {"type": "error", "message": "중계 서비스는 Host 만 바꿀 수 있습니다."})
            return
        choice = str(message.get("provider") or "")
        if choice not in RELAY_CHOICES:
            await send_json(participant, {"type": "error", "message": "알 수 없는 중계 서비스입니다."})
            return
        if choice == room.relay_choice:
            return
        logger.info("[relay] 중계 변경 - 회의=%s %s → %s (Host=%s)", room.code, room.relay_choice, choice, participant.name)
        room.relay_choice, room.relay_extended = choice, False
        await push_relay_config(room, reconnect=True)
        spawn(send_relay_quota(room, participant))

    elif kind == "relay_extend":
        if not participant.is_host or connection_external(participant.connection):
            await send_json(participant, {"type": "error", "message": "영상 연장은 사내망에서 접속한 Host 만 할 수 있습니다."})
            return
        if room.relay_choice != "cloudflare" or relay_budget.level() != AUDIO_ONLY or room.relay_extended:
            await send_json(participant, {"type": "error", "message": "지금은 영상 연장을 할 수 없습니다."})
            return
        room.relay_extended = True
        logger.warning("[relay] %d GB 까지 영상 연장 - 회의=%s Host=%s 최근 31일=%.1f GB", BLOCK_GB, room.code,
                       participant.name, relay_budget.used_bytes() / 1e9)
        await push_relay_config(room, reconnect=False)
        spawn(send_relay_quota(room, participant))

    elif kind == "camera_pair":
        try:
            token = room.issue_camera_token(participant.id, settings.max_cameras)
        except JoinError as error:
            await send_json(participant, {"type": "camera_pair_failed", "message": str(error)})
            return
        logger.info("[camera] 연결 코드 발급 - 회의=%s 지점=%s", room.code, participant.name)
        await send_json(participant, {
            "type": "camera_pair", "meeting": room.code, "token": token,
            "expires_in": CAMERA_TOKEN_TTL_SECONDS,
        })

    elif kind == "caption_start":
        start_captions(room, participant)

    elif kind == "caption":
        await handle_caption(room, participant, message)

    elif kind == "caption_stop":
        end_captions(room, participant, "stopped", message.get("dictation"))

    elif kind == "summarize":
        if not participant.is_host:
            await send_json(participant, {"type": "error", "message": "회의 정리는 Host 만 할 수 있습니다."})
            return
        running = summary_tasks.get(room.code)
        if running is not None and not running.done():
            await send_json(participant, {"type": "summary_failed", "message": "이미 회의 정리가 진행 중입니다."})
            return
        engine_id = str(message.get("engine") or settings.summary_engine)
        engine = summary_engines.get(engine_id)
        if engine is None:
            await send_json(participant, {"type": "summary_failed", "message": "알 수 없는 회의 정리 엔진입니다."})
            return
        if engine.unavailable_reason():
            # 준비 안 된 엔진 — 다른 엔진으로 바꾸지 않고 이유를 돌려준다(Q18).
            await send_json(participant, {"type": "summary_failed", "engine": engine.label,
                                          "message": engine.unavailable_reason()})
            return
        if not room.transcript:
            await send_json(participant, {"type": "summary_failed", "message": "정리할 자막이 아직 없습니다."})
            return
        # 응답을 기다리는 동안 이 소켓의 수신 루프가 막히지 않도록 태스크로 돌린다.
        summary_tasks[room.code] = asyncio.create_task(run_summary(room, participant, engine_id))

    elif kind == "end_room":
        if not participant.is_host:
            await send_json(
                participant,
                {"type": "error", "message": "회의 종료는 Host 만 할 수 있습니다."},
            )
            return
        for person in list(room.participants.values()):
            end_captions(room, person, "room_closed")
        await broadcast(room, {"type": "room_closed"})
        end_vision(room)
        log_relay_usage(room)
        manager.close(room.code)
        logger.info("[room] Host 종료 - %s (자막 메모리에서 삭제)", room.code)

    else:
        await send_json(participant, {"type": "error", "message": f"알 수 없는 요청: {kind}"})
