"""회의 정리(요약) 엔진 — Claude Code CLI · Codex CLI (Q17·Q18). DeepSeek 은 유료라 제거(Q19),
EXAONE 은 API 약관(비상업·제3자 입력·타인 개인정보 입력 금지)상 업무 회의에 쓸 수 없어 제거(Q33).

- Host 가 엔진을 고른다. 준비 안 된 엔진은 사유와 함께 비활성, 실패해도 다른 엔진으로 자동 전환하지 않는다
  (자막이 Host 가 고르지 않은 회사로 가지 않게).
- 자막은 메모리에서만 읽어 보내고, 요약 결과도 서버에 저장하지 않는다. 가짜 요약을 만들지 않는다.
- CLI 엔진: 도구·파일 접근을 끄고(빈 작업 폴더) 자막은 표준 입력으로만 넘긴다. 시간 제한·동시 1건.
  API 키 환경변수를 지워 구독 로그인 경로만 쓰게 한다(API 과금 방지).
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from typing import Dict, List, Optional

from ..config import LANGUAGES

logger = logging.getLogger("visionmeeting.summary")

CLI_TIMEOUT_SECONDS = 180
# CLI 실행 때 지우는 환경변수 — 남아 있으면 구독 대신 API(과금)로 붙을 수 있다.
API_KEY_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
               "AZURE_OPENAI_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX")

# 요약 구조는 여기 한 곳에서만 정한다. 결과는 «## 제목» + «- 항목» 형식의 텍스트다.
# 절 제목·라벨을 언어별로 직접 주어야 모델이 제목을 원문(한국어)으로 남기지 않는다.
SECTION_LABELS = {
    "ko": {
        "sections": ["회의 개요", "주요 논의 내용", "결정 사항", "할 일", "미결·후속 논의 사항"],
        "none": "없음", "owner": "담당", "due": "기한",
    },
    "en": {
        "sections": ["Meeting Overview", "Key Discussion Points", "Decisions", "Action Items",
                     "Open Issues and Follow-ups"],
        "none": "None", "owner": "Owner", "due": "Due",
    },
    "vi": {
        "sections": ["Tổng quan cuộc họp", "Nội dung thảo luận chính", "Quyết định", "Việc cần làm",
                     "Vấn đề còn bỏ ngỏ và theo dõi"],
        "none": "Không có", "owner": "Phụ trách", "due": "Hạn",
    },
    "zh": {
        "sections": ["会议概要", "主要讨论内容", "决定事项", "待办事项", "未决及后续事项"],
        "none": "无", "owner": "负责人", "due": "截止",
    },
    "ja": {
        "sections": ["会議の概要", "主な議論", "決定事項", "アクション項目", "未決・今後の検討事項"],
        "none": "なし", "owner": "担当", "due": "期限",
    },
}

SYSTEM_PROMPT = """당신은 다국어 회의의 서기입니다. 아래 회의 자막을 읽고 회의 정리 문서를 작성합니다.

규칙:
- 모든 문장을 반드시 {language} 로만 작성합니다. 자막의 원문 언어가 달라도 모두 {language} 로 옮깁니다.
  절 제목·라벨도 아래에 적힌 {language} 표기를 글자 그대로 사용하고, 한국어 제목을 남기지 않습니다.
- 자막에 없는 내용을 지어내지 않습니다. 확인되지 않은 수치·이름·기한을 만들지 않습니다.
- 아래 5개 절을 이 순서와 제목으로 작성합니다. 해당 내용이 없는 절은 «- {none}» 한 줄만 둡니다.
- 각 절은 «## 제목» 한 줄 뒤에 «- » 로 시작하는 항목을 씁니다. 다른 마크다운(굵게, 표, 코드)은 쓰지 않습니다.
- 네 번째 절(할 일)의 항목에는 담당자·기한이 자막에 언급된 경우에만 «({owner}: 이름, {due}: 날짜)» 를 붙입니다.
- 정리 문서만 출력합니다. 인사말·설명·질문을 덧붙이지 않습니다.

