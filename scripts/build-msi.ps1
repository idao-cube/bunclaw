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
  $candidate = Get-ChildItem -Path "dist" -Filter "bunclaw-bun-windows-x64*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $candidate) {
    throw "未找到 Windows 可执行文件，请先运行: `$env:BUNCLAW_TARGET='bun-windows-x64'; bun run package"
  }
  $ExePath = $candidate.FullName
}

if (-not (Get-Command candle.exe -ErrorAction SilentlyContinue)) {
  throw "未找到 WiX (candle.exe)。请先安装 WiX Toolset 3.x。"
}

$outDir = Join-Path (Get-Location) "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$wxs = Join-Path (Get-Location) "packaging/wix/BunClaw.wxs"
$wixobj = Join-Path $outDir "BunClaw.wixobj"
$msi = Join-Path $outDir ("BunClaw-" + $Version + "-x64.msi")

& candle.exe -nologo -ext WixUIExtension -dProductVersion=$Version -dSourceExe="$ExePath" -out "$wixobj" "$wxs"
& light.exe -nologo -ext WixUIExtension -out "$msi" "$wixobj"

Write-Host "MSI 构建完成: $msi"

