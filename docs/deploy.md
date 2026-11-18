# VisionMeeting 다른 PC 에 설치하기 (배포 설명서)

이 설명서는 VisionMeeting **서버**를 다른 PC 에 새로 설치할 때 쓴다.
회의에 **참석만 하는 PC** 는 아무것도 설치하지 않는다. 브라우저(Chrome·Edge)만 있으면 되고,
사내망 주소로 들어올 때만 서버 운영자에게 받은 `rootCA.pem` 을 한 번 설치한다(사용 설명서 `/help` 2장).

---

## 1. 절대 넘기면 안 되는 것

아래는 원래 서버 PC 에만 있어야 한다. 메일·메신저·USB·클라우드 어디로도 보내지 않는다.

| 항목 | 왜 빼는가 |
|---|---|
| `.env`, `.env.bak` | Cloudflare TURN 토큰·사용량 조회 토큰, Metered 접속 정보, 회의 개설 코드가 들어 있다. 넘기면 남이 내 계정으로 중계를 쓰고, **카드가 등록된 Cloudflare 요금이 내게 청구될 수 있다.** |
| `.env` 가 가리키는 키 파일 (`AZURE_CREDENTIALS_FILE` 값의 경로) | 위와 같은 비밀값이 들어 있다. |
| `certs\ca\` 폴더 | **인증기관(CA) 개인키**(`rootCA-key.pem`). 이것이 있으면 이 CA 를 설치한 모든 PC 를 속이는 가짜 인증서를 만들 수 있다. 가장 위험하다. |
| `certs\localhost-key.pem` | 서버 인증서 개인키. 이 서버로 위장할 수 있다. |
| `certs\localhost.pem`, `certs\launcher.lock` | 비밀은 아니지만 원래 PC 의 IP 로 발급된 것이라 새 PC 에서는 쓸 수 없다. 새 PC 에서 다시 만든다. |
| `data\` 폴더 | 내 Cloudflare 중계 사용량 기록. 새 PC 에 가면 사용량 계산이 틀어진다. |
| `.git\` 폴더 | 커밋 이력. 작성자 이름·이메일과 지난 작업 내용이 모두 들어 있다. |
| `PLAN.md`, `CLAUDE.md`, `AGENTS.md`, `handoff.md`, `DESIGN.md` | 개발 기록. 계정 이름이 들어간 Metered 앱 이름, 내부 IP, Wi-Fi 이름, 내 PC 폴더 경로가 적혀 있다. 프로그램 실행에는 필요 없다. |
| `tests\`, `docs\visionmeeting-*.html`, `docs\architecture.md` | 개발·설명용. 실행에 필요 없다. |
| `.venv\`, `__pycache__\`, `.pytest_cache\` | 이 PC 전용 실행 환경·임시 파일. 새 PC 에서 다시 만든다. |

**내 Cloudflare·Metered 키를 새 PC 에 같이 쓰지 않는다.** 새 PC 운영자가 자기 계정을 만들어 자기 키를 넣는 것이 원칙이다(3-5).
같은 회사 계정을 일부러 함께 쓰기로 했다면, 그 키는 압축 파일에 넣지 말고 운영자에게 직접 따로 전달한다.

---

## 2. 배포 파일 만들기 (원래 서버 PC 에서)

위 1장의 파일을 하나하나 지우지 않는다. Git 이 **필요한 파일만** 골라 압축하게 한다.
이 방법은 커밋된 파일만 담으므로 `.env`·`certs`·`data`·`.venv`·커밋 이력은 처음부터 들어가지 않는다.

1. 바꾼 내용이 있으면 먼저 커밋한다(커밋되지 않은 변경은 압축에 들어가지 않는다).
2. PowerShell 에서 프로그램 폴더로 가서 아래를 그대로 실행한다. 바탕화면에 `visionmeeting.zip` 이 생긴다.

```powershell
cd C:\AI-project\visionmeeting
git archive --format=zip -o "$env:USERPROFILE\Desktop\visionmeeting.zip" HEAD `
  app static launcher.py requirements.txt run.bat program.bat program.ps1 stop.bat stop.ps1 .env.example docs/deploy.md
```

