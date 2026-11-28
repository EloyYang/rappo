"""Rappo 회의록: 옵시디언에서 녹음한 회의(<저장 폴더>/회의/녹음/*)를 받아 적고, 회의록으로 정리하고,
내가 맡은 할 일은 할 일 목록(할 일.md)에 넣는다.

- 녹음은 Rappo 옵시디언 플러그인이 만든다. 같이 만든 회의 노트의 meeting_audio 속성으로 짝을 찾는다.
  (노트가 PARA 자동 이동으로 프로젝트 폴더에 옮겨져도 볼트 전체에서 찾음) 없으면 <저장 폴더>/회의/ 에 새로 만든다.
- 회의록: 긴 회의는 나눠서 정리한 뒤 합친다 (로컬 모델의 문맥 길이 때문).
- 할 일: tasks.extract 의 엄격한 기준 그대로 (근거 문장 확인 + 재확인, 내가 하거나 함께 하는 일만).
"""
from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import tasks

AUDIO = {".webm", ".m4a", ".mp4", ".mp3", ".wav", ".ogg", ".aac"}
CHUNK = 5000


def _r():
    """rappo 모듈 (스크립트로 실행됐으면 __main__)"""
    import __main__
    if hasattr(__main__, "transcribe"):
        return __main__
    import rappo
    return rappo


def _llm(prompt: str) -> str:
    import llm
    try:
        return llm.generate(prompt, timeout=900)
    except Exception as e:
        print(f"     ! 회의록 정리 실패: {e}", file=sys.stderr)
    return ""


def _chunks(text: str) -> list[str]:
    lines, out, cur = text.split("\n"), [], ""
    for l in lines:
        if len(cur) + len(l) > CHUNK and cur:
            out.append(cur)
            cur = ""
        cur += l + "\n"
    if cur.strip():
        out.append(cur)
    return out


def minutes(text: str, when: datetime, title: str) -> str:
    """회의록 마크다운 (첫 줄은 한 줄 요약)"""
    head = f"회의: {title} · {when:%Y-%m-%d %H:%M}\n"
    form = ("한국어 마크다운으로만, 머리말 없이 이 형식 그대로:\n"
            "첫 줄: 한 줄 요약(기호 없이)\n\n## 요약\n- 3줄 이내\n\n## 논의 내용\n- 주제별 핵심\n\n"
            "## 결정 사항\n- 정해진 것 (없으면 '- 없음')\n\n## 액션 아이템\n- [담당자] 할 일 (마감) (없으면 '- 없음')\n"
            "대화를 그대로 옮기지 말고 정리해. 음성인식이라 오인식이 있을 수 있어. 말하지 않은 내용은 만들지 마.\n")
    parts = _chunks(text)
    if len(parts) <= 1:
        return _llm(head + "아래는 회의 녹음 전사문이야. " + form + "\n---\n" + text)
    notes = []
    for i, c in enumerate(parts, 1):
        print(f"     회의록 {i}/{len(parts)} 부분 정리", flush=True)
        notes.append(_llm(head + f"아래는 회의 녹음 전사문의 {i}/{len(parts)} 부분이야. 이 부분의 논의·결정·할 일(담당자, 마감)만 "
                                 "짧은 불릿으로 정리해. 말하지 않은 내용은 만들지 마.\n---\n" + c))
    return _llm(head + "아래는 한 회의를 부분별로 정리한 메모야. 겹치는 것은 합쳐서 하나의 회의록으로 만들어. " + form
                + "\n---\n" + "\n\n".join(f"[{i}부분]\n{n}" for i, n in enumerate(notes, 1)))


def _find_note(vault: Path, audio_name: str) -> Path | None:
    key = f'meeting_audio: "{audio_name}"'
    for p in vault.rglob("*.md"):
        if "/." in str(p.relative_to(vault)) or str(p.relative_to(vault)).startswith("."):
            continue
        try:
            with p.open(encoding="utf-8") as f:
                head = f.read(1500)
        except Exception:
            continue
        if key in head or f"meeting_audio: {audio_name}" in head:
            return p
    return None


