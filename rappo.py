#!/usr/bin/env python3
"""Rappo(라포): 녹취 파일 → STT(mlx-whisper, 로컬) → 옵시디언 통화 기록 노트 (+ 카카오톡).

파일명 형식:  [이름_]전화번호_YYYYMMDDHHMMSS.m4a
생성되는 노트:
  <VAULT>/2. Areas/통화기록/연락처/<이름 또는 번호>.md   ← 번호별 연락처 노트 (통화 목록은 Base/Dataview 없이도 자동 갱신)
  <VAULT>/2. Areas/통화기록/통화/YYYY-MM-DD HHMM <이름>.md ← 통화 1건 = 노트 1개 (요약 + 전사문)

이미 처리한 녹취는 통화 노트의 frontmatter(source)로 판별해 건너뜀 → 반복 실행해도 안전.
이름 규칙: 같은 번호의 녹취 중 가장 최근 파일에 붙은 이름이 그 번호의 이름이 되고, 연락처·통화 노트 전체에 반영.
녹취에 이름이 한 번도 없으면 name 은 "정보 없음" (연락처 노트에서 직접 고친 이름은 녹취 이름이 없을 때 유지).
연락처 노트 파일 이름은 이름(없으면 번호), 번호는 phone 속성에 따로 저장.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import unicodedata
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks  # noqa: E402

def _env(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(v).expanduser() if v else default


# 경로는 환경변수로 덮어쓸 수 있음. run.sh 가 config.sh(install.sh 가 생성)와 앱 설정에서 채운다.
RECORD_DIR = _env("RAPPO_RECORD", Path.home() / "Documents/Rappo/녹취")
KAKAO_DIR = _env("RAPPO_KAKAO", Path.home() / "Documents/Rappo/카카오톡")
# 이 시각(파일명의 통화 시각) 이전 녹취는 건너뜀. 예: "2026-11-26 01:30"
SINCE = os.environ.get("RAPPO_SINCE", "").strip()
KAKAO_ME: list[str] = [x.strip() for x in os.environ.get("RAPPO_KAKAO_ME", "").split(",") if x.strip()]
VAULT = _env("RAPPO_VAULT", Path.home() / "Documents/Obsidian")
BASE_DIR = os.environ.get("RAPPO_BASE", "").strip() or "2. Areas/통화기록"  # 볼트 안 저장 폴더
MODEL = "mlx-community/whisper-large-v3-turbo"
SR = 16000
MODELS = _env("RAPPO_HOME", Path.home() / ".venvs/rappo") / "models"  # 화자분리 ONNX 모델
TASK_STATE = MODELS.parent / "state" / "tasks.json"  # 할 일을 이미 찾아본 통화·카톡 묶음
ME_FILE = MODELS / "me.npy"  # 내 목소리 프로필
ME_MIN_SIM, ME_MIN_MARGIN = 0.5, 0.1
AUDIO_EXT ={".m4a", ".mp3", ".wav", ".amr", ".3gp", ".aac", ".ogg"}

FNAME_RE = re.compile(r"^(?:(?P<name>.+?)_)?(?P<phone>\+?\d{3,15})_(?P<ts>\d{14})$")


# ---------- 파싱 ----------
def fmt_phone(p: str) -> str:
    p = p.lstrip("+")
    if p.startswith("82") and len(p) >= 11:
        p = "0" + p[2:]
    if re.fullmatch(r"01\d{8,9}", p):
        return f"{p[:3]}-{p[3:-4]}-{p[-4:]}"
    if p.startswith("02") and len(p) in (9, 10):
        return f"02-{p[2:-4]}-{p[-4:]}"
    if re.fullmatch(r"0[3-6]\d\d{7,8}", p):
        return f"{p[:3]}-{p[3:-4]}-{p[-4:]}"
    if re.fullmatch(r"0[5-8]0\d{8,9}", p):  # 050x 안심번호, 070 등
        return f"{p[:4]}-{p[4:-4]}-{p[-4:]}" if p.startswith("050") else f"{p[:3]}-{p[3:-4]}-{p[-4:]}"
    if re.fullmatch(r"1[5-9]\d{6}", p):  # 1588-xxxx
        return f"{p[:4]}-{p[4:]}"
    return p


def parse(path: Path):
    m = FNAME_RE.match(unicodedata.normalize("NFC", path.stem))  # macOS 파일명은 NFD
    if not m:
        return None
    return {
        "name": (m["name"] or "").strip(),
        "phone": fmt_phone(m["phone"]),
        "dt": datetime.strptime(m["ts"], "%Y%m%d%H%M%S"),
        "path": path,
    }


# ---------- frontmatter ----------
def read_fm(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    fm = {}
    for line in text[4:end].splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"')
    return fm


def q(s: str) -> str:
    return '"' + str(s).replace('"', '\\"') + '"'


# ---------- 오디오/STT ----------
def duration_sec(path: Path) -> int:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return int(float(out))
    except Exception:
        return 0


def fmt_dur(s: int) -> str:
    return f"{s // 60}분 {s % 60:02d}초" if s >= 60 else f"{s}초"


def load_pcm(path: Path):
    import numpy as np

    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.float32)


# ---------- 화자 분리 (sherpa-onnx, 로컬) ----------
_dia = _ext = None


def _models():
    global _dia, _ext
    if _dia is None:
        import sherpa_onnx as so

        emb = str(MODELS / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx")
        seg = str(MODELS / "sherpa-onnx-pyannote-segmentation-3-0/model.onnx")
        _dia = so.OfflineSpeakerDiarization(so.OfflineSpeakerDiarizationConfig(
            segmentation=so.OfflineSpeakerSegmentationModelConfig(
                pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg)),
            embedding=so.SpeakerEmbeddingExtractorConfig(model=emb),
            clustering=so.FastClusteringConfig(num_clusters=2),  # 전화 = 2명
            min_duration_on=0.3, min_duration_off=0.5,
        ))
        _ext = so.SpeakerEmbeddingExtractor(so.SpeakerEmbeddingExtractorConfig(model=emb))
    return _dia, _ext


def embed(x):
    import numpy as np

    _, ext = _models()
    s = ext.create_stream()
    s.accept_waveform(SR, x)
    s.input_finished()
    v = np.array(ext.compute(s))
    return v / np.linalg.norm(v)


def diarize(x) -> tuple[list[tuple[float, float, int]], dict]:
    """[(start, end, speaker)], {speaker: 목소리 임베딩}"""
    import numpy as np

    dia, _ = _models()
    turns = [(s.start, s.end, s.speaker) for s in dia.process(x).sort_by_start_time()]
    audio = {}
    for a, b, k in turns:
        audio.setdefault(k, []).append(x[int(a * SR):int(b * SR)])
    embs = {k: embed(np.concatenate(v)[: SR * 60]) for k, v in audio.items()}
    return turns, embs


def identify_me(embs: dict) -> int | None:
    """등록된 내 목소리와 확실히 일치하는 화자 번호. 애매하면 None."""
    import numpy as np

    if not ME_FILE.exists() or len(embs) < 1:
        return None
    me = np.load(ME_FILE)
    sims = sorted(((float(v @ me), k) for k, v in embs.items()), reverse=True)
    best, k = sims[0]
    second = sims[1][0] if len(sims) > 1 else 0.0
    if best >= ME_MIN_SIM and best - second >= ME_MIN_MARGIN:
        if best >= 0.6:  # 확실할수록 프로필을 조금씩 보정
            v = 0.9 * me + 0.1 * embs[k]
            np.save(ME_FILE, v / np.linalg.norm(v))
        return k
    return None


def enroll(path: Path):
    """내 목소리만 들어 있는 녹음으로 프로필 등록."""
    import numpy as np

    v = embed(load_pcm(path))
    ME_FILE.parent.mkdir(parents=True, exist_ok=True)
    np.save(ME_FILE, v)
    print(f"내 목소리 등록 완료 → {ME_FILE}")


def speaker_at(turns, t0: float, t1: float) -> int | None:
    best, who = 0.0, None
    for a, b, k in turns:
        ov = min(b, t1) - max(a, t0)
        if ov > best:
            best, who = ov, k
    if who is None:  # 겹치는 구간이 없으면 가장 가까운 화자
        mid = (t0 + t1) / 2
        who = min(turns, key=lambda r: min(abs(r[0] - mid), abs(r[1] - mid)))[2] if turns else None
    return who


def transcribe(path: Path, other: str = "상대") -> list[dict]:
    """[{start, speaker, text}] — 화자가 바뀌는 지점마다 한 줄."""
    # 공개 모델이라 토큰 불필요 (만료된 HF 토큰이 있으면 401이 나므로 끔)
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    import mlx_whisper

    r = mlx_whisper.transcribe(
        str(path), path_or_hf_repo=MODEL, language="ko",
        condition_on_previous_text=False,  # 반복 환각 방지
        initial_prompt="다음은 한국어 전화 통화 녹음입니다.",
        word_timestamps=True,
    )

    try:
        turns, embs = diarize(load_pcm(path))
    except Exception as e:
        print(f"     ! 화자 분리 실패: {e}", file=sys.stderr)
        turns, embs = [], {}
    me = identify_me(embs) if embs else None
    order = []  # 등장 순서대로 화자1, 화자2
    for _, _, k in turns:
        if k not in order:
            order.append(k)

    def label(k):
        if k is None or not turns:
            return ""
        if me is not None:
            return "나" if k == me else other
        return f"화자{order.index(k) + 1}"

    lines, last_seg = [], None
    for s in r.get("segments", []):
        t = s["text"].strip()
        if not t or t == last_seg:  # 같은 문장 연속 반복 제거
            continue
        last_seg = t
        words = s.get("words") or [{"start": s["start"], "end": s["end"], "word": s["text"]}]
        for w in words:
            spk = label(speaker_at(turns, w["start"], w["end"])) if turns else ""
            if lines and lines[-1]["speaker"] == spk:
                lines[-1]["text"] += w["word"]
            else:
                lines.append({"start": int(w["start"]), "speaker": spk, "text": w["word"]})
    for ln in lines:
        ln["text"] = ln["text"].strip()
    return [ln for ln in lines if ln["text"]]


AI = os.environ.get("RAPPO_AI", "auto").strip() or "auto"          # auto | local | claude
AI_MODEL = os.environ.get("RAPPO_AI_MODEL", "qwen3.5:4b").strip() or "qwen3.5:4b"
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
WEEK = "월화수목금토일"


def _prompt(transcript: str, when: datetime | None) -> str:
    base = f"통화 날짜: {when:%Y-%m-%d} ({WEEK[when.weekday()]}요일)\n" if when else ""
    return (
        base +
        "아래는 전화 통화 녹취를 음성인식한 전사문이야(오인식이 있을 수 있음). "
        "통화 기록용으로 한국어 마크다운으로만 답해. 형식:\n"
        "첫 줄: 한 줄 요약(기호 없이)\n\n- 핵심 내용 불릿 2~5개 (대화를 그대로 옮기지 말고 내용을 정리)\n"
        "할 일·일정은 따로 뽑으니 쓰지 마.\n"
        "머리말·인사·제목 없이 바로 시작.\n\n---\n" + transcript
    )


def _ollama_up() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _ollama(prompt: str) -> str:
    """로컬 모델(Ollama)로 요약. 생각 모드는 끈다."""
    import json, urllib.request
    body = json.dumps({"model": AI_MODEL, "prompt": prompt, "stream": False, "think": False,
                       "options": {"temperature": 0.2, "num_ctx": 8192}}).encode()
    req = urllib.request.Request(OLLAMA + "/api/generate", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.loads(r.read().decode()).get("response", "")
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


def summarize(transcript: str, when: datetime | None = None) -> str:
    """요약: 로컬 모델(Ollama, 기본 qwen3.5:4b) 또는 claude CLI. 실패하면 빈 문자열.
    RAPPO_AI=auto 면 Ollama 가 켜져 있을 때 로컬, 아니면 claude."""
    if len(transcript) < 30:
        return ""
    prompt = _prompt(transcript, when)
    use_local = AI == "local" or (AI == "auto" and _ollama_up())
    try:
        if use_local:
            out = _ollama(prompt)
            if not out:
                print("     ! 요약 실패: 로컬 모델 응답 없음", file=sys.stderr)
            return out
        if not shutil.which("claude"):
            return ""
        r = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=180)
        out = r.stdout.strip()
        if r.returncode != 0 or not out or out.startswith(("Failed to authenticate", "Error", "Invalid API key")):
            print(f"     ! 요약 실패: {(out or r.stderr).strip()[:120]}", file=sys.stderr)
            return ""
        return out
    except Exception as e:
        print(f"     ! 요약 실패 ({'로컬 ' + AI_MODEL if use_local else 'claude'}): {e}", file=sys.stderr)
        return ""


def resummarize(call_dir: Path, cdir: Path):
    """요약이 비어 있는 통화 노트만 골라 요약을 채움."""
    targets = [p for p in sorted(call_dir.glob("*.md")) if "## 요약\n(요약 없음)" in p.read_text(encoding="utf-8")]
    print(f"요약 없는 통화 {len(targets)}개")
    phones = set()
    for n, p in enumerate(targets, 1):
        t = p.read_text(encoding="utf-8")
        body = t.split("## 전사문\n", 1)[-1]
        transcript = re.sub(r"^`\d+:\d+` ", "", body, flags=re.M).replace("**", "")
        fm = read_fm(p)
        try:
            when = datetime.fromisoformat(str(fm.get("datetime", ""))[:16])
        except ValueError:
            when = None
        summary = summarize(transcript, when)
        if not summary:
            continue
        first = summary.splitlines()[0].strip("# ").lstrip("-*[] x").strip()
        t = t.replace("## 요약\n(요약 없음)", "## 요약\n" + summary, 1)
        t = re.sub(r'^summary: .*$', f"summary: {q(first)}", t, count=1, flags=re.M)
        p.write_text(t, encoding="utf-8")
        phones.add(read_fm(p).get("phone"))
        print(f"[{n}/{len(targets)}] ✓ {p.stem}", flush=True)
    idx = contact_index(cdir)
    for ph in phones:
        if ph in idx:
            refresh_contact_calls(idx[ph], call_dir, ph)


# ---------- 노트 ----------
def contact_index(cdir: Path) -> dict[str, Path]:
    idx = {}
    for p in cdir.glob("*.md"):
        ph = read_fm(p).get("phone")
        if ph:
            idx[ph] = p
    return idx


def safe(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|#^\[\]]', "", s).strip()


UNKNOWN = "정보 없음"


def latest_names(items: list[dict]) -> dict[str, str]:
    """번호 → 가장 최근 녹취 파일에 붙은 이름."""
    names = {}
    for i in sorted(items, key=lambda i: i["dt"]):
        if i["name"]:
            names[i["phone"]] = i["name"]
    return names


def known(name: str) -> str:
    return "" if not name or name == UNKNOWN else name


def set_fm(t: str, key: str, val: str, after: str = "") -> str:
    """frontmatter 의 key 값을 바꾸거나(없으면 after 줄 뒤에) 넣는다."""
    head, sep, body = t.partition("\n---\n")
    line = f"{key}: {val}"
    if re.search(rf"^{key}:.*$", head, flags=re.M):
        head = re.sub(rf"^{key}:.*$", lambda _: line, head, count=1, flags=re.M)
    elif after and re.search(rf"^{after}:.*$", head, flags=re.M):
        head = re.sub(rf"^({after}:.*)$", lambda m: m[1] + "\n" + line, head, count=1, flags=re.M)
    else:
        head += "\n" + line
    return head + sep + body


def contact_stem(name: str, phone: str, cdir: Path, current: Path | None) -> str:
    stem = safe(name) if name else safe(phone)
    p = cdir / f"{stem}.md"
    if p.exists() and p != current:  # 같은 이름이 이미 있으면 번호를 붙여 구분
        stem = safe(f"{name} {phone}")
    return stem


def ensure_contact(cdir: Path, idx: dict, phone: str, name: str) -> tuple[Path, str]:
    """연락처 노트를 찾거나 만들고 (경로, 표시이름) 반환. 이름 정리는 sync_names 가 맡는다."""
    p = idx.get(phone)
    if p:
        return p, known(read_fm(p).get("name", "")) or phone
    p = cdir / f"{contact_stem(name, phone, cdir, None)}.md"
    p.write_text(
        "---\n"
        f"name: {q(name or UNKNOWN)}\n"
        f"phone: {q(phone)}\n"
        "tags: [연락처]\n"
        "memo: \"\"\n"
        "---\n"
        f"# {name or phone}\n\n"
        "## 메모\n\n\n"
        "## 통화 기록\n\n<!-- calls:start -->\n\n<!-- calls:end -->\n",
        encoding="utf-8",
    )
    idx[phone] = p
    return p, name or phone


def relink(root: Path, renames: dict[str, str]):
    """노트 이름이 바뀌면 통화기록 폴더 안의 [[옛이름…]] 링크를 새 이름으로."""
    if not renames:
        return
    pat = re.compile(r"\[\[(" + "|".join(re.escape(o) for o in sorted(renames, key=len, reverse=True)) + r")(?=\]\]|\||\\\|)")
    for f in root.rglob("*.md"):
        t = f.read_text(encoding="utf-8")
        n = pat.sub(lambda m: "[[" + renames[m[1]], t)
        if n != t:
            f.write_text(n, encoding="utf-8")


def sync_names(root: Path, cdir: Path, call_dir: Path, rec_names: dict[str, str]) -> dict[str, Path]:
    """번호별 이름을 정하고(최근 녹취 이름 > 연락처에 직접 적은 이름 > 정보 없음)
    연락처·통화 노트의 name/제목/파일 이름/화자 표시를 모두 맞춘다."""
    renames: dict[str, str] = {}
    final: dict[str, str] = {}
    idx = contact_index(cdir)
    for phone, p in sorted(idx.items()):
        cur = known(read_fm(p).get("name", ""))
        name = rec_names.get(phone) or cur
        final[phone] = name
        t = p.read_text(encoding="utf-8")
        n = set_fm(t, "name", q(name or UNKNOWN))
        n = re.sub(r"^# .*$", lambda _: f"# {name or phone}", n, count=1, flags=re.M)
        if n != t:
            p.write_text(n, encoding="utf-8")
        stem = contact_stem(name, phone, cdir, p)
        if stem != p.stem:
            new = p.with_name(f"{stem}.md")
            p.rename(new)
            renames[p.stem] = stem
            idx[phone] = new
    for c in sorted(call_dir.glob("*.md")):
        fm = read_fm(c)
        phone = fm.get("phone", "")
        if phone not in idx:
            continue
        name = final.get(phone, "")
        disp = name or phone
        t = c.read_text(encoding="utf-8")
        m = re.search(r"^# (.+?) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$", t, flags=re.M)
        old = m[1] if m else ""
        stem = idx[phone].stem
        n = set_fm(t, "name", q(name or UNKNOWN), after="contact")
        n = re.sub(r'^contact: .*$', lambda _: f'contact: "[[{stem}]]"', n, count=1, flags=re.M)
        n = re.sub(r"^- 연락처: .*$", lambda _: f"- 연락처: [[{stem}]]", n, count=1, flags=re.M)
        if m:
            n = n.replace(m[0], f"# {disp} · {m[2]}", 1)
        if name:  # 전사문 화자: 예전 이름/번호/상대 → 현재 이름
            for o in {old, phone, "상대"} - {"", name}:
                n = n.replace(f"**{o}**:", f"**{name}**:")
        if n != t:
            c.write_text(n, encoding="utf-8")
        dt = fm.get("datetime", "")
        if re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", dt):
            want = safe(f"{dt[:10]} {dt[11:13]}{dt[14:16]} {disp}")
            if want != c.stem:
                new = c.with_name(f"{want}.md")
                if not new.exists():
                    c.rename(new)
                    renames[c.stem] = want
    relink(root, renames)
    for phone, p in idx.items():
        refresh_contact_calls(p, call_dir, phone)
    if renames:
        print(f"이름 정리: 노트 {len(renames)}개 이름 변경")
    return idx


def refresh_contact_calls(contact: Path, call_dir: Path, phone: str):
    rows = []
    for c in call_dir.glob("*.md"):
        fm = read_fm(c)
        if fm.get("phone") == phone:
            rows.append((fm.get("datetime", ""), c.stem, fm.get("duration", ""), fm.get("summary", "")))
    rows.sort(reverse=True)
    lines = ["| 일시 | 통화 | 길이 | 요약 |", "|---|---|---|---|"]
    for dt, stem, dur, summ in rows:
        lines.append(f"| {dt[:16].replace('T', ' ')} | [[{stem}]] | {dur} | {summ.replace('|', '/')} |")
    block = "<!-- calls:start -->\n\n" + "\n".join(lines) + "\n\n<!-- calls:end -->"
    t = contact.read_text(encoding="utf-8")
    t = re.sub(r"<!-- calls:start -->.*?<!-- calls:end -->", lambda _: block, t, flags=re.S)
    # frontmatter 집계값 갱신
    last = rows[0][0][:10] if rows else ""
    for key, val in (("last_call", last), ("call_count", str(len(rows)))):
        if re.search(rf"^{key}:.*$", t, flags=re.M):
            t = re.sub(rf"^{key}:.*$", f"{key}: {val}", t, count=1, flags=re.M)
        else:
            t = t.replace("tags: [연락처]", f"tags: [연락처]\n{key}: {val}", 1)
    contact.write_text(t, encoding="utf-8")


def fmt_line(s: dict) -> str:
    who = f"**{s['speaker']}**: " if s.get("speaker") else ""
    return f"`{s['start'] // 60:02d}:{s['start'] % 60:02d}` {who}{s['text']}"


def write_call(call_dir: Path, info: dict, display: str, contact: Path, segs, summary: str, dur: int) -> Path:
    dt = info["dt"]
    title = safe(f"{dt:%Y-%m-%d %H%M} {display}")
    p = call_dir / f"{title}.md"
    first_line = summary.splitlines()[0].strip("# ").lstrip("-*[] x").strip() if summary else ""
    transcript = "\n\n".join(fmt_line(s) for s in segs) or "(인식된 음성 없음)"
    audio_uri = info["path"].as_uri()
    p.write_text(
        "---\n"
        f"contact: \"[[{contact.stem}]]\"\n"
        f"name: {q(known(read_fm(contact).get('name', '')) or UNKNOWN)}\n"
        f"phone: {q(info['phone'])}\n"
        f"datetime: {dt:%Y-%m-%dT%H:%M:%S}\n"
        f"duration: {q(fmt_dur(dur))}\n"
        f"summary: {q(first_line)}\n"
        f"source: {q(info['path'].name)}\n"
        "tags: [통화기록]\n"
        "---\n"
        f"# {display} · {dt:%Y-%m-%d %H:%M}\n\n"
        f"- 연락처: [[{contact.stem}]]\n"
        f"- 길이: {fmt_dur(dur)}\n"
        f"- 녹음: [원본 열기]({audio_uri})\n\n"
        "## 요약\n"
        f"{summary or '(요약 없음)'}\n\n"
        "## 전사문\n"
        f"{transcript}\n",
        encoding="utf-8",
    )
    return p


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description="녹취 → 옵시디언 통화 기록")
    ap.add_argument("--src", type=Path, default=RECORD_DIR)
    ap.add_argument("--vault", type=Path, default=VAULT)
    ap.add_argument("--no-summary", action="store_true", help="통화 요약 생략")
    ap.add_argument("--limit", type=int, default=0, help="이번에 처리할 최대 개수")
    ap.add_argument("--redo-tasks", action="store_true", help="모든 통화 노트에서 할 일 다시 찾기 (요약 속 옛 할 일은 뺌)")
    ap.add_argument("--kakao-tasks", action="store_true", help="최근 카톡 대화에서 할 일 찾기만")
    ap.add_argument("--resummarize", action="store_true", help="요약이 비어 있는 통화 노트만 요약 채우기")
    ap.add_argument("--kakao-src", type=Path, default=KAKAO_DIR)
    ap.add_argument("--kakao-me", action="append", default=list(KAKAO_ME), metavar="이름", help="내 카톡 이름 (여러 번 지정 가능)")
    ap.add_argument("--kakao-db", action="store_true", help="카카오톡 맥 앱의 암호화 DB를 직접 읽기")
    ap.add_argument("--kakao-min", type=int, default=10, metavar="N", help="메시지 N개 미만인 방은 건너뛰기")
    ap.add_argument("--since", default=SINCE, metavar="YYYY-MM-DD HH:MM", help="이 시각 이전 통화 녹취는 건너뛰기")
    ap.add_argument("--sync-names", action="store_true", help="녹취 변환 없이 연락처·통화 노트 이름만 정리")
    ap.add_argument("--rebuild", action="store_true", help="이미 처리한 녹취도 다시 변환(덮어쓰기)")
    ap.add_argument("--setup-obsidian", action="store_true", help="볼트에 대시보드·검색 플러그인 설치")
    ap.add_argument("--enroll", type=Path, metavar="녹음파일", help="내 목소리만 담긴 녹음으로 '나' 프로필 등록")
    a = ap.parse_args()

    if a.setup_obsidian:
        import obsidian_setup
        print(obsidian_setup.setup(a.vault, BASE_DIR))
        return

    # 중복 실행 방지: 녹취 감시 작업과 주기 작업이 동시에 떠도 하나만 진행
    import fcntl
    MODELS.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = open(MODELS.parent / "run.lock", "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("이미 실행 중 — 건너뜀")
        return

    root = a.vault / BASE_DIR
    cdir, call_dir = root / "연락처", root / "통화"
    cdir.mkdir(parents=True, exist_ok=True)
    call_dir.mkdir(parents=True, exist_ok=True)
    if a.enroll:
        return enroll(a.enroll)
    if a.resummarize:
        return resummarize(call_dir, cdir)
    if a.redo_tasks:
        return tasks.redo_calls(root, call_dir, TASK_STATE, read_fm)
    if a.kakao_tasks:
        return print(f"카톡 할 일 {tasks.from_kakao(root, TASK_STATE)}개")

    done = set() if a.rebuild else {read_fm(p).get("source") for p in call_dir.glob("*.md")}
    # 네트워크 드라이브(SMB)는 큰 폴더에서 같은 파일을 여러 번 돌려줄 때가 있어 set 으로 중복 제거
    files = sorted({p for p in a.src.rglob("*") if p.suffix.lower() in AUDIO_EXT and not p.name.startswith(".")})
    items = [i for i in map(parse, files) if i]
    skipped = [f.name for f in files if not parse(f)]
    todo = [i for i in items if i["path"].name not in done]
    if a.since:
        cut = datetime.strptime(a.since, "%Y-%m-%d %H:%M")
        todo = [i for i in todo if i["dt"] >= cut]
    if a.limit:
        todo = todo[: a.limit]
    if a.sync_names:
        todo = []

    # 같은 번호는 가장 최근 녹취에 붙은 이름으로 통일 (기존 노트도 함께 정리)
    names = latest_names(items)
    idx = sync_names(root, cdir, call_dir, names)
    print(f"녹취 {len(items)}개 중 신규 {len(todo)}개 처리" + (f", 형식 불일치 {len(skipped)}개 건너뜀" if skipped else ""))

    touched = set()
    for n, info in enumerate(todo, 1):
        name = names.get(info["phone"], "")
        contact, display = ensure_contact(cdir, idx, info["phone"], name)
        name = display if display != info["phone"] else ""
        print(f"[{n}/{len(todo)}] {info['path'].name} → {display}", flush=True)
        dur = duration_sec(info["path"])
        segs = transcribe(info["path"], other=name or "상대")
        summary = "" if a.no_summary else summarize("\n".join(
            (f"{s['speaker']}: " if s["speaker"] else "") + s["text"] for s in segs), info["dt"])
        out = write_call(call_dir, info, display, contact, segs, summary, dur)
        print(f"     ✓ {out.relative_to(a.vault)}", flush=True)
        if not a.no_summary:
            st = tasks.load_state(TASK_STATE)
            k = tasks.from_call(root, out, "\n".join((f"{s['speaker']}: " if s["speaker"] else "") + s["text"] for s in segs),
                                info["dt"], display if display != info["phone"] else info["phone"], st)
            tasks.save_state(TASK_STATE, st)
            if k:
                print(f"     ✓ 할 일 {k}개", flush=True)
        touched.add((contact, info["phone"]))

    for contact, phone in touched:
        refresh_contact_calls(contact, call_dir, phone)
    if a.sync_names:
        return
    for f in skipped:
        print(f"  ! 파일명 형식 불일치: {f}", file=sys.stderr)

    import kakao
    kakao.run(a.kakao_src, root, a.kakao_me, from_db=a.kakao_db, min_msgs=a.kakao_min)
    if not a.no_summary:
        tasks.from_kakao(root, TASK_STATE)


if __name__ == "__main__":
    main()
