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

function Normalize-WixVersion([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "Version is empty."
  }
  $v = $raw.Trim()
  if ($v.StartsWith("v")) { $v = $v.Substring(1) }
  if ($v.Contains("-")) { $v = $v.Split("-")[0] }
  if ($v.Contains("+")) { $v = $v.Split("+")[0] }

  $parts = $v.Split(".")
  if ($parts.Length -lt 2) {
    throw "Invalid version '$raw'. Expected at least major.minor."
  }
  while ($parts.Length -lt 4) {
    $parts = $parts + "0"
  }
  if ($parts.Length -gt 4) {
    $parts = $parts[0..3]
  }

  foreach ($p in $parts) {
    if ($p -notmatch '^\d+$') {
      throw "Invalid numeric segment '$p' in version '$raw'."
    }
    $n = [int]$p
    if ($n -lt 0 -or $n -gt 65534) {
      throw "Version segment '$p' out of range (0..65534)."
    }
  }
  return ($parts -join ".")
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Get-PackageVersion
}
$WixVersion = Normalize-WixVersion $Version

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

$candleArgs = @(
  "-nologo",
  "-ext", "WixUIExtension",
  "-dProductVersion=$WixVersion",
  "-dSourceExe=$ExePath",
  "-out", $wixobj,
  $wxs
)
& $candle.Source @candleArgs
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
