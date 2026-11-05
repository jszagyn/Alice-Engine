#!/usr/bin/env bash
# 爱丽丝（Alice）一键安装脚本（macOS / Linux）
# 前提：已安装 DeepSeek Harness（DSH），且用 pnpm 管理 profile 依赖

set -e

# 仓库根目录（scripts/ 的上一级）
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/character"
PROFILE="${1:-}"

echo ""
echo "=============================================="
echo "  爱丽丝（Alice）· 一键安装"
echo "=============================================="
echo ""

# ── 1. 定位 DSH 的 profile 目录 ──
if [ -z "$PROFILE" ]; then
    FOUND=()
    for base in "$HOME/.config/dsh/profiles" "$HOME/.dsh/profiles" "$HOME/dsh/profiles"; do
        [ -d "$base" ] && for d in "$base"/*/; do FOUND+=("${d%/}"); done
    done
    if [ ${#FOUND[@]} -eq 1 ]; then
        PROFILE="${FOUND[0]}"
    elif [ ${#FOUND[@]} -gt 1 ]; then
        echo "找到多个 profile："
        printf '  %s\n' "${FOUND[@]}"
        read -rp "请输入要装的 profile 完整路径: " PROFILE
    else
        read -rp "没自动找到 DSH profile，请手动输入完整路径: " PROFILE
    fi
fi

if [ -z "$PROFILE" ] || [ ! -d "$PROFILE" ]; then
    echo "未定位到 profile，跳过自动链接。请手动在 profile 的 package.json 里加："
    echo "  dependencies: { \"@alice/dsh-character\": \"link:$PLUGIN\" }"
    echo "然后在该目录跑 pnpm install"
else
    echo "profile: $PROFILE"
    PKG="$PROFILE/package.json"
    if [ -f "$PKG" ]; then
        # 用 node 安全地改 package.json 的 dependencies
        node -e '
            const fs = require("fs");
            const p = process.argv[1];
            const plug = process.argv[2];
            const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
            pkg.dependencies = pkg.dependencies || {};
            pkg.dependencies["@alice/dsh-character"] = "link:" + plug;
            fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
        ' "$PKG" "$PLUGIN"
        echo "已把 @alice/dsh-character 写入 profile 依赖"
        echo "运行 pnpm install ..."
        (cd "$PROFILE" && pnpm install)
    else
        echo "没有 package.json，请在 $PROFILE 下补一个，加入上面的 link 依赖"
    fi
fi

echo ""
echo "=============================================="
echo "  安装完成"
echo "=============================================="
echo "下一步："
echo "  1. 启动 DSH"
echo "  2. 在 DSH 里加载「爱丽丝」companion preset"
echo "  3. 跟她聊天"
echo ""
echo "LLM 配置在 DSH 里设置；改人格/模型去 character/data/character.json"
echo "TTS（可选）：需要自备 GPT-SoVITS，见 README.md"
