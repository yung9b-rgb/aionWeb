param([string]$Zig = 'zig')
$ErrorActionPreference = 'Stop'
$captureRoot = Split-Path $PSScriptRoot -Parent
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $captureRoot 'tools\build\zig-global-cache'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $captureRoot 'tools\build\zig-local-cache'
New-Item -ItemType Directory -Force -Path (Join-Path $captureRoot 'tools\bin') | Out-Null
& $Zig cc -target x86_64-windows-gnu -O2 -Wall -Wextra (Join-Path $PSScriptRoot 'npcap-capture.c') -o (Join-Path $PSScriptRoot 'bin\npcap-capture.exe')
if ($LASTEXITCODE -ne 0) { throw 'Capture helper build failed' }
Get-FileHash (Join-Path $PSScriptRoot 'bin\npcap-capture.exe')
