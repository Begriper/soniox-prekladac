# Soniox Live Translator v5.1 deployment helper
# Spusti z koreňa projektu, napr. D:\prekladac

$ErrorActionPreference = "Stop"

Write-Host "== Soniox Live Translator v5.1 deploy ==" -ForegroundColor Cyan
Write-Host "Aktuálny priečinok: $(Get-Location)"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "..\prekladac-backup-$stamp"
Write-Host "Vytváram zálohu do $backupPath ..." -ForegroundColor Yellow
Copy-Item -Recurse -Force . $backupPath

Write-Host "Inštalujem/verifikujem balíčky..." -ForegroundColor Yellow
npm install

Write-Host "Kontrolujem syntax..." -ForegroundColor Yellow
npm run check

Write-Host "Kontrolujem audit balíčkov..." -ForegroundColor Yellow
npm run audit

Write-Host "Nasadzujem na Fly.io..." -ForegroundColor Yellow
fly deploy -a soniox-prekladac

Write-Host "Uisťujem sa, že beží 1 machine..." -ForegroundColor Yellow
fly scale count 1 -a soniox-prekladac -y

Write-Host "Aktuálny scale stav:" -ForegroundColor Yellow
fly scale show -a soniox-prekladac

Write-Host "Health check:" -ForegroundColor Yellow
Invoke-WebRequest "https://soniox-prekladac.fly.dev/health" -UseBasicParsing | Select-Object StatusCode, Content

Write-Host "AudioWorklet súbor:" -ForegroundColor Yellow
Invoke-WebRequest "https://soniox-prekladac.fly.dev/audio-capture-worklet.js?v=2.6.1" -UseBasicParsing | Select-Object StatusCode, @{Name="ContentLength";Expression={$_.Content.Length}}

Write-Host "Hotovo. Teraz otvor aplikáciu, prihlás sa a otestuj Textový režim + Reproduktor režim." -ForegroundColor Green
Write-Host "Logy: fly logs -a soniox-prekladac" -ForegroundColor Cyan