3. 압축 안에 무엇이 들었는지 확인한다. 목록에 `.env`·`certs`·`data`·`PLAN.md` 가 **없어야** 한다.

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::OpenRead("$env:USERPROFILE\Desktop\visionmeeting.zip").Entries.FullName
```

참석자 PC 에 줄 것은 이 압축 파일이 아니라 사내망 접속용 `certs\rootCA.pem` **한 파일뿐**이다.
이름에 `key` 가 들어간 파일은 어떤 경우에도 주지 않는다.

---

## 3. 새 PC 에 설치하기 (새 서버 PC 에서)

### 3-1. 준비물

- Windows 10·11, Chrome 또는 Edge
- **Python 3.10 이상** — python.org 에서 내려받아 설치한다. 첫 화면의 «Add python.exe to PATH» 를 꼭 체크한다.
- 설치 확인: PowerShell 에서 `python --version` 이 `Python 3.x` 를 보이면 된다.

### 3-2. 프로그램 풀기

`visionmeeting.zip` 을 **영문 경로**에 푼다(예: `C:\visionmeeting`). 경로에 한글·공백이 없게 한다.

### 3-3. 실행 환경 만들기

PowerShell 에서:

```powershell
cd C:\visionmeeting
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### 3-4. 사내망 HTTPS 인증서 만들기 (처음 한 번)

브라우저는 HTTPS 가 아니면 마이크·카메라를 허용하지 않는다. 새 PC 는 **자기 인증기관(CA)을 새로 만든다.**
원래 PC 의 `certs\ca` 를 옮겨 쓰지 않는다(1장).

1. mkcert 설치: `winget install FiloSottile.mkcert`
   (또는 github.com/FiloSottile/mkcert 의 Releases 에서 `mkcert-…-windows-amd64.exe` 를 받아 `mkcert.exe` 로 이름을 바꿔 PATH 에 둔다.)
   설치 후 **PowerShell 창을 새로 연다.**
2. CA 만들기·이 PC 에 신뢰 등록: `mkcert -install`
   «보안 경고 — 인증서를 설치하시겠습니까?» 창이 뜨면 **예**. (Windows 신뢰 저장소를 바꾸는 단계라 운영자가 직접 한다.)
3. CA 의 **공개 인증서**를 프로그램 폴더에 복사한다(실행기가 이 파일로 CA 가 맞는지 확인한다):

```powershell
cd C:\visionmeeting
New-Item -ItemType Directory -Force certs | Out-Null
Copy-Item "$(mkcert -CAROOT)\rootCA.pem" certs\rootCA.pem
```

서버 인증서(`localhost.pem`)는 만들지 않아도 된다. 3-7 의 `run.bat` 이 현재 IP 로 자동 발급한다.

새 CA 이므로 **이 서버에 사내망으로 접속하는 모든 PC·휴대폰은 새 `certs\rootCA.pem` 을 설치해야 한다.**
원래 서버의 `rootCA.pem` 으로는 경고가 뜬다.

### 3-5. 설정 파일 `.env` 만들기

```powershell
Copy-Item .env.example .env
notepad .env
```

새 운영자 **자신의** 값을 넣는다. 값 앞뒤에 `< >` 나 따옴표를 붙이지 않는다.

| 항목 | 넣을 값 | 비우면 |
|---|---|---|
| `ROOM_PASSCODE` | 회의 개설 코드(직접 정함) | 사내망에서만 회의를 만들 수 있고, 외부 참석 링크는 열리지 않는다 |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` | Cloudflare 대시보드 → Realtime → TURN Server 에서 만든 키 ID·API 토큰 | Cloudflare 중계 없음(회사 방화벽 뒤 참석자가 연결 안 될 수 있음) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | 계정 ID(대시보드 주소의 32자) + **«Account Analytics Read» 권한 하나만** 준 API 토큰 | 사용량을 확인할 수 없어 프로그램이 Cloudflare 중계를 켜지 않는다 |
| `METERED_…` | (선택) Metered 무료 계정의 접속 정보 | Host 화면에서 Metered 를 고를 수 없다 |
| `AZURE_CREDENTIALS_FILE` | (선택) 키를 따로 둔 파일 경로. 비우면 `.env` 의 값만 쓴다 | — |

Cloudflare 중계는 매달 1,000 GB 까지 무료이고 넘으면 카드로 청구된다. 프로그램이 최근 31일 합계로 900 GB 에서 음성만, 950 GB 에서 중계를 막아
청구가 생기지 않게 한다. 그래도 Cloudflare 대시보드의 예산 알림(Billing → Budget alerts)은 따로 켜 둔다.

### 3-6. (선택) 추가 도구

- **외부 참석 링크**(사내망 밖 참석자): `winget install Cloudflare.cloudflared`
- **회의 정리(요약)**: 이 PC 에 Claude Code CLI 를 설치하고 `claude` 로 로그인한다. 또는 Node.js 설치 후 `npm i -g @openai/codex`, `codex login`.
  둘 다 없으면 회의 정리만 «사용 불가»와 사유로 표시되고, 나머지 기능은 그대로 동작한다.

### 3-7. 실행

`C:\visionmeeting\run.bat` 을 두 번 누른다.

- 처음 실행 때 Windows 방화벽 창이 뜨면 **개인 네트워크**만 허용한다(공용 네트워크는 체크하지 않는다).
- 창에 `내 PC 접속: https://localhost:8443` 과 `참가자 PC 접속: https://<이 PC IP>:8443` 이 보이고 브라우저가 열리면 성공이다.
- 회의 화면만 다시 열 때는 `program.bat`, 서버를 끌 때는 `stop.bat`.