def action_items(text: str, when: datetime) -> list[dict]:
    """회의에서 나온 할 일을 모두 — 누가 하는지(발화자 이름), 모르면 '미정'. 근거 문장이 원문에 있는 것만."""
    import json as _json
    import hashlib
    out, seen = [], set()
    for c in _chunks(text):
        p = (f"회의 날짜: {when:%Y-%m-%d} ({'월화수목금토일'[when.weekday()]}요일)\n"
             "아래 회의 전사문에서 나온 할 일(액션 아이템)을 빠짐없이 뽑아. 각 줄 앞의 '이름:'이 말한 사람이야.\n"
             "owner=그 일을 맡은 사람: 맡겠다고 말한 사람이나 맡으라고 지목된 사람의 이름표(예: 나, 참석자1, 홍길동) 그대로. "
             "누가 할지 분명하지 않으면 '미정'.\n"
             "due=마감 YYYY-MM-DD (말하지 않았으면 빈 문자열), quote=근거 문장을 원문 그대로.\n"
             '설명 없이 JSON 하나만: {"items":[{"task":"","owner":"","due":"","quote":""}]}\n\n---\n' + c)
        try:
            raw = _llm(p)
            m = re.search(r"\{.*\}", raw, re.S)
            items = (_json.loads(m.group(0)) if m else {}).get("items") or []
        except Exception:
            items = []
        for it in items:
            if not isinstance(it, dict):
                continue
            task = re.sub(r"\s+", " ", str(it.get("task", ""))).strip(" .-")
            quote = str(it.get("quote", ""))
            if len(task) < 3 or not tasks._grounded(quote, c):
                continue
            owner = re.sub(r"\s+", "", str(it.get("owner", ""))) or "미정"
            if owner not in c and owner not in ("나", "미정"):
                owner = "미정"
            due = tasks.vague_due(f"{tasks._quote_line(quote, c)} {quote}", when) or tasks._clean_due(str(it.get("due", "")), when)
            k = tasks._norm(task)
            if k in seen:
                continue
            seen.add(k)
            out.append({"task": task, "owner": owner, "due": due, "id": hashlib.sha1(f"{when}|{task}".encode()).hexdigest()[:6]})
    return out


def _write(note: Path, fm_text: str, title: str, mins: str, segs, dur: int, audio_link: str, acts: list[dict]):
    R = _r()
    ls = (mins or "").strip().splitlines()
    if ls and not ls[0].lstrip().startswith(("#", "-", "*")):      # 첫 줄 = 한 줄 요약
        first, body_min = ls[0].strip(), "\n".join(ls[1:]).strip()
    else:
        first = next((l.lstrip("-* ").strip() for l in ls if l.strip() and not l.lstrip().startswith("#")), "")
        body_min = "\n".join(ls).strip()
    body_min = re.sub(r"^#{1,2} ", "### ", body_min, flags=re.M)   # 회의록 안의 소제목은 한 단계 아래로
    fm = fm_text if fm_text.startswith("---") else f"---\nmeeting_audio: {R.q(audio_link)}\n---\n"
    for k, v in [("duration", R.q(R.fmt_dur(dur))), ("summary", R.q(first)), ("meeting_done", "true")]:
        fm = R.set_fm(fm, k, v)
    tr = "\n\n".join(R.fmt_line(s) for s in segs) if segs else "(전사문 없음)"
    # 할 일은 담당자별로: 옵시디언의 ```회의할일``` 칸에서 담당자를 바꿀 수 있고, '나'로 정하면 내 할 일 목록에 들어간다
    lines = [f"- [ ] {a['task']} 👤 {a['owner']}" + (f" 📅 {a['due']}" if a["due"] else "") + f" 🆔 m{a['id']}" for a in acts]
    todo = "```회의할일\n```\n\n" + ("\n".join(lines) if lines else "- 이 회의에서 나온 할 일은 없어요.")
    note.write_text(
        fm.rstrip("\n") + "\n"
        f"# {title}\n\n"
        f"![[{audio_link}]]\n\n"
        f"## 회의록\n" + (f"> {first}\n\n" if first else "") + f"{body_min or '(정리 실패 — Rappo 설정 › AI 를 확인해 주세요)'}\n\n"
        f"## 할 일 (담당자별)\n{todo}\n\n"
        "## 전사문\n" + tr + "\n",
        encoding="utf-8",
    )


