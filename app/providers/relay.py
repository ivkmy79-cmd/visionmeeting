"""외부(다른 망) 참석자용 WebRTC 중계(TURN) 접속 정보.

Cloudflare Realtime TURN(기본, 매달 1,000 GB 무료·넘으면 과금 — Q34)은 파일 아래쪽 CloudflareRelay·CloudflareUsage.
아래는 Metered TURN 무료 요금제 (현재 Free Trial 월 500 MB, 한도에서 멈춤, Q3·Q4).

설정 방법 두 가지 (고정 정보가 하나라도 있으면 그쪽을 쓴다):
1. 고정 정보(권장): 대시보드 Credentials 에서 만든 서버 주소·username·password 를 그대로 쓴다. 외부 요청 없음.
2. API: 아래 주소로 접속 정보를 물어 온다.

Metered API: GET https://<앱 이름>.metered.live/api/v1/turn/credentials?apiKey=<키>
→ 브라우저 RTCPeerConnection 에 그대로 넣는 iceServers 배열(2026-11-11 공식 문서 확인).

- 키는 Metered 가 주소(쿼리)로만 받는다. 그래서 요청 주소·예외 문구를 로그에 남기지 않는다
  (httpx 는 INFO 로 요청 주소를 찍고, HTTPStatusError 문구에도 주소가 들어간다).
- 미설정·실패를 성공으로 보이지 않는다: 공개 STUN 만 돌려주고 사유를 함께 준다.
  STUN 만으로도 집·사무실 공유기 대부분은 연결되지만, 회사 방화벽 뒤 참석자는 TURN 이 없으면 연결되지 않는다.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional, Tuple

import httpx

from ..config import KST_OFFSET_HOURS

logger = logging.getLogger("visionmeeting.relay")
# httpx 는 INFO 로 요청 주소 전체(= apiKey 포함)를 찍는다. 이 모듈을 불러오는 순간 막아,
# main.py 를 거치지 않는 경로(단독 테스트·다른 진입점)에서도 키가 로그에 남지 않게 한다.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

# 계정이 필요 없는 공개 STUN(무료). 내 공인 주소를 알아내는 데만 쓰고 영상은 지나가지 않는다.
PUBLIC_STUN = [{"urls": "stun:stun.l.google.com:19302"}]
CACHE_SECONDS = 60 * 60       # 받은 중계 정보를 메모리에 두는 시간
RETRY_SECONDS = 60            # 실패 후 다시 묻기까지의 간격(입장마다 Metered 를 두드리지 않게)
TIMEOUT_SECONDS = 5.0
# Metered 가입 화면: 공백 없이, 특수문자는 - _ 만 허용(2026-11-11 사용자 캡처). 주소 주입을 막으려고 그 밖의 글자는 거부한다.
APP_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
HOST_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
STATIC_NAMES = ("METERED_TURN_HOST", "METERED_TURN_USERNAME", "METERED_TURN_PASSWORD")


class RelayProvider:
    def __init__(self, app_name: str, api_key: str, source: str,
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None,
                 turn_host: str = "", turn_username: str = "", turn_password: str = "") -> None:
        self.app_name = app_name.strip().lower()
        self.api_key = api_key.strip()
        self.turn_host = turn_host.strip().lower()
        self.turn_username = turn_username.strip()
        self.turn_password = turn_password.strip()
        self.source = source
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT_SECONDS))
        self._servers: List[dict] = []
        self._expires = 0.0
        self._error = ""
        self._retry_at = 0.0
        self._lock = asyncio.Lock()

    def _static_values(self) -> tuple:
        return (self.turn_host, self.turn_username, self.turn_password)

    def _uses_static(self) -> bool:
        return any(self._static_values())

    def _missing(self, names) -> str:
        return (f"{self.source} 에 " + ", ".join(names) + " 값이 비어 있습니다 — "
                "다른 망(회사 방화벽 뒤) 참석자는 연결되지 않을 수 있습니다.")

    def _config_error(self) -> str:
        if self._uses_static():
            missing = [name for name, value in zip(STATIC_NAMES, self._static_values()) if not value]
            if missing:
                return self._missing(missing)
            if not HOST_PATTERN.match(self.turn_host):
                return "METERED_TURN_HOST 형식이 올바르지 않습니다(예: asia-east.relay.metered.ca)."
            wrapped = [name for name, value in zip(STATIC_NAMES[1:], self._static_values()[1:])
                       if value.startswith("<") or value.endswith(">")]
            if wrapped:
                # 안내 예시 «<값>» 의 꺾쇠까지 붙여 넣으면 중계 서버가 400 으로 거부한다(2026-11-11 실측).
                return ", ".join(wrapped) + " 값에 꺾쇠(< >)가 들어 있습니다 — 예시 표시를 지우고 값만 넣으세요."
            return ""
        if not self.app_name and not self.api_key:
            return self._missing(list(STATIC_NAMES) + ["(또는 METERED_APP_NAME", "METERED_API_KEY)"])
        missing = [name for name, value in (("METERED_APP_NAME", self.app_name), ("METERED_API_KEY", self.api_key))
                   if not value]
        if missing:
            return self._missing(missing)
        if not APP_NAME_PATTERN.match(self.app_name):
            return "METERED_APP_NAME 형식이 올바르지 않습니다(영문·숫자·- _ 만, 예: myapp)."
        return ""

    def _static_servers(self) -> List[dict]:
        """대시보드 «RTCConfiguration snippet» 과 같은 구성(STUN 1 + TURN 80/443, UDP·TCP·TLS)."""
        host = self.turn_host
        auth = {"username": self.turn_username, "credential": self.turn_password}
        urls = (f"turn:{host}:80", f"turn:{host}:80?transport=tcp",
                f"turn:{host}:443", f"turns:{host}:443?transport=tcp")
        return [{"urls": "stun:stun.relay.metered.ca:80"}] + [dict(urls=url, **auth) for url in urls]

    def status(self) -> dict:
        """UI 표시용. 값은 넣지 않는다."""
        error = self._config_error() or self._error
        if error:
            return {"state": "unconfigured", "label": "외부 중계 없음", "reason": error}
        return {"state": "configured", "label": "외부 중계 준비됨", "reason": ""}

    async def ice_servers(self) -> Tuple[List[dict], dict]:
        """(브라우저에 줄 iceServers, 상태). 실패해도 예외 대신 공개 STUN 을 준다."""
        if self._config_error():
            return list(PUBLIC_STUN), self.status()
        if self._uses_static():
            return self._static_servers(), self.status()
        async with self._lock:
            now = time.monotonic()
            if self._servers and now < self._expires:
                return list(self._servers), self.status()
            if self._error and now < self._retry_at:
                return list(PUBLIC_STUN), self.status()
            servers, error = await self._fetch()
            if error:
                self._error, self._retry_at = error, now + RETRY_SECONDS
                self._servers = []
                return list(PUBLIC_STUN), self.status()
            self._servers, self._expires, self._error = servers, now + CACHE_SECONDS, ""
            return list(servers), self.status()

    async def _fetch(self) -> Tuple[List[dict], str]:
        url = f"https://{self.app_name}.metered.live/api/v1/turn/credentials"
        try:
            async with self._client_factory() as client:
                response = await client.get(url, params={"apiKey": self.api_key})
        except httpx.HTTPError as error:
            # 예외 문구에 주소(=키)가 들어갈 수 있어 종류만 남긴다.
            logger.warning("[relay] 중계 정보 요청 실패 - %s", type(error).__name__)
            return [], f"중계 서버(Metered)에 연결하지 못했습니다({type(error).__name__})."
        if response.status_code != 200:
            logger.warning("[relay] 중계 정보 거부 - HTTP %d", response.status_code)
            hint = " — METERED_API_KEY·METERED_APP_NAME 을 확인하세요" if response.status_code in (401, 403, 404) else ""
            return [], f"중계 서버(Metered)가 요청을 거부했습니다(HTTP {response.status_code}){hint}."
        try:
            body = response.json()
        except ValueError:
            body = None
        servers = [entry for entry in body if isinstance(entry, dict) and entry.get("urls")] if isinstance(body, list) else []
        turn = [entry for entry in servers if any(str(url).startswith(("turn:", "turns:"))
                                                  for url in _as_list(entry["urls"]))]
        if not turn:
            # 응답은 왔지만 TURN 항목이 0건 — 성공으로 보지 않는다.
            logger.warning("[relay] 중계 정보 응답에 TURN 항목 0건 - 항목=%d", len(servers))
            return [], "중계 서버(Metered) 응답에 TURN 정보가 없습니다."
        logger.info("[relay] 중계 정보 받음 - 항목=%d (TURN %d)", len(servers), len(turn))
        return servers, ""


def _as_list(urls) -> list:
    return urls if isinstance(urls, list) else [urls]


USAGE_CACHE_SECONDS = 60  # 사용량 조회 결과를 재사용하는 시간(Host 화면이 1분마다 묻는다)
USAGE_FIELDS = ("quotaInGB", "usageInGB", "overageInGB")
KST = timezone(timedelta(hours=KST_OFFSET_HOURS))


class MeteredUsage:
    """이번 결제 주기의 Metered TURN 총량·사용량·초과량 — Host 화면 표시용.

    Metered API: GET https://<앱 이름>.metered.live/api/v1/turn/current_usage?secretKey=<키>
    → {"quotaInGB", "usageInGB", "overageInGB"} (2026-11-12 공식 문서 확인·실제 호출 HTTP 200).
    Secret Key 는 계정 전체 권한(접속 정보 생성·삭제 가능)이라 서버 안에서만 쓰고 화면에는 숫자만 보낸다.
    키를 주소(쿼리)로만 받으므로 RelayProvider 와 같이 요청 주소·예외 문구를 로그에 남기지 않는다.
    """

    def __init__(self, app_name: str, secret_key: str, source: str,
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None) -> None:
        self.app_name = app_name.strip().lower()
        self.secret_key = secret_key.strip()
        self.source = source
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT_SECONDS))
        self._result: Optional[dict] = None
        self._expires = 0.0
        self._logged: Optional[tuple] = None
        self._lock = asyncio.Lock()

    def _config_error(self) -> str:
        missing = [name for name, value in (("METERED_APP_NAME", self.app_name),
                                            ("METERED_SECRET_KEY", self.secret_key)) if not value]
        if missing:
            return f"{self.source} 에 " + ", ".join(missing) + " 값이 비어 있습니다."
        if not APP_NAME_PATTERN.match(self.app_name):
            return "METERED_APP_NAME 형식이 올바르지 않습니다(영문·숫자·- _ 만, 예: myapp)."
        if self.secret_key.startswith("<") or self.secret_key.endswith(">"):
            return "METERED_SECRET_KEY 값에 꺾쇠(< >)가 들어 있습니다 — 예시 표시를 지우고 값만 넣으세요."
        return ""

    async def current(self) -> dict:
        """{"ok": True, quota_gb, used_gb, remaining_gb, overage_gb, checked_at} 또는 {"ok": False, reason}."""
        error = self._config_error()
        if error:
            return {"ok": False, "reason": error}
        async with self._lock:
            now = time.monotonic()
            if self._result is None or now >= self._expires:
                # 실패도 1분 동안 재사용한다 — Host 화면이 여러 개여도 Metered 를 두드리지 않게.
                self._result, self._expires = await self._fetch(), now + USAGE_CACHE_SECONDS
            return dict(self._result)

    async def _fetch(self) -> dict:
        url = f"https://{self.app_name}.metered.live/api/v1/turn/current_usage"
        try:
            async with self._client_factory() as client:
                response = await client.get(url, params={"secretKey": self.secret_key})
        except httpx.HTTPError as error:
            logger.warning("[relay] 중계 사용량 요청 실패 - %s", type(error).__name__)
            return {"ok": False, "reason": f"Metered 에 연결하지 못했습니다({type(error).__name__})."}
        if response.status_code != 200:
            logger.warning("[relay] 중계 사용량 거부 - HTTP %d", response.status_code)
            if response.status_code == 400:
                hint = " — Metered 계정에 TURN 요금제가 없습니다"
            elif response.status_code in (401, 403, 404):
                hint = " — METERED_SECRET_KEY·METERED_APP_NAME 을 확인하세요"
            else:
                hint = ""
            return {"ok": False, "reason": f"Metered 가 사용량 요청을 거부했습니다(HTTP {response.status_code}){hint}."}
        try:
            body = response.json()
        except ValueError:
            body = None
        values = [body.get(name) for name in USAGE_FIELDS] if isinstance(body, dict) else []
        if len(values) != 3 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0
                                       for v in values):
            logger.warning("[relay] 중계 사용량 응답 형식이 다름 - %s", type(body).__name__)
            return {"ok": False, "reason": "Metered 사용량 응답 형식이 예상과 다릅니다."}
        quota, used, overage = (float(v) for v in values)
        if self._logged != (quota, used, overage):
            logger.info("[relay] Metered 사용량 - 총량=%.3f GB 사용=%.3f GB 초과=%.3f GB", quota, used, overage)
            self._logged = (quota, used, overage)
        return {"ok": True, "quota_gb": quota, "used_gb": used, "remaining_gb": max(quota - used, 0.0),
                "overage_gb": overage, "checked_at": datetime.now(KST).strftime("%H:%M")}


# --- Cloudflare Realtime TURN (Q34) ---------------------------------------------
# 공식 문서(2026-11-16 확인): https://developers.cloudflare.com/realtime/turn/generate-credentials/
#   POST https://rtc.live.cloudflare.com/v1/turn/keys/<키 ID>/credentials/generate-ice-servers
#   Authorization: Bearer <TURN 키 API 토큰>, 본문 {"ttl": 초} → 201 {"iceServers": [...]}
# 토큰은 헤더로만 보내므로 주소(로그에 남는 값)에 비밀이 들어가지 않는다.

CLOUDFLARE_TTL_SECONDS = 24 * 60 * 60     # 임시 접속 정보 유효기간(공식 예시 값)
CLOUDFLARE_CACHE_SECONDS = 12 * 60 * 60   # 발급분 재사용 시간 — 나눠 준 정보가 최소 12시간은 유효하게
CLOUDFLARE_ID_PATTERN = re.compile(r"^[A-Za-z0-9]{1,64}$")  # 주소·조회에 들어가는 ID — 그 밖의 글자는 거부
CLOUDFLARE_TURN_NAMES = ("CLOUDFLARE_TURN_KEY_ID", "CLOUDFLARE_TURN_KEY_API_TOKEN")
CLOUDFLARE_USAGE_NAMES = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")


def _named_values_error(source: str, pairs) -> str:
    """비어 있거나 꺾쇠가 붙은 항목 이름만 알려 준다(값은 넣지 않는다)."""
    missing = [name for name, value in pairs if not value]
    if missing:
        return f"{source} 에 " + ", ".join(missing) + " 값이 비어 있습니다."
    wrapped = [name for name, value in pairs if value.startswith("<") or value.endswith(">")]
    if wrapped:
        return ", ".join(wrapped) + " 값에 꺾쇠(< >)가 들어 있습니다 — 예시 표시를 지우고 값만 넣으세요."
    return ""


class CloudflareRelay:
    """Cloudflare TURN 임시 접속 정보. 실패는 예외 대신 (빈 목록, 사유)로 돌려준다."""

    def __init__(self, key_id: str, api_token: str, source: str,
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None) -> None:
        self.key_id = key_id.strip()
        self.api_token = api_token.strip()
        self.source = source
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT_SECONDS))
        self._servers: List[dict] = []
        self._expires = 0.0
        self._error = ""
        self._retry_at = 0.0
        self._lock = asyncio.Lock()

    def config_error(self) -> str:
        error = _named_values_error(self.source, zip(CLOUDFLARE_TURN_NAMES, (self.key_id, self.api_token)))
        if not error and not CLOUDFLARE_ID_PATTERN.match(self.key_id):
            error = "CLOUDFLARE_TURN_KEY_ID 형식이 올바르지 않습니다(영문·숫자만)."
        return error

    async def ice_servers(self) -> Tuple[List[dict], str]:
        error = self.config_error()
        if error:
            return [], error
        async with self._lock:
            now = time.monotonic()
            if self._servers and now < self._expires:
                return list(self._servers), ""
            if self._error and now < self._retry_at:
                return [], self._error
            servers, error = await self._fetch()
            if error:
                self._servers, self._error, self._retry_at = [], error, now + RETRY_SECONDS
                return [], error
            self._servers, self._expires, self._error = servers, now + CLOUDFLARE_CACHE_SECONDS, ""
            return list(servers), ""

    async def _fetch(self) -> Tuple[List[dict], str]:
        url = f"https://rtc.live.cloudflare.com/v1/turn/keys/{self.key_id}/credentials/generate-ice-servers"
        try:
            async with self._client_factory() as client:
                response = await client.post(url, json={"ttl": CLOUDFLARE_TTL_SECONDS},
                                             headers={"Authorization": f"Bearer {self.api_token}"})
        except httpx.HTTPError as error:
            logger.warning("[relay] Cloudflare 중계 정보 요청 실패 - %s", type(error).__name__)
            return [], f"Cloudflare 중계 서버에 연결하지 못했습니다({type(error).__name__})."
        if response.status_code not in (200, 201):
            logger.warning("[relay] Cloudflare 중계 정보 거부 - HTTP %d", response.status_code)
            hint = (" — CLOUDFLARE_TURN_KEY_ID·CLOUDFLARE_TURN_KEY_API_TOKEN 을 확인하세요"
                    if response.status_code in (401, 403, 404) else "")
            return [], f"Cloudflare 가 중계 정보 요청을 거부했습니다(HTTP {response.status_code}){hint}."
        try:
            body = response.json()
        except ValueError:
            body = None
        raw = body.get("iceServers") if isinstance(body, dict) else None
        servers = [entry for entry in raw if isinstance(entry, dict) and entry.get("urls")] if isinstance(raw, list) else []
        turn = [entry for entry in servers if any(str(url).startswith(("turn:", "turns:"))
                                                  for url in _as_list(entry["urls"]))]
        if not turn:
            logger.warning("[relay] Cloudflare 응답에 TURN 항목 0건 - 항목=%d", len(servers))
            return [], "Cloudflare 응답에 TURN 정보가 없습니다."
        logger.info("[relay] Cloudflare 중계 정보 받음 - 항목=%d (TURN %d)", len(servers), len(turn))
        return servers, ""


USAGE_WINDOW_DAYS = 31  # 최근 31일 합계(Q34) — 계정 조회 한도는 4w4d(32일), 2026-11-16 실측
GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
# 날짜(date) 차원으로 묶어 날짜별 합을 받은 뒤 더한다. 차원 없이 합계만 물으면 Cloudflare 가 오류 없이
# 틀린 값을 준다(2026-11-16 실측: 차원 없음 5,304 B / date·시간·키 차원 31,865,784 B).
USAGE_QUERY = """query($account: String!, $from: Date!, $to: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    callsTurnUsageAdaptiveGroups(limit: 100, filter: {date_geq: $from, date_leq: $to}) {
      dimensions { date } sum { egressBytes }
    }
  } }
}"""


class CloudflareUsage:
    """Cloudflare TURN 최근 31일 egress 합계(청구 기준 = Cloudflare → 사용자 방향).

    공식 문서: https://developers.cloudflare.com/realtime/turn/analytics/ (GraphQL callsTurnUsageAdaptiveGroups)
    쓴 양이 없으면 빈 목록 [] 이 온다 — 그건 유효한 0. 형식이 다르거나 오류 목록이 있으면 실패로 본다.
    """

    def __init__(self, account_id: str, api_token: str, source: str,
                 client_factory: Optional[Callable[[], httpx.AsyncClient]] = None,
                 today: Optional[Callable[[], "datetime.date"]] = None) -> None:
        self.account_id = account_id.strip()
        self.api_token = api_token.strip()
        self.source = source
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT_SECONDS))
        self._today = today or (lambda: datetime.now(timezone.utc).date())

    def config_error(self) -> str:
        error = _named_values_error(self.source, zip(CLOUDFLARE_USAGE_NAMES, (self.account_id, self.api_token)))
        if not error and not CLOUDFLARE_ID_PATTERN.match(self.account_id):
            error = "CLOUDFLARE_ACCOUNT_ID 형식이 올바르지 않습니다(영문·숫자만)."
        return error

    async def fetch_bytes(self) -> Tuple[Optional[int], str]:
        """(최근 31일 egress 바이트, 오류). 실패면 (None, 사유)."""
        error = self.config_error()
        if error:
            return None, error
        to_day = self._today()
        from_day = to_day - timedelta(days=USAGE_WINDOW_DAYS - 1)
        variables = {"account": self.account_id, "from": from_day.isoformat(), "to": to_day.isoformat()}
        try:
            async with self._client_factory() as client:
                response = await client.post(GRAPHQL_URL, json={"query": USAGE_QUERY, "variables": variables},
                                             headers={"Authorization": f"Bearer {self.api_token}"})
        except httpx.HTTPError as error:
            logger.warning("[relay] Cloudflare 사용량 요청 실패 - %s", type(error).__name__)
            return None, f"Cloudflare 사용량 조회에 연결하지 못했습니다({type(error).__name__})."
        if response.status_code != 200:
            logger.warning("[relay] Cloudflare 사용량 거부 - HTTP %d", response.status_code)
            hint = " — CLOUDFLARE_API_TOKEN(Account Analytics Read)을 확인하세요" if response.status_code in (401, 403) else ""
            return None, f"Cloudflare 가 사용량 조회를 거부했습니다(HTTP {response.status_code}){hint}."
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return None, self._shape_error("본문")
        if body.get("errors"):
            # GraphQL 은 HTTP 200 으로 오류를 돌려준다(권한 없음·기간 초과 등). 문구 앞부분만 남긴다(값·토큰 없음).
            first = body["errors"][0] if isinstance(body["errors"], list) and body["errors"] else {}
            message = str(first.get("message", "")) if isinstance(first, dict) else ""
            logger.warning("[relay] Cloudflare 사용량 조회 오류 - %s", message[:160])
            return None, f"Cloudflare 사용량 조회 오류: {message[:160] or '알 수 없음'}"
        accounts = ((body.get("data") or {}).get("viewer") or {}).get("accounts")
        if not isinstance(accounts, list) or len(accounts) != 1:
            return None, self._shape_error("계정")
        groups = accounts[0].get("callsTurnUsageAdaptiveGroups") if isinstance(accounts[0], dict) else None
        if not isinstance(groups, list):
            return None, self._shape_error("사용량 목록")
        total = 0
        for group in groups:
            value = ((group or {}).get("sum") or {}).get("egressBytes") if isinstance(group, dict) else None
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                return None, self._shape_error("egressBytes")
            total += int(value)
        return total, ""

    @staticmethod
    def _shape_error(part: str) -> str:
        logger.warning("[relay] Cloudflare 사용량 응답 형식이 다름 - %s", part)
        return f"Cloudflare 사용량 응답 형식이 예상과 다릅니다({part})."


def build_cloudflare_relay(settings) -> CloudflareRelay:
    return CloudflareRelay(settings.cloudflare_turn_key_id, settings.cloudflare_turn_key_api_token,
                           settings.credentials_path or "서버 .env")


def build_cloudflare_usage(settings) -> CloudflareUsage:
    return CloudflareUsage(settings.cloudflare_account_id, settings.cloudflare_api_token,
                           settings.credentials_path or "서버 .env")


def build_metered_usage(settings) -> MeteredUsage:
    return MeteredUsage(settings.metered_app_name, settings.metered_secret_key,
                        settings.credentials_path or "서버 .env")


def build_relay_provider(settings) -> RelayProvider:
    return RelayProvider(settings.metered_app_name, settings.metered_api_key,
                         settings.credentials_path or "서버 .env",
                         turn_host=settings.metered_turn_host,
                         turn_username=settings.metered_turn_username,
                         turn_password=settings.metered_turn_password)
