Param(
  [string]$Version = "",
  [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

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

if (-not (Get-Command candle.exe -ErrorAction SilentlyContinue)) {
  throw "WiX Toolset 3.x not found (missing candle.exe)."
}

$outDir = Join-Path (Get-Location) "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$wxs = Join-Path (Get-Location) "packaging/wix/BunClaw.wxs"
$wixobj = Join-Path $outDir "BunClaw.wixobj"
$msi = Join-Path $outDir ("BunClaw-" + $Version + "-x64.msi")

& candle.exe -nologo -ext WixUIExtension -dProductVersion=$Version -dSourceExe="$ExePath" -out "$wixobj" "$wxs"
& light.exe -nologo -ext WixUIExtension -out "$msi" "$wixobj"

Write-Host "MSI build completed: $msi"

