# Evolv Stage 6 - Local Hearing Intelligence

## Delivered scope

Stage 6 replaces the previous single-pass, immediately-send transcription path with an evidence-based local hearing pipeline. It remains push-to-talk only: the microphone is active only while the user holds the chat microphone button. No wake word or background-listening bridge is exposed to the sandboxed renderer.

## Audio preparation

Before Whisper.cpp runs, Evolv validates the WAV container and requires mono 16-bit PCM audio. It then measures and records:

- original and processed duration;
- RMS level and peak;
- clipping ratio;
- estimated noise floor and signal-to-noise ratio;
- detected speech ratio;
- applied gain;
- good, fair, or poor quality plus concrete issues.

Leading and trailing silence are trimmed with speech padding. Quiet speech is raised with bounded gain while protecting against clipping. Silence and recordings too short to contain clear speech are rejected before Whisper runs, reducing blank-audio hallucinations.

These are signal measurements and heuristics, not a claim that Evolv knows the true transcript.

## Two-pass local decoding

Enhanced mode runs the same local Whisper model twice with different bounded decoding settings. Evolv compares the word sequences and calculates edit-distance agreement. When both passes agree and the audio is good, the result may send normally. When the passes disagree, the selected candidate and alternative are shown and the draft is held for review.

The displayed confidence is explicitly labeled `audio-quality-and-pass-agreement`. It is not a calibrated Whisper probability. A low-confidence transcript is never silently presented as certain.

Fast mode remains available for a single lower-latency pass. The user can also choose **Always let me review first**, which prevents every voice transcript from sending automatically.

## Context-aware recognition

Whisper's local initial prompt receives a bounded vocabulary containing common Evolv engineering names plus:

- up to 30 user-entered personal vocabulary terms;
- up to four short recent local conversation phrases.

The values are sanitized and length-limited. They remain inside the Electron/Whisper process and are never sent to Ollama or a cloud provider as part of transcription. Context only helps rank transcript candidates; a disagreement still triggers review instead of silently replacing the user's words.

## Model choices

The bundled `ggml-base.en.bin` model remains the balanced default. The settings screen can now select another `ggml-*.bin` file. When a Whisper folder contains multiple models, Evolv prefers the higher-accuracy English tier. The fixed download button opens the [whisper.cpp GGML model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/main).

Suggested upgrades are `ggml-small.en.bin` or `ggml-medium.en.bin`. Larger models generally require more memory and transcription time. Evolv reports the selected model and its fast, balanced, improved, high, or maximum tier without claiming a guaranteed accuracy percentage.

## User experience

The Local Desktop Voice settings now include:

- Enhanced two-pass or Fast one-pass transcription;
- review-uncertain or always-review behavior;
- personal vocabulary;
- Whisper folder selection;
- direct Whisper model selection;
- a verified model-download destination;
- detailed audio, pass-agreement, confidence, alternative, and review diagnostics.

If a result is uncertain, it stays in the message box for editing and nothing is submitted. TTS remains local Piper-first with the existing device-voice fallback.

## Verification

All 173 automated tests pass. New tests cover model ranking and explicit selection, WAV validation, silence rejection, trimming, bounded gain, quality metrics, bounded prompt context, word-sequence agreement, contextual candidate ranking, uncertainty review, IPC boundaries, and the visible settings controls.

Two real Piper-to-Whisper tests were run with the bundled `base.en` model:

- Expected `Build a profitable software product.` — exact result.
- Expected `Evolv, check the SQLite API in my Obsidian project.` — correct words, with the comma omitted.

The packaged Stage 6 executable then passed a stricter smoke test requiring the exact normalized first phrase, two passes, 100% pass agreement, 0.96 heuristic confidence, no review flag, good audio quality, working microphone permission, Whisper, Piper, Electron, and native SQLite.

## Honest limitations

- Real microphones, room noise, accents, names, and speaking styles can produce different results from synthesized test speech.
- The confidence number measures local evidence and decoder agreement, not objective truth.
- The bundled English model is not multilingual.
- Stage 6 does not add speaker identification, diarization, wake words, background listening, or cloud transcription.
- The Windows build remains unsigned and may trigger SmartScreen.

