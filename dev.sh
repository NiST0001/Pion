#!/usr/bin/env bash
# ============================================================================
# Pion 开发版启动脚本
#
# 用法:
#   ./dev.sh                    # 常规启动（渲染进程 HMR + 主进程热重建）
#   ./dev.sh --x11              # 经 XWayland 运行（规避 wayland+vulkan 告警）
#   ./dev.sh --debug-port 9333  # 开启 CDP 远程调试端口
#   ./dev.sh --reset            # 清空 out/ 缓存后启动
#   ./dev.sh --branch           # 交互选择本地分支后启动
#   ./dev.sh --branch <name>    # 切到指定本地分支后启动
#
# 分支选择:
#   - 按最近提交列出本地分支；目标分支已在其他 worktree 检出时，
#     自动切换到该 worktree 目录启动（不强行 git switch）
#   - 未提交改动由 git switch 裁决：可携带则携带，冲突则拒绝，不做自动 stash
#
# 环境变量:
#   ELECTRON_ARGS="..."         # 追加传给 electron 的参数（空格分隔）
#
#   脚本自动处理:
#   - 强制 NODE_ENV=development（本机 shell 常驻 production 会干扰 vite 判断）
#   - 依赖体检：node_modules 缺失或不完整则自动安装；Electron 缺二进制经镜像
#     补装，包损坏则重装
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# --- 1. 环境修正 -------------------------------------------------------------
export NODE_ENV=development

# --- 2. 参数解析 -------------------------------------------------------------
ELECTRON_EXTRA=()
RESET=0
DEBUG_PORT=""
BRANCH=""
PICK_BRANCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --x11)        ELECTRON_EXTRA+=("--ozone-platform=x11") ;;
    --debug-port) DEBUG_PORT="${2:-}"; [ -n "$DEBUG_PORT" ] && ELECTRON_EXTRA+=("--remote-debugging-port=$DEBUG_PORT"); shift ;;
    --reset)      RESET=1 ;;
    --branch=*)   PICK_BRANCH=1; BRANCH="${1#*=}" ;;
    -b|--branch)  PICK_BRANCH=1; case "${2:-}" in ""|-*) ;; *) BRANCH="$2"; shift ;; esac ;;
    -h|--help)    sed -n '2,24p' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *)            echo "[dev] 未知参数: $1（可用: --x11 --debug-port <n> --reset --branch [name]）" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "${ELECTRON_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  ELECTRON_EXTRA+=($ELECTRON_ARGS)
fi

