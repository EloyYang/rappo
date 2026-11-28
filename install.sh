#!/bin/bash
# Rappo(라포) 설치 — 이 폴더에서 한 번 실행:  bash install.sh
#  1) 필요한 도구(Homebrew ffmpeg·sqlcipher)와 파이썬 환경·음성 모델 설치
#  2) 녹취 폴더 지정
#  3) 옵시디언이 있으면 볼트에 대시보드·검색 플러그인 자동 세팅
#  4) 메뉴막대 앱 Rappo.app 빌드·실행
# 다시 실행해도 안전합니다(기존 설정·노트 유지). 질문 없이 기본값으로: RAPPO_YES=1 bash install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ask() {  # ask "질문" "기본값" [환경변수 이름] → 답(stdout). 설치 창(앱)은 답을 환경변수로 넘긴다
  local q="$1" def="$2" ans=""
  if [ -n "$3" ] && [ -n "${!3}" ]; then printf '%s' "${!3}"; return; fi
  if [ -z "$RAPPO_YES" ] && [ -r /dev/tty ]; then
    printf '%s [%s]: ' "$q" "$def" >/dev/tty
    read -r ans </dev/tty || true
  fi
  printf '%s' "${ans:-$def}"
}

step "Rappo(라포) 설치"
say "코드 폴더: $HERE"

