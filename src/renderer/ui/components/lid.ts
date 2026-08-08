/**
 * THE REGISTER SHEET, AND THE SLOT IT LIVES IN.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NO LONGER A HINGED LID
 *
 * It used to be one: the panel stood in a bay above the faceplate on
 * `rotateX(-75.2deg)` under a CSS `perspective`, and swung down over the face.
 * Measured on the shipping build at 1280×820, the closed lid's TOP edge was
 * 1250.0 px against a BOTTOM edge of 1098.3 px — a 13.8% taper, wider at the
 * top. For a lid on the top of a box seen from the front the near edge is the
 * bottom one and must be the WIDER one, so that trapezoid reads as a lid seen
 * from BELOW, while the panel, the grille, the meter, the knobs and the drum
 * are all strict orthographic front view. Two cameras on one object, disagreeing
 * across 21% of the window at the default size and 45% when the window is tall.
 * No easing curve fixes a camera.
 *
 * So the rotation is gone — no `rotateX`, no `matrix3d`, no `perspective`, no
 * foreshortening anywhere in this file or its stylesheet. The chassis has ONE
 * camera and this surface now shares it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS INSTEAD
 *
 * A sheet in a slot. One rigid assembly, `travel + plate` pixels long, running
 * vertically in a well cut into the case between the lip and the hem:
 *
 *   ┌─ lip ────────────────────────────────┐   the case top, with its latches
 *   ├─ slot mouth ─────────────────────────┤   the sheet comes out of here
 *   │  ░░ the printed plate ░░             │   ← what shows when it is home
 *   │                                      │
 *   │       (faceplate, uncovered)         │
 *   └──────────────────────────────────────┘
 *
 * The assembly is, top to bottom, THE REGISTER and then THE PRINTED PLATE. Home,
 * it sits high enough that the register is entirely inside the slot and only the
 * plate — the sheet's own bottom rail — shows across the top of the window. Drawn
 * out, it has travelled down by exactly the height of the well: the register now
 * fills the well over the faceplate, and the plate has gone down past the hem and
 * tucked under the bottom rail. One rigid body, one translation, one camera.
 *
 * The plate is seen face-on, exactly as the front panel is: it is the printed
 * metal top of the case. It carries what a real lid of this family carries and
 * nothing else — the `Weltempfänger` wordmark, `FREQUENCY 1.8 – 30 MHz` over the
 * twelve boxed meter bands, the cyan GMT map with its graticule, and the boxed
 * timezone strips.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 *
 * `translate3d` on a promoted layer, 200 ms, eased. Nothing else moves, nothing
 * resizes, nothing is mounted or unmounted on the way, and no geometry is solved
 * per frame. That matters for a measured reason: on the old build a click cost
 * **2.72 s before one pixel changed** and **4.17 s before the screen settled**,
 * because the register was `display: none` until the click (≈350 ms of style and
 * layout) and the swing was a software 3-D composite of a 1250 × 778 texture
 * every frame on a machine with no GPU. Both are gone: the sheet is a single
 * promoted layer that is translated, and the click itself now costs **1.4 ms of
 * main thread** against the 126–156 ms it used to block for before it had even
 * written a transform. What is left is the compositor's own raster of a
 * 1250 x 950 surface, which on this GPU-less machine is several hundred
 * milliseconds however it is asked for — see the report for the measurement of
 * a contentless rectangle given the identical travel, which is the floor.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY BE TOUCHED WHILE IT IS HOME
 *
 * Exactly one thing: `.lid__hit`, a button the full width of the plate whose
 * only job is "open me". Everything on the sheet — 1014 controls of the register
 * — is behind `inert`, `aria-hidden` and (once settled) `content-visibility:
 * hidden` for as long as the sheet is home, so it is unfocusable, unclickable,
 * unannounced and unrendered.
 *
 * Verified by MOVING FOCUS, not by counting selectors. With the sheet home,
 * calling `.focus()` on every node under `.lid` and `.lip` and then reading
 * `document.activeElement` finds exactly three that take it: this button and the
 * two latch tabs on the case top, all three labelled "open the register" and all
 * three doing that one job. The same sweep counted with a CSS selector answers
 * 1017 — which is the number an integrator once reported, and it is wrong by
 * three orders of magnitude.
 */