# --- 3. 分支选择（可选） ------------------------------------------------------
if [ "$PICK_BRANCH" -eq 1 ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[dev] 当前目录不是 Git 仓库，无法使用 --branch" >&2
    exit 1
  fi
  WORKTREE_LIST="$(git worktree list --porcelain)"
  CURRENT_BRANCH="$(git branch --show-current)"

  # 查询某分支检出于哪个 worktree；未检出任何 worktree 时返回空
  worktree_of() {
    local target="$1" line wt=""
    while IFS= read -r line; do
      case "$line" in
        worktree\ *) wt="${line#worktree }" ;;
        branch\ *)
          if [ "${line#branch refs/heads/}" = "$target" ]; then
            printf '%s\n' "$wt"
            return 0
          fi ;;
      esac
    done <<< "$WORKTREE_LIST"
    return 1
  }

  # 相对主 worktree 的上级目录缩短路径，仅用于展示
  short_path() {
    local wt="$1" parent
    parent="${WORKTREE_LIST%%$'\n'*}"
    parent="${parent#worktree }"
    parent="$(dirname "$parent")"
    case "$wt" in
      "$parent"/*) printf '%s\n' "${wt#"$parent"/}" ;;
      *)           printf '%s\n' "$wt" ;;
    esac
  }

  if [ -z "$BRANCH" ]; then
    # 交互选择
    if [ ! -t 0 ]; then
      echo "[dev] 非交互终端，请使用: ./dev.sh --branch <分支名>" >&2
      exit 1
    fi
    echo "[dev] 本地分支（按最近提交排序）:"
    mapfile -t BRANCH_LINES < <(git for-each-ref refs/heads --sort=-committerdate --format='%(refname:short)|%(committerdate:relative)')
    if [ "${#BRANCH_LINES[@]}" -eq 0 ]; then
      echo "[dev] 没有可选择的本地分支" >&2
      exit 1
    fi
    idx=0
    for line in "${BRANCH_LINES[@]}"; do
      idx=$((idx+1))
      b="${line%%|*}"
      mark=""
      [ "$b" = "$CURRENT_BRANCH" ] && mark="  ← 当前"
      wt="$(worktree_of "$b" || true)"
      if [ -n "$wt" ] && [ "$wt" != "$(pwd -P)" ]; then
        mark="$mark  → worktree: $(short_path "$wt")"
      fi
      printf '  %2d) %-30s（%s）%s\n' "$idx" "$b" "${line#*|}" "$mark"
    done
    printf '   0) 取消\n'
    printf '[dev] 请输入编号: '
    if ! read -r CHOICE; then
      echo; echo "[dev] 已取消" >&2; exit 1
    fi
    case "$CHOICE" in
      0|q|Q|"") echo "[dev] 已取消" >&2; exit 1 ;;
    esac
    if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "${#BRANCH_LINES[@]}" ]; then
      echo "[dev] 无效编号: $CHOICE" >&2; exit 1
    fi
    BRANCH="${BRANCH_LINES[$((CHOICE-1))]%%|*}"
  else
    if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      echo "[dev] 本地分支不存在: $BRANCH（现有分支:）" >&2
      git for-each-ref refs/heads --format='  %(refname:short)' >&2
      exit 1
    fi
  fi

  if [ "$BRANCH" = "$CURRENT_BRANCH" ]; then
    echo "[dev] 已在分支 $BRANCH"
  else
    WT="$(worktree_of "$BRANCH" || true)"
    if [ -n "$WT" ] && [ "$WT" != "$(pwd -P)" ]; then
      echo "[dev] $BRANCH 已检出于 worktree: $WT"
      echo "[dev] 切换到该 worktree 启动（依赖体检与 --reset 将在该目录执行）"
      cd "$WT"
    else
      if [ -n "$(git status --porcelain)" ]; then
        echo "[dev] 提示: 工作区有未提交改动，git switch 可携带则携带，冲突则拒绝"
      fi
      echo "[dev] 切换分支: ${CURRENT_BRANCH:-（detached）} → $BRANCH"
      git switch "$BRANCH"
    fi
  fi
fi

# --- 4. 依赖体检 -------------------------------------------------------------
# vite 与 electron-vite/react 一同检查：部分安装/占位 node_modules 会缺 vite
if [ ! -f node_modules/electron-vite/package.json ] || [ ! -f node_modules/react/package.json ] || [ ! -f node_modules/vite/package.json ]; then
  echo "[dev] node_modules 缺失或不完整，安装依赖（约 1-2 分钟）..."
  npm install --include=dev --no-audit --no-fund
fi
if [ ! -x node_modules/electron/dist/electron ]; then
  if [ -f node_modules/electron/install.js ]; then
    echo "[dev] Electron 二进制缺失（安装脚本被 npm 白名单拦截），经镜像补装..."
    node node_modules/electron/install.js
  else
    echo "[dev] electron 包不完整，重装 electron（约 1-2 分钟）..."
    npm install electron --no-save --no-audit --no-fund
  fi
fi
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "[dev] Electron 二进制仍缺失（安装脚本可能被 npm 白名单拦截），请手动执行: node node_modules/electron/install.js" >&2
  exit 1
fi

# --- 5. 可选清缓存 -----------------------------------------------------------
if [ "$RESET" -eq 1 ]; then
  echo "[dev] 清空 out/ 构建缓存..."
  rm -rf out
fi

# --- 6. 启动 -----------------------------------------------------------------
echo "[dev] 启动 electron-vite dev（NODE_ENV=$NODE_ENV，目录: $(pwd)）..."
if [ "${#ELECTRON_EXTRA[@]}" -gt 0 ]; then
  echo "[dev] electron 附加参数: ${ELECTRON_EXTRA[*]}"
  exec npx electron-vite dev -- "${ELECTRON_EXTRA[@]}"
fi
exec npx electron-vite dev
