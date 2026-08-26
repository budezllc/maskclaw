# Build Linux aarch64 switchyard-server on this PC. Never run cargo on the Pi.
param(
    [string]$EnginePath = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $EnginePath) {
    $pin = Get-Content (Join-Path $Root "ENGINE_PIN")
    $EnginePath = ($pin | Where-Object { $_ -like "ENGINE_PATH=*" }) -replace "^ENGINE_PATH=", ""
}
if (-not [System.IO.Path]::IsPathRooted($EnginePath)) {
    $EnginePath = [System.IO.Path]::GetFullPath((Join-Path $Root $EnginePath))
}
if (-not $OutDir) {
    $OutDir = Join-Path $Root "deploy\bin"
}

if (-not (Test-Path (Join-Path $EnginePath "Cargo.toml"))) {
    throw "Engine Cargo.toml not found at $EnginePath"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Image = "maskclaw-engine-aarch64:1.96.1"
$Dockerfile = Join-Path $Root "docker\engine-aarch64.Dockerfile"

docker build --platform linux/arm64 -t $Image -f $Dockerfile (Join-Path $Root "docker")
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

$engineVol = (Resolve-Path $EnginePath).Path
$outVol = (Resolve-Path $OutDir).Path

docker run --rm --platform linux/arm64 `
    -e CARGO_TARGET_DIR=/target `
    -v "${engineVol}:/src:ro" `
    -v "maskclaw-engine-target:/target" `
    -v "maskclaw-engine-cargo-registry:/usr/local/cargo/registry" `
    -v "maskclaw-engine-cargo-git:/usr/local/cargo/git" `
    -v "${outVol}:/out" `
    $Image `
    bash -c "set -eu; export PATH=/usr/local/cargo/bin:`$PATH; cargo build --release -p switchyard-server; strip --strip-unneeded /target/release/switchyard-server; install -m 0755 /target/release/switchyard-server /out/switchyard-server"
if ($LASTEXITCODE -ne 0) { throw "docker run failed" }

$bin = Join-Path $OutDir "switchyard-server"
if (-not (Test-Path $bin) -or ((Get-Item $bin).Length -lt 1024)) {
    throw "aarch64 binary missing or too small: $bin"
}
Write-Host "Wrote $bin ($((Get-Item $bin).Length) bytes)"
