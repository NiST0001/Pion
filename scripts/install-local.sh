#!/usr/bin/env bash
# ============================================================================
# Pion 本机安装脚本
#
# 编译当前源码并把应用安装到本机（免分发打包，供单机长期使用）:
#   ~/.local/share/pion/app/        应用本体（out/ + package.json + node_modules）
#   ~/.local/share/pion/icon.png    应用图标
#   ~/.local/bin/pion               命令行启动器
#   ~/.local/share/applications/pion.desktop  桌面快捷方式
# 数据目录遵循 XDG_DATA_HOME，以上为默认路径。
#
# 用法:
#   ./scripts/install-local.sh            # 递增补丁版本号 + 编译 + 安装
#   ./scripts/install-local.sh --no-build # 跳过编译，直接安装现有 out/
#   ./scripts/install-local.sh --no-bump  # 跳过版本号递增
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/pion"
APP_DIR="$PREFIX/app"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
FONT_BOLD="/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"

BUILD=1
BUMP=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-bump) BUMP=0 ;;
    *) echo "[install] 未知参数: $arg（可用: --no-build --no-bump）" >&2; exit 1 ;;
  esac
done

if [ "$BUMP" -eq 1 ]; then
  OLD_VERSION="$(node -p "require('./package.json').version")"
  if command -v npm >/dev/null 2>&1; then
    NEW_VERSION="$(npm version patch --no-git-tag-version)"
  else
    NEW_VERSION="$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));const v=p.version.split('.');v[2]=String(Number(v[2]||0)+1);p.version=v.join('.');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('v'+p.version)")"
  fi
  echo "[install] 版本号: $OLD_VERSION -> $NEW_VERSION"
fi

if [ "$BUILD" -eq 1 ]; then
  echo "[install] 编译（electron-vite build）..."
  if command -v npm >/dev/null 2>&1; then
    npm run build
  else
    node node_modules/electron-vite/bin/electron-vite.js build
  fi
fi

if [ ! -f out/main/index.js ]; then
  echo "[install] 缺少 out/main/index.js，请先编译" >&2
  exit 1
fi

echo "[install] 安装应用到 $APP_DIR ..."
# Limit deletion to generated files; never mirror/delete the application root
# or Chromium/user configuration directories during an upgrade.
mkdir -p "$APP_DIR/out"
PREFIX="$(cd "$PREFIX" && pwd -P)"
APP_DIR="$(cd "$APP_DIR" && pwd -P)"
rsync -a --delete out/ "$APP_DIR/out/"
cp package.json "$APP_DIR/package.json"

echo "[install] 同步运行时依赖（剔除开发依赖）..."
LIST="$(mktemp)"
if command -v npm >/dev/null 2>&1; then
  npm ls --omit=dev --parseable --all 2>/dev/null | tail -n +2 | sed "s|^$PWD/||" > "$LIST" || true
fi
if [ -s "$LIST" ]; then
  rm -rf "$APP_DIR/node_modules"
  mkdir -p "$APP_DIR/node_modules"
  tar -cf - -T "$LIST" | tar -xf - -C "$APP_DIR"
else
  echo "[install] 警告：无法枚举生产依赖，回退为完整复制 node_modules" >&2
  mkdir -p "$APP_DIR/node_modules"
  rsync -a --delete node_modules/ "$APP_DIR/node_modules/"
fi
rm -f "$LIST"
# Electron 在 package.json 里属 devDependency，但它是桌面应用运行时本体
rm -rf "$APP_DIR/node_modules/electron"
cp -a node_modules/electron "$APP_DIR/node_modules/electron"
# npm ls may still report packages left in the developer checkout after a dependency
# removal. Never ship the removed third-party plan extension (or its namespace).
rm -rf "$APP_DIR/node_modules/@narumitw"
mkdir -p "$APP_DIR/node_modules/.bin"
ln -sfn ../electron/cli.js "$APP_DIR/node_modules/.bin/electron"

echo "[install] 生成图标..."
if [ -f "$FONT_BOLD" ]; then
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0xd97757:s=512x512" \
    -vf "drawtext=fontfile=$FONT_BOLD:text='π':fontcolor=0xeeeae4:fontsize=360:x=(w-text_w)/2:y=(h-text_h)/2-18" \
    -frames:v 1 "$PREFIX/icon.png"
else
  ffmpeg -y -loglevel error -f lavfi -i "color=c=0xd97757:s=512x512" -frames:v 1 "$PREFIX/icon.png"
fi

echo "[install] 创建启动器 $BIN_DIR/pion ..."
mkdir -p "$BIN_DIR"
{
  printf '#!/bin/sh\n# Pion 本机启动器\n'
  # Capture the installed path; launch-time HOME/XDG changes must not retarget it.
  printf "APP_DIR='%s'\n" "${APP_DIR//\'/\'\\\'\'}"
  cat <<'EOF'
exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" "$@"
EOF
} > "$BIN_DIR/pion"
chmod +x "$BIN_DIR/pion"

echo "[install] 创建桌面快捷方式..."
mkdir -p "$DESKTOP_DIR"
# Desktop string escaping is applied after Exec's quoted-argument escaping.
desktop_escape_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}
DESKTOP_EXEC="$BIN_DIR/pion"
DESKTOP_EXEC="${DESKTOP_EXEC//\\/\\\\}"
DESKTOP_EXEC="${DESKTOP_EXEC//\"/\\\"}"
DESKTOP_EXEC="${DESKTOP_EXEC//\$/\\\$}"
DESKTOP_EXEC="${DESKTOP_EXEC//\`/\\\`}"
DESKTOP_EXEC="${DESKTOP_EXEC//%/%%}"
cat > "$DESKTOP_DIR/pion.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pion
GenericName=AI Coding Workbench
Comment=Electron desktop GUI for the pi coding agent
Exec=$(desktop_escape_string "\"$DESKTOP_EXEC\"")
Icon=$(desktop_escape_string "$PREFIX/icon.png")
Terminal=false
Categories=Development;Utility;
Keywords=ai;coding;agent;pi;
StartupWMClass=pion
EOF
chmod 644 "$DESKTOP_DIR/pion.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true

echo "[install] 完成。应用菜单搜索「Pion」或终端运行 pion 即可启动。"
