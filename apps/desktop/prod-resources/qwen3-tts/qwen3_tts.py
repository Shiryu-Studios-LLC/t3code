#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
import io
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get(
    "SHIRYU_QWEN_TTS_MODEL",
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
)
DEFAULT_VOICE = "Aiden"
IDLE_UNLOAD_SECONDS = max(60, int(os.environ.get("SHIRYU_QWEN_TTS_IDLE_UNLOAD_SECONDS", "300")))

VOICE_ALIASES = {
    "aiden": "Aiden",
    "ryan": "Ryan",
    "vivian": "Vivian",
    "serena": "Serena",
    "uncle_fu": "Uncle_Fu",
    "uncle-fu": "Uncle_Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ono_anna": "Ono_Anna",
    "ono-anna": "Ono_Anna",
    "sohee": "Sohee",
    # Preserve older Kokoro selections when users upgrade to Qwen3-TTS.
    "am_michael": "Aiden",
    "am_adam": "Ryan",
    "am_eric": "Ryan",
    "am_liam": "Aiden",
    "am_onyx": "Ryan",
    "af_bella": "Vivian",
    "af_nicole": "Serena",
    "af_sarah": "Serena",
    "bf_emma": "Vivian",
    "bm_george": "Aiden",
    "en": "Aiden",
    "en-us": "Aiden",
    "en-gb": "Ryan",
}

VOICE_INFO = [
    {"id": "Aiden", "name": "Aiden", "language": "English", "description": "Sunny American male voice with a clear midrange."},
    {"id": "Ryan", "name": "Ryan", "language": "English", "description": "Dynamic English male voice with strong rhythmic drive."},
    {"id": "Vivian", "name": "Vivian", "language": "Chinese", "description": "Bright young female voice; can also speak English."},
    {"id": "Serena", "name": "Serena", "language": "Chinese", "description": "Warm, gentle young female voice; can also speak English."},
    {"id": "Uncle_Fu", "name": "Uncle Fu", "language": "Chinese", "description": "Seasoned low male voice; can also speak English."},
    {"id": "Dylan", "name": "Dylan", "language": "Chinese", "description": "Youthful clear male voice; can also speak English."},
    {"id": "Eric", "name": "Eric", "language": "Chinese", "description": "Lively slightly husky male voice; can also speak English."},
    {"id": "Ono_Anna", "name": "Ono Anna", "language": "Japanese", "description": "Playful light female voice; can also speak English."},
    {"id": "Sohee", "name": "Sohee", "language": "Korean", "description": "Warm female voice with rich emotion; can also speak English."},
]


def normalize_voice(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return DEFAULT_VOICE
    return VOICE_ALIASES.get(raw.lower(), raw if raw in {item["id"] for item in VOICE_INFO} else DEFAULT_VOICE)


class QwenTtsRuntime:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.model = None
        self.device = None
        self.last_used = 0.0
        self.loading = False
        self.last_error: str | None = None

    def _cuda_available(self) -> bool:
        try:
            import torch
            return bool(torch.cuda.is_available())
        except Exception:
            return False

    def load(self):
        with self.lock:
            if self.model is not None:
                self.last_used = time.monotonic()
                return self.model
            self.loading = True
            self.last_error = None
            try:
                import torch
                from qwen_tts import Qwen3TTSModel

                if not torch.cuda.is_available():
                    raise RuntimeError(
                        "Qwen3-TTS natural voice service requires CUDA on this workstation; "
                        "OmniRoute will fall back to the lightweight voice backend when CUDA is unavailable."
                    )

                self.device = "cuda:0"
                self.model = Qwen3TTSModel.from_pretrained(
                    MODEL_ID,
                    device_map=self.device,
                    dtype=torch.bfloat16,
                    attn_implementation="sdpa",
                )
                self.last_used = time.monotonic()
                return self.model
            except Exception as error:
                self.model = None
                self.device = None
                self.last_error = str(error)
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                gc.collect()
                raise
            finally:
                self.loading = False

    def unload_if_idle(self) -> None:
        with self.lock:
            if self.model is None or self.loading:
                return
            if time.monotonic() - self.last_used < IDLE_UNLOAD_SECONDS:
                return
            self.model = None
            self.device = None
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def synthesize(self, text: str, voice: str) -> tuple[bytes, int]:
        import soundfile as sf

        with self.lock:
            model = self.load()
            selected_voice = normalize_voice(voice)
            wavs, sample_rate = model.generate_custom_voice(
                text=text,
                language="English",
                speaker=selected_voice,
            )
            self.last_used = time.monotonic()
            output = io.BytesIO()
            sf.write(output, wavs[0], sample_rate, format="WAV", subtype="PCM_16")
            return output.getvalue(), int(sample_rate)

    def status(self) -> dict[str, object]:
        with self.lock:
            return {
                "ok": True,
                "ready": True,
                "model": MODEL_ID,
                "modelLoaded": self.model is not None,
                "loading": self.loading,
                "device": self.device,
                "cudaAvailable": self._cuda_available(),
                "idleUnloadSeconds": IDLE_UNLOAD_SECONDS,
                "lastError": self.last_error,
            }


def run_server(port: int) -> int:
    runtime = QwenTtsRuntime()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args) -> None:
            return

        def _json(self, status: int, body: object) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, runtime.status())
                return
            if self.path == "/voices":
                self._json(200, {"voices": VOICE_INFO, "default": DEFAULT_VOICE})
                return
            self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                if self.path != "/synthesize":
                    self._json(404, {"ok": False, "error": "not found"})
                    return
                text = str(payload.get("text", "")).strip()
                if not text:
                    self._json(400, {"ok": False, "error": "text is required"})
                    return
                voice = normalize_voice(payload.get("voice", DEFAULT_VOICE))
                audio, sample_rate = runtime.synthesize(text, voice)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("X-Shiryu-TTS-Voice", voice)
                self.send_header("X-Shiryu-TTS-Sample-Rate", str(sample_rate))
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except Exception as error:
                message = str(error).strip() or error.__class__.__name__
                status = 503 if "CUDA" in message.upper() or "MEMORY" in message.upper() else 500
                self._json(status, {"ok": False, "error": message})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    def idle_reaper() -> None:
        while True:
            time.sleep(15)
            runtime.unload_if_idle()

    threading.Thread(target=idle_reaper, daemon=True).start()

    def shutdown(_signum, _frame) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"Shiryu Qwen3-TTS service ready on 127.0.0.1:{port}", flush=True)
    server.serve_forever(poll_interval=0.25)
    server.server_close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Shiryu Studios shared Qwen3-TTS service")
    parser.add_argument("--server-port", type=int, default=37832)
    args = parser.parse_args()
    return run_server(args.server_port)


if __name__ == "__main__":
    raise SystemExit(main())
