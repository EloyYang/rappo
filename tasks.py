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
import llm  # noqa: E402
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
        "context=무슨 일 때문인지 한 줄, quote=근거가 되는 원문 문장을 한 글자도 바꾸지 말고 그대로.\n"
        "예시) '상대: 자료 좀 보내줄 수 있어? / 나: 네 내일까지 보내드릴게요' → 할일, doer=나, agreed=true, due=내일 날짜. "
        "'상대: 5시에 볼까? / 나: 그래 5시쯤 갈게' → 약속, doer=나, agreed=true, time=17:00. "
        "'나: 서류 발급 부탁드려요 / 상대: 요청해서 보내드릴게요' → 상대가 할 일이니 넣지 않음. "
        "'상대: 12월 5일까지 기다려 주세요' → 기다리는 일이니 넣지 않음.\n\n---\n" + text
    )


def _ask(prompt: str) -> dict | None:
    """AI 에 묻고 JSON 으로 받는다. (이 Ollama 는 구조화 출력을 지원하지 않아 형식을 글로 지시하고 파싱)"""
    prompt += ('\n\n---\n설명 없이 JSON 객체 하나만 출력. 형식: '
               '{"items":[{"task":"","kind":"할일|약속","doer":"나|상대|함께","agreed":true,"due":"","time":"",'
               '"priority":"높음|보통|낮음","context":"","quote":""}]}')
    try:
        out = llm.generate(prompt, temperature=0)
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
         "'나: ~하겠습니다 / ~드리겠습니다 / ~할게요 / 다음 주에 다시 연락드릴게요 / 확정되면 말씀드릴게요'처럼 내가 하겠다고 말했으면 true.\n"
         '설명 없이 JSON 하나만: {"ok": true 또는 false}\n\n---\n' + _around(quote, text))
    try:
        out = llm.generate(p, ctx=4096, temperature=0, timeout=300)
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


# 내가 하겠다고 한 말 (발화자가 '나'인 줄) — 근거가 원문에 있으면 재확인 없이 통과
COMMIT_RE = re.compile(r"드리겠|하겠습니다|하겠어요|할게|할께|드릴게|드릴께|보낼게|갈게|연락\s*드|말씀\s*드|알려\s*드|챙길게|해\s*놓을게|해\s*둘게")


def _quote_line(quote: str, text: str) -> str:
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return ""
    q = _norm(quote)
    return max(lines, key=lambda l: difflib.SequenceMatcher(None, q, _norm(l)).ratio())


def _mine(quote: str, text: str) -> bool:
    line = _quote_line(quote, text)
    return bool(re.match(r"^\s*(?:\d{1,2}:\d{2}\s+)?나\s*:", line) and COMMIT_RE.search(line))


def vague_due(s: str, base: datetime) -> str:
    """'다음 주에', '이번 달 안에'처럼 기간만 말했을 때 그 기간의 가장 빠른 날 (다음 주 → 다음 주 월요일).
    정확한 날짜(12월 3일, 12/3)가 있으면 '' (모델이 계산한 날짜를 쓴다)."""
    if re.search(r"\d{1,2}\s*월\s*\d{1,2}\s*일|\b\d{1,2}/\d{1,2}\b", s):
        return ""
    d = base.date()
    mon = d - timedelta(days=d.weekday())
    # 요일까지 말했으면 그 요일 (이번 주 금요일, 다음 주 화요일, 금요일까지)
    wm = re.search(r"(다다음\s*주|다음\s*주|담주|이번\s*주)?\s*([월화수목금토일])요일", s)
    if wm:
        wd = "월화수목금토일".index(wm.group(2))
        w = re.sub(r"\s", "", wm.group(1) or "")
        if w == "다다음주":
            return (mon + timedelta(days=14 + wd)).isoformat()
        if w in ("다음주", "담주"):
            return (mon + timedelta(days=7 + wd)).isoformat()
        day = mon + timedelta(days=wd)
        return (day if w == "이번주" or day >= d else day + timedelta(days=7)).isoformat()
    rules = [
        (r"다다음\s*주", mon + timedelta(days=14)),
        (r"다음\s*주|담주|다음\s*週", mon + timedelta(days=7)),
        (r"이번\s*주\s*말|이번\s*주말", mon + timedelta(days=5)),
        (r"이번\s*주|금주", d),
        (r"주말", mon + timedelta(days=5) if d.weekday() < 5 else d),
        (r"다음\s*달|다음\s*월|내달", (d.replace(day=1) + timedelta(days=32)).replace(day=1)),
        (r"이번\s*달|이달", d),
        (r"모레", d + timedelta(days=2)),
        (r"내일|낼", d + timedelta(days=1)),
        (r"오늘|당일", d),
        (r"조만간|곧|빠른\s*시일", d + timedelta(days=3)),
    ]
    for pat, day in rules:
        if re.search(pat, s):
            return day.isoformat()
    return ""


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
        if PASSIVE.search(task) or not _grounded(quote, text):
            continue
        if not _mine(quote, text) and not _confirm(task, quote, text):
            continue
        # 기간만 말했으면(다음 주 등) 그 기간의 가장 빠른 날, 아니면 모델이 계산한 날짜
        vd = vague_due(f"{_quote_line(quote, text)} {quote}", base)
        due = vd or _clean_due(str(it.get("due", "")), base)
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
            body = re.split(r"\s(?:⏫|🔼|🔽|📅|⏰|👤|💬|🔗|📝|🆔)", " " + m.group(1))[0]
            who = re.search(r"👤\s*([^💬🔗📝🆔📅⏰⏫🔼🔽]+)", line)
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
        link_notes(root)
    return len(new)


