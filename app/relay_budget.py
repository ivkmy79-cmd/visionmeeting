"""Cloudflare 중계 무료 한도 지킴이(Q31·Q34) — 청구 0원을 위해 1,000 GB 전에 알리고 막는다.

- 사용량 = 최근 31일 합계. Cloudflare 조회(GraphQL)에 성공하면 그 값이 기준이고 내부 집계도 그 값으로 맞춘다.
  조회가 실패하는 동안은 «마지막으로 맞춘 값 + 그 뒤 브라우저가 보고한 중계 바이트»로 판단한다.
- 서버를 켠 뒤 조회에 한 번도 성공하지 못했으면 Cloudflare 를 켜지 않는다(키·토큰 오류를 확실히 막는다).
- 900 GB = «음성만»(audio_only), 950 GB = 차단(blocked). GB 는 10^9 바이트(작은 단위라 덜 세지 않는다).
- 내부 집계는 바이트 수만 파일에 저장한다(음성·자막 아님). 서버를 다시 켜도 이어 센다.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from .providers.relay import KST, CloudflareUsage

logger = logging.getLogger("visionmeeting.relay")

GB = 1_000_000_000
QUOTA_GB = 1000      # Cloudflare 매달 무료(SFU·TURN·MoQ 공유)
WARN_GB = 900        # 알림 + 중계 연결 «음성만»
BLOCK_GB = 950       # 무조건 차단

OK, AUDIO_ONLY, BLOCKED = "ok", "audio_only", "blocked"


def level_for(used_bytes: int) -> str:
    if used_bytes >= BLOCK_GB * GB:
        return BLOCKED
    if used_bytes >= WARN_GB * GB:
        return AUDIO_ONLY
    return OK


class RelayBudget:
    def __init__(self, usage: CloudflareUsage, path: Path, config_error: str = "") -> None:
        self.usage = usage
        self.path = Path(path)
        self.config_error = config_error  # TURN 키 쪽 설정 오류(사용량 쪽은 usage 가 직접 알려 준다)
        self.ready = False           # 이번 기동 후 Cloudflare 조회에 한 번이라도 성공했는가
        self.synced_bytes = 0        # 마지막으로 맞춘 Cloudflare 값
        self.since_sync_bytes = 0    # 그 뒤 브라우저들이 보고한 Cloudflare 중계 바이트
        self.synced_at = ""          # KST 표시용
        self.source = "internal"     # 지금 판단 근거: cloudflare | internal
        self.last_error = ""
        self._load()

    # --- 저장 ------------------------------------------------------------------
    def _load(self) -> None:
        if not self.path.is_file():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            synced, since = int(data["synced_bytes"]), int(data["since_sync_bytes"])
            if synced < 0 or since < 0:
                raise ValueError("음수")
        except (OSError, ValueError, KeyError, TypeError) as error:
            # 못 읽으면 0 부터 센다. 어차피 Cloudflare 조회에 성공해야 켜지므로 덜 셀 위험은 그때 바로잡힌다.
            logger.warning("[relay] 내부 중계 집계 파일을 읽지 못했습니다 - %s (%s)", self.path, type(error).__name__)
            return
        self.synced_bytes, self.since_sync_bytes = synced, since
        self.synced_at = str(data.get("synced_at") or "")

    def _save(self) -> None:
        data = {"synced_bytes": self.synced_bytes, "since_sync_bytes": self.since_sync_bytes,
                "synced_at": self.synced_at}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(temp, self.path)
        except OSError as error:
            logger.warning("[relay] 내부 중계 집계 저장 실패 - %s (%s)", self.path, error.strerror)

    # --- 집계 ------------------------------------------------------------------
    def used_bytes(self) -> int:
        return self.synced_bytes + self.since_sync_bytes

    def level(self) -> str:
        return level_for(self.used_bytes())

    def add(self, value: int) -> None:
        """브라우저가 보고한 Cloudflare 중계 바이트(증가분)."""
        self.since_sync_bytes += value
        self._save()

    def unavailable_reason(self) -> str:
        """Cloudflare 를 쓸 수 없는 이유. 빈 문자열이면 사용 가능(차단 단계는 level 로 따로 본다)."""
        if self.config_error:
            return self.config_error
        if not self.ready:
            return self.usage.config_error() or self.last_error or "Cloudflare 사용량을 아직 확인하지 못했습니다."
        return ""

    async def refresh(self) -> Optional[str]:
        """Cloudflare 값을 다시 읽는다. 오류 문자열(없으면 None)."""
        if self.config_error:
            return self.config_error
        value, error = await self.usage.fetch_bytes()
        if error:
            self.last_error = error
            self.source = "internal"
            return error
        before = self.used_bytes()
        self.synced_bytes, self.since_sync_bytes = int(value), 0
        self.synced_at = datetime.now(KST).strftime("%m-%d %H:%M")
        self.source, self.last_error = "cloudflare", ""
        if not self.ready or before != self.used_bytes():
            logger.info("[relay] Cloudflare 최근 31일 중계 사용량 - %.3f GB (내부 집계 %.3f GB 를 맞춤)",
                        self.used_bytes() / GB, before / GB)
        self.ready = True
        self._save()
        return None

    def status(self) -> dict:
        """Host 화면 표시용(숫자·사유만)."""
        reason = self.unavailable_reason()
        if reason:
            return {"ok": False, "reason": reason}
        used = self.used_bytes() / GB
        return {"ok": True, "quota_gb": float(QUOTA_GB), "used_gb": used,
                "remaining_gb": max(QUOTA_GB - used, 0.0), "overage_gb": max(used - QUOTA_GB, 0.0),
                "window_days": 31, "source": self.source, "level": self.level(),
                "warn_gb": WARN_GB, "block_gb": BLOCK_GB,
                "reason": self.last_error if self.source == "internal" else "",
                "checked_at": self.synced_at}
