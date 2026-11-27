#!/usr/bin/env python3
"""Rappo(라포) → 옵시디언 볼트 세팅.

볼트에 다음을 넣는다 (이미 있는 노트는 덮어쓰지 않음):
  <볼트>/<저장 폴더>/통화기록 대시보드.md   할 일 · 챙길 날 · 연락처 · 대화·통화 검색 (한 화면)
  <볼트>/<저장 폴더>/통화기록.base          연락처·통화·카톡방 표 (옵시디언 Bases)
  <볼트>/<저장 폴더>/{연락처,통화,카톡}/
  <볼트>/.obsidian/plugins/rappo/          검색·최근 연락 플러그인 (+ data.json 에 저장 폴더)
  <볼트>/.obsidian/community-plugins.json  플러그인 켜기
  <볼트>/.obsidian/types.json              날짜·숫자 속성 형식

사용법:
  python3 obsidian_setup.py --list                 옵시디언에 등록된 볼트 목록
  python3 obsidian_setup.py --vault <볼트> [--base "2. Areas/통화기록"] [--force]
표준 라이브러리만 쓴다 (설치 전 시스템 python3 로도 실행 가능).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "obsidian"
PLUGIN_ID = "rappo"
OLD_PLUGIN_IDS = ["kakao-search"]  # 예전 이름 (CallNotes 시절)
OBSIDIAN_JSON = Path.home() / "Library/Application Support/obsidian/obsidian.json"
TYPES = {
    "datetime": "datetime", "last_call": "date", "last_kakao": "date",
    "first_message": "date", "last_message": "date",
    "call_count": "number", "message_count": "number",
}


def vaults() -> list[dict]:
    """옵시디언에 등록된 볼트 (최근에 연 순서)."""
    try:
        d = json.loads(OBSIDIAN_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = [{"path": v.get("path", ""), "ts": v.get("ts", 0), "open": bool(v.get("open"))}
           for v in (d.get("vaults") or {}).values()]
    out = [v for v in out if v["path"] and Path(v["path"]).is_dir()]
    return sorted(out, key=lambda v: (v["open"], v["ts"]), reverse=True)


def default_base(vault: Path) -> str:
    # PARA 구조(2. Areas)를 쓰는 볼트면 그 아래, 아니면 볼트 바로 아래
    return "2. Areas/통화기록" if (vault / "2. Areas").is_dir() else "통화기록"


def read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(p: Path, data):
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def setup(vault: Path, base: str = "", force: bool = False) -> str:
    vault = vault.expanduser()
    if not vault.is_dir():
        raise SystemExit(f"볼트 폴더가 없습니다: {vault}")
    base = (base or default_base(vault)).strip("/")
    obs = vault / ".obsidian"
    obs.mkdir(exist_ok=True)
    root = vault / base
    for sub in ("연락처", "통화", "카톡"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    log = []

    # 1) 노트 (이미 있으면 그대로)
    for name in ("통화기록 대시보드.md", "통화기록.base"):
        dst = root / name
        if dst.exists() and not force:
            old = dst.read_text(encoding="utf-8")
            # v3 대시보드(한 화면)가 아닌 예전 대시보드는 새것으로 — 예전 것은 볼트 휴지통(.trash)에 남김
            if name.endswith(".md") and "```연락대시보드" not in old:
                trash = vault / ".trash"
                trash.mkdir(exist_ok=True)
                (trash / "통화기록 대시보드 (이전 버전).md").write_text(old, encoding="utf-8")
                log.append(f"교체: {base}/{name} (예전 것은 .trash 에)")
            else:
                log.append(f"유지: {base}/{name} (이미 있음)")
                continue
        text = (SRC / "templates" / name).read_text(encoding="utf-8").replace("{{BASE}}", base)
        dst.write_text(text, encoding="utf-8")
        log.append(f"생성: {base}/{name}")

    # 2) 플러그인 (항상 최신으로 교체, 예전 이름은 정리)
    pdir = obs / "plugins" / PLUGIN_ID
    pdir.mkdir(parents=True, exist_ok=True)
    for f in ("main.js", "manifest.json", "styles.css"):
        shutil.copy2(SRC / "plugin" / f, pdir / f)
    data = read_json(pdir / "data.json", {})
    data["base"] = base
    write_json(pdir / "data.json", data)
    enabled = read_json(obs / "community-plugins.json", [])
    for old in OLD_PLUGIN_IDS:
        if (obs / "plugins" / old).is_dir():
            shutil.rmtree(obs / "plugins" / old)
            log.append(f"예전 플러그인 정리: {old}")
        enabled = [x for x in enabled if x != old]
    if PLUGIN_ID not in enabled:
        enabled.append(PLUGIN_ID)
    write_json(obs / "community-plugins.json", enabled)
    log.append(f"플러그인: .obsidian/plugins/{PLUGIN_ID} (켜짐)")

    # 3) 속성 형식
    types = read_json(obs / "types.json", {})
    t = types.setdefault("types", {})
    added = [k for k in TYPES if k not in t]
    for k in added:
        t[k] = TYPES[k]
    write_json(obs / "types.json", types)
    if added:
        log.append("속성 형식 추가: " + ", ".join(added))

    # 4) Bases(표) 는 옵시디언 기본 기능 — 꺼져 있으면 켠다
    core = obs / "core-plugins.json"
    cp = read_json(core, None)
    if isinstance(cp, dict) and cp.get("bases") is False:
        cp["bases"] = True
        write_json(core, cp)
    elif isinstance(cp, list) and "bases" not in cp:
        cp.append("bases")
        write_json(core, cp)

    return "\n".join(log)


def main():
    ap = argparse.ArgumentParser(description="Rappo 옵시디언 볼트 세팅")
    ap.add_argument("--vault", type=Path)
    ap.add_argument("--base", default="", help='볼트 안 저장 폴더 (기본: "2. Areas/통화기록" 또는 "통화기록")')
    ap.add_argument("--force", action="store_true", help="대시보드·표 노트도 새로 덮어쓰기")
    ap.add_argument("--list", action="store_true", help="등록된 볼트 목록 (경로를 한 줄에 하나씩)")
    ap.add_argument("--default-base", action="store_true", help="--vault 에 맞는 기본 저장 폴더 출력")
    a = ap.parse_args()
    if a.list:
        for v in vaults():
            print(v["path"])
        return
    if not a.vault:
        ap.error("--vault 가 필요합니다")
    if a.default_base:
        print(default_base(a.vault.expanduser()))
        return
    print(setup(a.vault, a.base, a.force))


if __name__ == "__main__":
    sys.exit(main())
