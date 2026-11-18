# VisionMeeting - open the meeting page in the browser. ASCII only - see CLAUDE.md.
# Never starts the server: if it is not running, says so and stops (start it with run.bat).
param([int]$Port = 8443)  # keep in sync with PORT in launcher.py

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "VisionMeeting :$Port"
$url = "https://localhost:$Port/"

if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] VisionMeeting server is not running on port $Port."
    Write-Host "        Start it with run.bat first. This file never starts the server."
    exit 1
}

# Same rule as launcher.py check_running_server: our server answers /api/status with these items.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    $status = Invoke-RestMethod -Uri "${url}api/status" -TimeoutSec 5 -UseBasicParsing
} catch {
    Write-Host "[ERROR] Port $Port is in use but $url did not answer: $($_.Exception.Message)"
    exit 1
}
foreach ($name in 'summary', 'languages', 'limits') {
    if ($null -eq $status.$name) {
        Write-Host "[ERROR] Port $Port is used by another app, not VisionMeeting. Nothing opened."
        exit 1
    }
}

Start-Process $url
Write-Host "[program] Opened $url"
if ($status.lan_url) { Write-Host "[program] Other PCs on the LAN: $($status.lan_url)" }
exit 0
