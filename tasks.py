"""Rappo 할 일: 통화 전사문·카카오톡 대화에서 '내가 하기로 정한 일'과 확정된 약속만 골라
<저장 폴더>/할 일.md 에 모은다.

- AI(로컬 Ollama 또는 claude)가 후보를 JSON 으로 내고, 근거 문장(quote)이 원문에 실제로 있는지 확인한 것만 남긴다.
- 내가 할 일(doer=나/함께)이고 수락·확정된 것(agreed)만. 상대가 할 일·제안만 한 것·안부는 버린다.
- 한 줄 형식 (옵시디언 Tasks 플러그인과 같은 기호):
    - [ ] 견적서 수정본 메일로 보내기 ⏫ 📅 2026-12-03 ⏰ 15:00 👤 홍길동 💬 단가가 바뀌어 다시 요청함 🔗 [[노트|통화 11/3]] 🆔 ab12cd
  우선순위 ⏫ 높음 · 🔼 보통 · 🔽 낮음, 지운 것은 '- [-]' 로 남겨 다시 생기지 않게 한다.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

NOTE = "할 일.md"
AI = os.environ.get("RAPPO_AI", "auto").strip() or "auto"
AI_MODEL = os.environ.get("RAPPO_AI_MODEL", "qwen3.5:4b").strip() or "qwen3.5:4b"
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
WEEK = "월화수목금토일"
PRIO = {"높음": "⏫", "보통": "🔼", "낮음": "🔽"}
# 카톡: 이런 말이 있는 날만 AI 에 물어본다 (요청·수락·약속)
TASK_KW = re.compile(
    r"해\s*줘|해\s*주세요|해\s*주실|부탁|보내\s*(?:줘|주세요|드릴|줄게)|드릴게|드리겠|할게|하겠습니다|줄게|까지|확인해|확인\s*부탁|"
    r"준비|챙겨|알려\s*(?:줘|주세요|드릴)|연락\s*(?:드릴|할게|줘|주세요)|예약|제출|입금|결제|송금|보자|만나|약속|미팅|회의|방문"
)
MAX_KAKAO_CHUNKS = 8          # 한 번 실행할 때 카톡 묶음은 이만큼만 (나머지는 다음 실행에)
KAKAO_DAYS = 7                # 최근 며칠 대화까지 볼지

HEADER = """---
tags: [할일]
---
# ✅ 할 일

Rappo 가 통화·카톡에서 **내가 하기로 정한 일**과 확정된 약속을 모아요. 대시보드의 ✅ 할 일 칸에서 우선순위를 바꾸거나 고치고 지울 수 있어요.
직접 적어도 돼요: `- [ ] 할 일 🔼 📅 2026-12-03 👤 홍길동 💬 메모` (⏫ 높음 · 🔼 보통 · 🔽 낮음)

