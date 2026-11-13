"""Generate original TetLive audio; only optional speech generation uses the network.

Run with the project's Python: .venv/Scripts/python scripts/generate_audio.py
Add --voices for edge-tts, or --voices --voice-provider gtts for Google speech.
"""

from __future__ import annotations

import argparse
import asyncio
from array import array
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import random
import sys
import wave


OUTPUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "audio"
SAMPLE_RATE = 32000
TAU = math.tau
VOICE_NAME = "vi-VN-HoaiMyNeural"
VOICE_LINES = {
    "welcome": "Chào mừng đến công ty cuối năm! Vào làm thôi nào.",
    "boss": "Sếp tới rồi! Cả nhà quay về bàn làm việc nha!",
    "month": "Sang tháng mới rồi! Cùng nhau chạy KPI nào!",
    "bonus": "Chốt sổ cuối năm! Cả nhà nhận thưởng Tết nào!",
    "station": "Bến xe Tết đã mở cửa! Bà con bình luận tên tỉnh thành hoặc số ghế từ 1 đến 24 để lên xe về quê ăn Tết nha!",
    "depart": "Chuyến xe Tết đã xuất bến! Chúc bà con thượng lộ bình an, về quê ăn Tết sum vầy!",
}


def frequency(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


def silence(seconds: float) -> list[float]:
    return [0.0] * round(seconds * SAMPLE_RATE)


def mix(
    target: list[float], samples: list[float], start: float, gain: float = 1.0,
    *, wrap: bool = False,
) -> None:
    offset = round(start * SAMPLE_RATE)
    for index, value in enumerate(samples):
        position = offset + index
        if wrap:
            position %= len(target)
        if 0 <= position < len(target):
            target[position] += value * gain


def mallet(midi: float, duration: float = 0.8, *, warm: bool = False) -> list[float]:
    tone = frequency(midi)
    result = []
    for index in range(round(duration * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        attack = min(1.0, t / 0.006)
        release = min(1.0, (duration - t) / 0.035)
        fundamental = math.sin(TAU * tone * t) * math.exp(-t * (4.5 if warm else 6.0))
        overtone = 0.21 * math.sin(TAU * tone * 2 * t) * math.exp(-t * 11.0)
        bell = 0.06 * math.sin(TAU * tone * 3 * t) * math.exp(-t * 18.0)
        result.append((fundamental + overtone + bell) * attack * release)
    return result


def pad(midi: float, duration: float) -> list[float]:
    tone = frequency(midi)
    result = []
    for index in range(round(duration * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        envelope = min(1.0, t / 0.22, (duration - t) / 0.6)
        result.append(math.sin(TAU * tone * t) * envelope)
    return result


def brass_horn(midi: float, duration: float) -> list[float]:
    tone = frequency(midi)
    tone_fifth = frequency(midi + 4)
    result = []
    for index in range(round(duration * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        attack = min(1.0, t / 0.012)
        release = min(1.0, (duration - t) / 0.035)
        vib = 1.0 + 0.004 * math.sin(TAU * 6.5 * t)
        f1 = tone * vib
        f2 = tone_fifth * vib
        wave_a = (
            0.55 * math.sin(TAU * f1 * t)
            + 0.30 * math.sin(TAU * f1 * 2 * t)
            + 0.15 * math.sin(TAU * f1 * 3 * t)
        )
        wave_b = (
            0.45 * math.sin(TAU * f2 * t)
            + 0.25 * math.sin(TAU * f2 * 2 * t)
            + 0.12 * math.sin(TAU * f2 * 3 * t)
        )
        result.append(0.55 * (wave_a + 0.75 * wave_b) * attack * release)
    return result


def engine_roll(duration: float, seed: int = 77) -> list[float]:
    rng = random.Random(seed)
    filtered = 0.0
    result = []
    for index in range(round(duration * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        progress = t / max(duration, 0.001)
        rpm_freq = 48.0 + 38.0 * progress
        filtered += 0.06 * (rng.uniform(-1, 1) - filtered)
        rumble = (
            0.55 * math.sin(TAU * rpm_freq * t)
            + 0.28 * math.sin(TAU * rpm_freq * 2.0 * t)
            + 0.45 * filtered
        )
        envelope = min(1.0, t / 0.12, (duration - t) / 0.35)
        result.append(rumble * envelope)
    return result


def noise(duration: float, seed: int, *, decay: float, cutoff: float = 0.3) -> list[float]:
    rng = random.Random(seed)
    filtered = 0.0
    result = []
    for index in range(round(duration * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        filtered += cutoff * (rng.uniform(-1, 1) - filtered)
        envelope = min(1.0, t / 0.003, (duration - t) / 0.02) * math.exp(-decay * t)
        result.append(filtered * envelope)
    return result


def office_music() -> list[list[float]]:
    # Eight original bars in D major pentatonic, 4/4 at 80 BPM: exactly 24 seconds.
    beat = 0.75
    dry = silence(32 * beat)
    melody = [
        [(0, 74), (1.5, 78), (2.5, 81), (3.5, 78)],
        [(0.5, 76), (1.5, 74), (3, 69)],
        [(0, 71), (1, 74), (2.5, 78), (3.5, 76)],
        [(0.5, 74), (2, 71), (3, 69)],
        [(0, 74), (1.5, 76), (2.5, 78), (3.5, 81)],
        [(0.5, 83), (1.5, 81), (3, 78)],
        [(0, 76), (1, 78), (2.5, 74), (3.5, 71)],
        [(0.5, 69), (2, 76), (3, 74)],
    ]
    roots = [50, 57, 47, 52, 50, 47, 52, 57]
    for bar, notes in enumerate(melody):
        start = bar * 4 * beat
        for event, note in notes:
            mix(dry, mallet(note, 1.05, warm=True), start + event * beat, 0.14, wrap=True)
        mix(dry, mallet(roots[bar], 2.0, warm=True), start, 0.075, wrap=True)
        mix(dry, mallet(roots[bar] + 12, 1.1, warm=True), start + 2 * beat, 0.035, wrap=True)
        for note in (roots[bar] + 12, roots[bar] + 19):
            mix(dry, pad(note, 3.15), start, 0.018, wrap=True)
        for pulse in (1, 3):
            mix(dry, noise(0.065, 200 + bar * 2 + pulse, decay=65), start + pulse * beat, 0.025, wrap=True)

    # Circular room reflections retain the tails at the loop boundary.
    channels = []
    for taps in (((0.145, 0.12), (0.305, 0.07)), ((0.181, 0.12), (0.371, 0.07))):
        channel = dry.copy()
        for delay, gain in taps:
            mix(channel, dry, delay, gain, wrap=True)
        channels.append(channel)
    return channels


def station_music() -> list[list[float]]:
    # Sixteen lively bars in G major pentatonic, 4/4 at 160 BPM (beat=0.375s): 64 beats = 24 seconds.
    beat = 0.5
    # 12 bars of 4/4 at 120 BPM = 48 beats * 0.5s = 24.0s exactly!
    dry = silence(48 * beat)
    melody = [
        [(0, 79), (0.5, 81), (1, 83), (2, 86), (3, 83)],
        [(0, 81), (1, 79), (2, 74), (3, 76)],
        [(0, 79), (1, 83), (1.5, 86), (2.5, 88), (3.5, 86)],
        [(0, 83), (1.5, 81), (2.5, 79)],
        [(0, 76), (0.5, 79), (1, 81), (2, 83), (3, 79)],
        [(0, 74), (1, 76), (2, 79), (3, 81)],
        [(0, 83), (0.5, 86), (1, 88), (2, 86), (3, 83)],
        [(0, 81), (1, 79), (2, 74), (3, 79)],
        [(0, 86), (1, 83), (1.5, 81), (2.5, 79), (3.5, 81)],
        [(0, 83), (1, 86), (2, 88), (3, 86)],
        [(0, 83), (0.5, 81), (1, 79), (2, 76), (3, 74)],
        [(0, 76), (1, 79), (2, 83), (3, 79)],
    ]
    roots = [55, 62, 52, 57, 55, 52, 60, 62, 55, 52, 60, 55]
    for bar, notes in enumerate(melody):
        start = bar * 4 * beat
        for event, note in notes:
            mix(dry, mallet(note, 0.72, warm=False), start + event * beat, 0.145, wrap=True)
        # Bouncy travel bassline on beats 0, 1.5, 2, 3
        mix(dry, mallet(roots[bar], 1.1, warm=True), start, 0.085, wrap=True)
        mix(dry, mallet(roots[bar] + 7, 0.7, warm=True), start + 1.5 * beat, 0.05, wrap=True)
        mix(dry, mallet(roots[bar] + 12, 0.9, warm=True), start + 2 * beat, 0.06, wrap=True)
        mix(dry, mallet(roots[bar] + 7, 0.7, warm=True), start + 3 * beat, 0.045, wrap=True)
        for note in (roots[bar] + 12, roots[bar] + 19):
            mix(dry, pad(note, 2.1), start, 0.016, wrap=True)
        # Upbeat train/bus shaker rhythm
        for pulse in (0.5, 1.0, 1.5, 2.5, 3.0, 3.5):
            gain = 0.028 if pulse in (1.0, 3.0) else 0.015
            mix(dry, noise(0.05, 500 + bar * 8 + int(pulse * 2), decay=80, cutoff=0.38), start + pulse * beat, gain, wrap=True)

    channels = []
    for taps in (((0.12, 0.11), (0.25, 0.06)), ((0.16, 0.11), (0.31, 0.06))):
        channel = dry.copy()
        for delay, gain in taps:
            mix(channel, dry, delay, gain, wrap=True)
        channels.append(channel)
    return channels


def effects() -> dict[str, list[list[float]]]:
    result = {}

    def add(name: str, length: float, notes: list[tuple[float, float, float]]) -> list[float]:
        clip = silence(length)
        for start, midi, gain in notes:
            mix(clip, mallet(midi, min(0.7, length - start)), start, gain)
        result[name] = [clip]
        return clip

    add("join", 0.65, [(0, 74, 0.22), (0.12, 81, 0.17)])
    work = add("work", 0.24, [])
    for index, start in enumerate((0, 0.065, 0.14)):
        mix(work, noise(0.045, 30 + index, decay=75, cutoff=0.45), start, 0.42)
        mix(work, mallet(55 + index * 2, 0.07, warm=True), start, 0.11)
    coffee = add("coffee", 0.85, [(0.57, 86, 0.12), (0.62, 81, 0.08)])
    mix(coffee, noise(0.47, 90, decay=1.3, cutoff=0.04), 0.035, 0.32)
    add("salary", 0.8, [(0, 81, 0.19), (0.11, 86, 0.17), (0.23, 90, 0.11)])
    add("bonus", 1.65, [(0, 62, 0.10), (0, 69, 0.09), (0.08, 74, 0.17),
                        (0.23, 78, 0.16), (0.39, 81, 0.16), (0.58, 86, 0.14),
                        (0.82, 81, 0.12)])
    add("month", 1.3, [(0, 74, 0.19), (0.18, 76, 0.17), (0.36, 81, 0.16),
                       (0.60, 78, 0.14)])
    add("boss", 0.85, [(0, 62, 0.19), (0, 69, 0.12), (0.27, 62, 0.17),
                      (0.27, 74, 0.13)])
    click = add("click", 0.12, [(0, 81, 0.13)])
    mix(click, noise(0.025, 16, decay=110), 0, 0.10)

    # Bus horn: cheerful warm double horn ("bíp bíp!") + chime (~0.62s)
    horn = add("horn", 0.62, [(0.30, 83, 0.14), (0.40, 86, 0.12)])
    mix(horn, brass_horn(67, 0.13), 0.0, 0.28)
    mix(horn, brass_horn(67, 0.18), 0.16, 0.32)

    # Bus departure: horn fanfare + ascending Tet chime + engine roll (~1.8s)
    depart = add("depart", 1.8, [
        (0.38, 74, 0.16), (0.52, 79, 0.16), (0.68, 83, 0.17),
        (0.86, 86, 0.18), (1.08, 91, 0.15),
    ])
    mix(depart, brass_horn(67, 0.15), 0.0, 0.28)
    mix(depart, brass_horn(71, 0.24), 0.18, 0.30)
    mix(depart, engine_roll(1.55), 0.20, 0.22)
    return result


def write_wav(filename: str, channels: list[list[float]]) -> dict:
    frames = len(channels[0])
    assert all(len(channel) == frames for channel in channels)
    peak = max(abs(value) for channel in channels for value in channel)
    # Preserve deliberate mixing levels, with a ceiling only for accidental overs.
    gain = min(1.0, 0.70 / peak) if peak else 1.0
    pcm = array("h", (
        round(max(-1.0, min(1.0, channels[channel][index] * gain)) * 32767)
        for index in range(frames) for channel in range(len(channels))
    ))
    if sys.byteorder != "little":
        pcm.byteswap()
    path = OUTPUT / filename
    with wave.open(str(path), "wb") as output:
        output.setnchannels(len(channels))
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())
    rms = math.sqrt(sum(value * value for channel in channels for value in channel) / (frames * len(channels))) * gain
    return {
        "file": filename,
        "duration": round(frames / SAMPLE_RATE, 4),
        "sampleRate": SAMPLE_RATE,
        "channels": len(channels),
        "peak": round(peak * gain, 5),
        "rms": round(rms, 5),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def mp3_duration(path: Path) -> float | None:
    """Validate an MPEG Layer III frame sequence without an external decoder."""
    if not path.exists():
        return None
    data = path.read_bytes()
    position = 0
    if data[:3] == b"ID3" and len(data) >= 10:
        position = 10 + sum((data[6 + i] & 0x7F) << (21 - 7 * i) for i in range(4))
    duration = 0.0
    frames = 0
    while position + 4 <= len(data):
        header = int.from_bytes(data[position:position + 4], "big")
        if header >> 21 != 0x7FF:
            position += 1
            continue
        version, layer = (header >> 19) & 3, (header >> 17) & 3
        bitrate_index, sample_index = (header >> 12) & 15, (header >> 10) & 3
        if version == 1 or layer != 1 or bitrate_index in (0, 15) or sample_index == 3:
            position += 1
            continue
        mpeg1 = version == 3
        rates = (44100, 48000, 32000)
        rate = rates[sample_index] // (1 if mpeg1 else 2 if version == 2 else 4)
        bitrates = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320) if mpeg1 else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
        size = (144000 if mpeg1 else 72000) * bitrates[bitrate_index] // rate + ((header >> 9) & 1)
        if position + size > len(data):
            break
        frames += 1
        duration += (1152 if mpeg1 else 576) / rate
        position += size
    return round(duration, 4) if frames >= 10 and duration > 0.3 else None


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


async def generate_voices(force: bool, provider: str = "edge") -> dict:
    try:
        if provider == "gtts":
            from gtts import gTTS
            metadata = {
                "provider": "gtts",
                "providerVersion": package_version("gTTS"),
                "voice": "Google Translate Vietnamese (vi)",
                "upstream": "https://gtts.readthedocs.io/en/latest/module.html",
            }
        else:
            import edge_tts
            metadata = {
                "provider": "edge",
                "providerVersion": package_version("edge-tts"),
                "voice": VOICE_NAME,
                "upstream": "https://github.com/rany2/edge-tts",
            }
    except ImportError:
        print(f"{provider} is unavailable; browser Vietnamese speech will be used if installed.")
        return {}
    generated = {}
    for key, text in VOICE_LINES.items():
        path = OUTPUT / f"voice-{key}.mp3"
        if mp3_duration(path) and not force:
            print(f"Keeping valid {path.name}")
            continue
        temporary = path.with_suffix(".mp3.part")
        try:
            if provider == "gtts":
                # This CLI runs sequentially; each Google request has bounded I/O.
                speaker = gTTS(text=text, lang="vi", lang_check=False, timeout=(5, 12))
                speaker.save(str(temporary))
            else:
                speaker = edge_tts.Communicate(text, VOICE_NAME, rate="-3%", volume="-8%")
                await asyncio.wait_for(speaker.save(str(temporary)), timeout=30)
            if not mp3_duration(temporary):
                raise ValueError("The service did not return a valid MP3 frame sequence")
            temporary.replace(path)
            generated[key] = metadata.copy()
            print(f"Created {path.name} via {provider}")
        except Exception as error:
            print(f"Speech unavailable for {key}: {type(error).__name__}")
        finally:
            temporary.unlink(missing_ok=True)
    return generated


def voice_manifest(generated: dict | None = None) -> dict:
    try:
        previous = json.loads((OUTPUT / "audio-manifest.json").read_text(encoding="utf-8")).get("voices", {})
    except (OSError, ValueError, AttributeError):
        previous = {}
    clips = {}
    for key, text in VOICE_LINES.items():
        path = OUTPUT / f"voice-{key}.mp3"
        duration = mp3_duration(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest() if duration else None
        metadata = (generated or {}).get(key, {})
        old = previous.get(key, {})
        # Retain the actual provider on offline regeneration, only for identical bytes.
        if duration and not metadata and old.get("sha256") == digest:
            metadata = old
        clips[key] = {
            "file": path.name if duration else None,
            "text": text,
            "status": "recorded" if duration else "unavailable",
            "voice": metadata.get("voice") if duration else None,
            "provider": metadata.get("provider") if duration else None,
            "providerVersion": metadata.get("providerVersion") if duration else None,
            "upstream": metadata.get("upstream") if duration else None,
            "duration": duration,
            "sha256": digest,
        }
    return clips


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", action="store_true", help="Generate missing Vietnamese speech (network required)")
    parser.add_argument("--voice-provider", choices=("edge", "gtts"), default="edge", help="Optional speech provider; default: edge")
    parser.add_argument("--force-voices", action="store_true", help="Regenerate all speech, including existing valid clips (implies --voices)")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    music = write_wav("office-loop.wav", office_music())
    station_music_meta = write_wav("station-loop.wav", station_music())
    sound_effects = {key: write_wav(f"{key}.wav", channels) for key, channels in effects().items()}
    generated = {}
    if args.voices or args.force_voices:
        generated = asyncio.run(generate_voices(args.force_voices, args.voice_provider))
    voices = voice_manifest(generated)
    manifest = {
        "version": 1,
        "music": music,
        "stationMusic": station_music_meta,
        "effects": sound_effects,
        "voices": voices,
        "provenance": {
            "musicAndEffects": "Original TetLive synthesis; Python standard library only; no samples or borrowed melody.",
            "composition": "D major pentatonic (office, 80 BPM) & G major pentatonic (station, 120 BPM); circular room reflections.",
            "speech": "Original Vietnamese script; optional edge-tts or Google Translate via gTTS; no runtime cloud dependency for recorded clips. Actual provider is recorded per voice.",
            "edgeTtsVersion": package_version("edge-tts"),
            "gTtsVersion": package_version("gTTS"),
            "upstream": "https://github.com/rany2/edge-tts",
            "upstreamLicense": "LGPL-3.0 (library, not a claim about service output licensing)",
            "gTtsUpstream": "https://github.com/pndurette/gTTS",
            "gTtsLibraryLicense": "MIT (library, not a claim about service output licensing)",
        },
    }
    (OUTPUT / "audio-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    recorded = sum(clip["status"] == "recorded" for clip in voices.values())
    print(f"Audio ready: {music['duration']:g}s office + {station_music_meta['duration']:g}s station music, {len(sound_effects)} effects, {recorded}/{len(VOICE_LINES)} recorded voices.")
    print(f"Output: {OUTPUT}")


if __name__ == "__main__":
    main()
