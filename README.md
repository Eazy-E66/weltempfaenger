# Weltempfänger

**A desktop shortwave receiver that happens to stream internet radio.** Switch it on and it plays. Open the register, cut a band of stations onto the dial, then tune across them like it's 1977.

![The receiver, on air](docs/media/listening.png)

Open the register and sort, filter and audition every station

![The World Station Register](docs/media/register.png)

Real Icecast/SHOUTcast streams from the [Radio Browser](https://www.radio-browser.info/) open directory — 60,000+ stations

## Download

Grab a build from [**Releases**](../../releases/latest).

| Platform | Artifact | What has been verified |
|---|---|---|
| Linux x64 | AppImage, deb | Built, launched, **playback tested** on real hardware |
| Windows x64 | portable .exe, zip | Built and launched by CI; not playback tested |
| macOS x64 / arm64 | dmg, zip (unsigned) | Built by CI only. The ad-hoc-signed bundle has not been seen to launch on a CI runner; nobody has tried it on a real Mac yet |

"Launched" means the packaged binary started, the panel painted, and the renderer talked to the main process. "Playback tested" means a human heard audio. See [docs/MAINTAINERS.md](docs/MAINTAINERS.md) for how each rung is proved.

## Exploring the waves

The app boots in standby. The first time it comes up, the dial fills itself with the directory's most-listened stations, so there is something to hear straight away.

1. **Press the power dome** (`RADIO / STANDBY`, upper left of the black panel). It switches on to the station under the pointer.
2. **Turn the tuning knob** (bottom right). When the cursor lands on a blip the station resolves, connects and plays. Between blips you hear band noise.
3. **Turn up `VOLUME`.**

To choose your own stations:

4. **Press `STATIONS`** (bottom right of the panel). The lid opens on the World Station Register.
5. **Pick a subject, an origin or a language** from the index on the left. Click a ledger row to audition it on the spot.
6. **Throw `CUT BAND`.** The scope prints onto the twelve meter bands, the lid closes, and the first station comes on. `METER BAND` steps through the bands.

Hold `C` / `B` / `P` for a second to store the station on air; a short press recalls it. `RECONNECT` re-opens the stream (and walks to the next mount when a playlist offered several). `Esc` closes the lid; `Ctrl+K` or `/` opens it on the station-name search.

This shouldn't have to be said separately, but you need an internet connection — This is an *internet* radio, after all

## Build this yourself (why would you, but you do you!)

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

Node 20 or newer (CI builds on 22). Everything a maintainer needs — the system map, how to test, how to debug against a local stand-in directory, how to release and roll back — is in [docs/MAINTAINERS.md](docs/MAINTAINERS.md).

## Licence

MIT. Bundled font is [Archivo Narrow](https://github.com/Omnibus-Type/ArchivoNarrow) by Omnibus-Type, [SIL Open Font License 1.1](src/renderer/assets/fonts/OFL.txt).