def run(vault: Path, root: Path, state_path: Path, no_ai: bool = False) -> int:
    rec = root / "회의" / "녹음"
    if not rec.is_dir() or no_ai:   # AI 를 미뤄 둔 때(정해진 시간에 몰아서)는 회의도 그때 함께
        return 0
    st = tasks.load_state(state_path)
    seen = st.setdefault("meetings", {})
    files = sorted(p for p in rec.iterdir() if p.suffix.lower() in AUDIO and not p.name.startswith(".") and p.name not in seen)
    # 아직 쓰는 중인(방금 바뀐) 파일은 다음에
    import time
    files = [p for p in files if time.time() - p.stat().st_mtime > 20]
    if not files:
        return 0
    R = _r()
    print(f"회의 녹음 {len(files)}개 정리")
    for p in files:
        m = re.match(r"^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})\s*(.*)$", p.stem)
        when = datetime.strptime(f"{m.group(1)} {m.group(2)}{m.group(3)}", "%Y-%m-%d %H%M") if m else datetime.fromtimestamp(p.stat().st_mtime)
        note = _find_note(vault, p.name)
        if note:
            t = note.read_text(encoding="utf-8")
            fm_text = t[: t.index("\n---", 3) + 5] if t.startswith("---") and "\n---" in t[3:] else ""
            title = R.read_fm(note).get("title") or note.stem
        else:
            title = (m.group(4) if m and m.group(4) else "회의").strip()
            note = root / "회의" / f"{p.stem}.md"
            fm_text = ("---\ntype: note\nstatus: 메모용\narea: []\nproject: []\n"
                       f"created: {when:%Y-%m-%d}\nmeeting_audio: {R.q(p.name)}\ntags: [회의록]\n---\n")
        print(f"  ● {p.name} → {note.name}", flush=True)
        dur = R.duration_sec(p)
        segs = R.transcribe(p, other="참석자", meeting=True)
        text = "\n".join((f"{s['speaker']}: " if s["speaker"] else "") + s["text"] for s in segs)
        mins = "" if no_ai or len(text) < 30 else minutes(text, when, title)
        acts = []
        if not no_ai and len(text) >= 30:
            fm = R.read_fm(note) if note.exists() else {}
            proj = re.sub(r"[\[\]\"]", "", str(fm.get("project") or fm.get("area") or "")).strip(" ,")
            acts = action_items(text, when)
            # 내가 맡은 일은 바로 내 할 일 목록에
            mine = [{"task": a["task"], "kind": "할일", "due": a["due"], "time": "", "prio": "보통", "context": f"회의: {title}"}
                    for a in acts if a["owner"] == "나"]
            tasks.add(root, mine, proj or title, note.stem, f"회의 {when.month}/{when.day}")
        added = acts
        note.parent.mkdir(parents=True, exist_ok=True)
        _write(note, fm_text, title, mins, segs, dur, p.name, acts)
        seen[p.name] = note.stem
        tasks.save_state(state_path, st)
        print(f"     ✓ 회의록 · 할 일 {len(added)}개", flush=True)
        subprocess.run(["osascript", "-e", f'display notification "할 일 {len(added)}개 · {title}" with title "Rappo · 회의록 정리 끝"'],
                       capture_output=True)
    return len(files)
