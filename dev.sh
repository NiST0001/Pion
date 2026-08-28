#!/usr/bin/env bash
# ============================================================================
# Pion 开发版启动脚本
#
# 用法:
#   ./dev.sh                    # 常规启动（渲染进程 HMR + 主进程热重建）
#   ./dev.sh --x11              # 经 XWayland 运行（规避 wayland+vulkan 告警）
#   ./dev.sh --debug-port 9333  # 开启 CDP 远程调试端口
#   ./dev.sh --reset            # 清空 out/ 缓存后启动
#
# 环境变量:
#   ELECTRON_ARGS="..."         # 追加传给 electron 的参数（空格分隔）
#
# 脚本自动处理:
#   - 强制 NODE_ENV=development（本机 shell 常驻 production 会干扰 vite 判断）
#   - 依赖体检：node_modules 缺失则自动安装；Electron 二进制缺失则走镜像补装
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# --- 1. 环境修正 -------------------------------------------------------------
export NODE_ENV=development

# --- 2. 参数解析 -------------------------------------------------------------
ELECTRON_EXTRA=()
RESET=0
DEBUG_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --x11)        ELECTRON_EXTRA+=("--ozone-platform=x11") ;;
    --debug-port) DEBUG_PORT="${2:-}"; [ -n "$DEBUG_PORT" ] && ELECTRON_EXTRA+=("--remote-debugging-port=$DEBUG_PORT"); shift ;;
    --reset)      RESET=1 ;;
    -h|--help)    sed -n '2,17p' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *)            echo "[dev] 未知参数: $1（可用: --x11 --debug-port <n> --reset）" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "${ELECTRON_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  ELECTRON_EXTRA+=($ELECTRON_ARGS)
fi

# --- 3. 依赖体检 -------------------------------------------------------------
if [ ! -f node_modules/electron-vite/package.json ] || [ ! -f node_modules/react/package.json ]; then
  echo "[dev] node_modules 缺失，安装依赖（约 1-2 分钟）..."
  npm install --include=dev --no-audit --no-fund
fi
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "[dev] Electron 二进制缺失（安装脚本被 npm 白名单拦截），经镜像补装..."
  node node_modules/electron/install.js
fi

# --- 4. 可选清缓存 -----------------------------------------------------------
if [ "$RESET" -eq 1 ]; then
  echo "[dev] 清空 out/ 构建缓存..."
  rm -rf out
fi

# --- 5. 启动 -----------------------------------------------------------------
echo "[dev] 启动 electron-vite dev（NODE_ENV=$NODE_ENV）..."
if [ "${#ELECTRON_EXTRA[@]}" -gt 0 ]; then
  echo "[dev] electron 附加参数: ${ELECTRON_EXTRA[*]}"
  exec npx electron-vite dev -- "${ELECTRON_EXTRA[@]}"
fi
exec npx electron-vite dev
