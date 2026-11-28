"""Rappo 소비: 현대카드 승인 문자와 카드 이용내역 파일을 읽어
<저장 폴더>/소비/YYYY-MM.md 에 한 줄씩 모은다. 옵시디언 Rappo 플러그인의 ```소비``` 가 이 노트들을 읽어 보여 준다.

한 줄 형식 (사람이 고쳐도 됨 — 분류 #태그 를 바꾸면 그대로 유지):
  - 2026-11-03 12:30 · 12,000원 · OO마트 · 생필품 · 현대카드(일시불) #생활 ^p1234567890
취소는 금액 앞에 '-' (예: -30,000원).
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

CATS = [
    ("배달외식", r"우아한형제들|배달의민족|배민|쿠팡이츠|요기요|맥도날드|버거|스타벅스|투썸|이디야|메가커피|빽다방|커피|카페|치킨|피자|떡볶이|식당|레스토랑|베이커리|파리바게뜨|뚜레쥬르"),
    ("식료품", r"이마트|홈플러스|롯데마트|마켓컬리|컬리|오아시스|GS25|\bCU\b|세븐일레븐|이마트24|편의점|정육|청과|농협|하나로"),
    ("생활용품", r"다이소|생활용품|이케아|IKEA|모던하우스"),
    ("패션뷰티", r"무신사|올리브영|29CM|에이블리|지그재그|W컨셉|유니클로|자라|ZARA|H&M|미용실|헤어|네일"),
    ("쇼핑", r"쿠팡|네이버|11번가|지마켓|G마켓|옥션|SSG|오늘의집|알리|테무|롯데온|위메프|티몬"),
    ("교통", r"카카오T|카카오모빌리티|택시|코레일|SRT|티머니|주유|쏘카|그린카|버스|철도|항공|대한항공|아시아나|제주항공"),
    ("구독디지털", r"넷플릭스|Netflix|유튜브|YouTube|애플|Apple|구글|Google|멜론|스포티파이|Spotify|디즈니|티빙|웨이브|쿠팡플레이|Whois|도메인|호스팅|AWS|Anthropic|OpenAI|ChatGPT|노션|Notion|앱스토어"),
    ("공과금통신", r"\bKT\b|\bSKT\b|SK텔레콤|LG유플러스|유플러스|통신|관리비|전기|가스|수도|보험|국민연금|건강보험|세금"),
    ("여가문화", r"CGV|메가박스|롯데시네마|인터파크|예스24|교보|야놀자|여기어때|에어비앤비|티켓|공연|게임|스팀|Steam|넥슨|라이엇"),
    ("의료건강", r"병원|약국|의원|치과|한의원|헬스|피트니스|필라테스"),
]


def category(merchant: str, item: str) -> str:
    s = f"{merchant} {item}"
    for name, pat in CATS:
        if re.search(pat, s, re.I):
            return name
    return "기타"


def parse(message: str, attachment: str, sent_at: float, msg_id: str, room: str) -> dict | None:
    """결제 알림 한 건 → {id, dt, amount, merchant, item, method, room}. 결제 알림이 아니면 None."""
    text = message or ""
    amt = None
    try:
        a = json.loads(attachment) if attachment else {}
        text = text or a.get("P", {}).get("ME", "")
        td = a.get("C", {}).get("BTD", {}).get("TD", {})
        if "금액" in str(td.get("D", "")):
            amt = int(re.sub(r"[^\d]", "", str(td.get("T", ""))) or 0)
    except Exception:
        pass
    if not re.search(r"결제가?\s*(완료|취소)|결제\s*(완료|취소)|승인\s*취소|환불", text):
        return None
    if amt is None:
        m = re.search(r"(?:결제|취소|승인)\s*금액\s*[:：]?\s*([\d,]+)\s*원", text) or re.search(r"([\d,]{3,})\s*원", text)
        amt = int(m.group(1).replace(",", "")) if m else None
    if not amt:
        return None
    if re.search(r"취소|환불", text):
        amt = -amt
    field = lambda k: (re.search(rf"{k}\s*[:：]\s*(.+)", text) or [None, ""])[1].strip()
    when = field("결제일시") or field("거래일시") or field("일시")
    dt = None
    mm = re.match(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})", when)
    if mm:
        dt = datetime(*map(int, mm.groups()))
    else:
        dt = datetime.fromtimestamp(float(sent_at or 0))
    merchant = field("구매처") or field("가맹점") or field("사용처") or room
    item = field("상품명") or field("상품")
    return {"id": str(msg_id), "dt": dt, "amount": amt, "merchant": merchant, "item": item,
            "method": field("결제수단"), "room": room}


def _line(p: dict) -> str:
    clean = lambda s: re.sub(r"\s*·\s*", " ", s or "").replace("\n", " ").strip()
    amt = f"{'-' if p['amount'] < 0 else ''}{abs(p['amount']):,}원"
    parts = [f"{p['dt']:%Y-%m-%d %H:%M}", amt, clean(p["merchant"]) or "-", clean(p["item"]) or "-", clean(p["method"]) or "-"]
    return f"- {' · '.join(parts)} #{category(p['merchant'], p['item']).replace(' ', '')} ^{p.get('src', 'p')}{p['id']}"


# 분류 이름은 옵시디언 태그로 쓰므로 가운뎃점 없이 (화면에는 '배달·외식'처럼 보임)
HEAD = """---
tags: [소비]
cssclasses: [rappo-dash]
---
# 💳 {month} 소비

