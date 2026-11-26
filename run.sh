#!/bin/bash
# Rappo 실행 래퍼. Rappo.app 이 호출한다.
# RAPPO_HOME(=로컬 venv/모델/상태) 는 config.sh 에서 읽는다.
set -o pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"            # NAS/Rappo (코드·동기화됨)

# 로컬 설정 (install.sh 가 생성): RAPPO_HOME, 경로 오버라이드, PATH
# Rappo.app 설정 창에서 지정한 값(APP_RAPPO_*)이 있으면 그것이 우선한다.
[ -f "$HERE/config.sh" ] && . "$HERE/config.sh"
for k in RECORD KAKAO VAULT KAKAO_ME SINCE; do
  v="APP_RAPPO_$k"
  [ -n "${!v}" ] && export "RAPPO_$k=${!v}"
done
: "${RAPPO_HOME:=$HOME/.venvs/rappo}"

PY="$RAPPO_HOME/bin/python"
LOG_DIR="$RAPPO_HOME/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/rappo.log"

# sqlcipher, ffmpeg, claude 등이 있는 Homebrew 경로를 PATH 에 추가
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

{
  echo "──────── $(date "+%Y-%m-%d %H:%M:%S")  args: $*  녹취: ${RAPPO_RECORD:-기본}  since: ${RAPPO_SINCE:-없음}"
  "$PY" "$HERE/rappo.py" "$@"
  echo "끝 (exit $?)"
} >>"$LOG" 2>&1

# 로그가 5MB 넘으면 잘라냄
if [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
