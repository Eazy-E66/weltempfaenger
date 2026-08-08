/**
 * Where the material generators meet the panel.
 *
 * `textures2.ts` is pure arithmetic that returns canvases. This module decides
 * *when* those canvases get made and *where* they go — and the answer to "when"
 * is the constraint that shapes everything here.
 *
 * THE LAUNCH GATE. Baking the whole surface set costs 300–460 ms at DPR 1 and
 * about 1.3 s at DPR 2. That is one-time and entirely off the frame path, but
 * done synchronously at mount it would sit between the window appearing and the
 * panel being on it — a visible assembly, and a regression in the only number
 * the user experiences at launch. So nothing is baked during mount. The panel
 * paints first, in its CSS-gradient state, which is a complete and coherent
 * surface on its own; the generators then run in priority order across idle
 * callbacks, each one swapping a better surface in under the compositor. Every
 * `.mx-*` layer is additive or replaces a fallback that already looks finished,
 * so there is no frame in which the radio looks broken.
 *
 * THE ORDER is by visible area per millisecond: the grain tile (every aluminium
 * surface at once), then the grille (a quarter of the faceplate), then the small
 * round parts, then wear, then the knurl's extra rotation phases — which nobody
 * can see until they touch a knob, so they go last.
 *
 * INVALIDATION. Only two things invalidate a bake: a resize (debounced, and
 * only the grille and the wear maps depend on element size at all) and a change
 * of device pixel ratio. Everything else is cached by (kind, size, dpr), so the
 * three 62 px knobs share one sprite.
 */

import {
  bake,
  timings,
  brushedTile,
  grilleSheet,
  knurlSheet,
  domeSprite,
  bezelSprite,
  discSprite,
  wearMap,
  glassDust,
  barSprite,
  screwSprite,
  faceLight,
  toObjectURL,
  type Edge,
  type KnurlSheet,
  type RGB,
  type WearControl,
} from './textures2';

/* ---------------------------------------------------------------- scheduling */

type Job = () => void | Promise<void>;

interface Queued {
  /** Lower runs first. */
  priority: number;
  seq: number;
  run: Job;
}

const queue: Queued[] = [];
let seq = 0;
let draining = false;
let idleHandle = 0;

