"""카카오톡 '대화 내보내기' 파일 → 옵시디언 노트 + 연락처 연동.

지원 형식 (.txt / .csv / .zip 아무거나 KAKAO_DIR 에 넣으면 됨):
  PC(윈도우/맥) txt : [홍길동] [오후 2:01] 메시지      (날짜 구분선 --------------- 2026년 11월 14일 금요일 ---------------)
  Android txt      : 2026년 11월 14일 오후 2:01, 홍길동 : 메시지
  iPhone txt       : 2026. 11. 14. 오후 2:01, 홍길동 : 메시지
  CSV              : Date,User,Message
  zip              : 모바일 내보내기 압축파일 (안의 txt를 읽음)

생성:
  <BASE>/카톡/<방이름>.md            방 노트 (참여자 링크 + 월별 노트 목록)
  <BASE>/카톡/<방이름>/<방이름> YYYY-MM.md  월별 대화
  연락처 노트의 '## 카카오톡' 표    1:1방·단체방 링크

같은 방을 나중에 다시 내보내도 메시지를 합쳐서(중복 제거) 갱신함.
카톡 이름이 연락처 이름과 다르면 연락처 노트 frontmatter에  kakao: "길동, 길동이"  처럼 별칭을 적으면 매칭됨.
"""
from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path

from rappo import q, read_fm, safe

WEEK = "월화수목금토일"

# ---------- 파싱 ----------
RE_PC_DATE = re.compile(r"^-+ (\d{4})년 (\d{1,2})월 (\d{1,2})일 \S+ -+$")
RE_PC_MSG = re.compile(r"^\[(?P<who>.+?)\] \[(?P<ap>오전|오후) (?P<h>\d{1,2}):(?P<m>\d{2})\] (?P<text>.*)$")
RE_MOBILE = re.compile(
    r"^(?P<y>\d{4})(?:년 |\. )(?P<mo>\d{1,2})(?:월 |\. )(?P<d>\d{1,2})(?:일|\.) "
    r"(?:(?P<ap>오전|오후) )?(?P<h>\d{1,2}):(?P<m>\d{2}), (?P<who>.+?) : (?P<text>.*)$"
)
RE_MOBILE_ANY = re.compile(r"^\d{4}(?:년 |\. )\d{1,2}(?:월 |\. )\d{1,2}(?:일|\.) ")
RE_HEADER = re.compile(r"^\ufeff?(?P<room>.+?) 님과 카카오톡 대화$")


def _h24(ap: str | None, h: int) -> int:
    if ap == "오전":
        return 0 if h == 12 else h
    if ap == "오후":
        return h if h == 12 else h + 12
    return h


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def parse_text(text: str) -> tuple[str, list[tuple[str, str, str]]]:
    """(헤더 방이름, [(iso시각, 보낸사람, 내용)])"""
    text = nfc(text)
    room, msgs, day = "", [], None
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not msgs and not room and (m := RE_HEADER.match(line.strip())):
            room = m["room"].strip()
            continue
        if m := RE_PC_DATE.match(line.strip()):
            day = (int(m[1]), int(m[2]), int(m[3]))
            continue
        if day and (m := RE_PC_MSG.match(line)):
            dt = datetime(*day, _h24(m["ap"], int(m["h"])), int(m["m"]))
            msgs.append([dt.isoformat(timespec="minutes"), m["who"].strip(), m["text"]])
            continue
        if m := RE_MOBILE.match(line):
            dt = datetime(int(m["y"]), int(m["mo"]), int(m["d"]), _h24(m["ap"], int(m["h"])), int(m["m"]))
            msgs.append([dt.isoformat(timespec="minutes"), m["who"].strip(), m["text"]])
            continue
        if RE_MOBILE_ANY.match(line) or line.startswith("저장한 날짜"):
            continue  # 날짜 구분선, 입장/퇴장 같은 시스템 메시지
        if msgs and line.strip():  # 여러 줄 메시지의 이어지는 줄
            msgs[-1][2] += "\n" + line
    return room, [tuple(x) for x in msgs]


def parse_csv(text: str) -> list[tuple[str, str, str]]:
    out = []
    for row in csv.DictReader(io.StringIO(nfc(text).lstrip("\ufeff"))):
        d, who, msg = row.get("Date", ""), row.get("User", ""), row.get("Message", "")
        try:
            dt = datetime.fromisoformat(d.strip()[:19])
        except ValueError:
            continue
        out.append((dt.isoformat(timespec="minutes"), who.strip(), msg))
    return out


