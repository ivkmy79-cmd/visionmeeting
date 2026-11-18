"""회의방·참가자 상태.

메모리에만 존재한다. 디스크에 쓰지 않으며 방이 닫히면 사라진다.
WebSocket 이나 asyncio 에 의존하지 않아 단위 테스트가 가능하다.
"""
from __future__ import annotations

import hmac
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

KST = timezone(timedelta(hours=9))

MEETING_ID_DIGITS = 9
PASSWORD_DIGITS = 6
# 개설만 하고 아무도 들어오지 않은 회의를 메모리에서 치우는 기준
UNJOINED_TTL_SECONDS = 30 * 60
# 휴대폰 보조 카메라 일회용 연결 코드 유효 시간 (Q25)
CAMERA_TOKEN_TTL_SECONDS = 5 * 60

SITE = "site"      # 접속 지점(PC)
CAMERA = "camera"  # 지점에 딸린 휴대폰 보조 카메라 (지점 수에 넣지 않음, Q24)


def normalize_meeting_id(raw: str) -> str:
    """사용자가 «123-456-789» 나 공백을 섞어 입력해도 같은 회의로 본다."""
    return "".join(ch for ch in (raw or "") if ch.isdigit())


def now_kst_label() -> str:
    """UI·회의록에 표시할 KST 시각."""
    return datetime.now(KST).strftime("%H:%M:%S")


@dataclass
class Participant:
    id: str
    name: str
    speak_lang: str
    caption_lang: str
    is_host: bool = False
    connection: Any = None  # WebSocket. 상태 로직은 이 값을 해석하지 않는다.
    kind: str = SITE
    site_id: Optional[str] = None  # 보조 카메라가 딸린 지점
    cam: bool = True                # 영상 켜짐 (표시용, 지점이 알려 준 값)
    mic: bool = True
    screen: bool = False            # 화면 공유 중 (회의당 1곳, 서버가 정함)
    resume_token: str = ""          # 끊겼을 때 같은 자리로 돌아오는 토큰(Q14). 본인 welcome 에만 싣는다
    away_since: Optional[float] = None  # 연결이 끊긴 시각(monotonic). None = 연결됨

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "speak_lang": self.speak_lang,
            "caption_lang": self.caption_lang,
            "is_host": self.is_host,
            "kind": self.kind,
            "site_id": self.site_id,
            "cam": self.cam,
            "mic": self.mic,
            "screen": self.screen,
            "away": self.away_since is not None,
        }


class JoinError(Exception):
    """입장이 거부된 이유를 담는다. 메시지는 UI 에 그대로 나간다."""


class LanguageLimitError(JoinError):
    """회의 언어가 상한에 찼는데 새 언어로 들어오려 할 때. 표시명 변환은 호출부가 한다."""

    def __init__(self, languages: List[str], limit: int) -> None:
        self.languages = list(languages)
        self.limit = limit
        super().__init__(f"이 회의는 이미 {limit}개 언어({', '.join(languages)})를 쓰고 있습니다.")