type IdleDeadline = { timeRemaining(): number; didTimeout: boolean };
type IdleCallback = (deadline: IdleDeadline) => void;
interface IdleWindow {
  requestIdleCallback?: (cb: IdleCallback, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

const idleWin = window as unknown as IdleWindow;

function requestIdle(cb: IdleCallback): number {
  if (idleWin.requestIdleCallback) return idleWin.requestIdleCallback(cb, { timeout: 250 });
  return window.setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16);
}

function later(priority: number, run: Job): void {
  queue.push({ priority, seq: seq++, run });
  drain();
}

/**
 * Drain the queue across idle callbacks, one job per slice.
 *
 * One job at a time, not "as many as fit the deadline": the expensive
 * generators (the grille, the grain tile) run for longer than any idle slice,
 * so batching them would only mean two long tasks back to back. Yielding
 * between them keeps input responsive while the surface assembles.
 */
function drain(): void {
  if (draining || queue.length === 0) return;
  draining = true;
  idleHandle = requestIdle(() => {
    draining = false;
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const job = queue.shift();
    if (job) {
      try {
        void job.run();
      } catch (err) {
        // A texture that fails to bake leaves the CSS fallback in place, which
        // is a complete surface. It must never take the receiver down with it.
        console.warn('[materials] bake failed', err);
      }
    }
    drain();
  });
}

/** Priorities. Visible area per millisecond, descending. */
const P = {
  grain: 10,
  grille: 20,
  knobs: 30,
  jewels: 40,
  glassware: 50,
  wear: 60,
  cabinet: 70,
  /** Rotation phases nobody can see until a hand is on the knob. */
  knurlPhases: 90,
} as const;

/* -------------------------------------------------------------------- cache */

const cache = new Map<string, HTMLCanvasElement>();

function once(key: string, name: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = bake(name, make);
  cache.set(key, made);
  return made;
}

/** A private copy of a cached sprite, so one bitmap can serve several parts. */
function copyInto(target: HTMLCanvasElement, source: HTMLCanvasElement): void {
  target.width = source.width;
  target.height = source.height;
  const c = target.getContext('2d');
  if (!c) return;
  c.clearRect(0, 0, target.width, target.height);
  c.drawImage(source, 0, 0);
}

let dpr = 1;
/** The shared brushed grain, once the tile exists. Grille holes reuse it. */
let grainTile: HTMLCanvasElement | null = null;

/**
 * Every bake whose result depends on the size of the element it is on.
 *
 * These are the only things a reshape invalidates. Everything else is cached by
 * (kind, size, dpr) and is either the same size as before or already in the
 * map. Registering here rather than remembering to re-run each mount by hand is
 * what stops a sprite being baked at one size and then stretched by CSS to
 * another — which is exactly what happened to the carry handles when the
 * cabinet's cheeks came into view.
 */
const sizeDependent: { priority: number; run: () => void }[] = [];

function onResize(priority: number, run: () => void): void {
  sizeDependent.push({ priority, run });
  later(priority, run);
}

/* ---------------------------------------------------------------- the light */

/**
 * Per-face luminance, written into CSS as `ambient + N·L` from the one light
 * vector. Five multipliers, all derived: the left cheek turns toward the lamp
 * and is *brighter* than the front, the right cheek turns away and is darker,
 * the top return is brightest, the plinth darkest. No face can be hand-tuned
 * out of agreement with the others, because none of them carries its own
 * hand-picked light — which is Law 5 made mechanical rather than aspirational.
 *
 * Pure arithmetic, so this runs at mount rather than in the queue.
 */
function writeFaceLight(): void {
  const rs = document.documentElement.style;
  for (const face of ['left', 'right', 'top', 'bottom'] as const) {
    rs.setProperty(`--face-${face}`, faceLight(face).toFixed(3));
  }
  rs.setProperty('--face-front', '1');
}

/* ------------------------------------------------------------------- knurl */

interface KnurlState {
  coarse: boolean;
  sheet: KnurlSheet | null;
  /** Rotation the knob is at, degrees. Held until the sprite lands. */
  deg: number;
  drawn: number;
  size: number;
}

const knurls = new Map<HTMLCanvasElement, KnurlState>();

/**
 * THE FLUTE COUNT IS A FUNCTION OF THE PIXELS, NOT OF TASTE.
 *
 * `pitchPx` is now the MINIMUM arc pitch, taken at the band's inner radius —
 * the tightest arc on the part. 6.4 device px is what `knurlSprite`'s analytic
 * fade needs to leave the teeth at full contrast; below it the fade starts
 * collapsing them toward the period mean, and a tone knob at 41 px was landing
 * so far under that it rendered as a smooth grey ring with no knurl in it at
 * all. On a 41 px knob this buys ~14 flutes: coarser than the reference's real
 * knurl, and the most any rasteriser can actually show at that size. Asking for
 * 34 and getting a grey ring is not finer, it is nothing.
 *
 * The albedos are genuinely black. 0.125 linear encodes to 36% grey, which is
 * why the flywheel read as one flat mid-tone instead of black knurl against
 * bright chrome.
 */
const KNURL_FINE = {
  r0: 0.715,
  r1: 0.995,
  pitchPx: 6.4,
  flank: 0.92,
  cone: 0.58,
  depth: 1.0,
  albedo: [0.05, 0.05, 0.056] as RGB,
  ss: 2,
};
const KNURL_COARSE = {
  r0: 0.62,
  r1: 0.972,
  pitchPx: 8.2,
  flank: 1.0,
  cone: 0.6,
  depth: 1.05,
  albedo: [0.034, 0.034, 0.039] as RGB,
  ss: 2,
};

/**
 * Register a knurled surface.
 *
 * The tooth count is derived from the sprite's PIXEL size, not from an angle:
 * `repeating-conic-gradient` at 2.2° puts 164 teeth on a 56 px knob, which is
 * half a device pixel each, and a conic gradient has no pixel footprint so it
 * cannot antialias. That is a Nyquist failure, not a tuning problem, and it is
 * why the small knobs moiréd. See `knurlSprite`.
 */
export function mountKnurl(canvas: HTMLCanvasElement, coarse: boolean): void {
  const state: KnurlState = { coarse, sheet: null, deg: 0, drawn: NaN, size: 0 };
  knurls.set(canvas, state);
  onResize(P.knobs, () => {
    // Only when the knob has actually changed diameter — the compact reflow
    // steps --kd, and a sprite baked for 62 px stretched onto 56 px is exactly
    // the resampling this module exists to avoid.
    const d = Math.round(canvas.getBoundingClientRect().width);
    if (d >= 8 && d !== state.size) bakeKnurl(canvas, state, state.sheet?.phases ?? 1);
  });
}

function bakeKnurl(canvas: HTMLCanvasElement, state: KnurlState, phases = 1): void {
  const box = canvas.getBoundingClientRect();
  const d = Math.round(box.width);
  if (d < 8) return;
  state.size = d;
  const opts = state.coarse ? KNURL_COARSE : KNURL_FINE;
  const key = `knurl|${d}|${dpr}|${state.coarse}|${phases}`;
  const sheet = once(key, `knurl ${d}px x${phases}`, () =>
    knurlSheet({ d, dpr, phases, ...opts }),
  ) as KnurlSheet;
  state.sheet = sheet;
  state.drawn = NaN;
  paintKnurl(canvas, state);
}

/** Show the phase for this rotation. One drawImage; no shader runs on a drag. */
export function setKnurlAngle(canvas: HTMLCanvasElement, deg: number): void {
  const state = knurls.get(canvas);
  if (!state) return;
  state.deg = deg;
  paintKnurl(canvas, state);
}

function paintKnurl(canvas: HTMLCanvasElement, state: KnurlState): void {
  const sheet = state.sheet;
  if (!sheet) return;
  /* An N-tooth knurl is N-fold rotationally symmetric, so the lit appearance at
     rotation φ equals the appearance at φ mod (2π/N). One tooth period of
     pre-baked phases therefore covers the control's entire travel — four
     sprites, not 360 — and the light stays put while the metal turns, which is
     the whole point of baking it at all. */
  const perTooth = 360 / sheet.teeth;
  const phase = ((((state.deg % perTooth) + perTooth) % perTooth) / perTooth) * sheet.phases;
  const i = Math.min(sheet.phases - 1, Math.max(0, Math.floor(phase)));
  if (i === state.drawn && canvas.width === sheet.cell) return;
  state.drawn = i;
  if (canvas.width !== sheet.cell || canvas.height !== sheet.cell) {
    canvas.width = sheet.cell;
    canvas.height = sheet.cell;
  }
  const c = canvas.getContext('2d');
  if (!c) return;
  c.clearRect(0, 0, sheet.cell, sheet.cell);
  c.drawImage(sheet, i * sheet.cell, 0, sheet.cell, sheet.cell, 0, 0, sheet.cell, sheet.cell);
}

/** Bring the remaining rotation phases forward — a hand is on this knob. */
export function warmKnurl(canvas: HTMLCanvasElement): void {
  const state = knurls.get(canvas);
  if (!state || !state.sheet || state.sheet.phases > 1) return;
  bakeKnurl(canvas, state, KNURL_PHASES);
}

const KNURL_PHASES = 4;

/* ------------------------------------------------------- jewels and domes */

/** The three preset lamps, as pigments rather than as CSS colours. */
const JEWEL: Record<string, { tint: RGB; lamp: RGB }> = {
  C: { tint: [0.97, 0.94, 0.84], lamp: [1.0, 0.95, 0.8] },
  B: { tint: [0.99, 0.66, 0.16], lamp: [1.0, 0.68, 0.18] },
  P: { tint: [0.93, 0.19, 0.11], lamp: [1.0, 0.26, 0.13] },
};

/**
 * A preset jewel's glass.
 *
 * Called again whenever the lamp behind it changes, which is rare and cached,
 * so it costs one `drawImage` after the first time. Diffused coloured glass
 * scatters far more of its lamp than a clear moulded button does, hence the
 * high `glow`; an unlit jewel keeps its pigment, because coloured plastic is
 * still coloured in the dark.
 */
export function paintJewel(canvas: HTMLCanvasElement, slot: string, lit: boolean, d = 18): void {
  const col = JEWEL[slot] ?? JEWEL.C!;
  const key = `jewel|${slot}|${lit}|${d}|${dpr}`;
  const run = () => {
    const sprite = once(key, `jewel ${slot}${lit ? ' lit' : ''}`, () =>
      domeSprite({
        d,
        dpr,
        tint: lit ? col.tint : (col.tint.map((v) => v * 0.5 + 0.04) as RGB),
        sigma: 1.9,
        cap: 0.96,
        shine: 150,
        gloss: 1.05,
        peel: 0.1,
        glassy: true,
        glow: 2.6,
        lamp: lit ? 1 : 0,
        lampColor: col.lamp,
        seat: 0.03,
        seed: 3 + slot.charCodeAt(0),
      }),
    );
    copyInto(canvas, sprite);
  };
  if (cache.has(key)) run();
  else later(P.jewels, run);
}

/** The machined ring the jewel sits in — and the plated band on a tone knob. */
export function mountBezel(
  canvas: HTMLCanvasElement,
  d: number,
  opts: {
    r0?: number;
    r1?: number;
    pitchPx?: number;
    smooth?: boolean;
    polish?: number;
    tilt0?: number;
    tilt1?: number;
  } = {},
): void {
  const r0 = opts.r0 ?? 0.66;
  const r1 = opts.r1 ?? 1.0;
  const pitchPx = opts.pitchPx ?? 5.2;
  const smooth = opts.smooth ?? false;
  const polish = opts.polish ?? 1;
  const tilt0 = opts.tilt0 ?? 0.3;
  const tilt1 = opts.tilt1 ?? 0.55;
  later(P.jewels, () => {
    const key = `bezel|${d}|${dpr}|${r0}|${r1}|${pitchPx}|${smooth}|${polish}|${tilt0}|${tilt1}`;
    copyInto(
      canvas,
      once(key, `bezel ${d}px`, () =>
        bezelSprite({ d, dpr, r0, r1, pitchPx, smooth, polish, tilt0, tilt1 }),
      ),
    );
  });
}

/** The RADIO power button's moulded dome. */
export function paintPowerDome(canvas: HTMLCanvasElement, on: boolean, d = 38): void {
  const key = `power|${on}|${d}|${dpr}`;
  const run = () => {
    copyInto(
      canvas,
      once(key, `power dome ${on ? 'on' : 'off'}`, () =>
        domeSprite({
          d,
          dpr,
          tint: [0.95, 0.085, 0.055],
          sigma: 3.0,
          cap: 0.93,
          shine: 320,
          gloss: on ? 1.05 : 0.95,
          peel: 0.3,
          glow: 1.5,
          lamp: on ? 1.0 : 0,
          lampColor: [1.0, 0.28, 0.12],
          seat: 0.05,
          seed: 9,
        }),
      ),
    );
  };
  if (cache.has(key)) run();
  else later(P.jewels, run);
}

/**
 * The tuning flywheel's polished centre disc.
 *
 * `groovePx` is a real turning pitch now, not a sub-Nyquist one: at 2.7 device
 * px the fade left the grooves at 22% contrast and the radius-dependent phase
 * warp pushed the true local period to 1.9 px, which is where the bullseye on
 * the centre cap came from. 4.6 px resolves, and the disc is where the
 * flywheel's material contrast lives — bright chrome against black knurl.
 */
export function mountDisc(canvas: HTMLCanvasElement): void {
  onResize(P.knobs, () => {
    const d = Math.round(canvas.getBoundingClientRect().width);
    if (d < 8) return;
    const key = `disc|${d}|${dpr}`;
    copyInto(
      canvas,
      once(key, `turned disc ${d}px`, () =>
        /* `rough` is the depth of the turning marks, and 0.62 drew them as a
           target you could count the rings on. On a spun cap the grooves are
           microns deep and their whole job is to SMEAR the specular
           tangentially into the two opposed lobes that say "turned" — the
           bow-tie is the signature, not the rings. The environment here has a
           hard horizon, so even a shallow radial tilt sweeps the reflection
           across it and draws a hard ring: the depth has to stay small enough
           that the grooves modulate the lobe instead of cutting it up. */
        discSprite({ d, dpr, groovePx: 3.4, rough: 0.045, rim: 0.11, dimple: 0.075, ss: 2 }),
      ),
    );
  });
}

/* ------------------------------------------------------------------ grille */

/** Hole spacing, device px. A punch press has one tool: this never changes. */
const GRILLE_PITCH = 9.2;

/**
 * The punched sheet. One canvas; the biggest single surface in the window.
 *
 * THE SHEET OBSERVES ITSELF. Every other size-dependent bake here can go
 * through the chassis-wide observer, because being a few device pixels out on
 * a wear map costs nothing. The grille cannot: its canvas is stretched to the
 * host by `width: 100%`, so the moment the backing store is a different size
 * from the box, the compositor resamples it — and a resample along one axis
 * only turns a circular hole into an oval. That is exactly what happened at
 * maximised width: the sheet baked for a 264 px column, stretched onto a 398
 * px one, gave a 1.5:1 hole and a 14 px horizontal pitch against an unchanged
 * 16 px vertical one, so a 51% wider cabinet held FEWER holes per row.
 *
 * Any path that leaves the shared observer watching a stale element — a
 * re-mount, a second `installMaterials`, a detached chassis — reintroduces it
 * silently. So the grille watches its own box, in DEVICE pixels
 * (`device-pixel-content-box`, which is the only measurement that survives a
 * fractional DPR and an ancestor transform), and bakes to exactly that. Pitch
 * is then a fixed physical distance: widening the cabinet adds columns.
 */
export function mountGrille(host: HTMLElement): void {
  let wDev = 0;
  let hDev = 0;
  let pending: [number, number] | null = null;
  let timer = 0;

  const deviceBox = (entry?: ResizeObserverEntry): [number, number] => {
    const dp = entry?.devicePixelContentBoxSize?.[0];
    if (dp) return [Math.round(dp.inlineSize), Math.round(dp.blockSize)];
    // Chromium 130 has device-pixel-content-box; this is for anything that
    // does not, where `rect * dpr` is the best estimate available.
    const r = host.getBoundingClientRect();
    return [Math.round(r.width * dpr), Math.round(r.height * dpr)];
  };

  const settle = (): void => {
    const next = pending;
    pending = null;
    if (!next) return;
    const [w, h] = next;
    if (w === wDev && h === hDev) return;
    if (w < 20 || h < 20) return;
    wDev = w;
    hDev = h;
    later(P.grille, () => {
      // Re-check at bake time: the queue is drained across idle callbacks, so
      // several reshapes can land between scheduling and running.
      const [nowW, nowH] = deviceBox();
      if (nowW !== wDev || nowH !== hDev) {
        wDev = nowW;
        hDev = nowH;
      }
      if (wDev < 20 || hDev < 20) return;
      bakeGrille(host, wDev, hDev);
    });
  };

  const schedule = (entry?: ResizeObserverEntry): void => {
    pending = deviceBox(entry);
    window.clearTimeout(timer);
    // Debounced, because a slow window drag must not become a rasterisation
    // loop; short, because until it fires the holes are the wrong shape.
    timer = window.setTimeout(settle, 140);
  };

  const ro = new ResizeObserver((entries) => schedule(entries[0]));
  try {
    ro.observe(host, { box: 'device-pixel-content-box' });
  } catch {
    ro.observe(host);
  }
  grilleObservers.add(ro);
  schedule();
}

const grilleObservers = new Set<ResizeObserver>();

function bakeGrille(host: HTMLElement, wDev: number, hDev: number): void {
  const w = wDev / dpr;
  const h = hDev / dpr;
  /* Not cached by size: the grille is unique per window and re-baking it on a
     resize is the only per-shape cost in the whole module. */
  const sheet = bake(`grille ${wDev}x${hDev}dev`, () =>
    grilleSheet({
      w,
      h,
      wDev,
      hDev,
      dpr,
      pitch: GRILLE_PITCH,
      holeRatio: 0.6,
      seed: 5,
      grain: grainTile,
      driver: { x: w * 0.5, y: h * 0.44, r: Math.min(w, h) * 0.46 },
    }),
  );
  const existing = host.querySelector('canvas.mx-grille__sheet');
  if (existing) existing.remove();
  sheet.className = 'mx-grille__sheet';
  host.prepend(sheet);
  host.setAttribute('data-mx-punched', 'true');
}

/* -------------------------------------------------------------------- wear */

interface WearTarget {
  el: HTMLElement;
  edges: Edge[];
  controls: () => WearControl[];
}

/**
 * Wear, distributed by where hands and desks actually are.
 *
 * The single most worn line on a real case is the **arris** — where the front
 * face wraps round to the cheek. It is rubbed brighter and smoother than either
 * face it joins, broken by hard dings, with grime collecting in the shallow
 * just inboard of it. A uniform noise layer at `opacity: .3` is not wear, it is
 * dirt-coloured fog, and that is what this replaces.
 */
export function mountWear(
  el: HTMLElement,
  edges: Edge[],
  controls: () => WearControl[] = () => [],
): void {
  const target = { el, edges, controls };
  onResize(P.wear, () => bakeWear(target));
}

function bakeWear(target: WearTarget): void {
  const r = target.el.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  const map = bake(`wear ${Math.round(r.width)}x${Math.round(r.height)}`, () =>
    wearMap({
      w: r.width,
      h: r.height,
      dpr,
      controls: target.controls(),
      edges: target.edges,
      seed: 29 + Math.round(r.width),
    }),
  );
  void toObjectURL(map).then((url) => {
    const prev = target.el.style.getPropertyValue('--wear-url');
    target.el.style.setProperty('--wear-url', `url(${url})`);
    revokeUrl(prev);
  });
}

/* ------------------------------------------------------------------- glass */

/** Dust on the pane. Each mote carries its own shadow, which is what puts it
 *  ON the glass rather than IN the image behind it. */
export function mountDust(el: HTMLElement): void {
  onResize(P.glassware, () => {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const key = `dust|${Math.round(r.width)}|${Math.round(r.height)}|${dpr}`;
    const sprite = once(key, `glass dust ${Math.round(r.width)}px`, () =>
      glassDust({ w: r.width, h: r.height, dpr, seed: 41 + Math.round(r.width) }),
    );
    void toObjectURL(sprite).then((url) => el.style.setProperty('--dust-url', `url(${url})`));
  });
}

/* ----------------------------------------------------------------- cabinet */

/**
 * The foot pad at each end of a carry bracket, in CSS px.
 *
 * Shared with `faceplate.css`, which positions `.cheek__boss` — the fastener —
 * at half this from the strap's end so the screw lands in the middle of the
 * pad. Two files, one number, and it is a constant rather than a fraction of
 * the strap precisely so that the fastener does not drift off the foot when a
 * wider window grows the cheek.
 */
const HANDLE_FOOT_PX = 24;

/** A carry handle: moulded satin plastic, deliberately NOT the shell's metal. */
export function mountHandle(host: HTMLElement): void {
  onResize(P.cabinet, () => {
    const r = host.getBoundingClientRect();
    if (r.width < 6 || r.height < 20) return;
    const key = `bar|${Math.round(r.width)}|${Math.round(r.height)}|${dpr}`;
    const sprite = once(key, `handle ${Math.round(r.width)}x${Math.round(r.height)}`, () =>
      barSprite({
        w: r.width,
        h: r.height,
        dpr,
        axis: 'v',
        radius: 0.44,
        seed: 17,
        bracket: true,
        footPx: HANDLE_FOOT_PX,
      }),
    );
    let canvas = host.querySelector('canvas.mx-handle__bar') as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'mx-handle__bar';
      host.prepend(canvas);
    }
    copyInto(canvas, sprite);
  });
}

