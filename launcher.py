"""Windows HTTPS launcher. Uses the existing CA; never installs or creates one."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
PORT = 8443
RENEW_DAYS = 30


def log(message):
    print(f"[{datetime.now(KST):%Y-%m-%d %H:%M:%S} KST] {message}", flush=True)


def discover_networks():
    # Physical adapters exclude WSL/Hyper-V/VPN; do not assume the default route
    # belongs to the network participants will use.
    script = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
  $adapter = $_
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | Where-Object {
    $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '127.*'
  } | ForEach-Object { [pscustomobject]@{ name=$adapter.Name; ip=$_.IPAddress } }
})
ConvertTo-Json -InputObject $items -Compress
"""
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if result.returncode:
        raise RuntimeError("네트워크 조회 실패. PowerShell 권한과 네트워크 어댑터 상태를 확인하세요.")
    data = json.loads(result.stdout.lstrip("\ufeff"))
    return data if isinstance(data, list) else [data]


def choose_network(networks, ask=input):
    if not networks:
        log("[WARN] 연결된 물리 LAN이 없습니다. 이 PC의 localhost에서만 실행합니다.")
        return None
    if len(networks) == 1:
        return networks[0]
    log("여러 네트워크가 연결돼 있습니다. 참가자 PC와 같은 네트워크를 선택하세요.")
    for index, item in enumerate(networks, 1):
        print(f"  {index}. {item['name']} - {item['ip']}")
    while True:
        answer = ask("번호 입력 (종료: q): ").strip()
        if answer.lower() == "q":
            raise RuntimeError("네트워크 선택을 취소했습니다.")
        if answer.isdigit() and 1 <= int(answer) <= len(networks):
            return networks[int(answer) - 1]
        print("목록에 표시된 번호를 입력하세요.")


def fingerprint(path):
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(path.read_text(encoding="ascii"))).hexdigest()


def existing_ca(mkcert, pinned):
    # The explicitly provisioned project CA avoids user-context AppData differences.
    # An incomplete project CA must fail closed, not silently switch to another CA.
    ca_dir = pinned.parent / "ca"
    if not ca_dir.exists():
        result = subprocess.run([str(mkcert), "-CAROOT"], capture_output=True, encoding="utf-8", timeout=15)
        if result.returncode or not result.stdout.strip():
            raise RuntimeError("기존 루트 인증기관 위치를 확인하지 못했습니다.")
        ca_dir = Path(result.stdout.strip())
    log(f"기존 CA 확인 위치: {ca_dir}")
    ca = ca_dir / "rootCA.pem"
    for path in (ca, ca_dir / "rootCA-key.pem"):
        try:
            with path.open("rb") as stream:
                if not stream.read(1):
                    raise RuntimeError(f"CA 파일이 비어 있습니다: {path}. 새 CA는 만들지 않습니다.")
        except OSError as error:
            reason = "접근 권한 없음" if isinstance(error, PermissionError) else "파일 없음 또는 읽기 실패"
            raise RuntimeError(f"{reason}: {path}. 새 CA는 만들지 않습니다.") from error
    if not pinned.is_file() or fingerprint(ca) != fingerprint(pinned):
        raise RuntimeError("배포용 certs/rootCA.pem과 기존 CA가 일치하지 않습니다. 기존 CA를 확인하세요.")
    return ca


def inspect_pair(cert, key, ca):
    """Real TLS handshake validates the key pair, validity and pinned CA signature."""
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(str(cert), str(key))
    client = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client.load_verify_locations(cafile=str(ca))
    left, right = socket.socketpair()
    left.settimeout(5)
    right.settimeout(5)
    failures = []

    def serve():
        try:
            with server.wrap_socket(left, server_side=True) as connection:
                connection.recv(1)
                connection.sendall(b"y")
        except (OSError, ssl.SSLError) as exc:
            failures.append(exc)
        finally:
            left.close()

    worker = threading.Thread(target=serve, daemon=True)
    worker.start()
    try:
        with client.wrap_socket(right, server_hostname="localhost") as connection:
            info = connection.getpeercert()
            connection.sendall(b"x")
            if connection.recv(1) != b"y":
                raise RuntimeError("인증서 검증용 TLS 연결이 완료되지 않았습니다.")
    finally:
        right.close()
        worker.join(timeout=6)
    if failures:
        raise RuntimeError("인증서 TLS 검증에 실패했습니다.")
    return info


def renewal_reason(info, ip, now=None):
    now = time.time() if now is None else now
    if ssl.cert_time_to_seconds(info["notAfter"]) <= now + RENEW_DAYS * 86400:
        return "인증서 만료가 30일 이내입니다."
    addresses = {ipaddress.ip_address(value) for kind, value in info.get("subjectAltName", ()) if kind == "IP Address"}
    required = ["127.0.0.1", "::1"] + ([ip] if ip else [])
    if any(ipaddress.ip_address(value) not in addresses for value in required):
        return "현재 IP가 인증서에 포함되지 않았습니다."
    return None


def install_pair(new_cert, new_key, cert, key):
    # Save originals only in memory. If the second replace fails, restore both.
    originals = [(path, path.read_bytes() if path.exists() else None) for path in (cert, key)]
    try:
        os.replace(new_cert, cert)
        os.replace(new_key, key)
    except OSError:
        for path, data in originals:
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        raise


