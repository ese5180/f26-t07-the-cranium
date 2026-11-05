<#
.SYNOPSIS
  Put the Cranium Android app on a phone from Windows, from this checkout's apps\dist\.

.DESCRIPTION
  powershell -ExecutionPolicy Bypass -File apps\install.ps1                      the phone on USB
  powershell -ExecutionPolicy Bypass -File apps\install.ps1 -Pair 192.168.1.5:37000 -Code 123456
                                                     pair over Wi-Fi first (Android 11+: Developer options >
                                                     Wireless debugging > Pair device with pairing code)
  powershell -ExecutionPolicy Bypass -File apps\install.ps1 -Wifi 192.168.1.5:41000
                                                     connect over Wi-Fi to a paired phone, then install

  The phone needs USB debugging on (Settings > About phone > tap Build number 7 times, then
  Developer options > USB debugging) and asks "Allow USB debugging?" once. The APK is checked against
  apps\dist\SHA256SUMS first. From app 0.7.0 on, the app offers each new version by itself.

  iPhone apps cannot be built on Windows: see apps\README.md ("iPhone without a Mac", SideStore).
#>
param(
  [string]$Pair = "",
  [string]$Code = "",
  [string]$Wifi = ""
)
$ErrorActionPreference = "Stop"
$apps = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $apps "dist"

function Find-Adb {
  $candidates = @()
  $onPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  if ($env:ANDROID_HOME) { $candidates += (Join-Path $env:ANDROID_HOME "platform-tools\adb.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe") }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$adb = Find-Adb
if (-not $adb) {
  Write-Host "adb (Android's platform tools) is not installed. Install it, then run this again:"
  Write-Host "  winget install Google.PlatformTools"
  Write-Host "  or download: https://developer.android.com/tools/releases/platform-tools"
  Write-Host "Or skip it: open the console's Apps page on the phone and tap Download."
  exit 1
}

$apk = Get-ChildItem -Path $dist -Filter "cranium-android-*.apk" -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.BaseName -replace '^cranium-android-', '') } | Select-Object -Last 1
if (-not $apk) { Write-Error "No Android build in apps\dist\. Ask for one, or run apps/fetch-builds.sh on a Mac or Linux." }

$sums = Join-Path $dist "SHA256SUMS"
if (-not (Test-Path $sums)) { Write-Error "apps\dist\SHA256SUMS is missing." }
$line = Get-Content $sums | Where-Object { $_ -match ("  " + [regex]::Escape($apk.Name) + "$") } | Select-Object -First 1
if (-not $line) { Write-Error "$($apk.Name) is not in apps\dist\SHA256SUMS." }
$want = ($line -split "\s+")[0].ToLower()
$got = (Get-FileHash -Algorithm SHA256 $apk.FullName).Hash.ToLower()
if ($want -ne $got) { Write-Error "$($apk.Name) does not match apps\dist\SHA256SUMS." }

if ($Pair) {
  if (-not $Code) { Write-Error "-Pair needs -Code, the 6 digits the phone shows." }
  & $adb pair $Pair $Code
  Write-Host "Paired. Now connect with the IP address & Port that Wireless debugging shows (not the pairing port):"
  Write-Host "  powershell -ExecutionPolicy Bypass -File apps\install.ps1 -Wifi <IP:PORT>"
  exit 0
}
if ($Wifi) { & $adb connect $Wifi }

$phones = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" } | ForEach-Object { ($_ -split "\t")[0] }
if (-not $phones) {
  Write-Host "No phone is ready. Plug it in with USB debugging on and accept 'Allow USB debugging?',"
  Write-Host "or use -Pair / -Wifi for Wireless debugging. ('unauthorized' means the phone still has to allow it.)"
  & $adb devices
  exit 1
}
if (@($phones).Count -gt 1) { Write-Error "More than one phone: unplug the others, or set ANDROID_SERIAL." }

Write-Host "Installing $($apk.Name) on $phones..."
& $adb -s $phones install -r $apk.FullName
Write-Host "Done. Open Cranium on the phone and sign in. From 0.7.0 on, it offers each new version by itself."
