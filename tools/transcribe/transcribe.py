#!/usr/bin/env python3
"""Transcribe an audio recording to a timestamped text transcript.

Built for case-evidence intake: takes any audio file (m4a, mp3, wav, ...),
produces a timestamped transcript plus a JSON sidecar with per-segment detail
and a SHA-256 of the source audio for chain-of-custody purposes.

Runs fully offline once the model is cached. Uses Whisper base.en via
sherpa-onnx (ONNX runtime, CPU) so it works in restricted environments where
the usual PyTorch/HuggingFace download paths are unavailable.

Usage:
    python3 transcribe.py RECORDING.m4a
    python3 transcribe.py RECORDING.m4a --out-dir ./out --model small.en

First run downloads the model (~200 MB for base.en) to ~/.cache/case-transcribe.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000

# Whisper's encoder takes a fixed 30s window, so audio must be chunked below
# that. 25s leaves headroom and keeps decode latency reasonable.
CHUNK_SECONDS = 25.0
# How far from the ideal boundary we may slide to land the cut in a silence.
BOUNDARY_SEARCH_SECONDS = 3.0

MODEL_RELEASE = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-whisper-{name}.tar.bz2"
)
CACHE_DIR = Path.home() / ".cache" / "case-transcribe"


def ffmpeg_exe() -> str:
    """Locate ffmpeg, preferring a system install, falling back to the pip wheel."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
    except ImportError:
        sys.exit(
            "ffmpeg not found. Install it, or: pip install imageio-ffmpeg"
        )
    return imageio_ffmpeg.get_ffmpeg_exe()


def ensure_model(name: str) -> Path:
    """Return the local model directory, downloading and extracting if needed."""
    target = CACHE_DIR / f"sherpa-onnx-whisper-{name}"
    if target.is_dir():
        return target

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    url = MODEL_RELEASE.format(name=name)
    archive = CACHE_DIR / f"sherpa-onnx-whisper-{name}.tar.bz2"
    print(f"Downloading {name} model (one time)...", file=sys.stderr)
    urllib.request.urlretrieve(url, archive)
    with tarfile.open(archive, "r:bz2") as tar:
        tar.extractall(CACHE_DIR)
    archive.unlink()
    if not target.is_dir():
        sys.exit(f"Model extraction did not produce {target}")
    return target


def decode_to_wav(src: Path, dest: Path) -> None:
    """Convert any ffmpeg-readable audio to 16 kHz mono 16-bit PCM."""
    subprocess.run(
        [
            ffmpeg_exe(), "-nostdin", "-loglevel", "error", "-y",
            "-i", str(src),
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le",
            str(dest),
        ],
        check=True,
    )


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as handle:
        if handle.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM")
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def find_boundaries(samples: np.ndarray) -> list[tuple[int, int]]:
    """Split audio into <=CHUNK_SECONDS spans, cutting at the quietest nearby point.

    Cutting mid-word costs us the word, so each boundary slides within a search
    window to wherever the audio is quietest.
    """
    chunk = int(CHUNK_SECONDS * SAMPLE_RATE)
    search = int(BOUNDARY_SEARCH_SECONDS * SAMPLE_RATE)
    window = int(0.05 * SAMPLE_RATE)  # 50 ms energy window

    spans: list[tuple[int, int]] = []
    start = 0
    total = len(samples)
    while start < total:
        ideal = start + chunk
        if ideal >= total:
            spans.append((start, total))
            break

        lo = max(start + chunk // 2, ideal - search)
        hi = min(total, ideal + search)
        region = samples[lo:hi]
        if len(region) < window:
            cut = ideal
        else:
            trimmed = len(region) - (len(region) % window)
            energy = np.abs(region[:trimmed]).reshape(-1, window).mean(axis=1)
            cut = lo + int(np.argmin(energy)) * window

        spans.append((start, cut))
        start = cut
    return spans


def timestamp(seconds: float) -> str:
    return str(dt.timedelta(seconds=int(seconds)))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_recognizer(model_dir: Path, threads: int):
    import sherpa_onnx

    stem = model_dir.name.replace("sherpa-onnx-whisper-", "")
    return sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(model_dir / f"{stem}-encoder.int8.onnx"),
        decoder=str(model_dir / f"{stem}-decoder.int8.onnx"),
        tokens=str(model_dir / f"{stem}-tokens.txt"),
        num_threads=threads,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="source recording")
    parser.add_argument("--out-dir", type=Path, default=Path.cwd())
    parser.add_argument(
        "--model",
        default="base.en",
        help="tiny.en | base.en | small.en | medium.en (larger = slower, better)",
    )
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    if not args.audio.is_file():
        sys.exit(f"No such file: {args.audio}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(args.audio)
    model_dir = ensure_model(args.model)

    wav_path = args.out_dir / f"{args.audio.stem}.16k.wav"
    decode_to_wav(args.audio, wav_path)
    samples = read_wav(wav_path)
    duration = len(samples) / SAMPLE_RATE
    print(f"{args.audio.name}: {timestamp(duration)} of audio", file=sys.stderr)

    recognizer = build_recognizer(model_dir, args.threads)
    spans = find_boundaries(samples)

    segments = []
    for index, (start, end) in enumerate(spans, 1):
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples[start:end])
        recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        segments.append(
            {
                "start": start / SAMPLE_RATE,
                "end": end / SAMPLE_RATE,
                "text": text,
            }
        )
        print(f"  [{index}/{len(spans)}] {timestamp(start / SAMPLE_RATE)}", file=sys.stderr)

    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    lines = [
        f"# Transcript — {args.audio.name}",
        "",
        "> DRAFT — machine transcription, not certified. Verify against the",
        "> source audio before relying on any quotation.",
        "",
        f"- Source file: `{args.audio.name}`",
        f"- Duration: {timestamp(duration)}",
        f"- SHA-256 (source): `{source_hash}`",
        f"- Model: Whisper {args.model} (sherpa-onnx)",
        f"- Transcribed: {stamp}",
        "",
        "---",
        "",
    ]
    for segment in segments:
        if segment["text"]:
            lines.append(f"**[{timestamp(segment['start'])}]** {segment['text']}")
            lines.append("")

    transcript_path = args.out_dir / f"{args.audio.stem}.transcript.md"
    transcript_path.write_text("\n".join(lines), encoding="utf-8")

    json_path = args.out_dir / f"{args.audio.stem}.segments.json"
    json_path.write_text(
        json.dumps(
            {
                "source": args.audio.name,
                "sha256": source_hash,
                "duration_seconds": duration,
                "model": args.model,
                "transcribed_utc": stamp,
                "segments": segments,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    wav_path.unlink(missing_ok=True)
    print(f"\nTranscript: {transcript_path}\nSegments:   {json_path}")


if __name__ == "__main__":
    main()
