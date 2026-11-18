// 사용 설명서 — 테마 전환 + 서버 설정값(지점 수·언어·카메라 수)을 읽어 본문 숫자를 채운다.
// 서버 상태를 못 읽으면 HTML 에 적힌 기본값을 그대로 둔다.

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const next = theme === "dark" ? "밝은 화면으로" : "어두운 화면으로";
  for (const button of document.querySelectorAll(".theme-toggle")) {
    button.querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    button.setAttribute("aria-label", next);
    button.title = next;
  }
}

function toggleTheme() {
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  try { localStorage.setItem("translator-theme", theme); } catch (error) { /* 저장 불가 환경 */ }
  applyTheme(theme);
}

function fill(name, value) {
  if (value === undefined || value === null || value === "") return;
  document.querySelectorAll(`[data-fill="${name}"]`).forEach((node) => { node.textContent = String(value); });
}

function fillLanguages(languages) {
  if (!Array.isArray(languages) || !languages.length) return;
  const list = document.getElementById("lang-list");
  list.replaceChildren(...languages.map((lang) => {
    const item = document.createElement("li");
    const chip = document.createElement("span");
    chip.className = "ui";
    chip.textContent = lang.verified ? lang.label : `${lang.label} (미검증)`;
    item.appendChild(chip);
    return item;
  }));
  if (languages.every((lang) => lang.verified)) document.getElementById("lang-note").hidden = true;
}

async function loadSettings() {
  const response = await fetch("/api/status");
  if (!response.ok) return;
  const status = await response.json();
  for (const [name, value] of Object.entries(status.limits || {})) fill(name, value);
  fill("lan_url", status.lan_url);
  fillLanguages(status.languages);
}

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
  document.querySelectorAll(".theme-toggle").forEach((button) => button.addEventListener("click", toggleTheme));
  loadSettings().catch(() => { /* 기본값 유지 */ });
});