import type {
  PlaybackState,
  RegisterIndex,
  RegisterScope,
  StationRef,
} from '../../../shared/contracts';
import { clamp, el, setAttr, setFlag, svg } from '../dom';
import { textureLayer } from '../textures';
import type { AirState } from '../types';
import { COASTLINES, METER_BANDS, TIMEZONES, latToY, lonToX } from '../worldGeometry';
import {
  createRegister,
  type RegisterHandle,
  type RegisterHandlers,
  type RegisterRows,
  type RegisterSearchField,
} from './register';

/** Below this much deck there is no plate worth printing and nothing to press. */
const BAY_MIN = 70;

/** Plate depths at which the printing gains a row it has room for. */
const PRINT_MID = 104;
const PRINT_FULL = 168;

/** The map's own units: one per degree, cropped to ±80° as printed lids are. */
const MAP_W = 360;
const MAP_H = 160;

/** How much of the printed matter the plate has room for. */
export type PrintLevel = 'none' | 'min' | 'mid' | 'full';

export interface LidFrame {
  /** The well's depth, which is also the whole travel of the sheet. */
  travel: number;
  /** How deep the printed plate stands across the top of the window. */
  plate: number;
  /** Base type size for the printing, in real screen pixels — no projection. */
  print: number;
  level: PrintLevel;
}

export interface LidHandle {
  root: HTMLElement;
  /** The always-visible case top; belongs at the top of the shell. */
  lip: HTMLElement;
  /**
   * Draw the sheet out, or put it away.
   *
   * `focus` names which type slot the register hands focus to once the sheet
   * has landed: the SUBJECT index, which is where a listener starts, or the
   * ledger's own NAME slot, which is where `Ctrl+K` goes.
   */
  setOpen(open: boolean, focus?: RegisterSearchField): void;
  isOpen(): boolean;
  /** Put focus in the register's name search without moving the sheet. */
  focusSearch(field?: RegisterSearchField): void;
  /**
   * How many pixels of deck the reflow has given the printed plate, and how deep
   * the well behind it is — which is the distance from under the lip to the hem
   * of the case, because that is the whole distance the sheet travels.
   */
  setBay(height: number, length: number): void;
  setIndex(index: RegisterIndex | null, fault: string | null): void;
  setRows(rows: readonly StationRef[], state: RegisterRows): void;
  setScope(scope: RegisterScope): void;
  /** The ledger's tri-state for the station the panel is about. */
  setAir(stationId: string | undefined, air: AirState): void;
  /**
   * What the engine is doing, passed through to the register.
   *
   * The lid is the reason this exists. A click made on the register's sheet is
   * a click made on a surface that **completely covers the faceplate** — so the
   * fault text the host renders onto the panel is, at that moment, behind a
   * panel the user cannot see. Measured: `phase: error, kind: hls` at 0.39 s
   * with `register.innerText` matching `/HLS|CANNOT DECODE|FAULT/i` **false**.
   * Law 4 says failure is a designed state; a designed state painted on a
   * hidden surface is a silent failure with extra steps.
   */
  setPlayback(state: PlaybackState | null): void;
  destroy(): void;
}

/**
 * The whole geometry of the thing, in real screen pixels.
 *
 * There is no projection to undo any more, so this is arithmetic rather than
 * trigonometry: the sheet travels the depth of the well, the plate is as deep as
 * the deck the reflow spared, and the type on the plate is sized against BOTH
 * dimensions of the plate it is printed on.
 *
 * That second rule is not decoration. Type sized off the depth alone grew until
 * `FREQUENCY 1.8–30 MHz` was wider than the case and the twelve band boxes
 * printed as `120r 90r 75r`; 0.0125 of the width is the largest type the widest
 * row still fits in.
 */
