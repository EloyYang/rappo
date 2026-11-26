#!/bin/bash
# Rappo 앱 제거 (옵시디언 노트·파이썬 환경은 남김)
pkill -x Rappo 2>/dev/null || true
rm -rf "$HOME/Applications/Rappo.app"
echo "Rappo.app 을 지웠습니다. (옵시디언 노트와 ~/.venvs 의 파이썬 환경·모델은 유지)"
echo "완전히 지우려면:  rm -rf ~/.venvs/rappo"
echo "로그인 항목에 남아 있으면: 시스템 설정 → 일반 → 로그인 항목 에서 Rappo 제거"