/** A pan-head fastener. Small, but the thing that says "assembled". */
export function mountScrew(canvas: HTMLCanvasElement, d = 9): void {
  later(P.cabinet, () => {
    copyInto(canvas, once(`screw|${d}|${dpr}`, `screw ${d}px`, () => screwSprite({ d, dpr, angle: 0.4 })));
  });
}

/* ------------------------------------------------------------------ sockets */

/** The 6.3 mm headphone jack is fixed at 26 px by controls.css. */
const JACK_D = 26;

/**
 * The chrome flange around the headphone bore.
 *
 * The jack has no canvas of its own — it is one decorative `<div>` — so the
 * ring goes out as a custom property and CSS blits it as a background layer.
 * That is deliberately not a `conic-gradient`: a polished ring is very nearly a
 * mirror, and what you see in it is the room — a hot band just above the
 * horizon, a near-black desk below — which is what puts a sharp specular arc in
 * the upper left and a dark return opposite it. A conic ramp has colour stops
 * where the arc should be, and no horizon at all.
 *
 * One 26 px sprite for however many jacks the case has, baked with the jewels.
 */
function bakeJackRing(): void {
  const ring = once(`jackring|${JACK_D}|${dpr}`, `jack chrome ring ${JACK_D}px`, () =>
    bezelSprite({
      d: JACK_D,
      dpr,
      r0: 0.6,
      r1: 1,
      smooth: true,
      polish: 1.08,
      tilt0: 0.24,
      tilt1: 0.74,
    }),
  );
  void toObjectURL(ring).then((url) => {
    liveUrls.add(url);
    const prev = document.documentElement.style.getPropertyValue('--jack-ring-url');
    document.documentElement.style.setProperty('--jack-ring-url', `url(${url})`);
    revokeUrl(prev);
  });
}

