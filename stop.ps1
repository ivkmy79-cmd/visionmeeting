# VisionMeeting server stop. ASCII only - see CLAUDE.md.
# Stops the server on $Port only when the process belongs to this project folder.
# Another app on the port is never stopped.
param([int]$Port = 8443)  # keep in sync with PORT in launcher.py

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "VisionMeeting stop :$Port"
$root = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\').ToLower()

function Test-Ours($p) {
    foreach ($text in @($p.ExecutablePath, $p.CommandLine)) {
        if ($text -and $text.ToLower().Contains($root)) { return $true }
    }
    return $false
}

function Stop-Tree([int]$id) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id")) {
        Stop-Tree $child.ProcessId
    }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
if ($listeners.Count -eq 0) {
    Write-Host "[stop] No server is listening on port $Port. Nothing to do."
    exit 0
}

foreach ($listenId in $listeners) {
    # Walk up from the listening process: uvicorn <- venv python <- launcher.py <- run.bat window.
    $chain = @()
    $id = $listenId
    for ($i = 0; $i -lt 6 -and $id; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
        if (-not $p) { break }
        $chain += $p
        $id = $p.ParentProcessId
    }
    $ours = @($chain | Where-Object { $_.Name -like 'python*' -and (Test-Ours $_) })
    if ($ours.Count -eq 0) {
        $owner = $chain[0]
        Write-Host "[ERROR] Port $Port is used by another app (PID $($owner.ProcessId), $($owner.ExecutablePath)). Not stopped."
        exit 1
    }
    # Topmost python of this project = launcher; stopping its tree also stops uvicorn and cloudflared.
    # The run.bat window itself is left open.
    $top = $ours[-1]
    Stop-Tree $top.ProcessId
    Write-Host "[stop] Stopped VisionMeeting server (PID $($top.ProcessId), port $Port)."
}

$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host "[stop] Port $Port is free."
        exit 0
    }
    Start-Sleep -Milliseconds 300
}
Write-Host "[ERROR] Port $Port is still in use after 5 seconds."
exit 1
