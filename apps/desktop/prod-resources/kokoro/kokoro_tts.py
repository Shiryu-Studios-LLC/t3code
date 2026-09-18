#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_BASE_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
FULL_MODEL_URL = f"{MODEL_BASE_URL}/kokoro-v1.0.onnx"
INT8_MODEL_URL = f"{MODEL_BASE_URL}/kokoro-v1.0.int8.onnx"
VOICES_URL = f"{MODEL_BASE_URL}/voices-v1.0.bin"
FULL_MODEL_NAME = "kokoro-v1.0.onnx"
INT8_MODEL_NAME = "kokoro-v1.0.int8.onnx"
VOICES_NAME = "voices-v1.0.bin"
DEFAULT_VOICE = "am_michael"


def download_if_missing(url: str, path: Path) -> None:
    if path.is_file() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".download")
    print(f"Downloading {path.name}...", file=sys.stderr, flush=True)
    try:
        urllib.request.urlretrieve(url, temporary)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)


def language_for_voice(voice: str) -> str:
    return "en-gb" if voice.startswith("b") else "en-us"


def load_kokoro(cache_dir: Path):
    voices_path = cache_dir / VOICES_NAME
    download_if_missing(VOICES_URL, voices_path)

    from kokoro_onnx import EspeakConfig, Kokoro
    import onnxruntime as ort

    espeak_library = os.environ.get("T3_ESPEAK_LIBRARY", "/usr/lib/libespeak-ng.so.1")
    espeak_config = EspeakConfig(lib_path=espeak_library)

    if "CUDAExecutionProvider" in ort.get_available_providers():
        full_model_path = cache_dir / FULL_MODEL_NAME
        download_if_missing(FULL_MODEL_URL, full_model_path)
        try:
            session = ort.InferenceSession(
                str(full_model_path),
                providers=[
                    (
                        "CUDAExecutionProvider",
                        {
                            "cudnn_conv_algo_search": "DEFAULT",
                            "do_copy_in_default_stream": "1",
                        },
                    ),
                    "CPUExecutionProvider",
                ],
            )
            print(
                "T3 Kokoro using CUDAExecutionProvider with full model",
                file=sys.stderr,
                flush=True,
            )
            return Kokoro.from_session(
                session,
                str(voices_path),
                espeak_config=espeak_config,
            )
        except Exception as error:
            print(
                f"Kokoro CUDA initialization failed; falling back to INT8 CPU: {error}",
                file=sys.stderr,
                flush=True,
            )

    int8_model_path = cache_dir / INT8_MODEL_NAME
    download_if_missing(INT8_MODEL_URL, int8_model_path)
    print("T3 Kokoro using CPUExecutionProvider with INT8 model", file=sys.stderr, flush=True)
    return Kokoro(
        str(int8_model_path),
        str(voices_path),
        espeak_config=espeak_config,
    )


