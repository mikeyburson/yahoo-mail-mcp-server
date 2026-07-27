# Recording transcription

Turns an audio recording into a timestamped draft transcript, for intake of
call/voice-memo evidence.

Everything runs locally on CPU. The only network access is a one-time model
download from GitHub, which makes this usable in sandboxes where the usual
HuggingFace and OpenAI model endpoints are blocked.

## Setup

```bash
pip install sherpa-onnx numpy
pip install imageio-ffmpeg   # skip if ffmpeg is already on PATH
```

## Use

```bash
python3 transcribe.py "Parents Phone Call 4.6.26 4-30 PM.m4a" --out-dir ./out
```

Writes two files next to each other:

- `<name>.transcript.md` — timestamped, human-readable, with a draft-quality
  warning and the source hash in the header
- `<name>.segments.json` — per-segment start/end/text, for programmatic use

## Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--model` | `base.en` | `tiny.en`, `base.en`, `small.en`, `medium.en` — larger is slower and more accurate |
| `--threads` | `4` | CPU threads for decoding |
| `--out-dir` | cwd | Output directory |

Models cache in `~/.cache/case-transcribe/`, so the download happens once.
`base.en` is ~200 MB.

Rough throughput with `base.en` on 4 threads is 3–4× realtime, so a 30-minute
call takes about 8–10 minutes. Step up to `small.en` for noisy phone audio
where accuracy matters more than turnaround.

## Accuracy expectations

This is a **draft**. Whisper `base.en` on phone-call audio will drop names,
mishear numbers, and merge overlapping speakers, and it does not do speaker
diarization — there are no "who said what" labels. Verify every quotation
against the source audio before it goes anywhere that matters.

For anything intended as an exhibit, a certified human transcription is the
one that holds up. Use this to triage quickly and to find the timestamps worth
listening to.

## Chunking

Whisper's encoder takes a fixed 30-second window, so longer audio has to be
split. Rather than cutting on a fixed grid and losing whatever word straddles
the boundary, each cut slides within ±3 s to land on the quietest 50 ms in that
window. Boundaries land in pauses, which is usually between words.

## Downstream

The transcript is the input to the intake and legal-evaluation steps, which run
as separate agents against the generated `.transcript.md`.
