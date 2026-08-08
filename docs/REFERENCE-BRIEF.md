# Reference Brief

Four reference images drive this product. Builders cannot see them; this brief is the
substitute. Read it fully before writing any visual code.

The two reference sets do different jobs:

- **PSP Radio** defines *interaction character, information hierarchy, and tuning feel*.
- **Sony ICF-6800W** defines *physical design, materials, controls, density, proportions,
  tactility*.

The finished app should feel like a real Weltempfänger that happens to stream internet radio.

---

## 1. PSP Radio (photo of a PSP screen, slight moiré, shot at an angle)

Vertical stack, top to bottom:

1. **Top-right corner:** "Powered by *SHOUTcast* Radio" in small type, gold/amber italic
   wordmark. *We do not reproduce this — we don't use the SHOUTcast directory. It tells us
   only that a provenance line lives up there in small type.*
2. **Now-playing line:** `♫ Energy Voice - Discolights(MDR Extended Party Mix)` — centered,
   dark text on a very light silver-blue panel, preceded by an eighth-note glyph. This is
   ICY `StreamTitle` metadata. It is the single most prominent piece of text on screen.
3. **Station line, smaller, below it:** `Radio Italo4you (256kbps/44.1kHz)` — station name
   plus a parenthesised technical readout. Bitrate and sample rate are shown as a matter of
   course. Ours must be *measured*, not claimed.
4. **Wood-grain band:** a warm reddish-brown horizontal strip, like a veneered radio cabinet
   face, spanning the full width behind the indicator cluster.
5. **Three round indicator lamps** on a light rounded-rect plaque floating on the wood, each
   labelled above with a single letter: **C**, **B**, **P**. Each lamp is a domed glass jewel
   in a knurled chrome bezel — top-lit, with a bright specular arc across the upper third and
   a dark pooled lower half. Colours left→right: pale cream/white, warm amber/gold, deep red.
   These are the preset slots.
6. **The tuning strip** — the strongest element. A long horizontal scale running edge to edge:
   - A row of small **amber/gold rectangular blips** along the upper portion, irregularly
     spaced — these are stations.
   - Below them, dense **vertical tick marks** of alternating heights (tall major, short
     minor), like a printed frequency scale, in dark grey on silver.
   - A **glass slider/cursor** rides the strip: a translucent pale-blue rounded rectangle
     with visible vertical edge rails and a hairline centre mark, casting a subtle shadow.
     It is clearly a physical part sliding on a track.
7. **Bottom control row:** `Other Stations` label left, then a `◀` button, a wide
   `Reconnect` button, a `▶` button, then `Other Stations` right. Buttons are light grey
   bevelled rounded rects with thin dark borders and soft top-light — classic late-90s
   skeuomorphic buttons, not flat.

**Character to carry over:** dense but calm; information stacked in strict hierarchy with
the human-meaningful text (song) on top and the technical readout subordinate; the tuning
strip as the emotional centre; an explicit *Reconnect* affordance, i.e. the design assumes
streams drop and makes recovery a first-class control.

---

## 2. Sony ICF-6800W — front view (the primary material reference)

A wide, heavy, flat desktop receiver. Roughly **2.6:1** width to height. Two-material body:

- **Outer shell:** warm mid-grey **brushed aluminium** with a fine horizontal grain, slightly
  warm/champagne cast, visible wear. Softly rounded corners. Matte, not chrome.
- **Central control panel:** a large inset **matte black** rectangle occupying the right ~72%
  of the face, sitting slightly proud with a crisp edge shadow. All labelling is silkscreened
  on this in small white sans-serif caps, with occasional **teal/cyan** accent marks.

Left ~28% of the face is the **speaker grille**: hundreds of small round perforations in a
precise offset (hex-packed) grid, dark holes in the aluminium, each with a subtle inner
shadow at top and faint lower highlight so the sheet reads as physically punched. `SONY`
wordmark top-left in white. Below the grille, small text: `FM/AM MULTI BAND RECEIVER
ICF-6800W`.

### Control inventory and placement (front face, left→right)

**Far left, below the grille — the tone row:**
- `HEADPHONES` 6.3 mm jack (dark recessed circle with chrome ring).
- Three identical small knobs, labelled `BASS`, `TREBLE`, `VOLUME`, each with a scale from
  a small mark to `MAX`. Knobs are black cylinders with fine vertical knurling, a **polished
  chrome band around the upper edge**, a flat top with a white indicator line, and a soft
  drop shadow. Scale numerals 0–8 arc around each.

**Left of the black panel, top:**
- `RADIO` label over a large round **red translucent power button** — glossy, domed, lit from
  above, `ON` above it and `STANDBY` below, joined by a thin bracket line.
- `LIGHT / BATT` in teal, a small **amber/yellow round lamp**, and `AM FREQUENCY DISPLAY
  ON/OFF` with a small black push button.

**Top centre-left — the analog meter (a defining element):**
- A **round-cornered rectangular meter window** with a cream/ivory dial face behind glass.
- Printed scale arc numbered `1 2 3 4 5 6 7 8 9 0`, with `TUNING` above it and a coloured
  arc segment (red at one end, blue/green mid) beneath.
- A slim black **needle** pivoting from bottom centre.
- `SONY` and `BATT INDICATOR` printed small on the face.
- The glass has a faint top-left specular sheen and the bezel casts an inner shadow.

**Top centre — band selection:**
- `BAND SELECTOR` title with a white underline rule, and three **rectangular slide/piano
  switches** labelled `FM`, `MW`, `SW`, each a small light-grey tab in a dark slot with a
  teal dot marking the engaged state.