def room_from_filename(stem: str) -> str:
    s = re.sub(r"(?i)^kakaotalk_?chats?_?", "", nfc(stem))
    s = re.sub(r"[_ ]?\d{4}[-.]\d{2}[-.]\d{2}.*$", "", s)  # 뒤에 붙는 저장 날짜
    return s.strip("_ ") or stem


def load_export(path: Path) -> list[tuple[str, list]]:
    """[(방이름, 메시지들)] — zip 하나에 여러 txt가 있을 수 있음."""
    def dec(b: bytes) -> str:
        for enc in ("utf-8-sig", "cp949"):
            try:
                return b.decode(enc)
            except UnicodeDecodeError:
                pass
        return b.decode("utf-8", "replace")

    fallback = room_from_filename(path.stem)
    if path.suffix.lower() == ".zip":
        out = []
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if n.lower().endswith(".txt") and not n.startswith("__MACOSX"):
                    room, msgs = parse_text(dec(z.read(n)))
                    out.append((room or fallback, msgs))
        return out
    text = dec(path.read_bytes())
    if path.suffix.lower() == ".csv":
        return [(fallback, parse_csv(text))]
    room, msgs = parse_text(text)
    return [(room or fallback, msgs)]


# ---------- 저장소 (중복 제거 병합) ----------
def merge(store: Path, room: str, msgs: list, meta: dict | None = None) -> list:
    old = json.loads(store.read_text(encoding="utf-8")) if store.exists() else {"messages": []}
    oc = Counter(tuple(m) for m in old["messages"])
    nc = Counter(tuple(m) for m in msgs)
    keep = oc | nc  # 같은 메시지는 두 쪽 중 많은 횟수만큼
    order = {}
    for m in old["messages"] + [list(x) for x in msgs]:
        order.setdefault(tuple(m), len(order))
    merged = sorted((list(k) for k, c in keep.items() for _ in range(c)), key=lambda m: (m[0], order[tuple(m)]))
    store.parent.mkdir(parents=True, exist_ok=True)
    meta = meta or old.get("meta") or {}
    store.write_text(json.dumps({"room": room, "messages": merged, "meta": meta}, ensure_ascii=False), encoding="utf-8")
    return merged


# ---------- 연락처 매칭 ----------
def name_index(cdir: Path) -> dict[str, Path]:
    """카톡 이름 → 연락처 노트. 연락처 name + kakao 별칭."""
    idx = {}
    for p in cdir.glob("*.md"):
        fm = read_fm(p)
        for n in [fm.get("name", "")] + fm.get("kakao", "").split(","):
            n = nfc(n.strip())
            if n and n != "정보 없음":
                idx[n] = p
    return idx


def phone_index(cdir: Path) -> dict[str, Path]:
    idx = {}
    for p in cdir.glob("*.md"):
        ph = read_fm(p).get("phone")
        if ph:
            idx[ph] = p
    return idx


def detect_me(rooms: dict[str, list], given: list[str]) -> set[str]:
    """내 카톡 이름 추정: 1:1방(헤더가 상대 이름)에서 상대가 아닌 쪽 + 모든 방에 공통으로 있는 이름."""
    me = set(given)
    if me:
        return me
    sets = [set(m[1] for m in msgs) for msgs in rooms.values() if msgs]
    for room, msgs in rooms.items():
        senders = set(m[1] for m in msgs)
        if room in senders and len(senders) == 2:
            me |= senders - {room}
    if not me and len(sets) >= 2:
        me = set.intersection(*sets)
    return me


# ---------- 노트 ----------
def link(name: str, names: dict[str, Path], table: bool = False) -> str:
    p = names.get(name)
    if not p:
        return name
    return f"[[{p.stem}\\|{name}]]" if table else f"[[{p.stem}|{name}]]"


# 이름 없는 단체방(카톡 DB 의 "채팅방 <번호>")은 카톡 앱처럼 참여자 이름으로 보여 준다.
AUTO_RE = re.compile(r"^채팅방 \d+$")


def auto_title(msgs: list, me: set[str], taken: set[str]) -> str:
    ppl = sorted({m[1] for m in msgs} - me)
    if not ppl:
        return ""
    base = ", ".join(ppl) if len(ppl) <= 4 else ", ".join(ppl[:3]) + f" 외 {len(ppl) - 3}명"
    name, n = base, 2
    while name in taken or safe(name) in taken:
        name, n = f"{base} ({n})", n + 1
    return name