### 3-8. 설치 확인

- [ ] 브라우저 주소창에 자물쇠가 보이고 경고가 없다
- [ ] 회의 화면 상단 배지가 초록색 «외부 중계 준비됨 · Cloudflare» 다(3-5 를 채웠다면. 빨간 «외부 중계 없음» 이면 배지에 마우스를 올려 사유를 본다)
- [ ] 다른 PC(새 `rootCA.pem` 설치)에서 `https://<이 PC IP>:8443` 으로 들어와 영상·자막이 오간다
- [ ] 압축 파일·새 PC 폴더 어디에도 원래 PC 의 `.env`·`certs\ca`·`data` 가 없다

---

## 4. 다시 설치·업데이트할 때

**같은 PC 에서 프로그램만 새 버전으로 바꿀 때**
1. `stop.bat` 으로 서버를 끈다.
2. 새 `visionmeeting.zip` 을 같은 폴더에 풀어 덮어쓴다. 압축에는 `.env`·`certs`·`data` 가 없으므로 기존 설정·인증서·사용량 기록은 그대로 남는다.
3. `requirements.txt` 가 바뀌었을 수 있으니 `.venv\Scripts\pip install -r requirements.txt` 를 한 번 실행한 뒤 `run.bat`.

**실행 환경이 꼬였을 때**: `.venv` 폴더만 지우고 3-3 을 다시 한다. `.env`·`certs`·`data` 는 지우지 않는다.

**같은 PC 를 완전히 새로 설치할 때**: 3장을 처음부터 하되, `certs\` 폴더를 미리 다른 곳에 보관했다가 되돌려 놓으면
3-4 를 건너뛸 수 있고 참석자 PC 도 인증서를 다시 설치하지 않아도 된다. 보관한 `certs\` 에는 CA 개인키가 있으니 본인만 접근하는 곳에 둔다.

---

## 5. 자주 나오는 오류 (`run.bat` 창)

| 메시지 | 해결 |
|---|---|
| `.venv not found` | 3-3 을 하지 않았다 |
| `mkcert가 없습니다` | 3-4 의 1번 후 PowerShell·`run.bat` 창을 새로 연다 |
| `파일 없음 또는 읽기 실패: …rootCA.pem. 새 CA는 만들지 않습니다.` | 3-4 의 2번(`mkcert -install`)을 하지 않았다 |
| `배포용 certs/rootCA.pem과 기존 CA가 일치하지 않습니다` | `certs\rootCA.pem` 이 없거나 다른 PC 것이다. 3-4 의 3번으로 이 PC 의 것을 복사한다 |
| `8443 포트를 다른 서비스가 사용하고 있습니다` | 다른 프로그램이 8443 을 쓰고 있다. 그 프로그램을 끄고 다시 실행한다 |
| 화면에 «자격증명 파일을 찾을 수 없습니다» | `.env` 의 `AZURE_CREDENTIALS_FILE` 경로가 틀렸다. 키를 `.env` 에 직접 넣었다면 이 줄을 비운다 |

화면 사용법과 참석자 안내는 서버 실행 후 `https://localhost:8443/help` 에 있다.
