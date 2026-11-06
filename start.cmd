@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 自助營運分析啟動檔（Windows，雙擊或在命令提示字元執行）

where node >nul 2>&1 || (echo 找不到 Node.js，請先安裝 Node 22.23 以上。& pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=23)?0:1)" || (echo Node 版本太舊，需要 22.23 以上。& pause & exit /b 1)

if "%PORT%"=="" set "PORT=3100"
start "" /b powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%PORT%/'"
echo 關閉這個視窗或按 Ctrl+C 就會停止站台。
node --disable-warning=ExperimentalWarning server\index.ts
pause