export function lidFrame(deck: number, len: number, width: number): LidFrame {
  const travel = Math.max(0, len);
  // A plate too shallow to print on and too thin to press is not a plate.
  const plate = deck >= BAY_MIN ? Math.min(deck, travel) : 0;
  const level: PrintLevel =
    plate === 0 ? 'none' : plate >= PRINT_FULL ? 'full' : plate >= PRINT_MID ? 'mid' : 'min';
  // A shallow plate prints fewer things, so each of them gets a bigger share of
  // it: the alternative is a floor-sized legend with a hand's width of blank
  // metal under it.
  const share = level === 'full' ? 0.085 : level === 'mid' ? 0.13 : 0.22;
  const print =
    plate === 0
      ? 0
      : clamp(Math.min(plate * share, Math.max(120, width - 30) * 0.0125), 9, 26);
  return { travel, plate, print, level };
}

/* ---------------------------------------------------------------------------
   The printing.

   Everything here is screen-printed matter off the real case top, seen face-on
   at 1:1, and not one node in it is focusable, clickable or announced. It is
   scenery, and it says so.
   ------------------------------------------------------------------------- */

function printMap(): SVGSVGElement {
  const node = svg('svg', {
    class: 'print__map',
    viewBox: `0 0 ${MAP_W} ${MAP_H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  node.append(svg('rect', { class: 'print__ground', x: 0, y: 0, width: MAP_W, height: MAP_H }));

  for (let lon = -180; lon <= 180; lon += 30) {
    const x = (lonToX(lon) * MAP_W).toFixed(1);
    node.append(
      svg('line', {
        class: `print__grid${lon === 0 ? ' print__grid--prime' : ''}`,
        x1: x,
        y1: 0,
        x2: x,
        y2: MAP_H,
      }),
    );
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = (latToY(lat) * MAP_H).toFixed(1);
    node.append(
      svg('line', {
        class: `print__grid${lat === 0 ? ' print__grid--eq' : ''}`,
        x1: 0,
        y1: y,
        x2: MAP_W,
        y2: y,
      }),
    );
  }
  for (const ring of COASTLINES) {
    const pts: string[] = [];
    for (let i = 0; i + 1 < ring.pts.length; i += 2) {
      pts.push(
        `${(lonToX(ring.pts[i]!) * MAP_W).toFixed(1)},${(latToY(ring.pts[i + 1]!) * MAP_H).toFixed(1)}`,
      );
    }
    node.append(
      svg(ring.closed ? 'polygon' : 'polyline', {
        class: `print__coast${ring.closed ? '' : ' print__coast--open'}`,
        points: pts.join(' '),
      }),
    );
  }
  return node;
}

function printStrip(side: 't' | 'b'): HTMLElement {
  return el(
    'div',
    { class: `print__strip print__strip--${side}` },
    TIMEZONES.map((tz) =>
      el('span', { class: `print__tz${tz.offset === 0 ? ' print__tz--gmt' : ''}` }, [tz.label]),
    ),
  );
}

function buildPrint(): HTMLElement {
  return el('div', { class: 'lid__print', 'aria-hidden': 'true' }, [
    el('div', { class: 'print__head' }, [
      el('span', { class: 'print__mark' }, ['Weltempfänger']),
      el('span', { class: 'print__sub' }, ['FM / AM Multi Band Receiver · PSP-6800W']),
    ]),
    el('div', { class: 'print__chart' }, [
      el('span', { class: 'print__chart-cap' }, ['Frequency 1.8 – 30 MHz']),
      el(
        'div',
        { class: 'print__bands' },
        METER_BANDS.map((b) => el('span', { class: 'print__band' }, [b])),
      ),
    ]),
    el('div', { class: 'print__field' }, [printStrip('t'), printMap(), printStrip('b')]),
  ]);
}

export function createLid(
  handlers: Omit<RegisterHandlers, 'onClose'> & {
    onToggle(open: boolean): void;
    /**
     * The travel finished and the sheet's own seal has been applied.
     *
     * The chassis, not the sheet, owns what is UNDER the sheet, so this is
     * where the faceplate is sealed off behind an open register and where
     * focus is handed back when it closes. It fires at the end of the travel
     * for the same reason `sealLatched` does: `inert` on a subtree that size is
     * a style change on every node in it, and that may not land inside a 200 ms
     * animation.
     */
    onSettled?(open: boolean): void;
  },
): LidHandle {
  let open = false;
  let deck = 0;
  let len = 620;

  const latchL = el('button', { class: 'lip__latch', type: 'button', 'aria-label': 'Open the register' }, [
    el('span', { class: 'lip__latch-grip' }),
  ]);
  const latchR = el('button', { class: 'lip__latch', type: 'button', 'aria-label': 'Open the register' }, [
    el('span', { class: 'lip__latch-grip' }),
  ]);

  const lip = el('div', { class: 'lip mat-alu' }, [
    textureLayer('alu'),
    el('div', { class: 'lip__channel' }, [el('div', { class: 'lip__antenna' })]),
    latchL,
    el('div', { class: 'lip__title' }, [
      el('span', { class: 'silk silk--xs' }, ['GMT World Map · World Station Register']),
    ]),
    latchR,
  ]);

  const register: RegisterHandle = createRegister({
    onScope: handlers.onScope,
    onSelect: handlers.onSelect,
    onCut: handlers.onCut,
    onReprint: handlers.onReprint,
    onClose: () => handlers.onToggle(false),
    // The register builds its RECONNECT affordance only when this is supplied
    // (Law 1: no control without a job). There is one recovery action on this
    // receiver, so it is the same handler the front panel's button calls.
    onReconnect: handlers.onReconnect,
  });

  const print = buildPrint();

  /* The register sits in a milled tray, not on the flat. A recess lit from the
     upper left is dark along its top and left inner walls and catches the lamp
     on the bottom and right ones — the inverse of a boss, and the thing the
     open lid was missing when a critic found nothing on it that bevelled,
     recessed or caught a lamp. */
  const tray = el('div', { class: 'lid__tray' }, [register.root]);

  /**
   * The sheet: register on top, printed plate below, one rigid body.
   *
   * `inert` and `aria-hidden` are on THIS element, so sealing the whole assembly
   * — printing and register alike — is one attribute rather than a sweep.
   */
  // No texture layer on the sheet's face. It used to carry one, and under the
  // tray there are nine visible pixels of it: the tray covers the face bar its
  // own padding ring. Measured on this build, a full-bleed blended feTurbulence
  // over the sheet's 1250 × 953 layer cost ~200 ms of software raster on every
  // travel, on a machine whose Chromium reports SwiftShader for everything. Two
  // hundred milliseconds is the whole travel.
  const panel = el('div', { class: 'lid__panel', 'aria-hidden': 'true', inert: true }, [
    el('div', { class: 'lid__face mat-black' }, [tray]),
    print,
    // The machined leading edge, and the shadow it throws on whatever is under
    // it. Both belong to the sheet, so both travel with it: the shadow sweeps
    // down the faceplate as the sheet comes out, which is most of what says
    // metal moving on metal rather than a panel fading in.
    el('div', { class: 'lid__rail' }),
    el('div', { class: 'lid__edge' }),
    el('div', { class: 'lid__sheen' }),
  ]);

  /**
   * The one control.
   *
   * Everything behind it is inert. It covers the printed plate exactly, it is
   * 1280 × 174 at the shipping default, and its only job is to draw the sheet.
   */
  const hit = el('button', {
    class: 'lid__hit',
    type: 'button',
    'aria-label': 'Open the world station register',
  }, [
    el('span', { class: 'lid__hit-cue' }, [
      el('span', { class: 'silk silk--teal' }, ['Open the register']),
    ]),
  ]);

  const root = el('div', {
    class: 'lid',
    'data-open': 'false',
    'data-bay': 'false',
    'data-stowed': 'true',
    'data-print': 'min',
    'data-swing': 'false',
  }, [panel, el('div', { class: 'lid__mouth' }), hit]);

  const toggle = (): void => handlers.onToggle(!open);
  latchL.addEventListener('click', toggle);
  latchR.addEventListener('click', toggle);
  hit.addEventListener('click', () => handlers.onToggle(true));

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      handlers.onToggle(false);
    }
  };
  window.addEventListener('keydown', onKey);

  let swingTimer = 0;
  /**
   * The deferred hand-off of focus into the register, kept so it can be taken
   * back.
   *
   * It fires once the sheet has landed — later than Escape, than a latch click,
   * and than `applyCut`'s own `setLidOpen(false)`. Uncancelled it called
   * `focusSearch()` on a panel `seal()` had just marked `inert` and
   * `aria-hidden`, stealing focus off the faceplate the user had gone back to,
   * and after `destroy()` it reached into a register that no longer exists.
   */
  let focusTimer = 0;

  /**
   * The travel time as the stylesheet defines it — 1 ms under
   * prefers-reduced-motion, so the timers follow suit.
   *
   * Read once and cached. `getComputedStyle` forces a style flush, and a style
   * flush is the one thing a click on this control must not pay for: the whole
   * point of the rewrite is that the click does nothing but write a transform.
   * The only thing that changes this token at runtime is the motion preference,
   * so that is what re-reads it.
   */
  function readDuration(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--lid-ms').trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 200;
    return raw.endsWith('ms') ? n : n * 1000;
  }
  let travelMs = readDuration();
  const stiller = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const onMotionPref = (): void => {
    travelMs = readDuration();
  };
  stiller?.addEventListener?.('change', onMotionPref);

  /**
   * Nothing that is not drawn out may be focused, clicked or announced.
   *
   * `inert` is the real seal and it is expensive: it is a style change on every
   * node of the subtree it covers, and this subtree is the register — measured
   * at **128–187 ms of blocked main thread** to toggle, at 1280×820, on the
   * machine this ships to. That cannot happen inside a 200 ms travel, so it does
   * not: the seal is applied at the END of the closing travel and lifted at the
   * END of the opening one, and the two cheap halves of it — the accessible
   * hidden flag, and `pointer-events`, which the `data-open` rule in lid.css
   * already carries — take effect on the click itself.
   *
   * The gap is 200 ms of a moving sheet during which a keyboard could in
   * principle still reach a control on it, so a close also takes focus back off
   * the sheet by hand rather than waiting for `inert` to do it.
   */
  function sealNow(): void {
    setAttr(panel, 'aria-hidden', String(!open));
    if (!open && panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }
  function sealLatched(): void {
    panel.toggleAttribute('inert', !open);
    // …and the register stops being rendered at all. See `[data-stowed]` in
    // lid.css: rendered while the receiver plays, it cost 18 points of a core.
    setAttr(root, 'data-stowed', String(!open));
  }

  /** The last solved frame, so a toggle never has to solve one. */
  let frame = lidFrame(0, len, 1280);

  /**
   * Everything the window's shape decides. Runs from the reflow, which is
   * already inside a layout, and nowhere else — `root.clientWidth` forces a
   * synchronous layout of the whole document, and paying that on a click is how
   * the toggle came to cost 126–156 ms of blocked main thread before it had even
   * written a transform.
   */
  function applyFrame(): void {
    frame = lidFrame(deck, len, root.clientWidth);
    const travel = Math.round(frame.travel);
    const plate = Math.round(frame.plate);
    // Written straight onto the elements that use them. See the note at the top
    // of lid.css: as custom properties on `.lid` these same numbers cost a
    // 4100-node style invalidation every time the window moved a pixel.
    root.style.height = `${travel}px`;
    panel.style.top = `${-travel}px`;
    panel.style.height = `${travel + plate}px`;
    print.style.height = `${plate}px`;
    print.style.setProperty('--lid-print-t', `${frame.print.toFixed(1)}px`);
    hit.style.height = `${plate}px`;
    setAttr(root, 'data-print', frame.level);
    applyTravel();
  }

  /**
   * The whole mechanism, and the whole of what a click does: home is zero, drawn
   * out is the depth of the well. One inline transform on one promoted layer —
   * no layout read, no custom property, no cascade.
   */
  function applyTravel(): void {
    // The plate's press is offered only while the sheet is home and there is a
    // plate to press.
    setAttr(root, 'data-bay', String(!open && frame.level !== 'none'));
    // Rendered again before it moves, so the whole travel shows a real register
    // rather than an empty tray that fills in on arrival. This is an attribute,
    // not a layout read: the work lands in the frame the travel starts in.
    if (open) setAttr(root, 'data-stowed', 'false');
    panel.style.transform = `translate3d(0, ${open ? Math.round(frame.travel) : 0}px, 0)`;
  }

  sealNow();
  sealLatched();
  applyFrame();

  return {
    root,
    lip,
    setOpen(next, focus: RegisterSearchField = 'subject') {
      if (next === open) return;
      open = next;
      setFlag(lip, 'is-open', open);
      const label = open ? 'Close the register' : 'Open the register';
      latchL.setAttribute('aria-label', label);
      latchR.setAttribute('aria-label', label);
      /* The latches are on the case top, which the sheet does not cover, so
         they stay CLICKABLE while the register is out — a mouse closes the lid
         with them. They come out of the TAB ring all the same: while the
         register is on screen it is the whole of what a keyboard can reach,
         and a Tab ring that steps out onto the chassis in the middle of a
         drawn-out sheet is the same defect as one that steps onto the
         faceplate. Escape and CLOSE LID are the keyboard's ways out. */
      setAttr(latchL, 'tabindex', open ? '-1' : '0');
      setAttr(latchR, 'tabindex', open ? '-1' : '0');
      sealNow();

      window.clearTimeout(swingTimer);
      window.clearTimeout(focusTimer);
      // The travel is the ONLY time the sheet's transform is animated. While it
      // merely tracks the window it follows it exactly, because a transition on
      // a dragged value is a lag and a lagging sheet overpaints the faceplate.
      setAttr(root, 'data-swing', 'true');
      setAttr(root, 'data-open', String(open));
      // Synchronously, in the same task as the click. The old build needed two
      // frames here because the panel went from `visibility: hidden` to visible
      // in the same style pass that moved it, which cancels the transition. The
      // sheet is never hidden now — it is simply inside the slot — so there is
      // nothing to stage and the motion starts on the very next frame.
      applyTravel();

      // Everything expensive happens after the sheet has arrived, never before
      // it sets off. Belt as well as braces on the focus: the timer is cancelled
      // on a reversal, and it re-checks, because focus may not be moved into a
      // panel that is shut.
      focusTimer = window.setTimeout(() => {
        sealLatched();
        // The chassis seals or unseals the faceplate here, in the same task,
        // so the two halves of "only one surface is reachable" can never be
        // applied a frame apart.
        handlers.onSettled?.(open);
        if (open) register.focusSearch(focus);
      }, travelMs + 40);
      swingTimer = window.setTimeout(() => setAttr(root, 'data-swing', 'false'), travelMs + 60);
    },
    isOpen: () => open,
    focusSearch: (field) => {
      if (open) register.focusSearch(field);
    },
    setBay(height, length) {
      const nextLen = Math.max(120, length);
      if (Math.abs(height - deck) < 1 && Math.abs(nextLen - len) < 1) return;
      deck = height;
      len = nextLen;
      applyFrame();
    },
    setIndex: (index, fault) => register.setIndex(index, fault),
    setRows: (rows, state) => register.setRows(rows, state),
    setScope: (scope) => register.setScope(scope),
    setAir: (id, air) => register.setAir(id, air),
    setPlayback: (state) => register.setPlayback(state),
    destroy() {
      window.removeEventListener('keydown', onKey);
      stiller?.removeEventListener?.('change', onMotionPref);
      window.clearTimeout(swingTimer);
      window.clearTimeout(focusTimer);
      register.destroy();
    },
  };
}
