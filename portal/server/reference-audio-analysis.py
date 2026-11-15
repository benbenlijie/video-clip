import json
import sys
import wave

import numpy as np


def read_samples(path):
    with wave.open(path, "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    if width != 2 or channels != 1:
        raise RuntimeError("expected mono 16-bit PCM audio")
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0, rate


def analyze(samples, rate):
    frame_size = 512
    hop = 256
    if len(samples) < frame_size * 4:
        return {"bpm": None, "sfxDensity": "unknown", "onsetRate": 0, "confidence": 0}
    frame_count = 1 + (len(samples) - frame_size) // hop
    energy = np.empty(frame_count, dtype=np.float32)
    for index in range(frame_count):
        start = index * hop
        frame = samples[start:start + frame_size]
        energy[index] = float(np.sqrt(np.mean(frame * frame) + 1e-9))
    envelope = np.maximum(0.0, np.diff(energy, prepend=energy[0]))
    envelope -= np.median(envelope)
    envelope = np.maximum(0.0, envelope)
    peak_threshold = float(np.mean(envelope) + np.std(envelope))
    peak_count = int(np.count_nonzero(envelope > peak_threshold))
    duration_seconds = len(samples) / rate
    onset_rate = peak_count / max(0.001, duration_seconds) * 60
    if peak_count < 3 or not np.any(envelope > 0):
        return {"bpm": None, "sfxDensity": "low", "onsetRate": round(onset_rate, 1), "confidence": 0}
    spectrum = np.fft.rfft(envelope)
    autocorrelation = np.fft.irfft(spectrum * np.conj(spectrum), n=len(envelope) * 2)[:len(envelope)]
    frame_rate = rate / hop
    candidates = []
    for bpm in range(60, 181):
        lag = max(1, round(frame_rate * 60 / bpm))
        if lag < len(autocorrelation):
            candidates.append((float(autocorrelation[lag]), bpm))
    best_score, best_bpm = max(candidates, default=(0, None), key=lambda item: item[0])
    confidence = best_score / max(1e-9, float(autocorrelation[0]))
    bpm = best_bpm if confidence >= 0.12 else None
    if bpm is not None and bpm < 80 and bpm * 2 <= 160:
        bpm *= 2
    elif bpm is not None and bpm > 160:
        bpm = round(bpm / 2)
    if onset_rate < 30:
        density = "low"
    elif onset_rate < 100:
        density = "medium"
    else:
        density = "high"
    return {
        "bpm": bpm,
        "sfxDensity": density,
        "onsetRate": round(onset_rate, 1),
        "confidence": round(min(1.0, max(0.0, confidence)), 3),
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: reference-audio-analysis.py FILE.wav")
    samples, rate = read_samples(sys.argv[1])
    print(json.dumps(analyze(samples, rate), ensure_ascii=False))


if __name__ == "__main__":
    main()
