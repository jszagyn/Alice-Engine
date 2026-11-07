# Pre-release privacy cleanup (repeatable).
# Removes QQ numbers, tokens, voice models, game corpus, and chat logs.
# Usage: powershell -File scripts\clean-release.ps1 [-Root <repo-or-package-root>]

param([string]$Root = 'G:\DSH\alice')

$ErrorActionPreference = 'SilentlyContinue'
Write-Host '=== Alice pre-release privacy cleanup ===' -ForegroundColor Cyan

# 1. Blank QQ privacy in character.json
$char = Join-Path $Root 'character\data\character.json'
if (Test-Path $char) {
  $c = Get-Content $char -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  if ($c.qq.selfId) { $c.qq.selfId = ''; $changed = $true }
  if ($c.qq.allowUsers.Count) { $c.qq.allowUsers = @(); $changed = $true }
  if ($c.qq.allowGroups.Count) { $c.qq.allowGroups = @(); $changed = $true }
  if ($changed) {
    [System.IO.File]::WriteAllText($char, ($c | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding $false))
    Write-Host '  [1/3] QQ ids blanked' -ForegroundColor Green
  } else {
    Write-Host '  [1/3] QQ ids: already blank' -ForegroundColor DarkGray
  }
}

# 2. Remove sensitive files/dirs
$sensitive = @(
  'nap\napcat-console.log',
  'nap\qrcode-big.png',
  'nap\guild1.db', 'nap\guild1.db-shm', 'nap\guild1.db-wal',
  'nap\NapCat.52230.Shell\versions\*\resources\app\napcat\logs',
  'nap\NapCat.52230.Shell\versions\*\resources\app\napcat\cache'
)
$removed = 0
foreach ($s in $sensitive) {
  $p = Join-Path $Root $s
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; $removed++ }
}
Write-Host "  [2/3] Removed $removed sensitive files (logs / qrcode / db)" -ForegroundColor Green

# 3. Residue check
$bad = @('944624695','3204141435')
$hits = Get-ChildItem $Root -Recurse -File -Include '*.js','*.json','*.md','*.bat','*.ps1','*.txt' |
  Where-Object { $_.FullName -notmatch 'node_modules|\.pnpm' } |
  Select-String -Pattern ($bad -join '|') -List
if ($hits) {
  Write-Host '  [3/3] Residue found (fix manually):' -ForegroundColor Red
  $hits | ForEach-Object { Write-Host '        ' + $_.Path.Replace($Root + '\', '') }
} else {
  Write-Host '  [3/3] Residue check passed (no QQ ids)' -ForegroundColor Green
}
Write-Host ''
