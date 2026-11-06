#!/bin/bash
# 自助營運分析啟動檔（macOS，雙擊或在終端機執行）
cd "$(dirname "$0")" || exit 1

fail() { echo "$1"; read -r -p "按 Enter 結束…"; exit 1; }

command -v node >/dev/null 2>&1 || fail "找不到 Node.js，請先安裝 Node 22.23 以上。"
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=23)?0:1)" || fail "Node 版本太舊，需要 22.23 以上。"

export PORT="${PORT:-3100}"
(sleep 2; open "http://127.0.0.1:$PORT/") &
echo "關閉這個視窗或按 Ctrl+C 就會停止站台。"
node --disable-warning=ExperimentalWarning server/index.ts