def drop_stale(kdir: Path, titles: dict[str, str], trash: Path):
    """방 이름이 바뀐 이름 없는 단체방의 예전 노트(폴더+목차 노트)를 휴지통으로."""
    import shutil
    for note in kdir.glob("*.md"):
        stem = unicodedata.normalize("NFC", note.stem)  # macOS 파일 이름은 NFD 일 수 있음
        key = read_fm(note).get("chat_key") or (stem if AUTO_RE.match(stem) else "")
        if not key or key not in titles or safe(titles[key]) == stem:
            continue
        dest = trash / "카톡 이전 방 이름"
        dest.mkdir(parents=True, exist_ok=True)
        for src in (kdir / note.stem, note):
            if src.exists():
                target = dest / src.name
                if target.exists():
                    shutil.rmtree(target) if target.is_dir() else target.unlink()
                shutil.move(str(src), str(target))
        print(f"카카오톡: 방 이름 변경 {stem} → {titles[key]}")


def render_room(kdir: Path, room: str, msgs: list, me: set[str], names: dict[str, Path], key: str = "") -> dict:
    others = sorted({m[1] for m in msgs} - me)
    kind = "1:1" if len(others) <= 1 else "단체"
    title = safe(room)
    mdir = kdir / title
    mdir.mkdir(parents=True, exist_ok=True)

    months: dict[str, list] = {}
    for m in msgs:
        months.setdefault(m[0][:7], []).append(m)
    plist = "[" + ", ".join(q(f"[[{names[o].stem}]]") if o in names else q(o) for o in others) + "]"

    for ym, ms in months.items():
        body, day = [], None
        for ts, who, text in ms:
            d = ts[:10]
            if d != day:
                day = d
                wd = WEEK[datetime.fromisoformat(ts).weekday()]
                body.append(f"\n### {d} ({wd})\n")
            who_s = "나" if who in me else link(who, names)
            text = text.replace("\n", "<br>")
            body.append(f"`{ts[11:16]}` **{who_s}**: {text}\n")
        (mdir / f"{title} {ym}.md").write_text(
            "---\n"
            f"room: {q(room)}\n"
            + (f"chat_key: {q(key)}\n" if key else "")
            + f"kind: {q(kind)}\n"
            f"month: {q(ym)}\n"
            f"participants: {plist}\n"
            f"message_count: {len(ms)}\n"
            "tags: [카카오톡]\n"
            "---\n"
            f"# {room} · {ym}\n\n"
            f"[[{title}|← {room}]]\n" + "".join(body),
            encoding="utf-8",
        )

    month_links = "\n".join(
        f"| [[{title} {ym}\\|{ym}]] | {len(months[ym])} |" for ym in sorted(months, reverse=True)
    )
    first, last = (msgs[0][0][:10], msgs[-1][0][:10]) if msgs else ("", "")
    (kdir / f"{title}.md").write_text(
        "---\n"
        f"room: {q(room)}\n"
        + (f"chat_key: {q(key)}\n" if key else "")
        + f"kind: {q(kind)}\n"
        f"participants: {plist}\n"
        f"first_message: {first}\n"
        f"last_message: {last}\n"
        f"message_count: {len(msgs)}\n"
        "tags: [카카오톡]\n"
        "---\n"
        f"# {room} ({kind})\n\n"
        "## 참여자\n"
        + "\n".join(f"- {link(o, names)}" for o in others)
        + "\n\n## 월별 대화\n\n| 월 | 메시지 |\n|---|---|\n" + month_links + "\n",
        encoding="utf-8",
    )
    return {"room": room, "title": title, "kind": kind, "others": others,
            "first": first, "last": last, "count": len(msgs)}


def refresh_contact_kakao(contact: Path, rooms: list[dict], names: dict[str, Path]):
    rows = sorted(rooms, key=lambda r: r["last"], reverse=True)
    rows = sorted(rows, key=lambda r: r["kind"] != "1:1")  # 1:1방 먼저
    lines = ["| 방 | 종류 | 기간 | 메시지 | 함께 있는 사람 |", "|---|---|---|---|---|"]
    for r in rows:
        lines.append(
            f"| [[{r['title']}]] | {r['kind']} | {r['first']} ~ {r['last']} | {r['count']} | "
            + (", ".join(link(o, names, table=True) for o in r["others"] if names.get(o) != contact) or "-")
            + " |"
        )
    block = "<!-- kakao:start -->\n\n" + "\n".join(lines) + "\n\n<!-- kakao:end -->"
    t = contact.read_text(encoding="utf-8")
    if "<!-- kakao:start -->" in t:
        t = re.sub(r"<!-- kakao:start -->.*?<!-- kakao:end -->", lambda _: block, t, flags=re.S)
    else:
        t = t.rstrip("\n") + "\n\n## 카카오톡\n\n" + block + "\n"
    last = rows[0]["last"] if rows else ""
    if re.search(r"^last_kakao:.*$", t, flags=re.M):
        t = re.sub(r"^last_kakao:.*$", f"last_kakao: {last}", t, count=1, flags=re.M)
    else:
        t = t.replace("tags: [연락처]", f"tags: [연락처]\nlast_kakao: {last}", 1)
    contact.write_text(t, encoding="utf-8")


