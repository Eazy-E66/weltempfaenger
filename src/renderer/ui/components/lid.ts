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
 * metal top of the case. It carries the `Weltempfänger` wordmark, `FREQUENCY
 * 1.8 – 30 MHz` over the twelve boxed meter bands, and the boxed `-11 … GMT …
 * +12` strip. It does NOT carry a world map — see `buildPrint`. The world map
 * on this product is the register's, behind the plate, where it is interactive
 * and where a hover can mark an origin on it.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 *
 * `translate3d` on a promoted layer — 340 ms in each direction, eased. The two
 * directions are still different jobs and still separate tokens: the draw-out is
 * the travel anybody watches, the put-away is what a misclick costs. The
 * put-away used to be 200 ms and at that length it presented ZERO frames, 14 of
 * 14 — see the note in tokens.css and `armStow` below.
 *
 * Nothing else moves, nothing resizes, nothing is mounted or unmounted on the
 * way, and no geometry is solved per frame. That matters for a measured reason:
 * on the old build a click cost **2.72 s before one pixel changed** and
 * **4.17 s before the screen settled**, because the register was `display: none` until the click (≈350 ms of style and
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
import { clamp, el, setAttr, setFlag } from '../dom';
import { textureLayer } from '../textures';
import type { AirState } from '../types';
// `COASTLINES` / `latToY` / `lonToX` are no longer imported here: the plate
// prints no map. They remain in `worldGeometry.ts` for the register's own map,
// which is a different surface and is untouched by that decision.
import { METER_BANDS, TIMEZONES } from '../worldGeometry';
import {
  offsetMinutes,
  resolveZone,
  stripLamp,
  STRIP_MAX_HOUR,
  STRIP_MIN_HOUR,
} from '../worldTime';
import {
  createRegister,
  type RegisterHandle,
  type RegisterHandlers,
  type RegisterRows,
  type RegisterSearchField,
} from './register';

/** Below this much deck there is no plate worth printing and nothing to press. */
const BAY_MIN = 70;

/**
 * The one plate depth at which the printing gains a row it has room for.
 *
 * There used to be a second, `PRINT_FULL = 168`, above which the plate also
 * printed a GMT world map and a second timezone strip. Both are gone (see
 * `buildPrint`), which left `full` with nothing that `mid` does not have, so
 * the level went with them. `mid` is now the deepest plate there is and it is
 * what the shipped Windows build prints at its own 158 px.
 */
const PRINT_MID = 104;

/*
 * THERE IS NO CAP ON THE PLATE'S DEPTH, AND THE ONE THAT WAS HERE IS WITHDRAWN.
 *
 * `PLATE_MAX = 208` stood here. It was added to stop a deep window printing a
 * 475 px black band, and the note that came with it claimed it had been
 * "screenshotted at 1920×1200, [where] the capped plate reads as a printed
 * plate with the brushed case below it, which is the proportion the owner's
 * build has".
 *
 * **That claim was false**, and it is the reason the cap is gone rather than
 * merely re-tuned. What sits below a capped plate is not a proportion the
 * owner's build has; it is a member the owner's build does not contain at all.
 * The chassis publishes `--lid-bay` = `windowHeight - PANEL_H` and the faceplate
 * never grows, so every pixel the plate declines becomes brushed aluminium
 * between the plate's rail and the panel. Measured on this build, `.lid__rail`
 * bottom → `.panel` top, pointer parked off the plate:
 *
 *   | window      | capped at 208 | plate = deck |
 *   |-------------|---------------|--------------|
 *   | 1280 × 820  |     8 px      |    8 px      |
 *   | 1440 × 900  |    55 px      |    8 px      |
 *   | 1920 × 1080 |   210 px      |    8 px      |
 *   | 1920 × 1200 |   330 px      |    8 px      |
 *   | 1280 × 1400 |   555 px      |    8 px      |
 *   |  900 × 1400 |   546 px      |    8 px      |
 *   |  640 × 900  |   293 px      |    6 px      |
 *
 * The owner's Windows reference has ~11 CSS px there — one hairline of case
 * between the printed plate and the faceplate — so 330 px is not a smaller
 * version of the reference, it is a different object: a bright brushed wall
 * across a quarter of the window, and the brightest thing on the screen.
 * Screenshotted side by side at 1920×1200 and 1280×1400 against the reference,
 * and against the four other placements of the printing on an uncapped plate.
 *
 * WHAT THE SURPLUS IS INSTEAD. Plate. The plate is the case's hinged top seen
 * face-on, and on the reference device the top IS the whole upper surface — the
 * hairline of aluminium in front of it is all the case top there is. So a taller
 * window gets a taller lid, and the ONE relationship the eye actually reads —
 * printed plate sitting directly on the faceplate — holds at every window shape
 * instead of at one.
 *
 * WHAT THIS DOES NOT FIX, AND WHOSE FILE IT IS IN — NOW FIXED, SEE
 * `caseTopDepth` BELOW. The plate was deeper than the reference's own
 * proportion on a tall window (530 px of plate against a 613 px faceplate at
 * 1920×1200, where the reference is 158 against 745), because `index.ts` gave
 * the whole of `windowHeight - PANEL_H` to the bay and the faceplate, being
 * content-sized, never took any of it. Capping the BAY there — and letting the
 * dial grow into the surplus the way the width axis already lets the cheeks
 * grow — is what `caseTopDepth` and `--panel-slack` now do.
 *
 * WHAT THE DEEP PLATE PRINTS. The same three rows, at the same size, centred on
 * the plate exactly as the reference centres them — until the blank above them
 * would be deeper than the block itself, at which point the top margin stops
 * growing and the surplus goes below. See the spacer note at `.lid__print` in
 * lid.css: plain centring is right at every depth the reference has and is what
 * left the legend "marooned in the middle" of a 530 px plate, which is what the
 * cap on the PLATE was really reacting to.
 */

/**
 * The type size the plate's printing is set in once only the case's WIDTH binds
 * it, in real screen pixels.
 *
 * Broken out of `lidFrame` because it is also the whole of `caseTopDepth`: a
 * plate deep enough for the cap to matter is always past the depth share, so
 * the depth term cannot be the binding one there. Measured on this build, at
 * every window shape it ships to: 15.6 px at 1280 of case, 19.5 at 1586 —
 * which is the size the owner's Windows plate is set in — and 23.6 at 1920.
 */
function plateType(width: number): number {
  return clamp(Math.max(120, width - 30) * 0.0125, 9, 26);
}

/**
 * HOW DEEP THE CASE TOP IS. A LAW ABOUT THE PRINTING, NOT ABOUT THE WINDOW.
 *
 * The plate used to be exactly the deck the reflow spared, which meant a taller
 * window bought nothing but unprinted ink. Measured, lowest printed pixel to the
 * plate's bottom edge, before this: 52.6 px (30.1%) at the 1280×820 default but
 * 139.2 px (43.2%) at the owner's own 1586×967 and 309.6 px (58.4%) at
 * 1920×1200. The reference plate is 158 px and full.
 *
 * The cap is NOT a constant, and that is the whole difference between this and
 * the withdrawn `PLATE_MAX = 208` in the note above. Two clauses:
 *
 *   · `CASE_TOP_PER_PT × plateType(width)` — the plate is a fixed multiple of
 *     its own printing. The printed block is ~4.5 × `--pt` tall at `mid`, so
 *     11.6 × `--pt` is a block with the default's own margins around it, and
 *     the plate therefore has the SAME composition at every window shape rather
 *     than the same number of pixels. It has to scale with the type: the type
 *     is width-bound, so a 900 px-wide window prints a 49 px block, and a plate
 *     frozen at the default's 175 would have put a 77 px hole under it (44%).
 *
 *   · `CASE_TOP_MAX` — and never deeper than the deck the shipping default
 *     prints on, which is also within 11% of the reference's own 158 px. Past
 *     about 1410 px of case this is the clause that binds, and it is what keeps
 *     a 1920 px-wide window from printing a 274 px case top.
 *
 * At the 1280×820 default the raw deck is 175 px after the faceplate has taken
 * its shortfall and the cap is 175 px, so the cap is exactly a no-op there and
 * the default is pixel-identical — diffed, max channel delta 0.
 *
 * WHERE THE SURPLUS GOES, WHICH IS THE HALF THAT MAKES THIS SHIPPABLE. To the
 * faceplate, as `--panel-slack` in `reflow()`. Neither of the two failures this
 * project has already seen is acceptable: the plate taking it is dead ink (the
 * table above), and capping the plate while leaving `--lid-bay` alone is up to
 * 330 px of brushed aluminium between the rail and the panel — the withdrawn
 * defect. The bay itself is capped, so `.lid__rail` bottom → `.panel` top stays
 * the 8 px it has always been, measured at all eight window shapes.
 */
const CASE_TOP_MAX = 175;
const CASE_TOP_PER_PT = 11.6;

export function caseTopDepth(width: number): number {
  return Math.min(CASE_TOP_MAX, CASE_TOP_PER_PT * plateType(width));
}

/** How much of the printed matter the plate has room for. */
export type PrintLevel = 'none' | 'min' | 'mid';

/** How long the sheet takes to travel, per direction, in milliseconds. */
export interface LidTravel {
  /** Drawing out — the travel anybody watches. */
  open: number;
  /** Putting away — what a misclick costs. Nothing waits on it. */
  shut: number;
}

/**
 * The travel times the timers fall back on when the stylesheet has not been
 * read — which is to say, what every DOM test actually runs on.
 *
 * These mirror `--lid-ms` / `--lid-ms-shut` in tokens.css and exist as an
 * export for one reason: jsdom loads no stylesheet, so `getComputedStyle`
 * answers `''` for both tokens and these constants are the whole of the timing
 * a test sees. A test that waits on the travel imports this and adds its own
 * margin, rather than hard-coding a number that silently races the token the
 * next time the token moves.
 */
export const LID_TRAVEL_MS: LidTravel = { open: 340, shut: 340 };

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
  // A plate too shallow to print on and too thin to press is not a plate. Above
  // that floor it is exactly the deck the reflow spared — never less, because
  // whatever it declines becomes brushed aluminium between it and the faceplate
  // (see the withdrawn `PLATE_MAX` note above). The travel is still the harder
  // limit: a plate deeper than the well would hang below the hem while the
  // sheet is home, i.e. over the faceplate.
  const plate = deck >= BAY_MIN ? Math.min(deck, travel) : 0;

  const level: PrintLevel = plate === 0 ? 'none' : plate >= PRINT_MID ? 'mid' : 'min';
  // A shallow plate prints fewer things, so each of them gets a bigger share of
  // it: the alternative is a floor-sized legend with a hand's width of blank
  // metal under it.
  //
  // `mid` keeps 0.13, which is what the shipped Windows plate is set in. The
  // 0.085 that went with the deleted `full` level would have made the type
  // SMALLER on a deep plate than on a shallow one, because it existed to leave
  // room for a map that is no longer printed.
  const share = level === 'mid' ? 0.13 : 0.22;
  const print = plate === 0 ? 0 : clamp(Math.min(plate * share, plateType(width)), 9, 26);
  return { travel, plate, print, level };
}

