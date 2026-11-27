#!/bin/bash
# Rappo.app 빌드·설치.  보통은 install.sh 가 부른다. 직접:  bash app/build.sh
# - ~/Applications/Rappo.app 을 만들고, 예전 이름(CallNotes)의 앱·launchd 작업은 정리한다.
set -e
APPSRC="$(cd "$(dirname "$0")" && pwd)"
HERE="$(dirname "$APPSRC")"
INTERVAL="${RAPPO_INTERVAL:-1800}"

# 코드 폴더: 네트워크 드라이브(/Volumes)에 있으면, 같은 폴더의 Synology Drive 로컬 동기화본을 우선
CODE="$HERE"
case "$HERE" in /Volumes/*)
  for base in "$HOME/Library/CloudStorage"/SynologyDrive-*; do
    [ -f "$base/1.Short/Rappo/run.sh" ] && { CODE="$base/1.Short/Rappo"; break; }
  done ;;
esac
[ -f "$CODE/config.sh" ] || { echo "config.sh 가 없습니다. 먼저 install.sh 를 실행하세요."; exit 1; }

ID="app.rappo.mac"
DEST="$HOME/Applications/Rappo.app"
BUILD="$(mktemp -d)"
APP="$BUILD/Rappo.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "컴파일 중…"
swiftc -O -o "$APP/Contents/MacOS/Rappo" "$APPSRC/Rappo.swift"
cp "$APPSRC/icon/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>Rappo</string>
  <key>CFBundleDisplayName</key><string>Rappo</string>
  <key>CFBundleExecutable</key><string>Rappo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.3</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>챙길 날과 대화에서 정한 일정을 캘린더에 넣어요.</string>
  <key>NSCalendarsUsageDescription</key><string>챙길 날과 대화에서 정한 일정을 캘린더에 넣어요.</string>
  <key>CNCodeDir</key><string>$CODE</string>
  <key>CNInterval</key><string>$INTERVAL</string>
</dict></plist>
EOF

# 이 맥에 'Rappo Local Signing' 인증서가 있으면 그것으로 서명 → 다시 빌드해도 서명이 같아서
# 전체 디스크 접근 권한이 풀리지 않는다. 없으면 임시(ad-hoc) 서명.
SIGN="$(security find-certificate -c "Rappo Local Signing" -Z 2>/dev/null | awk '/SHA-1 hash:/{print $3; exit}')"
if [ -n "$SIGN" ]; then
  codesign --force --sign "$SIGN" --identifier "$ID" "$APP"
else
  codesign --force --sign - --identifier "$ID" "$APP"
fi

# 기존 앱 종료 후 교체 (+ 예전 이름 CallNotes 정리)
pkill -x Rappo 2>/dev/null || true
pkill -x CallNotes 2>/dev/null || true
rm -rf "$HOME/Applications/CallNotes.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
mv "$APP" "$DEST"
rm -rf "$BUILD"
for p in "$HOME/Library/LaunchAgents"/com.eloy.callnotes.*.plist; do
  [ -f "$p" ] && { launchctl unload "$p" 2>/dev/null || true; rm -f "$p"; echo "예전 자동 실행 해제: $(basename "$p")"; }
done

# 예전 이름(CallNotes) 앱의 설정을 처음 한 번 옮겨 옴
if defaults read com.eloy.callnotes >/dev/null 2>&1 && ! defaults read "$ID" migratedFromCallNotes >/dev/null 2>&1; then
  defaults export com.eloy.callnotes - | defaults import "$ID" - && defaults write "$ID" migratedFromCallNotes -bool true
  echo "예전 CallNotes 설정을 옮겼습니다."
fi

open "$DEST"
echo "앱: $DEST  (코드 폴더: $CODE)"
[ -n "$SIGN" ] && echo "서명: Rappo Local Signing (다시 빌드해도 권한 유지)" || echo "⚠️  임시 서명이라 다시 빌드하면 '전체 디스크 접근 권한'을 다시 켜야 할 수 있습니다."
