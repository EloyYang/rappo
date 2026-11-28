#!/bin/bash
# 다른 사람에게 줄 맥 설치 파일 만들기:  bash make_dmg.sh [버전]  →  dist/Rappo.dmg
# - 앱(Rappo.app) 안에 프로그램 코드를 넣는다 (Contents/Resources/code).
#   처음 열면 설치 창이 떠서 녹취 폴더·볼트·로컬 AI 를 고르면 install.sh 를 대신 돌린다.
# - 내 맥 전용 설정(config.sh)·내 목소리/카톡 캐시(state/)·.git 은 넣지 않는다 (make_dist.sh 와 같은 기준).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
VER="${1:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')}"
VER="${VER:-0.0.0}"
STAMP="$VER-$(git rev-parse --short HEAD 2>/dev/null || date +%s)$(git diff --quiet 2>/dev/null || echo "-dev$(date +%s)")"
ID="${RAPPO_DMG_ID:-app.rappo.mac}"
OUT="$HERE/dist"
TMP="$(mktemp -d)"
APP="$TMP/dmg/Rappo.app"
mkdir -p "$OUT" "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "앱 컴파일 중… (버전 $VER)"
swiftc -O -o "$APP/Contents/MacOS/Rappo" app/Rappo.swift
cp app/icon/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# 프로그램 코드 (배포 zip 과 같은 기준으로 개인 파일 제외)
rsync -a \
  --exclude config.sh --exclude state/ --exclude dist/ --exclude __pycache__/ --exclude .git --exclude .claude/ \
  --exclude .DS_Store --exclude '*.pyc' --exclude '._*' \
  "$HERE/" "$APP/Contents/Resources/code/"
printf '%s\n' "$STAMP" >"$APP/Contents/Resources/code/.bundle-stamp"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>Rappo</string>
  <key>CFBundleDisplayName</key><string>Rappo</string>
  <key>CFBundleExecutable</key><string>Rappo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>챙길 날과 대화에서 정한 일정을 캘린더에 넣어요.</string>
  <key>NSCalendarsUsageDescription</key><string>챙길 날과 대화에서 정한 일정을 캘린더에 넣어요.</string>
  <key>CNInterval</key><string>1800</string>
</dict></plist>
EOF
codesign --force --deep --sign - --identifier "$ID" "$APP"

# 개인 경로가 들어갔으면 멈춤
if grep -rIl "$HOME" "$APP/Contents/Resources/code" >/dev/null 2>&1; then
  echo "⚠️  아래 파일에 내 맥 경로가 들어 있어 만들지 않았어요:"; grep -rIl "$HOME" "$APP/Contents/Resources/code"; rm -rf "$TMP"; exit 1
fi

# dmg: 앱 + 응용 프로그램 폴더 바로가기
ln -s /Applications "$TMP/dmg/Applications"
rm -f "$OUT/Rappo.dmg"
hdiutil create -quiet -volname "Rappo $VER" -srcfolder "$TMP/dmg" -fs HFS+ -format UDZO -ov "$OUT/Rappo.dmg"
rm -rf "$TMP"
echo "만듦: $OUT/Rappo.dmg"
echo "받는 사람: dmg 를 열고 Rappo 를 Applications 로 끌어다 놓은 뒤, 응용 프로그램에서 Rappo 열기"