@dataclass
class Room:
    code: str                 # 회의 ID (숫자만)
    password: str = ""
    host_token: str = ""
    participants: Dict[str, Participant] = field(default_factory=dict)
    transcript: List[dict] = field(default_factory=list)
    closed: bool = False
    created_at: float = field(default_factory=time.monotonic)
    ever_joined: bool = False
    wrong_password_count: int = 0
    # 일회용 연결 코드 -> (지점 id, 만료 시각 monotonic). 값은 로그에 남기지 않는다.
    camera_tokens: Dict[str, tuple] = field(default_factory=dict)
    relay_bytes: int = 0      # 이 회의의 중계(TURN) 사용량 합계 — 각 PC 보고의 합
    relay_choice: str = "cloudflare"  # 이 회의의 중계 서비스(Q34) — Host 가 회의 화면에서 바꾼다
    relay_extended: bool = False      # 900 GB «음성만» 중 사내망 Host 가 950 GB까지 영상을 연장했는지(Q31)

    # --- 입장 검사 ------------------------------------------------------
    def password_matches(self, password: str) -> bool:
        return hmac.compare_digest((password or "").strip(), self.password)

    def is_host_token(self, token: str) -> bool:
        return bool(token) and hmac.compare_digest(token, self.host_token)

    def sites(self) -> List[Participant]:
        return [p for p in self.participants.values() if p.kind == SITE]

    def cameras(self) -> List[Participant]:
        return [p for p in self.participants.values() if p.kind == CAMERA]

    def cameras_of(self, site_id: str) -> List[Participant]:
        return [p for p in self.cameras() if p.site_id == site_id]

    def languages(self) -> List[str]:
        """회의에서 쓰는 언어 집합. 지점당 언어는 1개(말하기 = 자막)."""
        return sorted({p.speak_lang for p in self.sites()})

    def check_admission(self, lang: str, max_sites: int, max_languages: int,
                        as_host: bool) -> None:
        if self.closed:
            raise JoinError("이미 종료된 회의입니다.")
        if len(self.sites()) >= max_sites:
            raise JoinError(f"이 회의는 이미 {max_sites}곳이 접속해 있어 더 들어올 수 없습니다.")
        if as_host and self.host() is not None:
            raise JoinError("Host 가 이미 입장해 있습니다. 초대 링크로 참여하세요.")
        current = self.languages()
        if lang not in current and len(current) >= max_languages:
            raise LanguageLimitError(current, max_languages)

    # --- 참가자 ---------------------------------------------------------
    def add_participant(self, name: str, speak_lang: str, caption_lang: str,
                        connection: Any = None, is_host: bool = False) -> Participant:
        if self.closed:
            raise JoinError("이미 종료된 회의입니다.")
        participant = Participant(
            id=uuid.uuid4().hex[:12],
            name=name,
            speak_lang=speak_lang,
            caption_lang=caption_lang,
            is_host=is_host,  # 개설자(Host 토큰 보유)만 Host
            connection=connection,
            resume_token=secrets.token_urlsafe(24),
        )
        self.participants[participant.id] = participant
        self.ever_joined = True
        return participant

    def remove_participant(self, participant_id: str) -> Optional[Participant]:
        """퇴장 처리. 그 지점의 카메라 연결 코드도 함께 지운다."""
        participant = self.participants.pop(participant_id, None)
        if participant is None:
            return None
        self._drop_tokens_of(participant_id)
        return participant

    # --- 끊김·재연결 (Q14·Q15) -------------------------------------------
    def find_by_resume_token(self, token: str) -> Optional[Participant]:
        if not token:
            return None
        for participant in self.participants.values():
            if participant.resume_token and hmac.compare_digest(token, participant.resume_token):
                return participant
        return None

    def mark_away(self, participant_id: str, now: Optional[float] = None) -> Optional[Participant]:
        """연결이 끊긴 지점의 자리를 30초 보관한다. 화면 공유·카메라 연결 코드는 바로 푼다."""
        participant = self.participants.get(participant_id)
        if participant is None:
            return None
        participant.connection = None
        participant.away_since = time.monotonic() if now is None else now
        participant.screen = False
        self._drop_tokens_of(participant_id)
        return participant

    def resume(self, participant: Participant, connection: Any) -> None:
        participant.connection = connection
        participant.away_since = None

    def transfer_host(self) -> Optional[Participant]:
        """Host 가 없으면 가장 먼저 들어온(연결된) 지점에게 넘긴다(Q15). 옛 Host 토큰은 무효로 해 되돌림이 없게 한다."""
        if self.host() is not None:
            return None
        for participant in self.participants.values():
            if participant.kind == SITE and participant.away_since is None:
                participant.is_host = True
                self.host_token = secrets.token_urlsafe(24)
                return participant
        return None

    # --- 휴대폰 보조 카메라 ---------------------------------------------
    def _drop_tokens_of(self, site_id: str) -> None:
        for token in [t for t, (owner, _) in self.camera_tokens.items() if owner == site_id]:
            del self.camera_tokens[token]

    def _check_camera_slot(self, site: Participant, max_cameras: int) -> None:
        if self.cameras_of(site.id):
            raise JoinError("이 지점에는 이미 휴대폰 카메라가 연결돼 있습니다.")
        if len(self.cameras()) >= max_cameras:
            raise JoinError(f"이 회의에는 이미 휴대폰 카메라 {max_cameras}대가 연결돼 있습니다.")

    def issue_camera_token(self, site_id: str, max_cameras: int,
                           now: Optional[float] = None) -> str:
        """지점 전용 일회용 연결 코드를 발급한다. 같은 지점의 이전 코드는 무효로 한다."""
        site = self.participants.get(site_id)
        if site is None or site.kind != SITE:
            raise JoinError("접속 지점만 휴대폰 카메라를 연결할 수 있습니다.")
        self._check_camera_slot(site, max_cameras)
        self._drop_tokens_of(site_id)
        now = time.monotonic() if now is None else now
        token = secrets.token_urlsafe(16)
        self.camera_tokens[token] = (site_id, now + CAMERA_TOKEN_TTL_SECONDS)
        return token

    def redeem_camera_token(self, token: str, max_cameras: int,
                            now: Optional[float] = None) -> Participant:
        """연결 코드를 소모하고 그 코드의 지점을 돌려준다. 실패해도 코드는 다시 쓸 수 없다."""
        now = time.monotonic() if now is None else now
        record = self.camera_tokens.pop(token or "", None)
        if self.closed:
            raise JoinError("이미 종료된 회의입니다.")
        if record is None or now > record[1]:
            raise JoinError("연결 코드가 만료됐거나 이미 사용됐습니다. 지점 PC 에서 QR 을 새로 띄우세요.")
        site = self.participants.get(record[0])
        if site is None:
            raise JoinError("QR 을 띄운 지점이 회의에 없습니다.")
        self._check_camera_slot(site, max_cameras)
        return site

    def add_camera(self, site: Participant, connection: Any = None) -> Participant:
        camera = Participant(
            id=uuid.uuid4().hex[:12],
            name=f"{site.name} · 현장 카메라",
            speak_lang=site.speak_lang,
            caption_lang=site.caption_lang,
            connection=connection,
            kind=CAMERA,
            site_id=site.id,
            mic=False,
        )
        self.participants[camera.id] = camera
        return camera

    def host(self) -> Optional[Participant]:
        for participant in self.participants.values():
            if participant.is_host:
                return participant
        return None

    def is_empty(self) -> bool:
        return not self.participants

    # --- 자막 -----------------------------------------------------------
    def append_final(self, speaker: Participant, original: str,
                     translations: Dict[str, str]) -> dict:
        entry = {
            "id": uuid.uuid4().hex[:12],
            "speaker_id": speaker.id,
            "speaker": speaker.name,
            "time_kst": now_kst_label(),
            "source_lang": speaker.speak_lang,
            "original": original,
            "translations": dict(translations),
        }
        self.transcript.append(entry)
        return entry

    def caption_languages(self) -> List[str]:
        """현재 방에서 필요한 자막 언어 집합."""
        return sorted({p.caption_lang for p in self.sites()})


class RoomManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}

    def create(self) -> Room:
        """무작위 회의 ID·비밀번호·Host 토큰을 발급한다. 추측 가능한 값(순번·시각)을 쓰지 않는다."""
        self.prune_unjoined()
        while True:
            code = "".join(secrets.choice("0123456789") for _ in range(MEETING_ID_DIGITS))
            if code[0] != "0" and code not in self.rooms:
                break
        room = Room(
            code=code,
            password="".join(secrets.choice("0123456789") for _ in range(PASSWORD_DIGITS)),
            host_token=secrets.token_urlsafe(24),
        )
        self.rooms[code] = room
        return room

    def prune_unjoined(self, now: Optional[float] = None) -> int:
        """개설 후 아무도 들어오지 않고 오래된 회의를 치운다. 치운 수를 돌려준다."""
        now = time.monotonic() if now is None else now
        stale = [
            code for code, room in self.rooms.items()
            if not room.ever_joined and now - room.created_at > UNJOINED_TTL_SECONDS
        ]
        for code in stale:
            self.close(code)
        return len(stale)

    def get(self, code: str) -> Optional[Room]:
        return self.rooms.get(normalize_meeting_id(code))

    def close(self, code: str) -> Optional[Room]:
        """방을 닫고 메모리에서 제거한다. 자막·음성은 어디에도 남기지 않는다."""
        room = self.rooms.pop(normalize_meeting_id(code), None)
        if room is not None:
            room.closed = True
            room.transcript.clear()
            room.participants.clear()
            room.camera_tokens.clear()
        return room