class PlaybackController:
    def __init__(self, kokoro) -> None:
        self.kokoro = kokoro
        self.lock = threading.Lock()
        self.synthesis_lock = threading.Lock()
        self.generation = 0
        self.stop_event: threading.Event | None = None
        self.pause_event: threading.Event | None = None
        self.player: subprocess.Popen[bytes] | None = None

    def _new_generation(self) -> tuple[int, threading.Event, threading.Event]:
        with self.lock:
            if self.stop_event is not None:
                self.stop_event.set()
            self.generation += 1
            stop_event = threading.Event()
            pause_event = threading.Event()
            self.stop_event = stop_event
            self.pause_event = pause_event
            return self.generation, stop_event, pause_event

    def _is_current(self, generation: int) -> bool:
        with self.lock:
            return self.generation == generation

    def control(self, action: str) -> None:
        with self.lock:
            stop_event = self.stop_event
            pause_event = self.pause_event
            player = self.player
        if action == "stop":
            if stop_event is not None:
                stop_event.set()
            if player is not None and player.poll() is None:
                player.terminate()
        elif action == "pause":
            if pause_event is not None:
                pause_event.set()
            if player is not None and player.poll() is None:
                player.send_signal(signal.SIGSTOP)
        elif action == "resume":
            if pause_event is not None:
                pause_event.clear()
            if player is not None and player.poll() is None:
                player.send_signal(signal.SIGCONT)

    def synthesize_wav(self, text: str, voice: str, rate: float) -> bytes:
        import numpy as np

        if not text.strip():
            raise ValueError("text is required")
        selected_voice = voice or DEFAULT_VOICE
        with self.synthesis_lock:
            samples, sample_rate = self.kokoro.create(
                text,
                voice=selected_voice,
                speed=max(0.5, min(2.0, rate)),
                lang=language_for_voice(selected_voice),
            )

        audio = np.asarray(samples, dtype=np.float32)
        channels = 1 if audio.ndim == 1 else audio.shape[1]
        pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm16.tobytes(order="C"))
        return output.getvalue()

    def speak(self, text: str, voice: str, rate: float) -> dict[str, object]:
        import numpy as np

        generation, stop_event, pause_event = self._new_generation()
        started = time.monotonic()
        player: subprocess.Popen[bytes] | None = None
        try:
            with self.synthesis_lock:
                if stop_event.is_set() or not self._is_current(generation):
                    return {"ok": True, "stopped": True}
                samples, sample_rate = self.kokoro.create(
                    text,
                    voice=voice or DEFAULT_VOICE,
                    speed=max(0.5, min(2.0, rate)),
                    lang=language_for_voice(voice or DEFAULT_VOICE),
                )
            if stop_event.is_set() or not self._is_current(generation):
                return {"ok": True, "stopped": True}

            audio = np.asarray(samples, dtype=np.float32)
            if audio.ndim == 1:
                channels = 1
            else:
                channels = audio.shape[1]
            player = subprocess.Popen(
                [
                    "pw-play",
                    "--raw",
                    "--rate",
                    str(sample_rate),
                    "--channels",
                    str(channels),
                    "--format",
                    "f32",
                    "-",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            with self.lock:
                if self.generation == generation:
                    self.player = player

            raw_audio = memoryview(audio.tobytes(order="C"))
            chunk_size = 65536
            assert player.stdin is not None
            for offset in range(0, len(raw_audio), chunk_size):
                if stop_event.is_set() or not self._is_current(generation):
                    break
                while pause_event.is_set() and not stop_event.is_set():
                    time.sleep(0.04)
                if stop_event.is_set() or not self._is_current(generation):
                    break
                try:
                    player.stdin.write(raw_audio[offset : offset + chunk_size])
                except BrokenPipeError:
                    break
            try:
                player.stdin.close()
            except BrokenPipeError:
                pass

            while player.poll() is None:
                if stop_event.is_set() or not self._is_current(generation):
                    player.terminate()
                    break
                time.sleep(0.02)
            return_code = player.wait(timeout=2.0)
            if return_code != 0 and not stop_event.is_set():
                detail = ""
                if player.stderr is not None:
                    detail = player.stderr.read().decode("utf-8", errors="replace").strip()
                raise RuntimeError(detail or f"pw-play exited with code {return_code}")
            return {
                "ok": True,
                "stopped": stop_event.is_set(),
                "elapsedMs": round((time.monotonic() - started) * 1000),
            }
        finally:
            if player is not None and player.poll() is None:
                player.terminate()
            with self.lock:
                if self.player is player:
                    self.player = None
                if self.generation == generation:
                    self.stop_event = None
                    self.pause_event = None


def run_server(kokoro, port: int, parent_pid: int) -> int:
    controller = PlaybackController(kokoro)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args) -> None:
            return

        def _json(self, status: int, body: dict[str, object]) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _bytes(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, {"ok": True, "ready": True})
                return
            self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/speak":
                    result = controller.speak(
                        str(payload.get("text", "")).strip(),
                        str(payload.get("voice", DEFAULT_VOICE)).strip() or DEFAULT_VOICE,
                        float(payload.get("rate", 1.0)),
                    )
                    self._json(200, result)
                    return
                if self.path == "/synthesize":
                    audio = controller.synthesize_wav(
                        str(payload.get("text", "")).strip(),
                        str(payload.get("voice", DEFAULT_VOICE)).strip() or DEFAULT_VOICE,
                        float(payload.get("rate", 1.0)),
                    )
                    self._bytes(200, "audio/wav", audio)
                    return
                if self.path in {"/pause", "/resume", "/stop"}:
                    controller.control(self.path[1:])
                    self._json(200, {"ok": True})
                    return
                self._json(404, {"ok": False, "error": "not found"})
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    def watch_parent() -> None:
        while True:
            time.sleep(1.0)
            try:
                os.kill(parent_pid, 0)
            except OSError:
                os._exit(0)

    if parent_pid > 0:
        threading.Thread(target=watch_parent, daemon=True).start()

    def shutdown(_signum, _frame) -> None:
        controller.control("stop")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"T3 Kokoro worker ready on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    server.serve_forever(poll_interval=0.25)
    server.server_close()
    return 0


def run_once(kokoro, text: str, voice: str, rate: float) -> int:
    controller = PlaybackController(kokoro)
    controller.speak(text, voice, rate)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="T3 Studio local Kokoro text-to-speech")
    parser.add_argument("--text")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--rate", type=float, default=1.0)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--server-port", type=int)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir).expanduser().resolve()
    kokoro = load_kokoro(cache_dir)
    if args.server_port is not None:
        return run_server(kokoro, args.server_port, args.parent_pid)
    if not args.text or not args.text.strip():
        parser.error("--text is required outside server mode")
    return run_once(kokoro, args.text.strip(), args.voice, args.rate)


if __name__ == "__main__":
    raise SystemExit(main())