# ---------- 할 일 ↔ PARA '시작 전' 노트 ----------
# PARA 를 쓰는 볼트(0. Inbox 가 있음)면 남은 할 일마다 노트를 하나씩 만들어 '📝 [[노트]]'로 잇는다.
# 노트는 PARA 대시보드 할 일 보드의 '시작 전'에 나오고, 상세 내용은 노트에 적는다. (상태는 옵시디언 플러그인이 양쪽으로 맞춤)
def _vault_of(root: Path) -> Path | None:
    for p in [root, *root.parents]:
        if (p / ".obsidian").is_dir():
            return p
    return None


def _safe_name(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", s)
    return re.sub(r"\s+", " ", s).strip()[:60] or "할 일"


def link_notes(root: Path) -> int:
    p = note_path(root)
    vault = _vault_of(root)
    if not p.exists() or not vault or not (vault / "0. Inbox").is_dir():
        return 0
    lines = p.read_text(encoding="utf-8").split("\n")
    names = None
    made = 0
    for i, line in enumerate(lines):
        m = re.match(r"^\s*-\s+\[ \]\s+(.+)$", line)
        if not m or "📝" in line:
            continue
        body = m.group(1)
        text = re.split(r"\s(?:⏫|🔼|🔽|📅|⏰|👤|💬|🔗|📝|🆔)", " " + body)[0].strip()
        g = lambda mark: (re.search(mark + r"\s*([^⏫🔼🔽📅⏰👤💬🔗📝🆔]+)", body) or [None, ""])[1].strip()
        due, who, ctx, link = g("📅"), g("👤"), g("💬"), g("🔗")
        if names is None:
            names = {q.stem for q in vault.rglob("*.md") if "/." not in str(q)}
        base = _safe_name(text)
        name, n = base, 2
        while name in names:
            name, n = f"{base} ({n})", n + 1
        names.add(name)
        (vault / "0. Inbox" / f"{name}.md").write_text(
            "---\ntype: note\nstatus: 시작 전\narea: []\nproject: []\n"
            f"end: {due}\ncreated: {datetime.now():%Y-%m-%d}\ntags: [할일]\n---\n"
            f"## 할 일\n- [ ] {text}\n\n"
            + (f"- 누구와: {who}\n" if who else "") + (f"- 무슨 일: {ctx}\n" if ctx else "")
            + (f"- 출처: {link}\n" if link else "") + "- 할 일 목록: [[할 일]]\n\n## 메모\n\n", encoding="utf-8")
        lines[i] = re.sub(r"(\s🆔\s)", f" 📝 [[{name}]]\\1", line, count=1) if "🆔" in line else f"{line} 📝 [[{name}]]"
        made += 1
    if made:
        p.write_text("\n".join(lines), encoding="utf-8")
    return made


def _fm_text(p: Path) -> str:
    t = p.read_text(encoding="utf-8", errors="ignore")
    m = re.match(r"^---\n(.*?)\n---", t, re.S)
    return m.group(1) if m else ""


def para_targets(vault: Path) -> dict:
    """{'project': [이름…], 'area': [이름…]} — 끝나거나 보관된 것 빼고"""
    out = {"project": [], "area": []}
    for p in vault.rglob("*.md"):
        rel = str(p.relative_to(vault))
        if rel.startswith(("4. Archive", ".", "_")):
            continue
        fm = _fm_text(p)
        ty = (re.search(r"^type:\s*(\S+)", fm, re.M) or [None, ""])[1]
        st = (re.search(r"^status:\s*(.*)$", fm, re.M) or [None, ""])[1].strip().strip('"')
        if ty == "project" and st not in ("완료", "중단"):
            out["project"].append(p.stem)
        elif ty == "area" and st != "아카이브":
            out["area"].append(p.stem)
    return out


def _new_para(vault: Path, kind: str, name: str) -> str:
    """새 프로젝트·영역 노트 (템플릿이 있으면 그걸로) — '1. Projects/이름/이름.md' 처럼"""
    name = _safe_name(name)[:40]
    folder = vault / ("1. Projects" if kind == "project" else "2. Areas") / name
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / f"{name}.md"
    if not f.exists():
        tpl = vault / "_Templates" / ("프로젝트.md" if kind == "project" else "영역.md")
        body = tpl.read_text(encoding="utf-8") if tpl.exists() else \
            f"---\ntype: {kind}\nstatus: {'시작 안 함' if kind == 'project' else '영역'}\ncreated: {{{{date}}}}\n---\n"
        body = re.sub(r"\{\{date(:[^}]*)?\}\}", datetime.now().strftime("%Y-%m-%d"), body).replace("{{title}}", name)
        if kind == "project":
            body = body.replace("status: 시작 안 함", "status: 진행 중", 1)
        f.write_text(body, encoding="utf-8")
    return name


def match_para(root: Path, limit: int = 20) -> int:
    """할 일 노트(0. Inbox, #할일, 프로젝트·영역 비어 있음)를 알맞은 프로젝트·영역에 잇는다.
    맞는 게 없으면 새 프로젝트나 영역을 만든다. (자동 이동 플러그인이 노트를 그 폴더로 옮김)"""
    vault = _vault_of(root)
    if not vault or not (vault / "0. Inbox").is_dir():
        return 0
    notes = []
    for p in sorted((vault / "0. Inbox").glob("*.md")):
        fm = _fm_text(p)
        if "할일" in fm and re.search(r"^area:\s*\[\]\s*$", fm, re.M) and re.search(r"^project:\s*\[\]\s*$", fm, re.M) \
                and "para_match:" not in fm:
            notes.append(p)
    if not notes:
        return 0
    tg = para_targets(vault)
    done = 0
    for p in notes[:limit]:
        body = p.read_text(encoding="utf-8")
        info = re.sub(r"^---.*?---", "", body, flags=re.S)[:600]
        prompt = (
            "할 일 노트를 PARA 의 알맞은 곳 하나에 넣으려고 해.\n"
            f"할 일 노트 제목: {p.stem}\n내용:\n{info}\n\n"
            f"기존 프로젝트(끝이 있는 일): {', '.join(tg['project']) or '없음'}\n"
            f"기존 영역(계속 챙기는 분야): {', '.join(tg['area']) or '없음'}\n\n"
            "기존 것 중 분명히 관련 있는 게 있으면 그 이름을 그대로 골라. 없으면 새로 만들 이름을 짧게(2~10자) 지어. "
            "기간이 있는 일·행사·납품이면 project, 생활·관계·건강·돈처럼 계속 챙기는 분야면 area.\n"
            '설명 없이 JSON 하나만: {"type":"project|area","name":"","new":true 또는 false}'
        )
        try:
            out = llm.generate(prompt, ctx=4096, temperature=0, timeout=300)
            j = json.loads(re.search(r"\{.*\}", out, re.S).group(0))
        except Exception as e:
            print(f"  ! PARA 연결 실패 ({p.stem}): {e}", file=sys.stderr)
            continue
        kind = "area" if j.get("type") == "area" else "project"
        name = str(j.get("name", "")).strip().strip("[]")
        if not name:
            continue
        exist = {n.replace(" ", "").lower(): n for n in tg[kind]}
        other = {n.replace(" ", "").lower(): n for n in tg["area" if kind == "project" else "project"]}
        key = name.replace(" ", "").lower()
        if key in exist:
            name, made = exist[key], False
        elif key in other:   # 종류만 틀린 경우
            kind = "area" if kind == "project" else "project"
            name, made = other[key], False
        else:
            name, made = _new_para(vault, kind, name), True
            tg[kind].append(name)
        body = re.sub(rf"^{kind}:\s*\[\]\s*$", f'{kind}:\n  - "[[{name}]]"', body, count=1, flags=re.M)
        body = body.replace("\ntags: [할일]", f"\ntags: [할일]\npara_match: {'new' if made else 'auto'}", 1)
        p.write_text(body, encoding="utf-8")
        done += 1
        print(f"  할 일 노트 → {'새 ' if made else ''}{'프로젝트' if kind == 'project' else '영역'} [{name}]: {p.stem[:30]}", flush=True)
    return done


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
