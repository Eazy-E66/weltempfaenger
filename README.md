# Weltempfänger

**A desktop shortwave receiver that happens to stream internet radio.** Open the register, cut a band of stations onto the dial, then tune across them like it's 1977.

![The receiver, on air](docs/media/listening.png)

Open the register and every station is a row you can sort, filter and audition; hovering one shows where it transmits from, and the plate's timezone strip lights the hour it is there.

![The World Station Register](docs/media/register.png)

Real Icecast/SHOUTcast streams from the [Radio Browser](https://www.radio-browser.info/) open directory — 60,000+ stations, folded across spelling variants so `trip hop`, `trip-hop` and `triphop` all find the same 46 stations. Every reading on the panel is measured: the signal meter is RMS of decoded audio, the bitrate comes from the codec's own frames, and nothing on the glass claims playback the audio engine didn't report.

## Download

Grab a build from [**Releases**](../../releases/latest).

| | |
|---|---|
| Linux | `.AppImage` (portable) or `.deb` |
| Windows | `.exe` (portable, self-extracting) or `.zip` — unpack and run the `.exe` |
| macOS | `.zip` — unsigned, so: right-click → Open, or `xattr -dr com.apple.quarantine` |

## Hearing something

The app boots in standby and the dial starts empty, which is deliberate — a receiver with no band cut has nothing to tune. Six steps, in order:

1. **Press the power dome** (`RADIO / STANDBY`, upper left of the black panel). This is also the user gesture that unlocks audio output; nothing can make a sound before it.
2. **Press `REGISTER`** (bottom right). The lid lifts.
3. **Pick a subject** — a genre, country or language. At least one.
4. **Throw `CUT BAND`.** The matching stations print onto the meter bands as blips and the lid shuts.
5. **Turn the tuning knob** until the cursor lands on a blip. It resolves, connects and plays.
6. **Turn up `VOLUME`.**

Hold `C` / `B` / `P` for a second to store a station; a short press recalls it. `RECONNECT` is on the panel rather than buried in a menu, because streams drop.

You need an internet connection — the directory is fetched live and there is no bundled station list.

## Build

```bash
npm install
npm run build
npm start
```

Package it yourself:

```bash
npm run pack:linux   # AppImage + deb
npm run pack:win     # portable .exe + zip — builds on Linux, no wine needed
npm run pack:mac     # unsigned .app zips, x64 + arm64
```

Node 20 or newer (CI builds on 22).

`pack:win` runs natively on Linux: electron-builder fetches its own Linux `makensis`, and the one step that genuinely needs wine — `rcedit`, which stamps the icon into the inner `.exe` — is disabled here and re-enabled on the Windows runner. The portable `.exe`'s own header is 32-bit; that is the NSIS launcher stub by design, and the application inside it is 64-bit.

`pack:mac` does not use electron-builder, which cannot build a macOS bundle off macOS. [`tools/pack-mac.mjs`](tools/pack-mac.mjs) assembles the `.app` by hand from the official Electron release and emits a `.zip`, never a `.dmg` — a DMG needs `hdiutil`, which is macOS-only.

## Platform status

Honest about what's actually been demonstrated, not what should work:

| | Built | Launched | Playback tested |
|---|---|---|---|
| Linux x64 | yes | yes | yes |
| Windows x64 | yes | not yet | no |
| macOS x64 + arm64 | yes | not yet | no |

- **Built** — an artifact of the right shape exists: PE32+ header on the app executable, Mach-O per architecture, an `Info.plist` that parses, framework symlinks intact through the zip, and an `app.asar` with no `src/`, `test/` or `docs/` in it. No code ran. Windows and macOS are cross-built from Linux.
- **Launched** — the packaged binary was executed on that OS, the renderer loaded and published a real `PlaybackState`, and a screenshot came back with pixels in it. [`tools/smoke.mjs`](tools/smoke.mjs) does this. On Linux it passes 32/32 against the packaged binary.
- **Playback tested** — audio was decoded and *heard*. [`tools/verify-audible.mjs`](tools/verify-audible.mjs) captures the system sink with `pw-record` and measures the PCM the OS actually played; the engine's own analyser can prove samples were produced, not that they left the process. On Linux, driven against the **packaged** binary, the engine reached `playing` in ~2s and the sink read peak 1.0 (0 dBFS), RMS 0.302, 99.9% of samples non-silent over six seconds.

Two caveats, both load-bearing:

**CI has not run yet.** [`.github/workflows/build.yml`](.github/workflows/build.yml) packages and smoke-tests all three platforms, but no run exists on this repo. Until one does, "Launched" for Windows and macOS is a *design*, not an observation — which is why the table says *not yet* rather than *CI only*. The first push settles it.

**CI can never fill the playback column.** GitHub-hosted runners have no audio device, so an `<audio>` element there can report that it is playing while not one sample reaches a speaker. Playback on Windows and macOS stays unproven until somebody with that hardware checks. An issue saying it worked — or that it broke — is genuinely useful.

## Typography

The panel's silkscreen is bundled, not requested, and that is a bug fix. `--font-silk` used to name only fonts that might be installed (`Liberation Sans Narrow`, `Arial Narrow`, …). Linux usually has one; macOS has none of them, so the stack fell through to a non-condensed face and every tracked all-caps label set **19% wider** — measured, with labels clipping and reflowing. 97% of this app's text is 6.5–9.5px tracked caps in fixed-width plates.

Archivo Narrow was picked by measurement: it is metrically indistinguishable from Liberation Sans Narrow, which the layout was tuned against (A–Z advance at 100px: 1444.14 vs 1444.31). Two weights, subset to Latin-1 plus the Latin Extended letters European station names need, ~20 kB each. Codepoints outside that set are left deliberately *unmapped*, so Cyrillic, Greek and CJK station names fall through to a system font rather than rendering as boxes.

Regenerate with `node tools/make-font.mjs`; prove it with `node tools/verify-font.mjs`, which renders the real panel under a restricted `fontconfig` with no condensed font installed.

## Licence

MIT. Bundled font is [Archivo Narrow](https://github.com/Omnibus-Type/ArchivoNarrow) by Omnibus-Type, [SIL Open Font License 1.1](src/renderer/assets/fonts/OFL.txt).