/* ------------------------------------------------------------- object URLs */

const liveUrls = new Set<string>();

function revokeUrl(css: string): void {
  const match = /url\((?:"|')?(blob:[^)"']+)/.exec(css);
  if (!match?.[1]) return;
  URL.revokeObjectURL(match[1]);
  liveUrls.delete(match[1]);
}

/* -------------------------------------------------------------- the grain */

function bakeGrain(): void {
  /* One seamless stochastic tile of real linisher marks, blended `overlay`, in
     place of three `repeating-linear-gradient`s at coprime periods. Coprimality
     lengthens a repeat; it does not remove it, and the eye is an extremely good
     periodicity detector — which is why the shipping surface read as corduroy.
     One tile serves every aluminium surface in the app. */
  grainTile = bake('grain tile 1024x512', () => brushedTile({ w: 1024, h: 512, seed: 11 }));
  void toObjectURL(grainTile).then((url) => {
    liveUrls.add(url);
    const rs = document.documentElement.style;
    rs.setProperty('--grain-url', `url(${url})`);
    rs.setProperty('--grain-size', `${1024 / dpr}px ${512 / dpr}px`);
    /* Foreshortening: a face seen at a grazing angle compresses along its depth
       axis, and the grain has to compress with it. A texture that stays square
       is what makes a box render look like a decal. */
    rs.setProperty('--cheek-grain', `${168 / dpr}px ${512 / dpr}px`);
    rs.setProperty('--return-grain', `${1024 / dpr}px ${64 / dpr}px`);
    document.documentElement.setAttribute('data-mx-grain', 'on');
  });

  const tooth = bake('tooth tile 256', () => brushedTile({ w: 256, h: 256, seed: 61, amp: 0.55 }));
  void toObjectURL(tooth).then((url) => {
    liveUrls.add(url);
    document.documentElement.style.setProperty('--tooth-url', `url(${url})`);
  });
}

/* ------------------------------------------------------------------ mount */

export interface MaterialsHandle {
  /** Bake timings, in order. Evidence, not decoration. */
  timings(): { name: string; ms: number }[];
  destroy(): void;
}

let installed = false;
/**
 * The chassis observer, so a second install can re-point it.
 *
 * `if (installed) return` on its own is a trap: the observer keeps watching
 * whatever element the FIRST install was given, and if the faceplate is ever
 * rebuilt — a re-mount, a hot reload — that element is detached and never
 * resizes again. Every size-dependent bake then freezes at whatever size it
 * had when the panel was replaced, and CSS quietly stretches the stale bitmaps
 * to fit. Re-observing is one line and it removes a whole class of ghost.
 */
let chassisRo: ResizeObserver | null = null;

/**
 * Start the material layer.
 *
 * Call after the faceplate is in the document. Nothing is baked here: the light
 * vector is written into CSS (arithmetic, free) and everything else is queued
 * behind the first paint.
 */
export function installMaterials(root: HTMLElement): MaterialsHandle {
  if (installed) {
    if (chassisRo) {
      chassisRo.disconnect();
      chassisRo.observe(root);
    }
    return { timings, destroy() {} };
  }
  installed = true;
  dpr = window.devicePixelRatio || 1;

  writeFaceLight();
  later(P.grain, bakeGrain);
  later(P.jewels, bakeJackRing);

  // Only the grille and the wear maps depend on the size of the element they
  // are on, so only those two re-bake on a reshape. Debounced, because a slow
  // window drag must not turn into a rasterisation loop.
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const nextDpr = window.devicePixelRatio || 1;
      if (nextDpr !== dpr) {
        // A different device pixel ratio invalidates every sprite, because the
        // tooth counts and the analytic antialiasing are all computed against
        // device pixels. Forgetting the recorded knob sizes is what makes the
        // knurl jobs below decide they have work to do.
        dpr = nextDpr;
        cache.clear();
        for (const state of knurls.values()) state.size = 0;
        later(P.grain, bakeGrain);
        later(P.jewels, bakeJackRing);
      }
      for (const job of sizeDependent) later(job.priority, job.run);
    }, 200);
  });
  ro.observe(root);
  chassisRo = ro;

  // The remaining rotation phases, last. Nobody can turn a knob before they
  // have touched it, so this is off every path that matters.
  later(P.knurlPhases, () => {
    for (const [canvas, state] of knurls) {
      if (state.sheet && state.sheet.phases === 1) later(P.knurlPhases, () => bakeKnurl(canvas, state, KNURL_PHASES));
    }
  });

  return {
    timings,
    destroy() {
      ro.disconnect();
      chassisRo = null;
      for (const g of grilleObservers) g.disconnect();
      grilleObservers.clear();
      window.clearTimeout(resizeTimer);
      if (idleWin.cancelIdleCallback && idleHandle) idleWin.cancelIdleCallback(idleHandle);
      queue.length = 0;
      sizeDependent.length = 0;
      for (const url of liveUrls) URL.revokeObjectURL(url);
      liveUrls.clear();
      installed = false;
    },
  };
}