def renew(mkcert, ca, cert, key, ip):
    root_hash = fingerprint(ca)
    with tempfile.TemporaryDirectory(prefix="renew-", dir=cert.parent) as staging:
        new_cert, new_key = Path(staging) / "server.pem", Path(staging) / "server-key.pem"
        hosts = ["localhost", "127.0.0.1", "::1"] + ([ip] if ip else [])
        env = dict(os.environ, CAROOT=str(ca.parent))
        result = subprocess.run(
            [str(mkcert), "-cert-file", str(new_cert), "-key-file", str(new_key), *hosts],
            env=env, capture_output=True, timeout=30,
        )
        if result.returncode:
            raise RuntimeError("인증서 재발급 실패. 기존 서버 인증서는 보존했습니다.")
        info = inspect_pair(new_cert, new_key, ca)
        if renewal_reason(info, ip) or fingerprint(ca) != root_hash:
            raise RuntimeError("새 인증서 검증 실패. 기존 서버 인증서는 보존했습니다.")
        install_pair(new_cert, new_key, cert, key)
    return info


def port_in_use():
    with socket.socket() as connection:
        connection.settimeout(1)
        return connection.connect_ex(("127.0.0.1", PORT)) == 0


def check_running_server(cert, ip):
    """No proxy, no certificate bypass, no stopping an unknown process."""
    context = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", PORT), timeout=3) as connection:
        with context.wrap_socket(connection, server_hostname=ip or "localhost") as tls:
            if hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest() != fingerprint(cert):
                raise RuntimeError("실행 중인 서버가 다른 인증서를 사용합니다.")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    with opener.open(f"https://localhost:{PORT}/api/status", timeout=3) as response:
        status = json.loads(response.read(65536))
    if not isinstance(status, dict) or not all(name in status for name in ("summary", "languages", "limits")):
        raise RuntimeError("8443 포트를 다른 서비스가 사용하고 있습니다.")


def serve(cert, key, ip):
    child = subprocess.Popen([
        sys.executable, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", str(PORT),
        "--ssl-certfile", str(cert), "--ssl-keyfile", str(key),
    ], cwd=ROOT, env=dict(os.environ, **({"LAN_URL": f"https://{ip}:{PORT}"} if ip else {})))
    try:
        deadline = time.monotonic() + 20
        while True:
            if child.poll() is not None:
                raise RuntimeError("서버가 시작되지 않았습니다. 위 서버 로그를 확인하세요.")
            try:
                check_running_server(cert, ip)
                break
            except (OSError, ValueError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("HTTPS 응답 검증 실패. 인증서 신뢰 설정과 포트 상태를 확인하세요.")
                time.sleep(0.4)
        log("HTTPS 응답 확인 완료. 브라우저를 엽니다. 종료하려면 이 창에서 Ctrl+C를 누르세요.")
        webbrowser.open(f"https://localhost:{PORT}")
        return child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)


def main():
    os.chdir(ROOT)
    cert_dir = ROOT / "certs"
    cert_dir.mkdir(exist_ok=True)
    # Hold a Windows file lock across setup AND serving to prevent concurrent replacement.
    import msvcrt
    with (cert_dir / "launcher.lock").open("a+b") as lock:
        lock.seek(0)
        if os.fstat(lock.fileno()).st_size == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        owns_lock = True
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            owns_lock = False
            if not port_in_use():
                raise RuntimeError("다른 실행기가 인증서를 확인하거나 서버를 시작 중입니다. 잠시 후 다시 실행하세요.")
            # A running launcher holds the lock. The read-only existing-server
            # branch below may open its page, but must never replace its files.
        networks = discover_networks()
        selected = choose_network(networks)
        ip = selected["ip"] if selected else None
        if selected:
            ipaddress.IPv4Address(ip)
            log(f"현재 네트워크: {selected['name']} / IP: {ip}")
        mkcert = shutil.which("mkcert") or str(Path(os.environ["LOCALAPPDATA"]) / "Programs/mkcert/mkcert.exe")
        if not Path(mkcert).is_file():
            raise RuntimeError("mkcert가 없습니다. 기존 CA를 보존한 상태에서 mkcert 설치를 확인하세요.")
        ca = existing_ca(mkcert, cert_dir / "rootCA.pem")
        cert, key = cert_dir / "localhost.pem", cert_dir / "localhost-key.pem"
        try:
            info = inspect_pair(cert, key, ca)
            reason = renewal_reason(info, ip)
        except (OSError, ValueError, RuntimeError):
            reason = "서버 인증서가 없거나, 만료·서명·개인키 검증에 실패했습니다."
        if port_in_use():
            if reason:
                raise RuntimeError("8443 포트 사용 중이며 인증서 갱신이 필요합니다. 기존 서버를 Ctrl+C로 종료한 후 다시 실행하세요.")
            check_running_server(cert, ip)
            log("기존 번역 서버가 정상 실행 중입니다. 중복 실행하지 않고 브라우저를 엽니다.")
            if ip:
                log(f"참가자 PC 접속: https://{ip}:{PORT}")
            webbrowser.open(f"https://localhost:{PORT}")
            return 0
        if not owns_lock:
            raise RuntimeError("기존 서버가 종료 중입니다. 해당 실행기가 끝난 후 다시 실행하세요.")
        if reason:
            log(reason + " 기존 루트 인증기관으로 재발급합니다.")
            info = renew(mkcert, ca, cert, key, ip)
            log("재발급 및 검증 완료. 참가자 PC의 루트 인증서 재설치는 필요 없습니다.")
        else:
            log("현재 IP와 인증서가 일치합니다. 인증서를 변경하지 않습니다.")
        expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(info["notAfter"]), KST)
        log(f"인증서 만료: {expires:%Y-%m-%d %H:%M:%S} KST")
        log(f"내 PC 접속: https://localhost:{PORT}")
        if ip:
            log(f"참가자 PC 접속: https://{ip}:{PORT}")
        log(f"최초 참가자에게 전달할 파일: {cert_dir / 'rootCA.pem'}")
        return serve(cert, key, ip)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("서버 실행을 종료했습니다.")
        raise SystemExit(0)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        log(f"[ERROR] {error}")
        raise SystemExit(1)
