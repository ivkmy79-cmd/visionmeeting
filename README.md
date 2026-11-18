# VisionMeeting

최대 4곳(PC 4대)을 잇는 **실시간 번역 화상회의** 웹앱입니다. 누가 말하든 자막이 뜨고, 각 지점은 자기 언어로 번역된 자막을 봅니다.
서버 PC 한 대에서 실행하고, 사내망 PC는 HTTPS 주소로, 회사 밖 참석자는 «외부 참석 링크»(Cloudflare 터널)로 들어옵니다.

- 언어: 한국어·영어·베트남어·중국어·일본어 중 회의당 3개(중국어·일본어는 실기 검증 전)
- 영상·음성: 브라우저끼리 직접(WebRTC), 직접 연결이 막히면 Cloudflare TURN 중계(매달 1,000 GB 무료, 프로그램이 950 GB 에서 스스로 멈춤)
- 자막: 말한 PC 의 브라우저 음성 인식 → 받는 PC 의 브라우저 번역(PC 용 Chrome 138·Edge 148 이상)
- 회의 정리(선택): 서버 PC 의 Claude Code 또는 Codex CLI

## 받기

이 페이지 위쪽 **Code → Download ZIP** 으로 받거나 `git clone` 합니다. 압축은 `C:\visionmeeting` 처럼 **영문 경로**에 풉니다.

## 설치 (서버 PC 한 대만)

회의에 참석만 하는 PC 는 설치가 필요 없습니다(브라우저만).

1. Python 3.10 이상 설치(«Add python.exe to PATH» 체크)
2. 실행 환경
   ```powershell
   cd C:\visionmeeting
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```
3. 사내망 HTTPS 인증서: `winget install FiloSottile.mkcert` → 새 PowerShell 창에서 `mkcert -install` →
   `Copy-Item "$(mkcert -CAROOT)\rootCA.pem" certs\rootCA.pem` (`certs` 폴더가 없으면 먼저 만듭니다)
4. 설정: `Copy-Item .env.example .env` 후 `notepad .env` — 회의 개설 코드(`ROOM_PASSCODE`)와 **본인 계정의** Cloudflare 값을 넣습니다
5. `run.bat` 실행 → 브라우저가 `https://localhost:8443` 을 엽니다

자세한 순서·확인 방법·오류 대처는 [docs/deploy.md](docs/deploy.md) 에 있습니다.
움직이는 그림 설명서는 `docs/visionmeeting-install.html`(설치)·`docs/visionmeeting-video.html`(사용)을 받아 브라우저로 엽니다.
서버를 켠 뒤에는 회의 화면의 «설명서»(`/help`)에 사용법이 있습니다.

## 올리지 않는 것 (보안)

이 저장소에는 설정·키·인증서가 들어 있지 않습니다. 각 PC 에서 새로 만들고, **절대 커밋하거나 남에게 보내지 않습니다**(`.gitignore` 로 제외).

| 파일 | 내용 |
|---|---|
| `.env` | 회의 개설 코드, Cloudflare·Metered 토큰 |
| `certs\` | 인증기관(CA) 개인키·서버 인증서 개인키 |
| `data\` | 중계 사용량 기록 |

참석자 PC 에 줄 것은 `certs\rootCA.pem` **한 파일뿐**입니다. 이름에 `key` 가 들어간 파일은 주지 않습니다.