/* ---------------------------------------------------------------------------
   The printing.

   Everything here is screen-printed matter off the real case top, seen face-on
   at 1:1, and not one node in it is focusable, clickable or announced. It is
   scenery, and it says so.
   ------------------------------------------------------------------------- */

/**
 * The `-11 … GMT … +12` strip, and the only thing left in the field.
 *
 * ONE STRIP, NOT TWO, AND NO MAP. The plate used to print a GMT world map with
 * a timezone strip along each of its edges, at plate depths of 168 px and over.
 * It is gone — see the note at `buildPrint`.
 *
 * The `--t` modifier stays in the class even though there is no `--b` any more:
 * it is what `applyOrigin` selects the lit cells through, and a strip that
 * carries a lamp is worth naming precisely.
 */
function printStrip(): HTMLElement {
  return el(
    'div',
    { class: 'print__strip print__strip--t' },
    TIMEZONES.map((tz) =>
      el('span', { class: `print__tz${tz.offset === 0 ? ' print__tz--gmt' : ''}` }, [tz.label]),
    ),
  );
}

/**
 * WHAT IS PRINTED ON THE PLATE, WHICH IS NO LONGER A MAP.
 *
 * The plate used to gain a GMT world map and a second timezone strip once it
 * was 168 px deep or more. Both are gone, at every window size, by the owner's
 * decision after seeing the map drawn correctly for the first time.
 *
 * Worth recording why it survived so long unexamined: the shipped Windows build
 * runs a **158 px** plate against a `PRINT_FULL` of 168, so it was ten pixels
 * below the threshold and the map was never once drawn there. The only way it
 * had ever been seen was as a 6.8× horizontal smear, because `.print__field`
 * carried both an `aspect-ratio` and a `max-height` and the cap won. Drawn
 * properly it was still not wanted. The plate is the wordmark, the band chart
 * and one strip — which is exactly what that Windows build prints.
 *
 * `COASTLINES` and `TIMEZONES` are untouched in `worldGeometry.ts`: the
 * REGISTER's map still uses both, and this decision is about the plate only.
 */
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
    el('div', { class: 'print__field' }, [printStrip()]),
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
     * a style change on every node in it, and that may not land inside a
     * 340 ms animation.
     */
    onSettled?(open: boolean): void;
  },
): LidHandle {
  let open = false;
  let deck = 0;
  let len = 620;

  // The latches and the plate are pointer affordances for the one thing the
  // STATIONS key already does from the keyboard. In the tab ring they were
  // four identical stops — "Open the register" twice before BASS, twice after
  // RECONNECT — for one action; a keyboard user reaches the register through
  // STATIONS, `/` or Ctrl+K, and closes it with Escape. Pointer-clickable
  // still, named still, and skipped by Tab.
  const latchL = el(
    'button',
    { class: 'lip__latch', type: 'button', tabindex: '-1', 'aria-label': 'Open the register' },
    [el('span', { class: 'lip__latch-grip' })],
  );
  const latchR = el(
    'button',
    { class: 'lip__latch', type: 'button', tabindex: '-1', 'aria-label': 'Open the register' },
    [el('span', { class: 'lip__latch-grip' })],
  );

  /**
   * The bar between the two latches — and the drawer's handle, not a caption.
   *
   * It names what is inside the drawer and it spans the whole case top, so it
   * is the most drawer-like object on the screen and it is where a hand goes.
   * It was inert: `cursor: default`, no listener. Observed on the real build, a
   * naive user pressed its dead centre and recorded 3.5 s of the display in
   * which the drawer did not move a pixel; the only live parts of the bar were
   * the two 44 × 15 px grips at the extreme corners.
   *
   * A `div` rather than a third `button` on purpose. The two latches beside it
   * already carry the accessible control — same job, same `aria-label`, both in
   * the tab ring — and a keyboard that had to step over three identical
   * "Open the register" stops to leave the case top would be a worse ring than
   * the one this fixes. So this is the pointer's half of a control that is
   * already announced, exactly as the plate's own `.lid__hit` is, and it is not
   * focusable and not announced twice.
   */
  const lipTitle = el('div', { class: 'lip__title' }, [
    el('span', { class: 'silk silk--xs' }, ['GMT World Map · World Station Register']),
  ]);

  const lip = el('div', { class: 'lip mat-alu' }, [
    textureLayer('alu'),
    el('div', { class: 'lip__channel' }, [el('div', { class: 'lip__antenna' })]),
    latchL,
    lipTitle,
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

  /* ---------------------------------------------------------------------------
     THE LIT CELL.

     The plate's timezone strip is screen-printed matter and stays that way:
     `printStrip()` is not restructured and `.print__tz--gmt` is not touched. GMT
     is where it is because a real lid has it engraved there, and engraving does
     not move when the receiver is retuned.

     What the receiver adds is a LAMP behind the correct cell — amber, because on
     this product cyan is printing and amber is measured data (the density dots,
     the on-air blip, the entry under the hand). One class, applied to the same
     cell in both strips, so the reading survives the plate losing its bottom
     strip and its map at shallow print levels.

     The unknown state is DARK. Not GMT. A cell parked on the meridian because
     nothing is known is the silent fallback that looks like a fact, which Law 4
     names as a defect — and it would be a wrong reading in a lit box, which is
     worse than no reading at all.
     ------------------------------------------------------------------------- */

  /**
   * Both printed strips' cells, in `TIMEZONES` order.
   *
   * Read off the built tree rather than collected during the build, so the
   * printing's own structure is untouched by this feature existing.
   */
  const tzCells: HTMLElement[][] = [
    Array.from(print.querySelectorAll<HTMLElement>('.print__strip--t .print__tz')),
  ];

  /** The station the strip is about, and when its origin was last resolved. */
  let originStation: StationRef | undefined;
  let originId: string | undefined;
  let originAt = 0;
  /** What the strip currently SHOWS. The DOM is touched only when this moves. */
  let originKey = '';

  /**
   * Light the cell the subject station transmits from.
   *
   * **`setPlayback` fires about ten times a second**, so this is a comparison
   * first and a write second. Same station, resolved less than a minute ago: two
   * comparisons and out, before any formatter is asked anything. Otherwise the
   * origin is resolved, a key is built out of what would be lit, and the DOM is
   * touched only if that key moved — which across a whole track is once.
   *
   * A minute is the right staleness window because the only thing that can
   * change for an unchanged station is the wall clock crossing a DST boundary,
   * and re-resolving inside sixty seconds of that is close enough for a lamp.
   *
   * `force` is for `setRows`: that is the moment `learnGeography` may have
   * promoted the subject from "nothing known" to "placed by its country", and
   * the guard would otherwise hold the old answer for the rest of the minute.
   */
  function applyOrigin(station: StationRef | undefined, force = false): void {
    const id = station?.id;
    const now = Date.now();
    if (!force && id === originId && now - originAt < 60_000) return;
    originId = id;
    originStation = station;
    originAt = now;

    const origin = register.originOf(station);
    /* THE CLOCK NEEDS A COUNTRY. THE MARKER NEEDS A POSITION. THEY ARE NOT THE
       SAME QUESTION, AND COUPLING THEM PUT 47 689 STATIONS IN THE DARK.

       This used to resolve the zone from `originOf`, so a station whose country
       the directory publishes but whose position it does not — and whose
       country the register had not yet learned a centroid for — lit nothing at
       all, even though `resolveZone('PL')` answers Warsaw perfectly and
       exactly. Measured over the directory: **47 689 of 62 038 stations carry a
       country code and no position.**

       So the country comes off the station, and only a position the register
       BELIEVES is allowed to refine it. `originOf` hands back `from: 'country'`
       for a fix it has disowned (see `fixRejected`), and that fix must not pick
       a band — it is the number that was wrong in the first place. */
    const fix = origin?.from === 'fix' ? origin : null;
    const res = resolveZone(station?.countryCode ?? origin?.countryCode, fix?.lon, fix?.lat);
    const offset = res ? offsetMinutes(res.zone, new Date(now)) : null;
    const lamp = offset === null ? null : stripLamp(offset);
    const cells: readonly number[] = lamp && lamp.kind !== 'off-strip' ? lamp.cells : [];
    // A fractional zone is BETWEEN two printed cells and says so by lighting
    // both at less than full — which is exactly true, and keeps the plate
    // wordless as it is printed.
    const half = lamp?.kind === 'between';
    /* THE `≈` AND THE DIM BELONG TO THE CLOCK, NOT TO THE DOT.

       They used to key off `origin.from === 'country'` — the *position's*
       provenance. But what is approximate here is the ZONE RESOLUTION, and
       inside a split country that is a meridian guess however exact the
       coordinates are. A Phoenix station with a real fix therefore lit `-6` at
       full brightness, undimmed, reading an hour off. `resolveZone` reports its
       own exactness and this reads that. */
    const dim = !!res?.approximate;
    /* PAST THE END OF THE PRINTED SCALE IS A STATE, NOT A SILENCE.

       `stripLamp` already distinguishes "beyond the strip" from "unknown"; the
       caller used to collapse the two into the same dark plate. New Zealand is
       +13 for the whole NZDT season — **240 stations dark from September to
       April** — and Tonga, Tokelau and Samoa are +13 all year and could never
       be lit at all. The case is screen-printed `-11 … +12` and cannot grow a
       cell, so the end cell is lit and marked as an edge the reading ran past.
       That is readable as "further than this strip goes", which is true, and it
       is not the same picture as nothing known. */
    const over = offset !== null && cells.length === 0 && offset > STRIP_MAX_HOUR * 60;
    const under = offset !== null && cells.length === 0 && offset < STRIP_MIN_HOUR * 60;
    const edge: readonly number[] = over ? [STRIP_MAX_HOUR] : under ? [STRIP_MIN_HOUR] : [];

    const key =
      cells.length === 0 && edge.length === 0
        ? ''
        : `${cells.join(',')}|${edge.join(',')}|${half ? 'h' : ''}${dim ? 'd' : ''}`;
    if (key === originKey) return;
    originKey = key;
    for (const strip of tzCells) {
      for (let i = 0; i < strip.length; i++) {
        const hour = TIMEZONES[i]!.offset;
        const on = cells.includes(hour);
        const past = edge.includes(hour);
        setFlag(strip[i]!, 'is-lit', on || past);
        setFlag(strip[i]!, 'is-lit--half', on && half);
        // Which side of the pair this cell is: the lamp sits on the line
        // BETWEEN them, so each half is lit from its shared edge and the
        // printed rule across that one boundary goes out. `cells` is ordered
        // low then high by `stripLamp`.
        setFlag(strip[i]!, 'is-lit--half-l', half && hour === cells[0]);
        setFlag(strip[i]!, 'is-lit--half-r', half && hour === cells[1]);
        setFlag(strip[i]!, 'is-lit--dim', (on || past) && dim);
        setFlag(strip[i]!, 'is-lit--over', past && over);
        setFlag(strip[i]!, 'is-lit--under', past && under);
      }
    }
  }

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
  // travel, on a machine whose Chromium reports SwiftShader for everything.
  // Two hundred milliseconds is most of either 340 ms travel.
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
    tabindex: '-1',
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
  // Toggles rather than opens, like the latches it sits between and unlike the
  // plate: the bar is on the case top, which the sheet never covers, so it is
  // on screen in both states and a handle that only works in one of them is
  // half a handle.
  lipTitle.addEventListener('click', toggle);
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
   * The travel times as the stylesheet defines them — 1 ms in both directions
   * under prefers-reduced-motion, so the timers follow suit.
   *
   * Read once and cached. `getComputedStyle` forces a style flush, and a style
   * flush is the one thing a click on this control must not pay for: the whole
   * point of the rewrite is that the click does nothing but write a transform.
   * The only thing that changes these tokens at runtime is the motion
   * preference, so that is what re-reads them.
   */
  function readMs(name: string, fallback: number): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return raw.endsWith('ms') ? n : n * 1000;
  }
  function readDurations(): LidTravel {
    return {
      open: readMs('--lid-ms', LID_TRAVEL_MS.open),
      shut: readMs('--lid-ms-shut', LID_TRAVEL_MS.shut),
    };
  }
  let travelMs = readDurations();
  const stiller = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const onMotionPref = (): void => {
    travelMs = readDurations();
  };
  stiller?.addEventListener?.('change', onMotionPref);

  /**
   * Nothing that is not drawn out may be focused, clicked or announced.
   *
   * `inert` is the real seal and it is expensive: it is a style change on every
   * node of the subtree it covers, and this subtree is the register — measured
   * at **128–187 ms of blocked main thread** to toggle, at 1280×820, on the
   * machine this ships to. That cannot happen inside the travel — 340 ms in
   * each direction — so it does not: the seal is applied at the END of the closing
   * travel and lifted at the END of the opening one, and the two cheap halves
   * of it — the accessible hidden flag, and `pointer-events`, which the
   * `data-open` rule in lid.css already carries — take effect on the click
   * itself.
   *
   * The gap is a moving sheet — 340 ms on the way home — during which a
   * keyboard could in principle still reach a control on it, so a close also
   * takes focus back off the sheet by hand rather than waiting for `inert` to
   * do it.
   */
  function sealNow(): void {
    setAttr(panel, 'aria-hidden', String(!open));
  }
  /**
   * WHY THE FOCUS IS PUT BACK RATHER THAN THROWN AWAY.
   *
   * Taking the focus off the sheet forces a synchronous style and layout pass
   * over the whole document, and while the sheet is closing the register is
   * still rendered — 8 675 layout objects. Traced inside the close's own click
   * task: `Blink.ForcedStyleAndLayout` **92.9 ms**, with no JS layout read
   * anywhere in the handler. It is the focus move itself, and `preventScroll`
   * is what removes it — there is genuinely nothing to scroll, the plate is
   * where it always is.
   *
   * It could not simply be dropped. For the length of the put-away the sheet is
   * `aria-hidden` and `pointer-events: none`, but a keyboard could still walk
   * into it, and `inert` — the real seal — does not land until the settle. So
   * the focus is not thrown away, it is put back on the control that will draw
   * the sheet out again, which is where a hand that just closed it would look
   * for it anyway.
   *
   * WHAT THIS DID **NOT** FIX, AND WHAT SINCE HAS.
   *
   * This note used to end by claiming the put-away presents "**4 frames**
   * (median)" with `preventScroll`, against 0 with a bare `blur()`. That was
   * false, and it stays retracted: re-measured on the shipping build,
   * `Display::DrawAndSwap`, fourteen consecutive closes, **0 presented frames,
   * 14 of 14**. Reproduced here, six closes, 0/0/0. The focus move is not what
   * animates the put-away and never was — deferring `hit.focus` out of the
   * click task entirely changed nothing (288/311/270/270/285/281 ms of click
   * task, 0 frames), and closing with Escape blocks for only 94-100 ms and
   * still presented 0.
   *
   * What actually killed it was two things, both now fixed, neither of them
   * here:
   *
   *   · The stow ran inside the settle, at `shut + 40` = 240 ms from the click,
   *     which is 130-580 ms BEFORE the travel has been measured to start. That
   *     un-render is ~3 300 nodes and it blocked the style pass that was going
   *     to begin the travel. It is deferred now — see `armStow`.
   *   · The budget was shorter than the lag. Click → `transitionstart` on a
   *     close is 370-820 ms, so a 200 ms transition was fully elapsed before it
   *     was ever committed: `transitionstart` and `transitionend` arrived in
   *     the same millisecond with `elapsedTime: 0.2`. `--lid-ms-shut` is 340
   *     now — see the put-away note in tokens.css.
   *
   * Measured after both, six closes per run, two runs: **1/7/9 and 0/9/9
   * presented frames** over real 126-359 ms travels, with the opening travel
   * unchanged. Eleven of twelve closes animate.
   *
   * The focus move stays as written. It is not free — `Blink.ForcedStyleAndLayout`
   * 92.9 ms inside the close's own click task, which `preventScroll` is what
   * removes — but for the length of the put-away the sheet is only
   * `aria-hidden` and `pointer-events: none`, `inert` does not land until the
   * settle, and a keyboard could still walk into it. So the focus is not thrown
   * away, it is put back on the control that will draw the sheet out again.
   */
  function dropFocus(): void {
    if (open || !panel.contains(document.activeElement)) return;
    // Onto the control that will draw the sheet again, rather than nowhere:
    // `preventScroll` because the whole of the expense here is the layout the
    // browser does to scroll a newly focused element into view, and there is
    // nothing to scroll — the plate is where it always is. Falls back to a bare
    // blur if the plate is not focusable at this instant (a window too shallow
    // to print one).
    hit.focus({ preventScroll: true });
    if (panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }
  /**
   * ORDER MATTERS HERE, AND IT IS WORTH 100+ ms ON EVERY CLOSE.
   *
   * `inert` and `content-visibility` are both style changes over the same
   * ~3 300-node subtree, and they land in the SAME style pass. Which one is
   * written first therefore decides how much work that pass does:
   *
   *   · closing, stow first — `content-visibility: hidden` takes the register
   *     out of rendering, so the `inert` flag that follows is written onto a
   *     subtree Blink has already stopped computing style for. Traced across
   *     the settle, one close each way, `Layout` totalled 416 ms with `inert`
   *     first and 326 ms with the stow first. That is one sample per arm and
   *     the difference is not far outside this machine's run-to-run spread, so
   *     it is recorded as an ordering that cannot be worse rather than as a
   *     measured win: the same two writes, in the order that gives the style
   *     pass less to do.
   *   · opening, un-stow first — there is no saving to be had (the subtree has
   *     to be rendered either way), but writing it first keeps the two halves
   *     in one pass rather than two.
   */
  function sealLatched(): void {
    // …and the register stops being rendered at all. See `[data-stowed]` in
    // lid.css: rendered while the receiver plays, it cost 18 points of a core.
    // On the way home that un-render is ARMED rather than run — see `armStow`:
    // run here it is 100+ ms of blocked main thread landing before the closing
    // travel has begun, and it is what made the put-away present zero frames.
    if (open) warmTray();
    else armStow();
    panel.toggleAttribute('inert', !open);
  }

  /* ---------------------------------------------------------------------------
     WARMING THE TRAY, WHICH IS WHY THE DRAWER MOVES AT ALL.

     `content-visibility: hidden` on the tray is a measured requirement — left
     rendered with the sheet home, the register cost 18 points of a core — and it
     stays. But un-stowing it is ~350-400 ms of style, layout and paint for a
     3 000-node subtree, and the shipped path paid that ON THE CLICK.

     Measured on this build, register live, six cycles per candidate: with the
     un-stow inside the click, the transition ran 0 times out of 6 at the shipped
     200 ms and 1 in 6 at 280 ms. The transform write and the end-of-travel
     `data-swing='false'` coalesced into one style pass, so there was no
     before-change style to transition from and the sheet TELEPORTED. Only 420 ms
     animated reliably, and only because it outlasted the block — which is buying
     an animation by making the user wait for it.

     So the render work is moved off the click and onto the gesture that always
     precedes it. A pointer has to cross the plate to press it and a keyboard has
     to focus it, so both of those warm the tray; by the time the press lands the
     work is already paid and the travel animates from its first frame.

     Two things this must not become:

       · A register left rendered because a pointer is parked on the plate. The
         warm is capped, and any press-less stay past the cap goes back to the
         stowed baseline. That cap is what protects the 18-point measurement.
       · A path that silently does not animate. Where nothing warned us — a
         programmatic open from the faceplate's STATIONS key or Ctrl+K — the
         un-stow is COMMITTED before the transform is written, so the two cannot
         land in one style pass. That travel starts late, but it does run.
     ------------------------------------------------------------------------- */

  /** Is the register rendered right now? Mirrors `data-stowed`. */
  let warm = false;
  /** Puts a warmed-but-unpressed tray back to the stowed baseline. */
  let coolTimer = 0;
  /** How long a hover may hold the register rendered without a press. */
  const WARM_CAP_MS = 8000;
  /** How long after the pointer leaves before the tray goes back. */
  const COOL_MS = 400;
  /**
   * The hard end of THIS visit's warm, as a clock reading.
   *
   * The cap used to be a timer alone, and a timer alone does not hold: the
   * `pointermove` re-arm below fired the instant it expired, so any pointer
   * that was moving — which is the ordinary state of a hand — held the register
   * rendered for ever. Measured cycle: `false@254ms → true@8251 → false@8504 →
   * true@32501`, i.e. cold for a quarter of a second in every eight, at
   * **+14.9 points of a core** for the rest of it.
   *
   * A deadline holds where a timer does not. It is set once, when the pointer
   * ARRIVES on the plate, and no amount of moving about on the plate can push
   * it out; only leaving and coming back is a new visit and a new eight
   * seconds. `.lid__hit` is the whole 1280 × 175 top band, so "the pointer is
   * somewhere over the plate" is far too weak a signal to keep paying for.
   */
  let warmUntil = 0;

  function warmTray(): void {
    window.clearTimeout(stowTimer);
    stowTimer = 0;
    if (warm) return;
    warm = true;
    setAttr(root, 'data-stowed', 'false');
  }
  function coolTray(): void {
    window.clearTimeout(coolTimer);
    coolTimer = 0;
    window.clearTimeout(stowTimer);
    stowTimer = 0;
    if (!warm) return;
    warm = false;
    setAttr(root, 'data-stowed', 'true');
  }
  /**
   * THE STOW COMES OFF THE CLOSE'S CRITICAL PATH, AND IT IS WHY THE PUT-AWAY
   * ANIMATES AT ALL.
   *
   * `coolTray` un-renders ~3 300 nodes. It used to run inside `sealLatched`,
   * i.e. inside the settle, which is armed at `shut + 40` = 240 ms from the
   * click — and the close's travel has been measured to START at 460-820 ms
   * from the click. So the un-render landed BEFORE the travel and blocked the
   * main thread across the style pass that was going to begin it: by the time
   * the transition was committed its whole 200 ms was already spent, and
   * `transitionstart` and `transitionend` arrived in the same millisecond with
   * `elapsedTime: 0.2`.
   *
   * Measured on this build, six closes per arm, one session each, counting
   * `Display::DrawAndSwap` between the panel's own `transitionstart` and
   * `transitionend` — real pointer press to open, Escape to close, receiver
   * idle, register printed from the live directory:
   *
   *   | close                          | presented frames min/med/max |
   *   |--------------------------------|------------------------------|
   *   | stow inside the settle         | 0 / 0 / 0                    |
   *   | stow neutralised entirely      | 0 / 2 / 3                    |
   *   | stow deferred past the travel  | see the table in tokens.css  |
   *
   * The middle row is the diagnosis, not a proposal: it was produced by
   * overriding `content-visibility` from the harness, which throws away the
   * measurement the stow exists for (+16.6 renderer points while playing). The
   * stow therefore stays and only its TIMING moves — far enough past the settle
   * that the travel is over before the un-render starts. Nothing else waits on
   * it: the register is already `inert` and `aria-hidden` by then, so for those
   * few hundred milliseconds it is an unreachable subtree that is still
   * rendered, which is exactly what it is for the whole of the travel anyway.
   */
  const STOW_AFTER_MS = 420;
  let stowTimer = 0;
  function armStow(): void {
    window.clearTimeout(stowTimer);
    stowTimer = window.setTimeout(() => {
      stowTimer = 0;
      if (!open) coolTray();
    }, STOW_AFTER_MS);
  }
  /** Warm now; go back on our own if the press never comes. */
  function warmFor(ms: number): void {
    window.clearTimeout(coolTimer);
    warmTray();
    coolTimer = window.setTimeout(() => {
      if (!open) coolTray();
    }, ms);
  }

  /** A pointer or a focus has just arrived: this is a new visit. */
  function beginVisit(): void {
    warmUntil = Date.now() + WARM_CAP_MS;
    warmFor(WARM_CAP_MS);
  }
  /** It has gone away: the visit is over and the next arrival starts a new one. */
  function endVisit(): void {
    warmUntil = 0;
    window.clearTimeout(coolTimer);
    coolTimer = window.setTimeout(() => {
      if (!open) coolTray();
    }, COOL_MS);
  }

  // The plate's press is the only thing on the sheet a pointer can reach while
  // it is home, so crossing it is the one gesture that always precedes an open.
  hit.addEventListener('pointerenter', beginVisit);
  hit.addEventListener('focus', beginVisit);
  hit.addEventListener('pointerleave', endVisit);
  hit.addEventListener('blur', endVisit);
  // Moving on the plate re-arms a warm that cooled early — but never past this
  // visit's deadline. See `warmUntil`: without that ceiling this listener is
  // what made the cap unenforceable.
  hit.addEventListener('pointermove', () => {
    if (warm) return;
    const left = warmUntil - Date.now();
    if (left > 0) warmFor(left);
  });

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
    // rather than an empty tray that fills in on arrival. Normally a no-op by
    // now: the hover over the plate warmed it several hundred milliseconds ago.
    if (open) warmTray();
    panel.style.transform = `translate3d(0, ${open ? Math.round(frame.travel) : 0}px, 0)`;
  }

  /* ---------------------------------------------------------------------------
     WHEN THE SETTLE HAPPENS, WHICH IS NOT WHEN THE CLICK HAPPENED.

     `sealLatched()` is `inert` on the register — a style change on every one of
     its ~3 300 nodes, measured at 128-187 ms of blocked main thread — and it may
     not run while the sheet is moving. It used to be armed at `travel + 40 ms`
     FROM THE CLICK, on the assumption that the travel begins on the click.

     It does not. Measured on the real build with the tray warm: the click chain
     writes the transform at +112 to +127 ms, and the transition does not start
     until +233 to +304 ms — the style pass that begins it is queued behind the
     work the press itself caused. A settle armed at +320 ms therefore landed
     between 20 and 90 ms INTO a 280 ms travel, blocked the main thread for the
     rest of it, and the browser reported `transitioncancel`.

     So the click's timer is only a backstop now. When the browser says the
     transition has really started, the countdown is restarted from there, which
     is the only moment that actually knows when the sheet will arrive. jsdom
     fires no transition events and no transitions, so there the backstop is the
     whole mechanism and the timing is exactly what it was.

     THE HALF THAT REPAIR MISSED, WHICH IS WHY THE PUT-AWAY NEVER ANIMATED.

     Restarting the countdown from `transitionstart` covers the case where the
     travel starts BEFORE the backstop lands. The close is the other case. Its
     click→`transitionstart` lag was measured at **662 ms** with a station
     playing, against a backstop of `shut + 40` = 240 ms, so the order inverts:

       click → focusTimer fires → `travelling = false`, the settle runs →
       `transitionstart` finally dispatches → `onTravelStart` sees
       `travelling === false` and returns without re-arming → the stale
       `swingTimer` lands **12 ms into the travel**, writes
       `data-swing='false'`, which removes the transition declaration itself,
       and Chromium reports `transitioncancel`.

     Observed on 3 of 4 consecutive closes, with `swing=false` and
     `transition-duration: 0s` read off the panel at the cancel. That is why the
     put-away presented zero frames: not raster, not scheduling — the travel was
     being deleted 12 ms after it began.

     So `data-swing` is now governed by the sheet's own motion rather than by
     the settle's clock. A `transitionstart` on the panel's transform means the
     sheet IS moving, whatever the settle believes, and re-arms the swing timer
     unconditionally; a `transitionend` means it has arrived and drops
     `data-swing` immediately rather than 60 ms later on a timer. The settle
     itself keeps its `travelling` guard, because a settle that runs twice would
     seal a panel that is on its way out.

     AMENDED: THAT WAS NECESSARY AND IT WAS NOT SUFFICIENT. "That is why the
     put-away presented zero frames" claims more than the repair delivered —
     with the cancel fixed, the close still presented 0/0/0 over six traced
     closes. Two more things were wrong and both are fixed elsewhere: the STOW
     ran inside this settle, ahead of a travel that starts 370-820 ms after the
     click (see `armStow`), and the 200 ms budget was shorter than that lag, so
     the transition was spent before it was committed (see `--lid-ms-shut` in
     tokens.css). With all three, the same six closes present 1/7/9 and 0/9/9.
     ------------------------------------------------------------------------- */

  /** A travel is in flight — its settle has not run yet. */
  let travelling = false;
  /** Which type slot the gesture that started this travel asked for. */
  let focusField: RegisterSearchField = 'subject';

  function armSettle(): void {
    window.clearTimeout(focusTimer);
    window.clearTimeout(swingTimer);
    // Which travel is running decides how long to wait. Reading the wrong one
    // would either land the seal inside a moving sheet or leave the register
    // unfocusable for the difference between the two.
    const ms = open ? travelMs.open : travelMs.shut;
    focusTimer = window.setTimeout(() => {
      travelling = false;
      sealLatched();
      // The chassis seals or unseals the faceplate here, in the same task, so
      // the two halves of "only one surface is reachable" can never be applied
      // a frame apart.
      handlers.onSettled?.(open);
      if (open) register.focusSearch(focusField);
    }, ms + 40);
    armSwing(ms);
  }

  /**
   * The backstop that ends the swing, and nothing else may end it early.
   *
   * Separate from `armSettle` because the two answer different questions:
   * `armSettle` asks "when has the sheet arrived, so the expensive work may
   * run?", and this asks "is the sheet still moving?". Only the second one may
   * be restarted by a `transitionstart` that arrives after the settle has
   * already given up on it.
   */
  function armSwing(ms: number): void {
    window.clearTimeout(swingTimer);
    swingTimer = window.setTimeout(() => setAttr(root, 'data-swing', 'false'), ms + 60);
  }

  const onTravelStart = (ev: Event): void => {
    const moved = ev as TransitionEvent;
    if (moved.target !== panel || moved.propertyName !== 'transform') return;
    // Unconditional: the sheet is moving now. A `data-swing` dropped while it
    // moves takes the transition declaration with it and the browser cancels
    // the travel — see the note above, which is the whole of why the put-away
    // presented no frames.
    armSwing(open ? travelMs.open : travelMs.shut);
    // The settle keeps its guard: if it has already run, running it again would
    // seal a panel that is on its way out.
    if (travelling) armSettle();
  };
  const onTravelEnd = (ev: Event): void => {
    const moved = ev as TransitionEvent;
    if (moved.target !== panel || moved.propertyName !== 'transform') return;
    // Arrived. The browser knows before any clock does, so the swing ends here
    // rather than 60 ms later on a backstop that only exists for jsdom and for
    // a transition that never started.
    window.clearTimeout(swingTimer);
    setAttr(root, 'data-swing', 'false');
  };
  panel.addEventListener('transitionstart', onTravelStart);
  panel.addEventListener('transitionend', onTravelEnd);

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
      // Out of the ring in both states; see the note where they are built.
      sealNow();

      window.clearTimeout(swingTimer);
      window.clearTimeout(focusTimer);
      // The travel is the ONLY time the sheet's transform is animated. While it
      // merely tracks the window it follows it exactly, because a transition on
      // a dragged value is a lag and a lagging sheet overpaints the faceplate.
      setAttr(root, 'data-swing', 'true');
      setAttr(root, 'data-open', String(open));
      if (open && !warm) {
        // Nothing warned us this open was coming — the faceplate's STATIONS key,
        // Ctrl+K, or a host calling `setOpen` outright. Un-stowing and moving in
        // one task is exactly the coalescing that made the sheet teleport, so
        // the un-stow is COMMITTED first: reading a layout property forces the
        // style pass that renders the tray, and the transform written after it
        // therefore has a settled before-change style to transition from.
        //
        // This blocks for as long as the render takes, which is the whole
        // argument for warming on hover instead. It is the floor for a path that
        // gets no warning, not the shipped path.
        warmTray();
        void panel.offsetHeight;
      }
      // Synchronously, in the same task as the click. The old build needed two
      // frames here because the panel went from `visibility: hidden` to visible
      // in the same style pass that moved it, which cancels the transition. The
      // sheet is never hidden now — it is simply inside the slot — so with the
      // tray already rendered there is nothing to stage and the motion starts on
      // the very next frame.
      applyTravel();
      // After the transform, because it is the expensive half of the seal and
      // the transform that starts the travel should not be queued behind it.
      // See `dropFocus`: this is what the close's animation cost.
      dropFocus();

      // Everything expensive happens after the sheet has ARRIVED, and the timer
      // that decides when that is now starts from the travel rather than from
      // the click. See `armSettle`.
      focusField = focus;
      travelling = true;
      armSettle();
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
    setRows(rows, state) {
      register.setRows(rows, state);
      // Rows are what `learnGeography` learns from, so this is the moment a
      // subject with no coordinates of its own may have become placeable by its
      // country. Forced past the staleness guard for exactly that reason.
      applyOrigin(originStation, true);
    },
    setScope: (scope) => register.setScope(scope),
    setAir: (id, air) => register.setAir(id, air),
    setPlayback(state) {
      register.setPlayback(state);
      // `PlaybackState.station` already arrives here, so the plate needs no
      // public setter of its own — a `LidHandle.setOrigin()` would be a method
      // with no job `index.ts` does not already do.
      applyOrigin(state?.station);
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      panel.removeEventListener('transitionstart', onTravelStart);
      panel.removeEventListener('transitionend', onTravelEnd);
      stiller?.removeEventListener?.('change', onMotionPref);
      travelling = false;
      window.clearTimeout(swingTimer);
      window.clearTimeout(focusTimer);
      window.clearTimeout(coolTimer);
      window.clearTimeout(stowTimer);
      register.destroy();
    },
  };
}
