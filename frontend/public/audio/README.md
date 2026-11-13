# TetLive local demo audio

Music and effects are original procedural assets for this project. They use no
downloaded samples or borrowed melody and work offline when served by the demo.
All WAVs are 16-bit PCM at 32 kHz. The music is stereo; effects are mono.

- `office-loop.wav`: exactly 24 seconds, eight bars at 80 BPM, original D major
  pentatonic mallets, gentle bass/pads and quiet office-like taps. Circular room
  reflections retain the tails at the loop seam. Peak 0.205 and RMS 0.041 before
  the music volume control.
- `join.wav` (0.65 s): a welcoming two-note wooden chime.
- `work.wav` (0.24 s): three soft keyboard-like taps.
- `coffee.wav` (0.85 s): filtered pouring noise and a small cup clink.
- `salary.wav` (0.8 s): a short rising coin chime.
- `bonus.wav` (1.65 s): a warm reward arpeggio.
- `month.wav` (1.3 s): a short new-month melody.
- `boss.wav` (0.85 s): two restrained attention chimes.
- `click.wav` (0.12 s): a light UI tap.
- `audio-manifest.json`: file durations, levels, SHA-256 hashes, voice texts and
  actual recorded-voice availability. The module does not infer recordings from
  filenames or display a recording as available until it has decoded it.

## Voice availability

Four actual Vietnamese speech clips are bundled, generated on 2026-11-12 from
the original project lines using `gTTS` 2.5.4 with `lang="vi"`:

- `voice-welcome.mp3`: 3.912 s, 31,296 bytes.
- `voice-boss.mp3`: 4.152 s, 33,216 bytes.
- `voice-month.mp3`: 4.056 s, 32,448 bytes.
- `voice-bonus.mp3`: 3.960 s, 31,680 bytes.

All four manifest entries are `recorded`, with their actual provider, version,
duration and SHA-256 hash. These files play locally and need no speech service
or installed browser voice at runtime. The generator retains their Google
provider metadata on subsequent offline runs. Earlier `edge-tts` 7.3.1 attempts
returned `NoAudioReceived`, including a separate Nam Minh voice probe; gTTS was
the successful alternative.

If a local clip is missing or cannot decode, the module uses `speechSynthesis`
only if a Vietnamese voice is actually present in `getVoices()`.
It prefers a local `vi-VN` voice, then another local Vietnamese
voice, then an available Vietnamese network voice. It listens for `voiceschanged`
and reports `voiceAvailable`, `voiceMode`, `missingVoices`,
`speechRequiresNetwork` and `error`. It does not fall back to an English voice.
If there is no Vietnamese browser voice, music and effects still work; the UI
can display `status.label` to explain the missing speech. Network browser voices
are not guaranteed to work offline. For browser speech, a nonzero voice-slider
change applies to subsequent lines; setting it to zero cancels speech immediately.

## Integration

Import `AudioManager` from `frontend/src/audio.ts`. It has no npm dependencies.

```ts
import { AudioManager } from './audio';

const audio = new AudioManager((status) => {
  audioLabel.textContent = status.label;
});

enableButton.addEventListener('click', () => {
  // Invoke directly in the gesture: do not await other work first.
  void audio.enable().then(() => audio.say('welcome'));
});

audio.setVolume('music', 0.35); // Each channel accepts 0..1, not 0..100.
audio.setVolume('effects', 0.62);
audio.setVolume('voice', 0.9);
audio.setRunning(gameRunning);
audio.play('work');
audio.say('boss');
audio.setMuted(true);
// Call audio.dispose() when the scene/application is destroyed.
```

Construction, restored volume preferences, and calls to setters/cues before
`enable()` never start audio. A fresh page always requires explicit activation;
the enabled state is never persisted. `enable()` resolves safely even if the
browser rejects audio or local files fail; inspect `audio.status` or `onStatus`
instead of assuming every asset loaded. Missing assets can be retried by calling
`enable()` again from the audio button.

`setRunning(false)` pauses only the music bed and preserves its position; voice
and cue previews remain usable while the simulation is paused. Music defaults
to running after activation. Muting immediately stops music, effects and speech,
and clears pending voices. Unmuting cannot activate an unenabled manager.