**Top right cluster:**
- `MODE` with `USB`/`LSB/CW` teal-marked positions over a knurled black knob.
- `NARROW` / `WIDE` selector to its left.
- `SW BAND SELECTOR` — a **rotary knob with a numbered dial 0–9 / MHz**, numerals printed in
  an arc around it, with a polished chrome centre cap. Labelled `SHORT WAVE BAND` beneath.
- `AM RF GAIN` — knob with `MIN`/`MAX` arc scale, teal tick.
- `PRESELECTOR` — knob below it, same family.

**Centre — the FM dial (small window):**
- A horizontal window showing a white scale with numerals `108 104 100 96` and `MHz`, fine
  ticks, a **red vertical pointer line**, on a pale backlit ground.
- `FM` in teal with a small red LED above.
- `AFC` `ON`/`OFF` toggle to the left — a small black lever switch.
- Below the window, a **large black tuning knob** with chrome centre cap for FM.

**Right centre — the kHz / SW window:**
- A narrow horizontal glass window with a printed linear scale `16 1 2 3 5 10 20 30 MHz`
  and `kHz`, in a chrome-edged recess.

**Bottom right — the main event, the MW/SW tuning dial:**
- A **large rectangular glass window** revealing a **curved (drum) dial scale** — the scale
  is printed on a rotating cylinder so it reads as an arc: numerals `1000 900 800 700` on
  the lower arc and `400 350 300 250 200 150 100` on the upper, with `kHz` at the right.
- The drum is warm silver/champagne, backlit, with dense tick marks; the glass shows
  reflections and the recess casts a strong shadow.
- Labelled `MW/SW TUNING DIAL` at the upper right.
- To its right, the **largest control on the radio**: a big black knurled **tuning knob**
  with a wide **polished chrome centre disc**, heavily finger-grooved. It reads heavy and
  weighted — a flywheel.
- `SCALE ADJ` small slider beneath the window; `MEMO-LITE` label bottom centre.

**Bottom edge, silkscreened in dark red/maroon:**
`SHORT WAVE SYNTHESIZED DUAL CONVERSION RECEIVER   ICF-6800W`

**Bottom left:** small jacks labelled `EARPHONE`, `REC OUT`, `TIMER` with pictogram glyphs.

**Feet:** four black rubber feet visible at the bottom corners, slightly proud.

---

## 3. Sony ICF-6800W — three-quarter / top view

Shows the **hinged top lid**, which is the device's most memorable feature:

- The lid is matte near-black plastic, filling almost the whole top surface.
- Printed on it: a **GMT world map** in **cyan/teal line-art** on black — continents as thin
  outlines, a **latitude/longitude graticule**, and major cities labelled in tiny type
  (`SAN FRANCISCO`, `LOS ANGELES`, `HONOLULU`, `TOKYO`, `NEW YORK`, `BUENOS AIRES`,
  `SANTIAGO DE CHILE`, `JOHANNESBURG`, `MOSCOW`, `LONDON`…).
- A **timezone strip runs along the top and bottom edges**: boxed numerals
  `-11 -10 -9 … -1 GMT +1 … +11 +12`, white on black.
- Above the map, a **frequency/meter-band reference chart**: a grid of small boxed numbers
  with band labels `120m 90m 75m 60m 49m 41m 31m 25m 19m 16m 13m 11m` and the range
  `FREQUENCY 1.8–30 MHz`.
- `SONY` and `FM/AM MULTI BAND RECEIVER` printed top-left on the lid.
- Two small **latch tabs** at the top corners, and a **telescopic antenna** lying in a
  channel along the lid's top edge, with a `LITHIUM-ION` sticker.
- Chunky **fold-out carry handles / brackets** on both sides of the case.

**In our app the lid opens** (animated hinge) to reveal the world map with live station
markers, the timezone strip, and the search / browse interface.

---

## 4. Third-party "vintage receiver" render (mood only — treat with caution)

A dark, dramatic studio render of a black receiver: glowing amber/green oscilloscope-style
traces behind glass, red and white illuminated square buttons, five knurled knobs in a row,
heavy vignetting and strong specular rim light.

**Use only for:** the *lighting* mood — dark surround, warm internal glow, strong speculars
on metal, shallow depth of field feel.

**Do not copy:** its layout, its fake/garbled labelling, or its neon look. The ICF-6800W is
the authority for structure and materials; this image only says "light it dramatically."

---

## Material and rendering targets

Every surface must read as a material, not a colour:

| Surface | Must show |
|---|---|
| Brushed aluminium shell | fine horizontal grain, anisotropic sheen, warm grey, edge highlights, wear |
| Matte black panel | slight surface noise, low-sheen, crisp inset shadow at its border |
| Knurled knobs | vertical grooves that catch light on one side, chrome band/cap with a sharp specular arc, contact shadow |
| Dial glass | top-left sheen streak, subtle inner shadow from the bezel, faint tint |
| Backlit scales | warm lamp glow falling off from the lamp position, not a flat tint |
| Speaker grille | hex-packed holes with per-hole inner shadow and lower rim highlight |
| Indicator jewels | domed glass, bright upper specular, colour pooling in the lower half, glow halo when lit |
| Silkscreen text | slightly soft edges, never pure white — off-white/teal, tiny sizes, wide tracking |
| Meter needle | thin, dark, with a soft shadow on the dial face beneath it |

**Typography:** condensed/technical sans for silkscreen labels, all-caps, wide letter-spacing,
very small sizes. Numerals on dial scales should feel printed, not UI-rendered.

**Lighting model:** one dominant light from the upper left. Every bevel, groove, dome and
recess must agree on that direction. Inconsistent light direction is the fastest way to break
the illusion.

**Anti-goals:** flat design, pure `#000`/`#fff`, uniform drop shadows on everything, glossy
"web 2.0" gradients, neon glows, emoji, rounded-everything, generic Material/Bootstrap
spacing, or any control that doesn't do a real job.
