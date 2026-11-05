# 爱丽丝（Alice）一键安装脚本
# 前提：已安装 DeepSeek Harness（DSH），且用 pnpm 管理 profile 依赖

param([string]$Profile = '')

$ErrorActionPreference = 'Continue'
$utf8 = [System.Text.UTF8Encoding]::new($false)

# 仓库根目录（scripts/ 的上一级）
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$plugin = Join-Path $repo 'character'

Write-Host ''
Write-Host '=============================================='
Write-Host '  爱丽丝（Alice）· 一键安装'
Write-Host '=============================================='
Write-Host ''

# ── 1. 定位 DSH 的 profile 目录 ──
if (-not $Profile) {
    $found = @()
    foreach ($base in @("$env:APPDATA\dsh\profiles", "$env:USERPROFILE\.dsh\profiles", "$env:USERPROFILE\dsh\profiles")) {
        if (Test-Path $base) {
            $found += Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
        }
    }
    if ($found.Count -eq 1) {
        $Profile = $found[0]
    } elseif ($found.Count -gt 1) {
        Write-Host '找到多个 profile：'
        $found | ForEach-Object { Write-Host "  $_" }
        $Profile = Read-Host '请输入要装的 profile 完整路径'
    } else {
        $Profile = Read-Host '没自动找到 DSH profile，请手动输入 profile 目录完整路径'
    }
}
if (-not $Profile -or -not (Test-Path $Profile)) {
    Write-Host '未定位到 profile，跳过自动链接。请手动在 profile 的 package.json 里加：'
    Write-Host "  dependencies: { ""@alice/dsh-character"": ""link:$plugin"" }"
    Write-Host '然后在该目录跑 pnpm install'
} else {
    Write-Host "profile: $Profile"
    $pkgPath = Join-Path $Profile 'package.json'
    if (Test-Path $pkgPath) {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue @{} -Force }
        $pkg.dependencies.'@alice/dsh-character' = "link:$plugin"
        [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 10), $utf8)
        Write-Host '已把 @alice/dsh-character 写入 profile 依赖'
        Write-Host '运行 pnpm install ...'
        Push-Location $Profile
        try { pnpm install } catch { Write-Host 'pnpm install 失败，请手动在该目录跑 pnpm install' }
        Pop-Location
    } else {
        Write-Host "没有 package.json，请在 $Profile 下补一个，加入上面的 link 依赖"
    }
}

# ── 2. 配置 .env（LLM key）──
Write-Host ''
$key = Read-Host '请输入你的 LLM API Key（回车跳过，之后手动改 .env）'
if ($key) {
    $envPath = Join-Path $repo '.env'
    $envContent = "LLM_PROVIDER=deepseek-official`nLLM_BASE_URL=https://api.deepseek.com/v1`nLLM_API_KEY=$key`nLLM_MODEL=deepseek-chat`n"
    [System.IO.File]::WriteAllText($envPath, $envContent, $utf8)
    Write-Host '已写 .env'
}

# ── 3. 完成 ──
Write-Host ''
Write-Host '=============================================='
Write-Host '  安装完成'
Write-Host '=============================================='
Write-Host '下一步：'
Write-Host '  1. 启动 DSH'
Write-Host '  2. 在 DSH 里加载「爱丽丝」companion preset'
Write-Host '  3. 跟她聊天'
Write-Host ''
Write-Host 'TTS（可选）：需要自备 GPT-SoVITS，见 README.md'