# 0) 기본 확인
[ "$(uname -s)" = Darwin ] || { say "macOS 전용입니다."; exit 1; }
[ "$(uname -m)" = arm64 ] || { say "Apple Silicon(M1 이상) 맥이 필요합니다 (음성 인식에 MLX 사용)."; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  say "Xcode 명령행 도구가 필요합니다. 설치 창이 뜨면 설치한 뒤 이 스크립트를 다시 실행하세요."
  xcode-select --install || true
  exit 1
fi
command -v brew >/dev/null || [ -x /opt/homebrew/bin/brew ] || {
  say "Homebrew 가 필요합니다. 아래 명령으로 설치한 뒤 다시 실행하세요:"
  say '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
}
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# 파이썬은 Homebrew 것으로 (맥 기본 python3 는 개발자 도구가 있어야 해서)
[ -x /opt/homebrew/bin/python3 ] || [ -x /usr/local/bin/python3 ] || brew install python

# 기존 설정(다시 설치하는 경우) 읽기 — 예전 이름(CALLNOTES_)도 인식
OLD_HOME="" OLD_RECORD="" OLD_KAKAO="" OLD_VAULT="" OLD_BASE="" OLD_SINCE=""
if [ -f config.sh ]; then
  # shellcheck disable=SC1091
  . ./config.sh
  OLD_HOME="${RAPPO_HOME:-$CALLNOTES_HOME}"; OLD_RECORD="${RAPPO_RECORD:-$CALLNOTES_RECORD}"
  OLD_KAKAO="${RAPPO_KAKAO:-$CALLNOTES_KAKAO}"; OLD_VAULT="${RAPPO_VAULT:-$CALLNOTES_VAULT}"
  OLD_BASE="${RAPPO_BASE:-}"; OLD_SINCE="${RAPPO_SINCE:-$CALLNOTES_SINCE}"
fi
HOME_DIR="${OLD_HOME:-$HOME/.venvs/rappo}"
[ -z "$OLD_HOME" ] && [ -d "$HOME/.venvs/callnotes/bin" ] && HOME_DIR="$HOME/.venvs/callnotes"  # 예전 설치 재사용

PY3="$(command -v python3)"
[ -x /opt/homebrew/bin/python3 ] && PY3=/opt/homebrew/bin/python3
# 로컬 AI (요약·할 일·회의록·Rappo AI 를 맥 안에서) — 선택. Apple 실리콘용 MLX
#  RAPPO_ANS_AI_MODEL: 받을 모델 (기본 Qwen3.5 4B 약 3GB · 메모리 16GB 이상이면 9B 약 6GB 도 좋아요)
AI_MODEL_ID="${RAPPO_ANS_AI_MODEL:-mlx-community/Qwen3.5-4B-MLX-4bit}"
install_ai() {
  if [ ! -x "$HOME/.venvs/mlx-llm/bin/python" ]; then
    yn="$(ask "로컬 AI(MLX + Qwen3.5, 약 3~6GB)도 설치할까요? 요약·할 일·회의록·Rappo AI 를 맥 안에서 해요. y/N" "N" RAPPO_ANS_AI)"
    [[ "$yn" =~ ^[Yy] ]] || return 0
    say "로컬 AI 설치 중… (MLX)"
    { "$PY3" -m venv "$HOME/.venvs/mlx-llm" && "$HOME/.venvs/mlx-llm/bin/pip" install -q -U pip mlx-lm; } \
      || { echo "  ! 로컬 AI 설치를 마치지 못했어요 — 나중에 다시 설치해 주세요"; return 0; }
  elif [ "$RAPPO_ANS_AI" = "n" ]; then
    return 0
  fi
  say "로컬 모델 받는 중… $AI_MODEL_ID (처음 한 번, 몇 분 걸려요)"
  "$HOME/.venvs/mlx-llm/bin/python" -c "from huggingface_hub import snapshot_download as s; s('$AI_MODEL_ID')" \
    || echo "  ! 모델을 받지 못했어요 — 옵시디언 Rappo AI 의 🧠 모델에서 다시 받을 수 있어요"
}

# AI·보기만 (다른 맥에서 이미 정리 중): 로컬 AI 만 설치하고, 녹음·카톡 정리는 하지 않는다
# (두 맥이 같은 볼트를 함께 정리하면 할 일·캘린더 일정이 겹칠 수 있어서)
if [ "$RAPPO_ROLE" = "viewer" ]; then
  step "1/2 로컬 AI"
  install_ai
  step "2/2 설정"
  VAULT="${OLD_VAULT:-$RAPPO_ANS_VAULT}"
  if [ -n "$VAULT" ] && [ ! -d "$VAULT/.obsidian/plugins/rappo" ]; then
    python3 obsidian_setup.py --vault "$VAULT" --base "${RAPPO_ANS_BASE:-통화기록}" | sed 's/^/  /'
  fi
  {
    echo "# Rappo 설정 (install.sh 가 생성) — 이 맥은 AI·보기만 (정리는 다른 맥에서)"
    echo "export RAPPO_ROLE=\"viewer\""
    echo "export RAPPO_HOME=\"$HOME_DIR\""
    echo "export RAPPO_VAULT=\"$VAULT\""
    echo "export RAPPO_BASE=\"${RAPPO_ANS_BASE:-$OLD_BASE}\""
    echo "export RAPPO_AI_MODEL=\"$AI_MODEL_ID\""
  } >config.sh
  step "설치 완료"
  say "이 맥에서는 옵시디언 Rappo AI 를 쓰고, 녹음·카톡 정리는 다른 맥이 해요."
  exit 0
fi

# 1) 도구
step "1/5 도구 설치 (ffmpeg, sqlcipher)"
for f in ffmpeg sqlcipher; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done

# 2) 파이썬 환경 + 모델
step "2/5 파이썬 환경·모델 (처음엔 몇 분 걸려요)"
say "위치: $HOME_DIR"
[ -d "$HOME_DIR/bin" ] || "$PY3" -m venv "$HOME_DIR"
install_ai
"$HOME_DIR/bin/python" -m pip install -q --upgrade pip
"$HOME_DIR/bin/python" -m pip install -q mlx-whisper sherpa-onnx soundfile
M="$HOME_DIR/models"; mkdir -p "$M" "$HOME_DIR/kakao" "$HOME_DIR/logs"
SEG="$M/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMB="$M/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
if [ ! -f "$SEG" ]; then
  say "화자 구분 모델 내려받는 중…"
  curl -fsSL -o "$M/seg.tar.bz2" \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar xjf "$M/seg.tar.bz2" -C "$M" && rm "$M/seg.tar.bz2"
fi
if [ ! -f "$EMB" ]; then
  say "화자 임베딩 모델 내려받는 중…"
  curl -fsSL -o "$EMB" \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
fi
# 같은 사람이 다른 맥에 설치할 때: state/ 에 둔 내 목소리·카톡 캐시를 가져옴 (배포본엔 없음)
[ -f state/me.npy ] && [ ! -f "$M/me.npy" ] && cp state/me.npy "$M/me.npy"
[ -f state/userids ] && [ ! -f "$HOME_DIR/kakao/userids" ] && cp state/userids "$HOME_DIR/kakao/userids"

# 3) 녹취 폴더
step "3/5 녹취 폴더"
DEF_REC="$OLD_RECORD"
if [ -z "$DEF_REC" ]; then
  for base in "$HOME/Library/CloudStorage"/SynologyDrive-*; do
    [ -d "$base/1.Short/녹취" ] && { DEF_REC="$base/1.Short/녹취"; break; }
  done
fi
DEF_REC="${DEF_REC:-$HOME/Documents/Rappo/녹취}"
say "휴대폰 통화 녹음 파일이 모이는 폴더 (파일 이름 예: 홍길동_01012345678_20261126143000.m4a)"
REC="$(ask "녹취 폴더" "$DEF_REC" RAPPO_ANS_REC)"
REC="${REC/#\~/$HOME}"
mkdir -p "$REC" 2>/dev/null || true
KAK="${OLD_KAKAO:-$HOME/Documents/Rappo/카카오톡}"
mkdir -p "$KAK" 2>/dev/null || true
SINCE="$OLD_SINCE"
if [ -z "$OLD_RECORD" ]; then
  N=$(find "$REC" -maxdepth 2 -type f \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.wav' -o -iname '*.amr' -o -iname '*.3gp' -o -iname '*.aac' -o -iname '*.ogg' \) 2>/dev/null | wc -l | tr -d ' ')
  if [ "${N:-0}" -gt 0 ]; then
    yn="$(ask "이미 있는 녹취 ${N}개도 모두 변환할까요? (오래 걸릴 수 있어요) y/N" "N" RAPPO_ANS_CONVERT)"
    case "$yn" in [yY]*) SINCE="" ;; *) SINCE="$(date '+%Y-%m-%d %H:%M')"; say "→ 지금($SINCE) 이후 녹취만 변환합니다. 앱 설정에서 바꿀 수 있어요." ;; esac
  fi