def run(src: Path, root: Path, me_names: list[str], from_db: bool = False, min_msgs: int = 1):
    cdir, kdir, store = root / "연락처", root / "카톡", root / ".kakao"
    if not src.exists():
        src.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in src.rglob("*") if p.suffix.lower() in (".txt", ".csv", ".zip") and not p.name.startswith("."))
    if not files and not store.exists() and not from_db:
        print(f"카카오톡: 내보내기 파일 없음 ({src})")
        return
    kdir.mkdir(parents=True, exist_ok=True)

    for f in files:
        for room, msgs in load_export(f):
            if len({m[1] for m in msgs}) > 2:  # 단체방 헤더는 "방이름 N 님과..." → 인원수 제거
                room = re.sub(r" \d+$", "", room)
            if msgs:
                merge(store / f"{safe(room)}.json", room, msgs)
                print(f"카카오톡: {f.name} → {room} ({len(msgs)}개)")

    if from_db:
        import kakao_db
        db_rooms, db_meta = kakao_db.extract(person_only=True)  # 브랜드·알림톡(채널) 제외
        for room, msgs in db_rooms.items():
            merge(store / f"{safe(room)}.json", room, msgs, meta=db_meta.get(room))
        print(f"카카오톡 DB: 사람·단체방 {len(db_rooms)}개 읽음 (브랜드·알림톡 제외)")
        if kakao_db.CARD_MSGS:
            import spend
            spend.from_kakao_card(root, kakao_db.CARD_MSGS)

    names = name_index(cdir)
    phones = phone_index(cdir)

    # 저장소의 모든 방 + 메타 로드
    all_rooms, meta = {}, {}
    for s in sorted(store.glob("*.json")):
        d = json.loads(s.read_text(encoding="utf-8"))
        all_rooms[d["room"]] = d["messages"]
        meta[d["room"]] = d.get("meta") or {}

    # 번호로 연락처 매칭 → 상대 이름을 연락처에 연결 (1:1방)
    for room, m in meta.items():
        ph = m.get("phone")
        if ph in phones and room not in names:
            names[room] = phones[ph]

    def keep(room: str, msgs: list) -> bool:
        if not meta.get(room):      # 내보내기 파일 방은 그대로
            return True
        others = {x[1] for x in msgs} - {"나"}
        if any(o in names for o in others):   # 연락처 매칭되면 항상 저장
            return True
        return len(msgs) >= min_msgs           # 그 외 사람 대화는 메시지 수 기준

    rooms = {r: v for r, v in all_rooms.items() if keep(r, v)}
    me = detect_me(rooms, me_names) | {"나"}  # DB 는 내 메시지를 '나'로 적어 둠

    taken = {r for r in rooms if not AUTO_RE.match(r)} | {safe(r) for r in rooms if not AUTO_RE.match(r)}
    titles = {}
    for r, v in rooms.items():
        if AUTO_RE.match(r):
            t = auto_title(v, me, taken) or r
            taken |= {t, safe(t)}
            titles[r] = t
    drop_stale(kdir, titles, root.parent.parent / ".trash")
    infos = [render_room(kdir, titles.get(room, room), msgs, me, names, key=room if room in titles else "")
             for room, msgs in rooms.items()]
    per_contact: dict[Path, list] = {}
    for info in infos:
        for o in info["others"]:
            if o in names:
                per_contact.setdefault(names[o], []).append(info)
    for c, rs in per_contact.items():
        refresh_contact_kakao(c, rs, names)
    linked = sorted({names[o].stem for i in infos for o in i["others"] if o in names})
    print(f"카카오톡: 저장 {len(infos)}개 방 / 후보 {len(all_rooms)}개 · 연락처 연동 {len(linked)}명")
