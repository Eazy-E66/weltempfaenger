# Design Laws

These are binding. Critics judge against this document. A violation is a defect regardless of
how good it looks in a screenshot.

---

## Law 1 — No control without a job

Every control on the panel is wired to something the audio engine or the directory actually
does. A control that exists because the reference had one, but does nothing here, is
decoration and must be cut.

The reference device is evidence about *what problem the design solves and how it feels to
solve it* — it is not a parts list.

### The audit

The ICF-6800W is a machine for finding signal in a huge, badly-indexed, noisy space. Internet
radio has the same problem shape: ~50,000 stations, poor indexing, no idea what's out there.
So controls map job-to-job.

| Reference control | Job here | Verdict |
|---|---|---|
| SW BAND SELECTOR (rotary) | **genre selector**, populated from live directory tag counts | Keep → primary |
| MW/SW TUNING (large knob) | sweep stations within the current genre | Keep — core |
| TUNING meter (needle) | real signal: RMS of decoded audio + connection/buffer health | Keep, engine-driven |
| PRESELECTOR (rotary) | region / country narrowing | Keep, repurposed |
| AM RF GAIN | inter-station noise floor level | Keep, repurposed |
| VOLUME / BASS / TREBLE | GainNode + two BiquadFilters in the live audio path | Keep |
| AFC ON/OFF | stay-locked: auto-reconnect with backoff when a stream drops | Keep, repurposed |
| NARROW / WIDE | buffer depth — narrow = snappy tuning, wide = robust | Keep, repurposed |
| RADIO ON / STANDBY | actual engine start/stop | Keep |
| AM FREQUENCY DISPLAY | station / measured bitrate / codec readout | Keep |
| LIGHT | dial backlight — it is a lamp, that is honest | Keep |
| C / B / P presets *(PSP Radio)* | station memory | Keep |
| RECONNECT *(PSP Radio)* | manual re-resolve + reconnect | Keep |
| Hinged lid + world map | discovery surface: map, search, browse | Keep, made functional |
| BAND SELECTOR FM/MW/SW | none — genre already *is* the category axis | **Cut** |
| MODE USB / LSB / CW | no analog in streaming | **Cut** |
| MEMO-LITE / SCALE ADJ / TIMER | no honest job | **Cut** |

Genres are read from the directory's real tag counts. A hardcoded genre list violates this law.

---

## Law 2 — Playback state is measured, never asserted

`PlaybackState.phase` is derived from real `HTMLMediaElement` events, real byte flow through
the proxy, and real decoder output. Pressing "play" *requests* a transition; only observed
reality *reports* one.

Specifically:
- `signalLevel` is RMS from `AnalyserNode.getFloatTimeDomainData` on decoded output. A dead or
  silent stream reads zero on the meter. The needle is never animated by a timer.
- `measuredBitrateKbps` comes from bytes actually delivered, not from the directory's claim or
  the ICY header.
- `bufferedSeconds` comes from `HTMLMediaElement.buffered`.
- A label may never say "Playing" unless the decoder is producing audio.

Corollary: no fixture, mock, or demo mode may ever be reachable from the shipping UI in a way
that looks like real playback. Fixtures are for tests.

---

## Law 3 — Discovery, resolution, and playback are separate

Three concerns, three modules, meeting only through the contracts in `src/shared/contracts.ts`:

- **Discovery** answers "what stations exist?" — `DirectoryProvider`. Never touches audio.
- **Resolution** answers "what URL is actually playable?" — `StreamResolver`. Handles PLS, M3U,
  redirects, content sniffing, `ICY 200 OK`. Never touches audio.
- **Playback** answers "what is the engine doing right now?" — the engine. Never fetches a
  directory.

The directory must be swappable. No SHOUTcast proprietary directory API. Radio Browser is one
implementation of `DirectoryProvider`; the fixture provider is another; a third must be
addable without touching playback.

---

## Law 4 — Failure is a designed state, not an exception

The PSP reference puts **Reconnect** on the front panel. That is a design statement: streams
break, and recovery is a first-class control.

Every failure maps to a specific `ResolveFailure` / `PlaybackError` kind and surfaces as
something the user can read and act on. Silent failure — a dead panel, a spinner forever, a
station that just never starts — is a defect. Dead-air must be visible: the meter falls, the
readout says why, and Reconnect is right there.

Empty results, an offline network, a station that 404s, an HLS-only station Chromium can't
decode, and a stream that stalls mid-song are all designed states with designed appearances.

---

## Law 5 — One light source

One dominant light from the upper left. Every bevel, groove, dome, recess, and cast shadow
agrees with it. Inconsistent lighting is the fastest way to break the illusion, and it is the
first thing a critic should check.

Surfaces read as materials, not colours — brushed aluminium has anisotropic grain, knobs have
knurling that catches light on one side, glass has a specular streak and an inner bezel
shadow, the grille has per-hole shading.

Anti-goals: flat design, pure `#000`/`#fff`, uniform drop shadows on everything, glossy web2.0
gradients, neon glow, emoji, generic Material/Bootstrap spacing.

---

## Law 6 — Evidence, not explanation

No claim of "works" without command output, a screenshot, or a test run pasted as proof.

Platform status uses exactly three independent levels, never blurred together:

| Level | Means |
|---|---|
| **BUILT** | an artifact exists on disk |
| **LAUNCHED** | the artifact was started and a window appeared |
| **PLAYBACK TESTED** | real audio from a real stream was verified running from that artifact |

Anything not personally demonstrated is "no". "Should work" is "no". A platform counts as
verified only to the degree actually demonstrated.
