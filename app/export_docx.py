"""회의록 DOCX 생성 - 메모리에서만 만들고 디스크에 쓰지 않는다."""
from __future__ import annotations

from io import BytesIO
from typing import Dict, List

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

from .config import LANGUAGES

_FONT = "맑은 고딕"


def _set_font(style) -> None:
    style.font.name = _FONT
    style.element.rPr.rFonts.set(qn("w:eastAsia"), _FONT)


def _add_summary(doc, summary: str) -> None:
    """Provider 가 돌려준 «## 제목 / - 항목» 텍스트를 제목·글머리표로 옮긴다."""
    for raw in summary.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=2)
        elif line.startswith("- "):
            doc.add_paragraph(line[2:].strip(), style="List Bullet")
        else:
            doc.add_paragraph(line)


def build_minutes_docx(
    room_code: str,
    entries: List[dict],
    caption_lang: str,
    summaries: Dict[str, str],
    generated_at_kst: str,
    engine: str = "",
) -> bytes:
    doc = Document()
    _set_font(doc.styles["Normal"])
    doc.styles["Normal"].font.size = Pt(10.5)
    for name in ("Heading 1", "Heading 2"):
        _set_font(doc.styles[name])

    doc.add_heading(f"회의록 - {room_code}", level=1)
    doc.add_paragraph(f"생성 시각: {generated_at_kst} KST · 발언 {len(entries)}건")

    # 활성 언어 순서(한국어·영어·베트남어)대로 정리 결과를 넣는다.
    for code in LANGUAGES:
        text = summaries.get(code)
        if not text:
            continue
        doc.add_heading(f"회의 정리 ({LANGUAGES[code].label})", level=1)
        if engine:
            doc.add_paragraph(f"정리 엔진: {engine}")  # Q18: 결과·DOCX 에 엔진명
        _add_summary(doc, text)

    lang = LANGUAGES.get(caption_lang)
    doc.add_heading("전체 자막" + (f" (번역: {lang.label})" if lang else ""), level=1)
    for entry in entries:
        meta = doc.add_paragraph()
        run = meta.add_run(f"[{entry.get('time_kst', '')}] {entry.get('speaker', '')}")
        run.bold = True
        translations = entry.get("translations") or {}
        translated = translations.get(caption_lang)
        original = entry.get("original", "")
        if translated and translated != original:
            doc.add_paragraph(translated)
            doc.add_paragraph(f"원문: {original}")
        else:
            doc.add_paragraph(original)

    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()
