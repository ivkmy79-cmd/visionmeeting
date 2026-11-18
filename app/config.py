"""설정과 언어 레지스트리.

언어를 추가할 때는 LANGUAGES 에 항목을 넣고 ACTIVE_LANGUAGES 에 코드를 추가하면 된다.
자막은 브라우저가 만든다(Q29): speech_locale = Web Speech API 인식 언어, translate_code = Translator API 언어 코드.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Tuple

from dotenv import load_dotenv

load_dotenv()

KST_OFFSET_HOURS = 9


@dataclass(frozen=True)
class Language:
    code: str           # 앱 내부 코드
    label: str          # UI 표시명
    speech_locale: str  # 브라우저 음성 인식 언어 (SpeechRecognition.lang)
    translate_code: str # 브라우저 번역 언어 코드 (Translator API, BCP 47)
    verified: bool = False  # 실기 검증 전이면 화면에 «미검증» (CLAUDE.md)


LANGUAGES: Dict[str, Language] = {
    "ko": Language("ko", "한국어", "ko-KR", "ko"),
    "en": Language("en", "English", "en-US", "en"),
    "vi": Language("vi", "Tiếng Việt", "vi-VN", "vi"),
    "zh": Language("zh", "中文(简体)", "zh-CN", "zh"),
    "ja": Language("ja", "日本語", "ja-JP", "ja"),
}

# Q12: 한·영·베·중·일. 브라우저 자막 경로는 아직 실기 검증 전이라 모두 verified=False.
ACTIVE_LANGUAGES: Tuple[str, ...] = ("ko", "en", "vi", "zh", "ja")


def active_languages() -> Tuple[Language, ...]:
    return tuple(LANGUAGES[code] for code in ACTIVE_LANGUAGES)


def is_active(code: str) -> bool:
    return code in ACTIVE_LANGUAGES


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        # 잘못된 설정을 조용히 기본값으로 넘기지 않고 알린다.
        raise ValueError(f"{name} 는 정수여야 합니다. 현재 값: {raw!r}")


def read_credentials_file(path: str) -> Tuple[Dict[str, str], str]:
    """`KEY=VALUE` 형식의 외부 자격증명 파일을 읽는다.

    돌려주는 값은 (값 사전, 오류 메시지)이다. 오류 메시지는 UI 에 그대로 노출되므로
    파일 경로까지만 담고 값은 절대 담지 않는다.
    """
    file_path = Path(path).expanduser()
    if not file_path.is_file():
        return {}, f"자격증명 파일을 찾을 수 없습니다: {file_path}"

    values: Dict[str, str] = {}
    try:
        content = file_path.read_text(encoding="utf-8-sig")
    except OSError as error:
        return {}, f"자격증명 파일을 읽지 못했습니다: {file_path} ({error.strerror})"

    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip().strip('"').strip("'")
    return values, ""


@dataclass(frozen=True)
class Settings:
    room_passcode: str = ""  # 회의 «개설 코드». 비어 있으면 사내망(localhost/LAN)에서만 개설 가능
    max_sites: int = 4       # 회의당 접속 지점(PC) 수 상한 - P2P 메시 한계
    max_languages: int = 3   # 회의당 언어 수 상한 (Q12)
    max_cameras: int = 2     # 회의당 휴대폰 보조 카메라 상한(지점당 1대, Q24)
    lan_url: str = ""        # 사내망 주소(https://<서버 IP>:8443). 실행기가 넘긴다. QR 주소용(Q26)
    metered_app_name: str = ""  # Metered 앱 이름(<이름>.metered.live). 비밀 아님
    metered_api_key: str = ""   # Metered TURN API 키. 키 파일 또는 .env(.env 우선)
    metered_turn_host: str = ""      # 고정 중계 정보: 서버 주소(예: asia-east.relay.metered.ca). 비밀 아님
    metered_turn_username: str = ""  # 고정 중계 정보: username. 키 파일 또는 .env
    metered_turn_password: str = ""  # 고정 중계 정보: password(비밀). 키 파일 또는 .env
    metered_secret_key: str = ""     # Metered 계정 Secret Key(사용량 조회용, 계정 전체 권한). 키 파일 또는 .env
    relay_default: str = "cloudflare"  # 회의 기본 중계(Q34) — cloudflare | metered. Host 가 회의마다 바꿀 수 있다
    cloudflare_turn_key_id: str = ""         # Cloudflare TURN 키 ID(비밀 아님). 키 파일 또는 .env
    cloudflare_turn_key_api_token: str = ""  # TURN 키 API 토큰(비밀) — 임시 접속 정보 발급용
    cloudflare_account_id: str = ""          # Cloudflare 계정 ID(비밀 아님) — 사용량 조회용
    cloudflare_api_token: str = ""           # Account Analytics Read 전용 API 토큰(비밀) — 사용량 조회용
    relay_usage_file: str = ""               # 내부 중계 집계 저장 파일(바이트 수만). 비우면 data/relay_usage.json
    summary_engine: str = "claude"    # 회의 정리 기본 엔진(Q18) — claude | codex (EXAONE 은 Q33 으로 제거)
    credentials_path: str = ""
    credentials_error: str = ""



def _secret(name: str, credentials: Dict[str, str]) -> str:
    """환경변수(.env)가 우선, 없으면 저장소 밖 자격증명 파일."""
    return os.getenv(name, "").strip() or credentials.get(name, "")


def load_settings() -> Settings:
    # .env 가 가리키는 외부 자격증명 파일. 키 자체는 저장소 밖에만 둔다.
    # 변수 이름(AZURE_CREDENTIALS_FILE)은 기존 .env 호환을 위해 유지한다 — Azure 를 쓰지 않아도 키 파일 경로로 쓴다.
    credentials_path = os.getenv("AZURE_CREDENTIALS_FILE", "").strip()
    credentials: Dict[str, str] = {}
    credentials_error = ""
    if credentials_path:
        credentials, credentials_error = read_credentials_file(credentials_path)

    # 환경변수를 직접 지정했으면 그쪽이 우선하고, 없을 때 자격증명 파일을 쓴다.
    metered_key = (
        os.getenv("METERED_API_KEY", "").strip() or credentials.get("METERED_API_KEY", "")
    )

    return Settings(
        room_passcode=os.getenv("ROOM_PASSCODE", "").strip(),
        max_sites=_int_env("MAX_SITES", 4),
        max_languages=_int_env("MAX_MEETING_LANGUAGES", 3),
        max_cameras=_int_env("MAX_CAMERAS", 2),
        lan_url=os.getenv("LAN_URL", "").strip().rstrip("/"),
        metered_app_name=os.getenv("METERED_APP_NAME", "").strip(),
        metered_api_key=metered_key,
        # 환경변수(.env)가 우선, 없으면 저장소 밖 자격증명 파일.
        metered_turn_host=os.getenv("METERED_TURN_HOST", "").strip() or credentials.get("METERED_TURN_HOST", ""),
        metered_turn_username=os.getenv("METERED_TURN_USERNAME", "").strip() or credentials.get("METERED_TURN_USERNAME", ""),
        metered_turn_password=os.getenv("METERED_TURN_PASSWORD", "").strip() or credentials.get("METERED_TURN_PASSWORD", ""),
        metered_secret_key=os.getenv("METERED_SECRET_KEY", "").strip() or credentials.get("METERED_SECRET_KEY", ""),
        relay_default=os.getenv("RELAY_PROVIDER", "").strip().lower() or "cloudflare",
        cloudflare_turn_key_id=_secret("CLOUDFLARE_TURN_KEY_ID", credentials),
        cloudflare_turn_key_api_token=_secret("CLOUDFLARE_TURN_KEY_API_TOKEN", credentials),
        cloudflare_account_id=_secret("CLOUDFLARE_ACCOUNT_ID", credentials),
        cloudflare_api_token=_secret("CLOUDFLARE_API_TOKEN", credentials),
        relay_usage_file=os.getenv("RELAY_USAGE_FILE", "").strip(),
        summary_engine=os.getenv("SUMMARY_PROVIDER", "").strip().lower() or "claude",
        credentials_path=credentials_path,
        credentials_error=credentials_error,
    )
