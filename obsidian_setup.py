#!/usr/bin/env python3
"""Rappo(라포) → 옵시디언 볼트 세팅.

볼트에 다음을 넣는다 (이미 있는 노트는 덮어쓰지 않음):
  <볼트>/<저장 폴더>/라포 홈.md            할 일 · 오늘 일정 · 챙길 날 · 소비 · 연락처 (한 화면)
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


PARA_DIRS = ["0. Inbox", "1. Projects", "2. Areas", "3. Resources", "4. Archive"]
PARA_PLUGINS = ["para-dashboard", "para-auto-mover"]


def has_para(vault: Path) -> bool:
    """이미 PARA 방식(폴더나 PARA 플러그인)을 쓰는 볼트인가"""
    return all((vault / d).is_dir() for d in PARA_DIRS[1:4]) or (vault / ".obsidian/plugins/para-dashboard").is_dir()


def setup_para(vault: Path) -> list[str]:
    """PARA 노트 정리 방식: 폴더 · 템플릿 · PARA 대시보드 · 플러그인(대시보드·자동 이동).
    이미 있는 폴더·템플릿·노트는 건드리지 않고, 플러그인만 최신으로 바꾼다."""
    log = []
    obs = vault / ".obsidian"
    src = SRC / "para"
    for d in PARA_DIRS:
        if not (vault / d).exists():
            (vault / d).mkdir(parents=True)
            log.append(f"PARA 폴더: {d}")
    tdir = vault / "_Templates"
    tdir.mkdir(exist_ok=True)
    for t in sorted((src / "templates").glob("*.md")):
        if not (tdir / t.name).exists():
            shutil.copy2(t, tdir / t.name)
            log.append(f"템플릿: _Templates/{t.name}")
    for name in ("PARA 대시보드.md", "PARA Table.base"):
        if not (vault / name).exists() and not (name.endswith(".md") and (vault / "대시보드.md").exists()):
            shutil.copy2(src / name, vault / name)
            log.append(f"생성: {name}")
    enabled = read_json(obs / "community-plugins.json", [])
    for pid in PARA_PLUGINS:
        pdir = obs / "plugins" / pid
        pdir.mkdir(parents=True, exist_ok=True)
        for f in (src / "plugins" / pid).iterdir():
            shutil.copy2(f, pdir / f.name)
        if pid not in enabled:
            enabled.append(pid)
    write_json(obs / "community-plugins.json", enabled)
    log.append("플러그인: para-dashboard · para-auto-mover (켜짐)")
    # 핵심 플러그인 '템플릿'과 템플릿 폴더
    core = read_json(obs / "core-plugins.json", {})
    if isinstance(core, dict):
        core["templates"] = True
        write_json(obs / "core-plugins.json", core)
    elif isinstance(core, list) and "templates" not in core:
        write_json(obs / "core-plugins.json", core + ["templates"])
    tj = read_json(obs / "templates.json", {})
    if not tj.get("folder"):
        tj.update({"folder": "_Templates", "dateFormat": "YYYY-MM-DD"})
        write_json(obs / "templates.json", tj)
    return log


def setup(vault: Path, base: str = "", force: bool = False, para: bool | None = None) -> str:
    vault = vault.expanduser()
    if not vault.is_dir():
        raise SystemExit(f"볼트 폴더가 없습니다: {vault}")
    if para:   # PARA 를 새로 쓰면 통화기록도 '2. Areas' 아래에
        for d in PARA_DIRS:
            (vault / d).mkdir(exist_ok=True)
    base = (base or default_base(vault)).strip("/")
    obs = vault / ".obsidian"
    obs.mkdir(exist_ok=True)
    root = vault / base
    for sub in ("연락처", "통화", "카톡"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    log = []

    # 1) 노트 (이미 있으면 그대로)
    # 예전 이름(통화기록 대시보드)이 있으면 새 이름(라포 홈)으로 옮긴다
    old_dash = root / "통화기록 대시보드.md"
    if old_dash.exists() and not (root / "라포 홈.md").exists():
        old_dash.rename(root / "라포 홈.md")
        log.append(f"이름 변경: {base}/통화기록 대시보드 → 라포 홈")
    for name in ("라포 홈.md", "통화기록.base"):
        dst = root / name
        if dst.exists() and not force:
            old = dst.read_text(encoding="utf-8")
            # v3 대시보드(한 화면)가 아닌 예전 대시보드는 새것으로 — 예전 것은 볼트 휴지통(.trash)에 남김
            if name.endswith(".md") and "```연락대시보드" not in old:
                trash = vault / ".trash"
                trash.mkdir(exist_ok=True)
                (trash / "라포 홈 (이전 버전).md").write_text(old, encoding="utf-8")
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

    # PARA: 직접 고르면(para=True) 설치, 정하지 않으면 이미 PARA 를 쓰는 볼트일 때만 (플러그인 업데이트)
    if para or (para is None and has_para(vault)):
        log += setup_para(vault)
    return "\n".join(log)


def main():
    ap = argparse.ArgumentParser(description="Rappo 옵시디언 볼트 세팅")
    ap.add_argument("--vault", type=Path)
    ap.add_argument("--base", default="", help='볼트 안 저장 폴더 (기본: "2. Areas/통화기록" 또는 "통화기록")')
    ap.add_argument("--para", action="store_true", help="PARA 노트 정리 방식(폴더·템플릿·PARA 대시보드·플러그인)도 설치")
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
    print(setup(a.vault, a.base, a.force, para=True if a.para else None))


if __name__ == "__main__":
    sys.exit(main())
