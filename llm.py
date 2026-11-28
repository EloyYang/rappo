"""Rappo 의 AI 호출을 한곳에서: 요약·할 일·회의록이 모두 이 함수를 쓴다.

RAPPO_AI            auto(기본) | local | claude    — auto 는 로컬 모델이 켜져 있으면 로컬, 아니면 claude
RAPPO_LOCAL_ENGINE  mlx | ollama                — 로컬 모델을 무엇으로 돌릴지
                    (기본: ~/.venvs/mlx-llm 이 있으면 mlx — 같은 모델이 Ollama 보다 약 2배 빠름)
RAPPO_AI_MODEL      ollama: qwen3.5:4b  /  mlx: mlx-community/Qwen3.5-4B-MLX-4bit 처럼
RAPPO_MLX_URL       mlx_lm.server 주소 (기본 http://127.0.0.1:8765)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import atexit
import time
import urllib.request
from pathlib import Path

MLX_PY = Path(os.environ.get("RAPPO_MLX_PY", str(Path.home() / ".venvs/mlx-llm/bin/python")))
AI = os.environ.get("RAPPO_AI", "auto").strip() or "auto"
ENGINE = os.environ.get("RAPPO_LOCAL_ENGINE", "").strip() or ("mlx" if MLX_PY.exists() else "ollama")
MODEL = os.environ.get("RAPPO_AI_MODEL", "").strip()
# 엔진에 맞지 않는 모델 이름이면 그 엔진의 기본 모델로 (mlx 는 'mlx-community/…' 같은 저장소 이름, ollama 는 'qwen3.5:4b' 같은 이름)
if ENGINE == "mlx" and "/" not in MODEL:
    MODEL = "mlx-community/Qwen3.5-4B-MLX-4bit"
elif ENGINE != "mlx" and (not MODEL or "/" in MODEL):
    MODEL = "qwen3.5:4b"
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MLX = os.environ.get("RAPPO_MLX_URL", "http://127.0.0.1:8765").rstrip("/")


def _get(url: str, timeout: float = 2):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status == 200


def local_up() -> bool:
    """로컬 모델을 쓸 수 있나 — mlx 는 서버가 꺼져 있어도 설치돼 있으면 필요할 때 띄운다."""
    if ENGINE == "mlx":
        return MLX_PY.exists()
    try:
        return _get(OLLAMA + "/api/tags")
    except Exception:
        return False


_server = None


def _ensure_mlx():
    """mlx_lm 서버가 없으면 이번 실행 동안만 띄운다 (끝나면 내려서 메모리를 돌려줌)."""
    global _server
    try:
        if _get(MLX + "/v1/models"):
            return
    except Exception:
        pass
    if _server is None:
        port = MLX.rsplit(":", 1)[-1]
        _server = subprocess.Popen(
            [str(MLX_PY), "-m", "mlx_lm.server", "--model", MODEL, "--port", port,
             "--chat-template-args", '{"enable_thinking": false}'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        atexit.register(lambda: _server and _server.poll() is None and _server.terminate())
    for _ in range(90):
        try:
            if _get(MLX + "/v1/models"):
                return
        except Exception:
            time.sleep(1)
    raise RuntimeError("MLX 로컬 모델 서버를 띄우지 못했어요")


def _post(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def local(prompt: str, ctx: int = 8192, max_tokens: int = 1500, temperature: float = 0.2, timeout: float = 600) -> str:
    """로컬 모델 한 번 호출 (생각 모드 끔)."""
    if ENGINE == "mlx":
        _ensure_mlx()
        d = _post(MLX + "/v1/chat/completions", {
            "model": MODEL, "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature, "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": False}}, timeout)
        out = d["choices"][0]["message"]["content"] or ""
    else:
        d = _post(OLLAMA + "/api/generate", {"model": MODEL, "prompt": prompt, "stream": False, "think": False,
                                             "options": {"temperature": temperature, "num_ctx": ctx}}, timeout)
        out = d.get("response", "")
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


def use_local() -> bool:
    return AI == "local" or (AI == "auto" and local_up())


def generate(prompt: str, ctx: int = 8192, temperature: float = 0.2, timeout: float = 600) -> str:
    """auto/local/claude 규칙대로 한 번 호출. 실패하면 예외."""
    if use_local():
        return local(prompt, ctx=ctx, temperature=temperature, timeout=timeout)
    if not shutil.which("claude"):
        return ""
    r = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=timeout)
    out = r.stdout.strip()
    if r.returncode != 0 or out.startswith(("Failed to authenticate", "Error", "Invalid API key")):
        raise RuntimeError((out or r.stderr).strip()[:120])
    return out


def label() -> str:
    return f"로컬 {MODEL} ({ENGINE})" if use_local() else "claude"