fi

# 4) 옵시디언
step "4/5 옵시디언"
VAULT="${OLD_VAULT:-$RAPPO_ANS_VAULT}" BASE="$OLD_BASE"
if [ -d /Applications/Obsidian.app ] || [ -f "$HOME/Library/Application Support/obsidian/obsidian.json" ]; then
  VAULTS=()
  while IFS= read -r v; do [ -n "$v" ] && VAULTS+=("$v"); done < <(python3 obsidian_setup.py --list 2>/dev/null)
  if [ -z "$VAULT" ] && [ ${#VAULTS[@]} -gt 0 ]; then
    if [ ${#VAULTS[@]} -eq 1 ]; then
      VAULT="${VAULTS[0]}"
    else
      say "옵시디언 볼트가 여러 개 있어요:"
      i=1; for v in "${VAULTS[@]}"; do say "  $i) $v"; i=$((i+1)); done
      n="$(ask "Rappo 노트를 넣을 볼트 번호" "1")"
      VAULT="${VAULTS[$((n-1))]:-${VAULTS[0]}}"
    fi
  fi
  if [ -z "$VAULT" ]; then
    say "등록된 볼트가 없어요. 옵시디언에서 볼트를 만든 뒤 메뉴막대 Rappo → '옵시디언에 대시보드·검색 설치'를 누르세요."
  else
    say "볼트: $VAULT"
    # PARA 노트 정리 방식 (Inbox·Projects·Areas·Resources·Archive 폴더, 템플릿, PARA 대시보드, 자동 이동)
    PARA_ARG=""
    if [ ! -d "$VAULT/1. Projects" ] && [ ! -d "$VAULT/.obsidian/plugins/para-dashboard" ]; then
      yn="$(ask "PARA 노트 정리 방식(프로젝트·영역 폴더, 템플릿, PARA 대시보드)도 함께 설치할까요? y/N" "N" RAPPO_ANS_PARA)"
      [[ "$yn" =~ ^[Yy] ]] && PARA_ARG="--para"
    fi
    if [ -n "$PARA_ARG" ]; then mkdir -p "$VAULT/2. Areas"; fi
    [ -n "$BASE" ] || BASE="$(python3 obsidian_setup.py --vault "$VAULT" --default-base)"
    BASE="$(ask "볼트 안 저장 폴더" "$BASE" RAPPO_ANS_BASE)"
    python3 obsidian_setup.py --vault "$VAULT" --base "$BASE" $PARA_ARG | sed 's/^/  /'
  fi
else
  say "옵시디언이 없어요 (https://obsidian.md 에서 설치). 설치 후 이 스크립트를 다시 실행하거나"
  say "메뉴막대 Rappo → 설정에서 볼트를 고르고 '옵시디언에 대시보드·검색 설치'를 누르세요."
fi
[ -n "$VAULT" ] || VAULT="$HOME/Documents/Obsidian"
[ -n "$BASE" ] || BASE="통화기록"

cat >config.sh <<EOF
# Rappo 설정 (install.sh 가 생성). 앱 설정 창에서 바꾼 값이 있으면 그것이 우선합니다.
export RAPPO_HOME="$HOME_DIR"
export RAPPO_RECORD="$REC"
export RAPPO_KAKAO="$KAK"
export RAPPO_VAULT="$VAULT"
export RAPPO_BASE="$BASE"
export RAPPO_SINCE="$SINCE"
EOF
if [ -n "$RAPPO_ANS_AI_MODEL" ]; then echo "export RAPPO_AI_MODEL=\"$RAPPO_ANS_AI_MODEL\"" >>config.sh; fi

# 5) 앱
step "5/5 메뉴막대 앱 Rappo.app"
if [ -n "$RAPPO_FROM_APP" ]; then
  say "응용 프로그램 폴더의 Rappo.app 을 그대로 써요."
else
  bash app/build.sh
fi

step "설치 완료"
say "메뉴막대의 📞 아이콘이 Rappo 입니다. 처음 한 번만 해 주세요:"
say "  1. 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한 → '+' → ~/Applications/Rappo.app 추가"
say "     (카카오톡 대화와 네트워크 드라이브 녹취를 읽는 데 필요)"
say "  2. 메뉴막대 Rappo → '로그인 시 자동 실행' 켜기"
say "  3. 메뉴막대 Rappo → '내 목소리 등록…' 에서 내 목소리만 녹음된 파일을 고르면 전사문에 '나'가 구분돼요"
say "  4. 옵시디언을 열고 '플러그인을 신뢰/사용' 할지 물으면 허용 → '$BASE/라포 홈' 노트를 여세요"
command -v claude >/dev/null || say "  (선택) 통화 요약은 Claude Code(claude 명령)가 있을 때 만들어져요: https://claude.com/claude-code"