## 목록
"""

SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "task": {"type": "string"},
            "kind": {"type": "string", "enum": ["할일", "약속"]},
            "doer": {"type": "string", "enum": ["나", "상대", "함께"]},
            "agreed": {"type": "boolean"},
            "due": {"type": "string"},
            "time": {"type": "string"},
            "priority": {"type": "string", "enum": ["높음", "보통", "낮음"]},
            "context": {"type": "string"},
            "quote": {"type": "string"},
        },
        "required": ["task", "kind", "doer", "agreed", "due", "time", "priority", "context", "quote"],
    }}},
    "required": ["items"],
}


def _prompt(text: str, base: datetime, partner: str, what: str) -> str:
    return (
        f"아래는 '나'와 {partner}의 {what}야. 기준 날짜: {base:%Y-%m-%d} ({WEEK[base.weekday()]}요일).\n"
        "'나'가 실제로 해야 하는 일과 날짜가 확정된 약속만 뽑아서 JSON 으로 답해.\n"
        "포함: 상대가 부탁했고 내가 하겠다고 수락한 일(예: '네, 보내드릴게요'), 내가 스스로 하겠다고 말한 일, "
        "날짜(와 시간)까지 정한 만남·예약·방문.\n"
        "제외: 상대가 할 일, 내가 상대에게 부탁·질문한 것, 상대 연락을 기다리는 것, 제안·가정만 하고 정하지 않은 것, "
        "이미 끝난 일, 안부·잡담, 조금이라도 확실하지 않은 것. "
        "애매하면 넣지 마. 없으면 items 는 빈 배열.\n"
        "각 항목: task=무엇을 하는지 짧게, 동사로 끝나게(예: '견적서 수정본 메일로 보내기'), "
        "kind=할일 또는 약속, doer=그 일을 하는 사람(나/상대/함께), agreed=내가 수락했거나 확정됐으면 true, "
        "due=마감·약속 날짜 YYYY-MM-DD ('내일','다음 주 화요일'은 기준 날짜로 계산, 언급 없으면 빈 문자열), "
        "time=HH:MM 또는 빈 문자열, priority=마감이 3일 안이거나 급하다고 했으면 높음, 마감이 없으면 낮음, 나머지 보통, "
        "context=무슨 일 때문인지 한 줄, quote=근거가 되는 원문 문장을 한 글자도 바꾸지 말고 그대로.\n\n---\n" + text
    )


def _ollama_up() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _ask(prompt: str) -> dict | None:
    """AI 에 묻고 JSON 으로 받는다. (이 Ollama 는 구조화 출력을 지원하지 않아 형식을 글로 지시하고 파싱)"""
    prompt += ('\n\n---\n설명 없이 JSON 객체 하나만 출력. 형식: '
               '{"items":[{"task":"","kind":"할일|약속","doer":"나|상대|함께","agreed":true,"due":"","time":"",'
               '"priority":"높음|보통|낮음","context":"","quote":""}]}')
    use_local = AI == "local" or (AI == "auto" and _ollama_up())
    try:
        if use_local:
            import urllib.request
            body = json.dumps({"model": AI_MODEL, "prompt": prompt, "stream": False, "think": False,
                               "options": {"temperature": 0, "num_ctx": 8192}}).encode()
            req = urllib.request.Request(OLLAMA + "/api/generate", data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as r:
                out = json.loads(r.read().decode()).get("response", "")
        else:
            if not shutil.which("claude"):
                return None
            r = subprocess.run(["claude", "-p", prompt],
                               capture_output=True, text=True, timeout=240)
            out = r.stdout
        m = re.search(r"\{.*\}", out, re.S)
        return json.loads(m.group(0)) if m else None
    except Exception as e:
        print(f"     ! 할 일 추출 실패: {e}", file=sys.stderr)
        return None


def _norm(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣]", "", s or "").lower()


def _grounded(quote: str, text: str) -> bool:
    """근거 문장이 원문에 실제로 있는지 (띄어쓰기·문장부호 무시, 음성인식 오차 조금 허용)."""
    q, t = _norm(quote), _norm(text)
    if len(q) < 4:
        return False
    if q in t:
        return True
    m = difflib.SequenceMatcher(None, q, t, autojunk=False).find_longest_match(0, len(q), 0, len(t))
    return m.size >= max(6, int(len(q) * 0.7))


PASSIVE = re.compile(r"기다리|대기|연락\s*받|전화\s*받|답\s*받|받기$|오기를|올\s*때까지")


def _around(quote: str, text: str, n: int = 4) -> str:
    """근거 문장 앞뒤 몇 줄 (확인 질문에 함께 보냄)"""
    lines = text.split("\n")
    q = _norm(quote)
    best = max(range(len(lines)), key=lambda i: difflib.SequenceMatcher(None, q, _norm(lines[i])).ratio()) if lines else 0
    return "\n".join(lines[max(0, best - n): best + n + 1])


def _confirm(task: str, quote: str, text: str) -> bool:
    """두 번째 확인: 이 대화에서 '나'가 정말 그 일을 하기로 했나?"""
    p = (f"다음 대화에서 '나'가 '{task}' 을(를) 직접 하겠다고 말했거나 하기로 확정됐는지 판단해.\n"
         "내가 상대에게 부탁·질문만 한 것, 상대가 할 일, 상대 연락을 기다리는 것, 정하지 않은 제안이면 false.\n"
         '설명 없이 JSON 하나만: {"ok": true 또는 false}\n\n---\n' + _around(quote, text))
    try:
        import urllib.request
        if AI == "claude" or (AI == "auto" and not _ollama_up()):
            if not shutil.which("claude"):
                return True
            out = subprocess.run(["claude", "-p", p], capture_output=True, text=True, timeout=120).stdout
        else:
            body = json.dumps({"model": AI_MODEL, "prompt": p, "stream": False, "think": False,
                               "options": {"temperature": 0, "num_ctx": 4096}}).encode()
            req = urllib.request.Request(OLLAMA + "/api/generate", data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.loads(r.read().decode()).get("response", "")
        m = re.search(r'"ok"\s*:\s*(true|false)', out)
        return bool(m and m.group(1) == "true")
    except Exception:
        return False


def _clean_due(v: str, base: datetime) -> str:
    try:
        d = datetime.strptime((v or "").strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return ""
    return d.isoformat() if base.date() - timedelta(days=1) <= d <= base.date() + timedelta(days=366) else ""


def _clean_time(v: str) -> str:
    m = re.match(r"^(\d{1,2}):(\d{2})$", (v or "").strip())
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m and int(m.group(1)) < 24 and int(m.group(2)) < 60 else ""


def extract(text: str, base: datetime, partner: str, what: str) -> list[dict]:
    """AI 후보 → 내가 할 일·확정된 것·근거가 원문에 있는 것만."""
    res = _ask(_prompt(text[-7000:], base, partner, what)) or {}
    out = []
    for it in res.get("items") or []:
        if not isinstance(it, dict):
            continue
        task = re.sub(r"\s+", " ", str(it.get("task", ""))).strip(" .-")
        if len(task) < 3 or it.get("doer") not in ("나", "함께") or it.get("agreed") is not True:
            continue
        quote = str(it.get("quote", ""))
        if PASSIVE.search(task) or not _grounded(quote, text) or not _confirm(task, quote, text):
            continue
        due = _clean_due(str(it.get("due", "")), base)
        prio = it.get("priority") if it.get("priority") in PRIO else "보통"
        if due and (datetime.strptime(due, "%Y-%m-%d").date() - base.date()).days <= 3:
            prio = "높음"
        out.append({"task": task, "kind": it.get("kind", "할일"), "due": due, "time": _clean_time(str(it.get("time", ""))) if due else "",
                    "prio": prio, "context": re.sub(r"\s+", " ", str(it.get("context", ""))).strip()[:80]})
    return out


# ---------- 할 일.md ----------
def note_path(root: Path) -> Path:
    return root / NOTE


def _existing(p: Path) -> set[str]:
    """이미 있는 할 일 (끝낸 것·지운 것 포함) — 같은 일이 다시 생기지 않게."""
    if not p.exists():
        return set()
    keys = set()
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*-\s+\[.\]\s+(.+)$", line)
        if m:
            body = re.split(r"\s(?:⏫|🔼|🔽|📅|⏰|👤|💬|🔗|🆔)", " " + m.group(1))[0]
            who = re.search(r"👤\s*([^💬🔗🆔📅⏰⏫🔼🔽]+)", line)
            keys.add(_norm(body) + "|" + _norm(who.group(1) if who else ""))
    return keys


def _line(t: dict, who: str, link: str, label: str) -> str:
    parts = [f"- [ ] {t['task']}", PRIO[t["prio"]]]
    if t["due"]:
        parts.append(f"📅 {t['due']}")
    if t["time"]:
        parts.append(f"⏰ {t['time']}")
    if who:
        parts.append(f"👤 {who}")
    if t["context"]:
        parts.append(f"💬 {t['context']}")
    parts.append(f"🔗 [[{link}|{label}]]")
    parts.append("🆔 " + hashlib.sha1(f"{link}|{t['task']}".encode()).hexdigest()[:6])
    return " ".join(parts)


def add(root: Path, items: list[dict], who: str, link: str, label: str) -> int:
    if not items:
        return 0
    p = note_path(root)
    have = _existing(p)
    new = []
    for t in items:
        k = _norm(t["task"]) + "|" + _norm(who)
        if k in have:
            continue
        have.add(k)
        new.append(_line(t, who, link, label))
    if new:
        text = p.read_text(encoding="utf-8") if p.exists() else HEADER
        p.write_text(text.rstrip("\n") + "\n" + "\n".join(new) + "\n", encoding="utf-8")
    return len(new)


# ---------- 상태 (이미 본 통화·카톡 묶음) ----------
def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"calls": {}, "kakao": {}}


def save_state(path: Path, st: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------- 통화 ----------
def from_call(root: Path, note: Path, transcript: str, when: datetime, partner: str, st: dict) -> int:
    if st["calls"].get(note.stem):
        return 0
    n = 0
    if len(transcript) >= 30:
        items = extract(transcript, when, partner or "상대", "전화 통화 전사문(음성인식이라 오인식이 있을 수 있음)")
        n = add(root, items, partner, note.stem, f"통화 {when.month}/{when.day}")
    st["calls"][note.stem] = True
    return n


def strip_old(note: Path) -> bool:
    """예전 요약에 섞여 있던 '- [ ]' 할 일과 '📅' 일정 줄을 요약에서 뺀다."""
    t = note.read_text(encoding="utf-8")
    if "## 요약" not in t:
        return False
    head, rest = t.split("## 요약", 1)
    summ, sep, tail = rest.partition("\n## ")
    lines = [l for l in summ.split("\n") if not re.match(r"^\s*(?:[-*]\s+)?(?:\[[ xX]\]|📅)", l)
             and not re.match(r"^\s*(?:#+\s*)?할\s*일", l)]
    new = head + "## 요약" + re.sub(r"\n{3,}", "\n\n", "\n".join(lines)) + sep + tail
    if new != t:
        note.write_text(new, encoding="utf-8")
        return True
    return False


def transcript_of(note: Path) -> str:
    body = note.read_text(encoding="utf-8").split("## 전사문\n", 1)[-1]
    return re.sub(r"^`\d+:\d+` ", "", body, flags=re.M).replace("**", "").strip()


def redo_calls(root: Path, call_dir: Path, state_path: Path, read_fm, days: int = 7):
    """기존 통화 노트: 요약 속 옛 할 일은 모두 빼고, 최근 days 일 통화만 엄격한 기준으로 다시 뽑는다.
    그보다 오래된 통화는 다시 보지 않도록 표시만."""
    st = load_state(state_path)
    cut = datetime.now() - timedelta(days=days)
    notes = []
    for p in sorted(call_dir.glob("*.md")):
        strip_old(p)
        try:
            when = datetime.fromisoformat(str(read_fm(p).get("datetime", ""))[:16])
        except ValueError:
            when = None
        if when and when >= cut:
            notes.append(p)
        else:
            st["calls"][p.stem] = True
    save_state(state_path, st)
    print(f"최근 {days}일 통화 {len(notes)}개에서 할 일 다시 찾기")
    total = 0
    for i, p in enumerate(notes, 1):
        fm = read_fm(p)
        try:
            when = datetime.fromisoformat(str(fm.get("datetime", ""))[:16])
        except ValueError:
            continue
        name = str(fm.get("name", "")).strip()
        partner = name if name and name != "정보 없음" else str(fm.get("phone", ""))
        st["calls"].pop(p.stem, None)
        n = from_call(root, p, transcript_of(p), when, partner, st)
        total += n
        save_state(state_path, st)
        print(f"[{i}/{len(notes)}] {'+' + str(n) if n else '·'} {p.stem}", flush=True)
    print(f"할 일 {total}개 → {NOTE}")


# ---------- 카카오톡 ----------
DAY_RE = re.compile(r"^### (\d{4}-\d{2}-\d{2})")
MSG_RE = re.compile(r"^`(\d{2}:\d{2})(?::\d{2})?` \*\*(.+?)\*\*: ?(.*)$")
LINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")


def _kakao_days(kdir: Path, since: str):
    """{(room, date): (kind, note, [(time, who, text)])} — 최근 노트만"""
    out = {}
    for p in kdir.rglob("*.md"):
        m = re.search(r"(\d{4}-\d{2})$", p.stem)
        if not m or m.group(1) < since[:7]:
            continue
        t = p.read_text(encoding="utf-8")
        fm = dict(re.findall(r'^(room|kind): "?(.*?)"?$', t.split("\n---", 1)[0], re.M))
        room, kind = fm.get("room") or p.parent.name, fm.get("kind", "")
        day = ""
        for line in t.split("\n"):
            d = DAY_RE.match(line)
            if d:
                day = d.group(1)
                continue
            mm = MSG_RE.match(line)
            if mm and day >= since:
                out.setdefault((room, day), (kind, p.stem, []))[2].append(
                    (mm.group(1), LINK_RE.sub(r"\1", mm.group(2)), mm.group(3).replace("<br>", " ")))
    return out


def from_kakao(root: Path, state_path: Path, limit: int = MAX_KAKAO_CHUNKS) -> int:
    kdir = root / "카톡"
    if not kdir.is_dir():
        return 0
    st = load_state(state_path)
    now = datetime.now()
    since = (now - timedelta(days=KAKAO_DAYS)).strftime("%Y-%m-%d")
    days = _kakao_days(kdir, since)
    todo = []
    for (room, day), (kind, stem, msgs) in days.items():
        key = f"{room}|{day}"
        if st["kakao"].get(key) == len(msgs):
            continue
        # 오늘 대화는 1시간 조용해진 뒤에
        if day == now.strftime("%Y-%m-%d") and msgs and (now - datetime.strptime(f"{day} {msgs[-1][0]}", "%Y-%m-%d %H:%M")).total_seconds() < 3600:
            continue
        people = {w for _, w, _ in msgs if w != "나"}
        if kind == "단체" and len(people) > 6:
            st["kakao"][key] = len(msgs)
            continue
        if not any(w == "나" for _, w, _ in msgs) or not any(TASK_KW.search(x) for _, _, x in msgs):
            st["kakao"][key] = len(msgs)
            continue
        todo.append((day, room, kind, stem, msgs))
    todo.sort(reverse=True)
    total = 0
    for day, room, kind, stem, msgs in todo[:limit]:
        text = "\n".join(f"{t} {w}: {x}" for t, w, x in msgs)
        partner = room if kind != "단체" else f"단체방 '{room}' 사람들"
        items = extract(text, datetime.strptime(day, "%Y-%m-%d"), partner, "카카오톡 대화")
        y, m, d = day.split("-")
        n = add(root, items, room, stem, f"카톡 {int(m)}/{int(d)}")
        total += n
        st["kakao"][f"{room}|{day}"] = len(msgs)
        save_state(state_path, st)
        print(f"  할 일 · 카톡 {room} {day}: {'+' + str(n) if n else '없음'}", flush=True)
    save_state(state_path, st)
    if len(todo) > limit:
        print(f"  할 일 · 카톡 {len(todo) - limit}묶음은 다음 실행에")
    return total
