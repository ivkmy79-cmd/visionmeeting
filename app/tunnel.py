"""외부 참석용 Cloudflare Quick Tunnel 을 서버가 직접 켜고 끈다(사용자 요청 2026-11-11: «PowerShell 창 없이 프로그램 안에서»).

- Host 가 사내망에서 «외부 참석 링크» 를 누를 때만 연다. 서버를 켤 때 자동으로 열지 않는다.
- 개설 코드(ROOM_PASSCODE)가 비어 있으면 열지 않는다 — 인터넷의 누구나 회의를 만들 수 있게 되므로(CLAUDE.md).
- 계정 없는 Quick Tunnel 은 실행마다 주소가 바뀌고 가동 보장이 없는 시험용이다.
- 서버가 끝나면(lifespan) 함께 닫는다. 서버가 강제 종료되면 cloudflared 가 남을 수 있다 — 작업 관리자에서 닫는다.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
from typing import List, Optional

logger = logging.getLogger("visionmeeting.tunnel")

URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
START_TIMEOUT_SECONDS = 40


def find_cloudflared() -> Optional[str]:
    found = shutil.which("cloudflared")
    if found:
        return found
    for path in (r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe"):
        if os.path.isfile(path):
            return path
    return None


class TunnelError(RuntimeError):
    """화면에 그대로 보여 줄 수 있는 사유."""


class TunnelManager:
    def __init__(self, executable: Optional[str] = None, command: Optional[List[str]] = None) -> None:
        self._executable = executable
        self._command = command  # 테스트에서 가짜 cloudflared 를 꽂는다
        self._process: Optional[asyncio.subprocess.Process] = None
        self._reader: Optional[asyncio.Task] = None
        self.url = ""
        self.started_at = 0.0
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return bool(self.url) and self._process is not None and self._process.returncode is None

    def status(self) -> dict:
        return {"running": self.running, "url": self.url if self.running else ""}

    async def start(self, port: int) -> str:
        async with self._lock:
            if self.running:
                return self.url
            command = self._command or ([self._executable, "tunnel", "--no-autoupdate",
                                         "--url", f"https://localhost:{port}", "--no-tls-verify"]
                                        if self._executable else None)
            if not command:
                raise TunnelError("서버 PC 에 cloudflared 가 없습니다 — `winget install Cloudflare.cloudflared` 로 설치하세요.")
            try:
                self._process = await asyncio.create_subprocess_exec(
                    *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            except OSError as error:
                raise TunnelError(f"cloudflared 를 실행하지 못했습니다({type(error).__name__}).") from error
            try:
                url = await asyncio.wait_for(self._read_url(), timeout=START_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                await self._kill()
                raise TunnelError(f"{START_TIMEOUT_SECONDS}초 안에 터널 주소를 받지 못했습니다 — 인터넷 연결을 확인하세요.")
            if not url:
                await self._kill()
                raise TunnelError("cloudflared 가 주소를 주지 않고 끝났습니다 — 서버 로그의 [tunnel] 항목을 확인하세요.")
            self.url, self.started_at = url, time.monotonic()
            # 출력 버퍼가 차서 cloudflared 가 멈추지 않게 이후 출력은 계속 읽어 버린다.
            self._reader = asyncio.create_task(self._drain())
            logger.info("[tunnel] 외부 참석 주소 열림 - %s", url)
            return url

    async def _read_url(self) -> str:
        assert self._process is not None and self._process.stderr is not None
        while True:
            line = await self._process.stderr.readline()
            if not line:
                return ""
            text = line.decode("utf-8", "replace")
            match = URL_PATTERN.search(text)
            if match:
                return match.group(0)
            if " ERR " in text or "error" in text.lower():
                logger.warning("[tunnel] %s", text.strip()[:200])

    async def _drain(self) -> None:
        process = self._process
        while process is not None and process.stderr is not None:
            line = await process.stderr.readline()
            if not line:
                break
        if process is not None and process is self._process and process.returncode is not None:
            logger.warning("[tunnel] cloudflared 가 끝났습니다(코드 %s) - 외부 참석 주소 닫힘", process.returncode)
            self.url = ""

    async def _kill(self) -> None:
        process, self._process = self._process, None
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()

    async def stop(self) -> None:
        async with self._lock:
            had = self.running
            if self._reader is not None:
                self._reader.cancel()
                self._reader = None
            await self._kill()
            self.url = ""
            if had:
                logger.info("[tunnel] 외부 참석 주소 닫음")
