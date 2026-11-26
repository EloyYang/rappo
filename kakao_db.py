"""카카오톡 맥 버전의 암호화 DB(SQLCipher)를 본인 맥에서 직접 읽는다.

동작 전제: 이 스크립트를 '그 DB가 만들어진 바로 그 맥'에서, 본인 계정으로 실행한다.
복호화 키는 이 맥의 하드웨어 UUID + 본인 카카오 user_id 로부터 카카오톡 앱과 똑같은
방식으로 유도한다. user_id 는 앱이 plist 에 SHA-512 해시로만 저장하므로, 해시가 되는
정수를 찾아서(최초 1회) ~/.venvs/rappo/kakao/userids 에 캐시한다.

출력: {room_name: [(iso시각, 보낸사람, 내용)]} — 이후 kakao.py 가 옵시디언 노트로 만든다.
"""
from __future__ import annotations

import glob
import hashlib
import os
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

CONTAINER = Path.home() / "Library/Containers/com.kakao.KakaoTalkMac/Data/Library"
DB_DIR = CONTAINER / "Application Support/com.kakao.KakaoTalkMac"
PREF_DIR = CONTAINER / "Preferences"
STATE = Path(os.environ.get("RAPPO_HOME", str(Path.home() / ".venvs/rappo"))).expanduser() / "kakao"
EMPTY_HASH = ("31bca02094eb78126a517b206a88c73cfa9ec6f704c7030d18212cace820f025"
              "f00bf0ea68dbf3f3a5436ca63b53bf7bf80ad8d5de7d8359d0b7fed9dbc3ab99")
HASH_PREFIXES = ("DESIGNATEDFRIENDSREVISION:", "DENYFILEEXTIONSIONREVISION:")


# ---------- 기기 UUID ----------
def platform_uuid() -> str:
    out = subprocess.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                         capture_output=True, text=True, check=True).stdout
    m = re.search(r'"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"', out)
    if not m:
        raise RuntimeError("IOPlatformUUID 를 찾지 못했습니다")
    return m.group(1)


# ---------- 키 유도 (카카오톡 앱과 동일) ----------
def _pbkdf2(password: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password, salt, 100_000, 128)


def hashed_uuid(uuid: str) -> str:
    b = uuid.encode()
    import base64
    return base64.b64encode(hashlib.sha1(b).digest() + hashlib.sha256(b).digest()).decode()


def secure_key(user_id: int, uuid: str) -> str:
    h = hashed_uuid(uuid)
    parts = ["A", h, "|", "F", uuid[:5], "H", str(user_id), "|", uuid[7:]]
    hawawa = "F".join(parts)
    salt = uuid[int(len(uuid) * 0.3):]
    derived = _pbkdf2(hawawa[::-1].encode(), salt.encode())
    return derived.hex()  # 256 hex chars


def database_name(user_id: int, uuid: str) -> str:
    hawawa = ".".join([".", "F", str(user_id), "A", "F", uuid[::-1], ".", "|"])
    salt = hashed_uuid(uuid)[::-1]
    return _pbkdf2(hawawa.encode(), salt.encode()).hex()[28:106]


# ---------- 내 user_id 찾기 ----------
def hashed_ids_from_plists() -> set[str]:
    out = set()
    for f in glob.glob(str(PREF_DIR / "com.kakao.KakaoTalkMac*.plist")):
        try:
            d = plistlib.load(open(f, "rb"))
        except Exception:
            continue
        for k, v in d.items():
            for pre in HASH_PREFIXES:
                if k.startswith(pre):
                    h = k[len(pre):]
                    if len(h) == 128 and h != EMPTY_HASH and isinstance(v, (int, float)) and v:
                        out.add(h.lower())
    return out


def _scan_chunk(args):
    start, span, targets = args
    found = {}
    for i in range(start, start + span):
        d = hashlib.sha512(str(i).encode()).hexdigest()
        if d in targets:
            found[d] = i
    return found


def recover_user_id(max_id: int = 7_000_000_000) -> int | None:
    """plist 의 SHA-512 해시가 되는 정수(=내 user_id)를 찾는다. 최초 1회만 돌면 캐시된다."""
    cache = STATE / "userids"
    targets = hashed_ids_from_plists()
    if not targets:
        print("  ! plist 에서 해시된 user_id 후보를 찾지 못했습니다", file=sys.stderr)
        return None
    if cache.exists():
        for line in cache.read_text().split():
            if line.isdigit() and hashlib.sha512(line.encode()).hexdigest() in targets:
                return int(line)
    from multiprocessing import Pool
    span, found = 10_000_000, {}
    print(f"  user_id 복원 중 (본인 계정 식별, 최초 1회)…", flush=True)
    with Pool(max(1, os.cpu_count() or 4)) as pool:
        jobs = ((s, span, targets) for s in range(0, max_id, span))
        for res in pool.imap_unordered(_scan_chunk, jobs):
            found.update(res)
            if found:
                break
    if not found:
        return None
    uid = next(iter(found.values()))
    STATE.mkdir(parents=True, exist_ok=True)
    cache.write_text(str(uid))
    return uid


# ---------- DB 열기 ----------
def find_db(user_id: int, uuid: str) -> Path | None:
    want = database_name(user_id, uuid)
    cand = DB_DIR / want
    if cand.exists():
        return cand
    for p in DB_DIR.iterdir():  # 이름 규칙이 안 맞으면 78자리 hex 파일로 탐색
        if re.fullmatch(r"[0-9a-f]{78}", p.name) and p.is_file():
            return p
    return None


