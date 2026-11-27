#!/bin/bash
# 다른 사람에게 줄 배포용 압축 파일 만들기:  bash make_dist.sh  →  dist/Rappo.zip
# 내 맥 전용 설정(config.sh)·내 목소리/카톡 캐시(state/)·캐시 파일은 넣지 않는다.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/dist"
TMP="$(mktemp -d)"
mkdir -p "$OUT" "$TMP/Rappo"
rsync -a \
  --exclude config.sh --exclude state/ --exclude dist/ --exclude __pycache__/ --exclude .git/ --exclude .claude/ \
  --exclude .DS_Store --exclude '*.pyc' --exclude '._*' \
  "$HERE/" "$TMP/Rappo/"
# 혹시 남은 개인 경로가 있으면 알림
if grep -rIl "$HOME" "$TMP/Rappo" >/dev/null 2>&1; then
  echo "⚠️  아래 파일에 내 맥 경로가 들어 있습니다. 확인하세요:"; grep -rIl "$HOME" "$TMP/Rappo"
fi
rm -f "$OUT/Rappo.zip"
(cd "$TMP" && ditto -c -k --norsrc --noextattr --noqtn --keepParent Rappo "$OUT/Rappo.zip")
rm -rf "$TMP"
echo "만듦: $OUT/Rappo.zip"
echo "받는 사람: 압축을 풀고  bash Rappo/install.sh"