Voice playback is serial, deduplicated and limited to three lines total including
the active line. Recent events replace the oldest pending line when full.
Music ducks to 22% of its configured level during speech, then smoothly returns.
Effects have individual cooldowns and a global limit of six simultaneous sources
to keep large player batches quiet. Only channel volumes are saved to
`localStorage` under `tetlive.audio.volumes.v1`; corrupt/blocked storage is safe.
`dispose()` stops playback, cancels this manager's speech and fetches, removes its
voice listener, closes its AudioContext and prevents later activation.

## Reproduction

From the repository root in PowerShell:

```powershell
.\.venv\Scripts\python.exe scripts\generate_audio.py
```

This recreates the WAVs and manifest using only Python's standard library, with
fixed noise seeds. It does not use the network and keeps any valid existing MP3s.

To reproduce the bundled recorded speech, use the project's existing virtual
environment and the successful Google Translate speech path:

```powershell
.\.venv\Scripts\python.exe -m pip install gTTS==2.5.4
.\.venv\Scripts\python.exe scripts\generate_audio.py --voices --voice-provider gtts
```

The integration follows the primary [gTTS module documentation](https://gtts.readthedocs.io/en/latest/module.html)
for `gTTS`, `lang`, request `timeout` and saving MP3s. Requests run sequentially
with 5-second connect and 12-second read timeouts per request. The gTTS library
is [MIT licensed](https://github.com/pndurette/gTTS). No library source is vendored.
It uses Google Translate speech rather than the paid Google Cloud API and
requires no account credentials.

The original Edge alternative remains available:

```powershell
.\.venv\Scripts\python.exe -m pip install edge-tts==7.3.1
.\.venv\Scripts\python.exe scripts\generate_audio.py --voices
```

The optional speech path follows the primary
[edge-tts documentation](https://github.com/rany2/edge-tts) and its
[Python examples](https://github.com/rany2/edge-tts/tree/master/examples).
The library is LGPL-3.0 (with a separately licensed subtitle utility); this is
not a claim about the text-to-speech service's output license. No library source
is vendored here. Speech generation uses original project text and requires no
credentials, payments or account setup. Successful MP3s are saved locally as
`voice-welcome.mp3`, `voice-boss.mp3`, `voice-month.mp3`, `voice-bonus.mp3`, so the
demo needs no cloud connection to play those files later. Use `--force-voices`
to regenerate existing clips. Failures preserve any valid existing clip and
remain visible in the manifest.

## Validation completed

- Strict standalone TypeScript check passed:
  `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler frontend/src/audio.ts`.
- Edge 157 headless decoded all nine production WAVs. No audio or asset fetches
  started before explicit activation; an initial programmatic enable was refused.
- A burst of 700 work cues produced one source in its cooldown window. The
  six-source effects ceiling, clamped/persisted volumes, mute and music pause
  passed browser checks.
- Speech discovery, the three-line total bound, serial playback, ducking to
  approximately 0.077 from music volume 0.35, and cancellation passed using a
  controlled Vietnamese speech-engine fixture. This Edge installation exposed
  no real Vietnamese voice, so actual Vietnamese speech was not heard here.
- Recorded-voice queue completion was exercised using local WAV fixtures in
  test-only HTTP routes. These fixtures are not bundled or reported as recordings.
- Missing-file retry, disposal and concurrent rejected activation passed without
  page errors or unhandled promise rejections.
- Python verified WAV headers, durations, SHA-256 hashes, non-clipping peak levels,
  and the 24-second loop. The loop boundary step was
  0.000397 of full scale.
- After successful gTTS generation, Python verified all four production MP3 frame
  sequences, their original texts, provider versions, exact hashes and retained
  provider metadata on offline regeneration. All thirteen asset hashes matched.
- A bounded decode-only check in Edge passed for the four actual production MP3s:
  durations matched the manifest, each was mono and non-silent, and decoded peaks
  were 0.476-0.566. This follow-up did not repeat full browser UI QA or play sound.