Rappo 가 현대카드 승인 문자·이용내역 파일에서 모은 내역이에요. 분류(#태그)는 고쳐도 그대로 유지돼요.
대시보드: [[소비 대시보드]]

"""


def save(root: Path, pays: list[dict]) -> int:
    """월별 노트에 새 결제만 추가 (^p<id> 로 중복 확인)."""
    d = root / "소비"
    d.mkdir(parents=True, exist_ok=True)
    by_month: dict[str, list[dict]] = {}
    for p in pays:
        by_month.setdefault(f"{p['dt']:%Y-%m}", []).append(p)
    added = 0
    for month, ps in by_month.items():
        f = d / f"{month}.md"
        text = f.read_text(encoding="utf-8") if f.exists() else HEAD.format(month=month)
        have = set(re.findall(r"\^[pc]([0-9a-f]+)", text))
        new = [p for p in sorted(ps, key=lambda x: x["dt"]) if p["id"] not in have]
        if not new:
            continue
        f.write_text(text.rstrip("\n") + "\n" + "\n".join(_line(p) for p in new) + "\n", encoding="utf-8")
        added += len(new)
    dash = d / "소비 대시보드.md"
    if not dash.exists():
        dash.write_text("---\ncssclasses:\n  - pd-wide\n  - rappo-dash\ntags: [대시보드]\n---\n```소비\n```\n", encoding="utf-8")
    return added


# ---------- 카드사 이용내역 파일 가져오기 (현대카드 등) ----------
# <저장 폴더>/소비/가져오기/ 에 카드사 홈페이지·앱에서 내려받은 이용내역(.xlsx / .xls / .csv)을 넣으면
# 다음 정리 때 월별 노트에 '^c…' 줄로 들어간다. 같은 파일을 다시 넣어도 중복되지 않는다.
import csv
import hashlib
import html
import io
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree as ET


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__(); self.rows, self.row, self.cell, self.inc = [], None, [], False
    def handle_starttag(self, tag, a):
        if tag == "tr": self.row = []
        elif tag in ("td", "th"): self.inc, self.cell = True, []
    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.row is not None: self.row.append(" ".join("".join(self.cell).split())); self.inc = False
        elif tag == "tr" and self.row is not None: self.rows.append(self.row); self.row = None
    def handle_data(self, d):
        if self.inc: self.cell.append(d)


def _xlsx(b: bytes) -> list[list[str]]:
    z = zipfile.ZipFile(io.BytesIO(b))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
    sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
    rows = []
    for row in ET.fromstring(z.read(sheets[0])).iter("{%s}row" % ns["m"]):
        out = {}
        for c in row.findall("m:c", ns):
            ref = re.sub(r"\d", "", c.get("r", "A")); col = 0
            for ch in ref: col = col * 26 + ord(ch) - 64
            v = c.find("m:v", ns); t = c.get("t")
            val = "" if v is None else v.text or ""
            if t == "s" and val: val = ss[int(val)]
            elif t == "inlineStr": val = "".join(x.text or "" for x in c.iter("{%s}t" % ns["m"]))
            out[col - 1] = val
        rows.append([out.get(i, "") for i in range(max(out) + 1)] if out else [])
    return rows


def read_table(path: Path) -> list[list[str]]:
    b = path.read_bytes()
    if b[:2] == b"PK":
        return _xlsx(b)
    head = b[:4000].lower()
    if b"<table" in head or b"<html" in head or b"<tr" in head:
        for enc in ("utf-8", "cp949", "euc-kr"):
            try: t = b.decode(enc); break
            except UnicodeDecodeError: continue
        p = _Tables(); p.feed(t); return p.rows
    if b[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        try:
            import xlrd  # 진짜 옛 엑셀(.xls)
            sh = xlrd.open_workbook(file_contents=b).sheet_by_index(0)
            return [[str(sh.cell_value(r, c)) for c in range(sh.ncols)] for r in range(sh.nrows)]
        except ImportError:
            raise RuntimeError("옛 엑셀(.xls) 형식이에요 — 엑셀·Numbers 에서 .xlsx 나 .csv 로 저장해 넣어 주세요")
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try: t = b.decode(enc); break
        except UnicodeDecodeError: continue
    return list(csv.reader(io.StringIO(t)))


def _num(s: str) -> int | None:
    s = str(s).replace(",", "").replace("원", "").strip()
    m = re.match(r"^-?\d+(\.\d+)?$", s)
    return int(float(s)) if m else None


def _date(s: str, year_hint: int) -> datetime | None:
    s = str(s).strip()
    m = re.match(r"(\d{2,4})[.\-/년 ]+(\d{1,2})[.\-/월 ]+(\d{1,2})일?(?:\s+(\d{1,2}):(\d{2}))?", s)
    if m:
        y = int(m.group(1)); y = y + 2000 if y < 100 else y
        return datetime(y, int(m.group(2)), int(m.group(3)), int(m.group(4) or 0), int(m.group(5) or 0))
    m = re.match(r"(\d{1,2})[./](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$", s)
    if m and year_hint:
        return datetime(year_hint, int(m.group(1)), int(m.group(2)), int(m.group(3) or 0), int(m.group(4) or 0))
    if re.match(r"^\d{5}(\.\d+)?$", s):   # 엑셀 날짜 숫자
        from datetime import timedelta
        return datetime(1899, 12, 30) + timedelta(days=float(s))
    return None


def parse_statement(rows: list[list[str]], card: str) -> list[dict]:
    """이용내역 표 → 결제 목록. 머리글 줄을 찾아 이용일·가맹점·금액·할부·취소 칸을 알아낸다."""
    hdr = None
    for i, r in enumerate(rows[:40]):
        j = " ".join(r)
        if re.search(r"(이용|승인|거래|매출)\s*(일자|일시|일)", j) and re.search(r"금액", j) and re.search(r"가맹점|이용처|사용처", j):
            hdr = i; break
    if hdr is None:
        raise RuntimeError("이용일·가맹점·금액 머리글을 찾지 못했어요")
    H = [re.sub(r"\s", "", h) for h in rows[hdr]]
    def col(*pats):
        for p in pats:
            for k, h in enumerate(H):
                if re.search(p, h): return k
        return None
    cd, ct = col(r"^(이용|승인|거래|매출)(일자|일시|일)$", r"(이용|승인|거래)일"), col(r"(이용|승인|거래)시간")
    cm = col(r"가맹점명", r"이용가맹점", r"가맹점", r"이용처", r"사용처")
    ca = col(r"^이용금액", r"^승인금액", r"^결제금액", r"^(원화)?금액", r"금액")
    ci, cs = col(r"할부|이용구분|결제방법"), col(r"취소|승인구분|상태|구분")
    years = [int(y) for y in re.findall(r"(20\d{2})", " ".join(" ".join(r) for r in rows[:hdr + 5]))]
    yh = years[0] if years else datetime.now().year
    out = []
    for k, r in enumerate(rows[hdr + 1:]):
        g = lambda c: (r[c] if c is not None and c < len(r) else "").strip()
        dt = _date(f"{g(cd)} {g(ct)}".strip(), yh)
        amt = _num(g(ca))
        if not dt or amt is None or amt == 0 or not g(cm):
            continue
        status = g(cs) + " " + g(ci)
        if re.search(r"취소|환불", status) and amt > 0:
            amt = -amt
        key = f"{card}|{dt:%Y-%m-%d %H:%M}|{g(cm)}|{amt}"
        out.append({"id": hashlib.sha1(key.encode()).hexdigest()[:12], "dt": dt, "amount": amt, "merchant": g(cm),
                    "item": "", "method": f"{card}({g(ci) or '일시불'})" if card else g(ci), "room": card, "src": "c"})
    return out


def import_files(root: Path) -> int:
    d = root / "소비" / "가져오기"
    d.mkdir(parents=True, exist_ok=True)
    done_f = d / ".가져온 파일.json"
    done = json.loads(done_f.read_text(encoding="utf-8")) if done_f.exists() else {}
    total = 0
    for f in sorted(d.iterdir()):
        if f.name.startswith(".") or f.suffix.lower() not in (".xlsx", ".xls", ".csv", ".htm", ".html"):
            continue
        h = hashlib.sha1(f.read_bytes()).hexdigest()
        if done.get(f.name) == h:
            continue
        card = "현대카드" if re.search(r"현대|hyundai", f.name, re.I) else ""
        try:
            rows = read_table(f)
            if not card and re.search(r"현대카드", " ".join(" ".join(r) for r in rows[:15])):
                card = "현대카드"
            pays = parse_statement(rows, card or "카드")
            n = save(root, pays)
            print(f"소비: {f.name} → {len(pays)}건 중 새로 {n}건")
            total += n
            done[f.name] = h
        except Exception as e:
            print(f"  ! 소비 가져오기 실패 ({f.name}): {e}", file=sys.stderr)
    done_f.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
    return total


# ---------- 카드 승인 문자 (아이폰 문자 → 맥 '메시지' 앱) ----------
# 아이폰 설정 › 메시지 › 문자 메시지 전달에서 이 맥을 켜 두면, 카드사 승인 문자가 맥의 메시지 DB에도 쌓인다.
# (읽으려면 Rappo 에 전체 디스크 접근 권한이 필요 — 카톡과 같음)
CHAT_DB = Path.home() / "Library/Messages/chat.db"
CARD_SMS = r"현대카드"


def _attr_text(blob: bytes) -> str:
    """메시지 본문이 attributedBody(NSAttributedString)에만 있을 때 글자만 꺼낸다."""
    if not blob:
        return ""
    try:
        i = blob.index(b"NSString")
        b = blob[i + 8:]
        j = b.index(b"+") + 1           # 길이 앞 표시
        n = b[j]
        if n == 0x81:
            n = int.from_bytes(b[j + 1:j + 3], "little"); j += 3
        else:
            j += 1
        return b[j:j + n].decode("utf-8", "ignore")
    except Exception:
        return ""


def read_sms(limit_days: int = 400) -> list[tuple[str, float]]:
    """(본문, 보낸 시각 epoch) — 카드사 이름이 들어간 문자만"""
    if not CHAT_DB.exists():
        return []
    import sqlite3, time
    try:
        con = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
    except Exception as e:
        print(f"  ! 메시지 DB 열기 실패: {e}", file=sys.stderr)
        return []
    since = (time.time() - limit_days * 86400 - 978307200) * 1e9
    out = []
    try:
        for text, body, date in con.execute(
                "SELECT text, attributedBody, date FROM message WHERE date > ? AND is_from_me = 0", (since,)):
            t = text or _attr_text(body)
            if t and re.search(CARD_SMS, t):
                out.append((t, date / 1e9 + 978307200))
    except Exception as e:
        print(f"  ! 메시지 읽기 실패 (전체 디스크 접근 권한 확인): {e}", file=sys.stderr)
    con.close()
    return out


def parse_sms(text: str, sent: float) -> dict | None:
    """현대카드 승인/취소 문자 → 결제 한 건. 예)
    [Web발신] 현대카드 승인 / 홍*동 / 12,000원 일시불 / 11/27 14:05 / 스타벅스 / 누적123,456원"""
    if not re.search(r"승인|취소", text) or re.search(r"승인\s*거절|결제\s*예정|청구\s*(금액|안내)|명세서", text):
        return None
    t = re.sub(r"\[Web발신\]", "", text)
    lines = [x.strip() for x in t.split("\n") if x.strip()]
    am = re.search(r"(-?[\d,]{2,})\s*원", t)
    if not am:
        return None
    amt = int(am.group(1).replace(",", ""))
    if re.search(r"취소", t):
        amt = -abs(amt)
    sent_dt = datetime.fromtimestamp(sent)
    dm = re.search(r"(\d{1,2})/(\d{1,2})\s+(\d{1,2}):(\d{2})", t)
    dt = datetime(sent_dt.year, int(dm.group(1)), int(dm.group(2)), int(dm.group(3)), int(dm.group(4))) if dm else sent_dt
    if dt > sent_dt.replace(hour=23, minute=59) and dm:   # 연말에 받은 지난해 문자
        dt = dt.replace(year=dt.year - 1)
    # 가맹점: 날짜 뒤(같은 줄 또는 다음 줄들)에서 금액·누적이 아닌 첫 줄
    # 예) 카톡 현대카드: "11/03 12:30" / "12,000원 일시불" / "OO마트 주식회사" / "누적 300,000원"
    merchant = ""
    money = re.compile(r"^-?[\d,]+\s*원|누적|잔여|일시불$|\d+개월$")
    for i, l in enumerate(lines):
        if dm and dm.group(0) in l:
            rest = re.sub(r"\s*(누적|잔여).*$", "", l.split(dm.group(0), 1)[1]).strip()
            rest = re.sub(r"^-?[\d,]+\s*원\s*(일시불|\d+개월)?\s*", "", rest).strip()
            merchant = rest or next((x for x in lines[i + 1:] if not money.search(x)), "")
            break
    if not merchant or re.search(r"누적|잔여|원$", merchant):
        cands = [l for l in lines if not re.search(r"현대카드|승인|취소|원|\*|누적|\d{1,2}/\d{1,2}", l)]
        merchant = cands[-1] if cands else ""
    inst = (re.search(r"원\s*(일시불|\d+개월)", t) or [None, "일시불"])[1]
    key = f"sms|{dt:%Y-%m-%d %H:%M}|{merchant}|{amt}"
    return {"id": hashlib.sha1(key.encode()).hexdigest()[:12], "dt": dt, "amount": amt, "merchant": merchant or "현대카드",
            "item": "", "method": f"현대카드({inst})", "room": "현대카드 문자", "src": "c"}


def from_sms(root: Path) -> int:
    msgs = read_sms()
    pays = [p for p in (parse_sms(t, s) for t, s in msgs) if p]
    n = save(root, pays) if pays else 0
    if pays:
        print(f"소비: 현대카드 승인 문자 {len(pays)}건 중 새로 {n}건")
    return n


# ---------- 카톡 현대카드 방 (알림톡) ----------
def parse_kakao_card(message: str, attachment: str, sent: float, log_id: str) -> dict | None:
    """카톡 현대카드 알림 → 결제 한 건. 본문은 승인 문자와 비슷해서 parse_sms 를 쓰고, 알림톡의 금액 칸이 있으면 그걸 믿는다."""
    text, amt = message or "", None
    try:
        a = json.loads(attachment) if attachment else {}
        text = text or a.get("P", {}).get("ME", "") or a.get("C", {}).get("TI", {}).get("TD", {}).get("T", "")
        td = a.get("C", {}).get("BTD", {}).get("TD", {})
        if "금액" in str(td.get("D", "")) or re.search(r"[\d,]+\s*원", str(td.get("T", ""))):
            amt = int(re.sub(r"[^\d]", "", str(td.get("T", ""))) or 0) or None
            if amt and "원" not in text:
                text = f"{text}\n{amt:,}원"
    except Exception:
        pass
    p = parse_sms(text, float(sent or 0))
    if not p:
        return None
    if amt:
        p["amount"] = -amt if p["amount"] < 0 else amt
    p["id"] = "k" + hashlib.sha1(str(log_id).encode()).hexdigest()[:11]
    p["room"] = "현대카드 카톡"
    return p


def from_kakao_card(root: Path, rows: list) -> int:
    pays = [p for p in (parse_kakao_card(*r) for r in rows) if p]
    n = save(root, pays) if pays else 0
    if rows:
        print(f"소비: 카톡 현대카드 알림 {len(rows)}건 → 결제 {len(pays)}건, 새로 {n}건")
    return n
