# Copy MaskClaw deploy + cloud-init onto a Raspberry Pi OS bootfs (e.g. G:).
param(
    [Parameter(Mandatory = $true)]
    [string]$BootDrive
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$letter = $BootDrive.TrimEnd(':', '\')
$boot = "${letter}:\"
if (-not (Test-Path $boot)) { throw "Boot drive $boot not found" }
if (-not (Test-Path (Join-Path $boot "cmdline.txt"))) {
    throw "$boot does not look like Raspberry Pi bootfs (missing cmdline.txt)"
}

$dst = Join-Path $boot "maskclaw-deploy"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy (Join-Path $Root "deploy") $dst /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy deploy failed: $LASTEXITCODE" }

Copy-Item -Force (Join-Path $Root "deploy\cloud-init\user-data") (Join-Path $boot "user-data")
Copy-Item -Force (Join-Path $Root "deploy\cloud-init\network-config") (Join-Path $boot "network-config")
Copy-Item -Force (Join-Path $Root "deploy\firstrun.sh") (Join-Path $boot "maskclaw-firstrun.sh")
New-Item -ItemType File -Force -Path (Join-Path $boot "ssh") | Out-Null

$bin = Join-Path $dst "bin\switchyard-server"
if (-not (Test-Path $bin) -or ((Get-Item $bin).Length -lt 1024)) {
    Write-Warning "Linux aarch64 switchyard-server is missing. Run pwsh scripts/build-engine-aarch64.ps1 before booting."
}

Write-Host "Staged MaskClaw onto $boot (user admin). Eject the drive, then boot the Pi on Ethernet."