절 제목 (이 표기를 그대로 사용):
{sections}"""


def build_system_prompt(language: str) -> str:
    labels = SECTION_LABELS.get(language, SECTION_LABELS["en"])
    lang_label = LANGUAGES[language].label if language in LANGUAGES else language
    return SYSTEM_PROMPT.format(
        language=lang_label,
        none=labels["none"], owner=labels["owner"], due=labels["due"],
        sections="\n".join(f"## {title}" for title in labels["sections"]),
    )


class SummaryUnavailable(RuntimeError):
    pass


def transcript_to_text(transcript: List[dict]) -> str:
    """LLM 에 보낼 자막 원문. 번역본은 빼고 원문만 보낸다(번역은 각 브라우저에만 있다)."""
    lines = []
    for entry in transcript:
        lang = LANGUAGES.get(entry.get("source_lang", ""), None)
        label = lang.label if lang else entry.get("source_lang", "?")
        lines.append(f"[{entry['time_kst']}] {entry['speaker']} ({label}): {entry['original']}")
    return "\n".join(lines)


def check_result(text: str) -> str:
    """빈 응답·형식이 전혀 다른 응답을 성공으로 보지 않는다(조용한 결손 방지)."""
    text = (text or "").strip()
    if not text:
        raise SummaryUnavailable("요약 결과가 비어 있습니다.")
    if "## " not in text:
        raise SummaryUnavailable("요약 결과 형식이 예상과 다릅니다(«## 제목» 없음).")
    return text


class SummaryEngine:
    id = ""
    label = ""
    sends_to = ""  # 자막이 전송되는 회사 — 엔진 선택 화면에 함께 보인다(architecture §6)

    def status(self) -> dict:
        reason = self.unavailable_reason()
        return {"id": self.id, "label": self.label, "sends_to": self.sends_to,
                "state": "unconfigured" if reason else "configured", "reason": reason}

    def unavailable_reason(self) -> str:
        return ""

    async def summarize(self, transcript: List[dict], language: str) -> str:
        raise NotImplementedError


class CliEngine(SummaryEngine):
    """구독 로그인된 CLI(Claude Code·Codex)를 도구 없이 실행해 표준 입력의 자막을 정리시킨다."""

    def __init__(self, executable: Optional[str], install_hint: str,
                 timeout_seconds: float = CLI_TIMEOUT_SECONDS) -> None:
        self._executable = executable
        self._install_hint = install_hint
        self._timeout = timeout_seconds
        self._lock = asyncio.Lock()  # 동시 1건

    def unavailable_reason(self) -> str:
        return "" if self._executable else self._install_hint

    def command(self, language: str, workdir: str) -> List[str]:
        raise NotImplementedError

    def stdin_text(self, transcript: List[dict], language: str) -> str:
        return transcript_to_text(transcript)

    def read_output(self, stdout: str, workdir: str) -> str:
        return stdout

    async def summarize(self, transcript: List[dict], language: str) -> str:
        if self.unavailable_reason():
            raise SummaryUnavailable(self.unavailable_reason())
        env = {k: v for k, v in os.environ.items() if k not in API_KEY_ENV}
        async with self._lock:
            # 빈 임시 폴더에서 실행 — 프로젝트 파일·CLAUDE.md 를 읽을 수 없게.
            with tempfile.TemporaryDirectory(prefix="summary-") as workdir:
                try:
                    process = await asyncio.create_subprocess_exec(
                        *self.command(language, workdir), cwd=workdir, env=env,
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                except OSError as error:
                    raise SummaryUnavailable(f"{self.label} 를 실행하지 못했습니다({type(error).__name__}).") from error
                try:
                    out, err = await asyncio.wait_for(
                        process.communicate(self.stdin_text(transcript, language).encode("utf-8")),
                        timeout=self._timeout)
                except asyncio.TimeoutError as error:
                    process.kill()
                    await process.wait()
                    raise SummaryUnavailable(f"{self.label} 가 {int(self._timeout)}초 안에 끝나지 않았습니다.") from error
                text = self.read_output(out.decode("utf-8", "replace"), workdir)
        if process.returncode != 0:
            # 오류 출력은 로그에 앞부분만(자막 내용이 섞일 수 있어 화면에는 내보내지 않는다).
            logger.warning("[summary] %s 종료 코드 %s - %s", self.label, process.returncode,
                           err.decode("utf-8", "replace")[:200].replace("\n", " "))
            raise SummaryUnavailable(f"{self.label} 실행이 실패했습니다(종료 코드 {process.returncode}). "
                                     "서버 PC 에서 로그인 상태를 확인하세요.")
        return check_result(text)


class ClaudeCodeEngine(CliEngine):
    id, label, sends_to = "claude", "Claude Code", "Anthropic"

    def command(self, language: str, workdir: str) -> List[str]:
        # --tools "" = 모든 도구 끔, --safe-mode = CLAUDE.md·스킬·훅 끔(인증은 그대로),
        # --strict-mcp-config = MCP 서버 없음, --no-session-persistence = 대화 기록 남기지 않음.
        return [self._executable, "-p", "--tools", "", "--safe-mode", "--strict-mcp-config",
                "--no-session-persistence", "--output-format", "text",
                "--system-prompt", build_system_prompt(language), "표준 입력의 회의 자막을 정리하세요."]


class CodexEngine(CliEngine):
    id, label, sends_to = "codex", "Codex", "OpenAI"

    def command(self, language: str, workdir: str) -> List[str]:
        # codex-cli 0.167 실측 옵션: 읽기 전용 샌드박스, 대화 기록 안 남김(--ephemeral), 사용자 설정 안 읽음(인증은 유지),
        # 지시·자막은 표준 입력(«-»), 최종 답만 파일로(-o).
        return [self._executable, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
                "--ignore-user-config", "--color", "never", "-o", os.path.join(workdir, "answer.txt"), "-"]

    def stdin_text(self, transcript: List[dict], language: str) -> str:
        return build_system_prompt(language) + "\n\n회의 자막:\n" + transcript_to_text(transcript)

    def read_output(self, stdout: str, workdir: str) -> str:
        # 최종 답만 파일(-o)로 받는다 — 진행 로그가 결과에 섞이지 않게. 파일이 없으면 표준 출력.
        answer = os.path.join(workdir, "answer.txt")
        if os.path.exists(answer):
            with open(answer, encoding="utf-8", errors="replace") as handle:
                return handle.read()
        return stdout


ENGINE_ORDER = ("claude", "codex")


def find_cli(name: str) -> Optional[str]:
    """PATH 에 없어도 흔한 설치 위치를 본다(npm 전역 = %APPDATA%\npm, 2026-11-11: PATH 차이로 «미설치» 오판)."""
    found = shutil.which(name)
    if found:
        return found
    candidates = [os.path.join(os.environ.get("APPDATA", ""), "npm", f"{name}.cmd"),
                  os.path.join(os.path.expanduser("~"), ".local", "bin", f"{name}.exe")]
    return next((path for path in candidates if path and os.path.isfile(path)), None)


def build_summary_engines(settings) -> Dict[str, SummaryEngine]:
    return {
        "claude": ClaudeCodeEngine(find_cli("claude"),
                                   "서버 PC 에 Claude Code CLI 가 없습니다 — 설치 후 `claude` 로 로그인하세요."),
        "codex": CodexEngine(find_cli("codex"),
                             "서버 PC 에 Codex CLI 가 없습니다 — `npm i -g @openai/codex` 설치 후 `codex login` 하세요."),
    }
