# Sync dashboard/ dist into appliance/deploy/www.
param(
    [string]$DashboardPath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Www = Join-Path $Root "deploy\www"
if (-not $DashboardPath) {
    $DashboardPath = Join-Path (Split-Path -Parent $Root) "dashboard"
}

if (-not (Test-Path (Join-Path $DashboardPath "package.json"))) {
    throw "Dashboard package.json not found at $DashboardPath"
}

Push-Location $DashboardPath
try {
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw "dashboard tests failed" }
    pnpm run build:appliance
    if ($LASTEXITCODE -ne 0) { throw "build:appliance failed" }
} finally {
    Pop-Location
}

$Dist = Join-Path $DashboardPath "dist"
if (-not (Test-Path (Join-Path $Dist "index.html"))) {
    throw "dashboard dist/index.html missing"
}

New-Item -ItemType Directory -Force -Path $Www | Out-Null
robocopy $Dist $Www /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy www failed: $LASTEXITCODE" }
Write-Host "Wrote $Www"
