"""공유 화면 분석 — 모의(MOCK) MOSS-VL (Q1·Q10).

GPU 가 없어 실제 MOSS-VL 은 돌리지 않는다. 이 Provider 는 파이프라인 자리만 만든다:
프레임을 받아 «무엇을 받았는지»만 돌려주고, 내용을 지어내지 않는다. 결과에는 반드시 mock=True.
프레임은 디스크에 쓰지 않고 호출이 끝나면 버린다. GPU 확보 후 같은 인터페이스(analyze)로 교체한다.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    seq: int          # 이번 공유에서 몇 번째로 받은 프레임
    width: int
    height: int
    size: int         # JPEG 바이트 수
    sharer: str       # 공유 지점 이름


class MockVisionProvider:
    mock = True
    name = "MOSS-VL (모의)"

    def __init__(self, delay_seconds: float = 0.3) -> None:
        self.delay_seconds = delay_seconds  # 실제 모델의 처리 시간 자리(대기열 1칸 동작을 보이게)

    async def analyze(self, jpeg: bytes, frame: Frame) -> dict:
        await asyncio.sleep(self.delay_seconds)
        return {
            "mock": True,
            "engine": self.name,
            "text": (f"«{frame.sharer}» 공유 화면 프레임 #{frame.seq} 수신 ({frame.width}×{frame.height}, "
                     f"{round(frame.size / 1024)}KB, 화면 변경 감지). 실제 화면 분석은 MOSS-VL(GPU) 연결 후 제공됩니다."),
        }