def decrypt_to_sqlite(db: Path, key_hex: str) -> Path:
    """sqlcipher CLI 로 평문 sqlite 복사본을 만든다(읽기 전용, 임시폴더)."""
    if not shutil.which("sqlcipher"):
        raise RuntimeError("sqlcipher 가 없습니다:  brew install sqlcipher")
    tmp = Path(tempfile.mkdtemp(prefix="kakao_")) / "plain.db"
    src = Path(tempfile.mkdtemp(prefix="kakao_src_"))
    for suf in ("", "-wal", "-shm"):  # 앱이 열려 있어도 건드리지 않도록 복사본에서 작업
        s = Path(str(db) + suf)
        if s.exists():
            shutil.copy2(s, src / (db.name + suf))
    copy = src / db.name
    for compat in (4, 3):
        script = (
            f"PRAGMA key='{key_hex}';\n"
            f"PRAGMA cipher_compatibility={compat};\n"
            f"ATTACH DATABASE '{tmp}' AS plain KEY '';\n"
            "SELECT sqlcipher_export('plain');\n"
            "DETACH DATABASE plain;\n"
        )
        r = subprocess.run(["sqlcipher", str(copy)], input=script, capture_output=True, text=True)
        if tmp.exists() and tmp.stat().st_size > 0:
            shutil.rmtree(src, ignore_errors=True)
            return tmp
        tmp.unlink(missing_ok=True)
    shutil.rmtree(src, ignore_errors=True)
    raise RuntimeError("복호화 실패: 키가 맞지 않거나 DB 형식이 다릅니다\n" + r.stderr[-500:])


# ---------- 메시지 읽기 ----------
def _ts(v) -> str:
    try:
        return datetime.fromtimestamp(int(float(v))).isoformat(timespec="minutes")
    except Exception:
        return ""


# 방 종류: 0=1:1사람, 1=단체, 2=채널/브랜드/알림톡, 4=오픈채팅, 5=나와의채팅, 그 외=시스템
PERSON_TYPES = (0, 1)


def _phone(num: str | None) -> str:
    if not num:
        return ""
    from rappo import fmt_phone
    return fmt_phone(re.sub(r"[^\d+]", "", num))


def read_rooms(plain: Path, person_only: bool = True) -> tuple[dict[str, list], dict[str, dict]]:
    """(rooms, meta). meta[room] = {kind, phone(1:1 상대 번호), type}."""
    con = sqlite3.connect(f"file:{plain}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"NTChatRoom", "NTChatMessage", "NTUser"} <= tables:
        con.close()
        raise RuntimeError(f"예상한 테이블이 없습니다. 있는 테이블: {sorted(tables)[:20]}")

    users, phones = {}, {}
    for r in con.execute(
        "SELECT userId, COALESCE(NULLIF(displayName,''),NULLIF(friendNickName,''),"
        "NULLIF(nickName,'')) AS name, phoneNumber FROM NTUser WHERE linkId=0"):
        users[r["userId"]] = r["name"] or ""
        phones[r["userId"]] = _phone(r["phoneNumber"])
    me = None
    try:
        me = con.execute("SELECT userId FROM NTChatContext LIMIT 1").fetchone()[0]
    except Exception:
        pass

    def label(uid):
        return "나" if uid == me else (users.get(uid) or f"({uid})")

    room_name, meta, seen = {}, {}, {}
    for r in con.execute(
        "SELECT chatId, type, chatName, directChatMemberUserId, activeMembersCount FROM NTChatRoom"):
        if person_only and r["type"] not in PERSON_TYPES:
            continue
        if r["chatName"]:
            name = r["chatName"]
        elif r["directChatMemberUserId"] in users:
            name = users[r["directChatMemberUserId"]]
        else:
            name = f"채팅방 {r['chatId']}"
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:  # 동명 방은 구분
            name = f"{name} ({seen[name]})"
        room_name[r["chatId"]] = name
        meta[name] = {"type": r["type"], "kind": "1:1" if r["type"] == 0 else "단체",
                      "phone": phones.get(r["directChatMemberUserId"], "")}

    rooms: dict[str, list] = {}
    for r in con.execute(
        "SELECT chatId, authorId, message, sentAt FROM NTChatMessage ORDER BY sentAt ASC"):
        if not r["message"] or r["chatId"] not in room_name:
            continue
        rooms.setdefault(room_name[r["chatId"]], []).append(
            (_ts(r["sentAt"]), label(r["authorId"]), r["message"]))
    con.close()
    rooms = {k: v for k, v in rooms.items() if v}
    return rooms, {k: meta[k] for k in rooms}


def extract(person_only: bool = True) -> tuple[dict[str, list], dict[str, dict]]:
    if not DB_DIR.exists():
        print("카카오톡(맥) 데이터 폴더가 없습니다. 카카오톡 맥 앱에 로그인되어 있어야 합니다.", file=sys.stderr)
        return {}, {}
    uuid = platform_uuid()
    uid = recover_user_id()
    if uid is None:
        print("  ! user_id 복원 실패", file=sys.stderr)
        return {}, {}
    db = find_db(uid, uuid)
    if not db:
        print("  ! 암호화 DB 파일을 찾지 못했습니다", file=sys.stderr)
        return {}, {}
    plain = decrypt_to_sqlite(db, secure_key(uid, uuid))
    try:
        return read_rooms(plain, person_only)
    finally:
        shutil.rmtree(plain.parent, ignore_errors=True)  # 평문 복사본 즉시 삭제


if __name__ == "__main__":
    data, meta = extract(person_only="--all" not in sys.argv)
    for room, msgs in sorted(data.items(), key=lambda x: len(x[1])):
        m = meta.get(room, {})
        print(f"{len(msgs):5d}  [{m.get('kind','?')}] {room}  {m.get('phone','')}")
    print("방", len(data), "개")
