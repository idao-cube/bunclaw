Param(
  [string]$Version = "",
  [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Ensure-WixInPath {
  $candidates = @(
    "${env:ProgramFiles(x86)}\WiX Toolset v3.11\bin",
    "${env:ProgramFiles}\WiX Toolset v3.11\bin"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $p })) {
        $env:PATH = "$p;$env:PATH"
      }
    }
  }
}

function Get-PackageVersion {
  $pkg = Get-Content -Raw "package.json" | ConvertFrom-Json
  return $pkg.version
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Get-PackageVersion
}

if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $candidate = Get-ChildItem -Path "dist" -Filter "bunclaw-bun-windows-x64*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($null -eq $candidate) {
    throw "Windows executable not found. Run: `$env:BUNCLAW_TARGET='bun-windows-x64'; bun run package"
  }
  $ExePath = $candidate.FullName
}

Ensure-WixInPath

$candle = Get-Command candle.exe -ErrorAction SilentlyContinue
$light = Get-Command light.exe -ErrorAction SilentlyContinue
if ($null -eq $candle -or $null -eq $light) {
  throw "WiX Toolset 3.x not found (missing candle.exe/light.exe)."
}

$outDir = Join-Path (Get-Location) "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$wxs = Join-Path (Get-Location) "packaging/wix/BunClaw.wxs"
$wixobj = Join-Path $outDir "BunClaw.wixobj"
$msi = Join-Path $outDir ("BunClaw-" + $Version + "-x64.msi")

& $candle.Source -nologo -ext WixUIExtension -dProductVersion=$Version -dSourceExe="$ExePath" -out "$wixobj" "$wxs"
if ($LASTEXITCODE -ne 0) {
  throw "candle failed with exit code $LASTEXITCODE"
}

& $light.Source -nologo -ext WixUIExtension -out "$msi" "$wixobj"
if ($LASTEXITCODE -ne 0) {
  throw "light failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $msi)) {
  throw "MSI output not found: $msi"
}

Write-Host "MSI build completed: $msi"
