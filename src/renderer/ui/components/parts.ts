/** Small panel hardware: preset jewels, lever switches, piano keys, buttons,
 *  lamps and the perforated grille. Each one does exactly one real job. */

import type { LogEntry, Preset } from '../../../shared/contracts';
import { el, pressAndHold, setAttr, setFlag, setText, silk } from '../dom';
import { mountBezel, mountGrille, paintJewel } from '../materials';
import { displayStationName } from '../stationName';

/* ---------------------------------------------------------------------------
   C / B / P preset jewels.

   Click recalls; press and hold stores, with a teal ring filling round the
   bezel so the store is a deliberate act rather than a mis-click. The jewel's
   colour is fixed by its slot (cream / amber / deep red, per the PSP panel);
   what changes is whether there is a lamp behind it.

   THREE STATES, NOT TWO. The occupancy treatment used to be `opacity: .85 → 1`
   on the glass — photometry across a real store put the mean RGB of the jewel
   at 65.6 before and 68.9 after, a 3.04/255 luminance step that is invisible at
   8× magnification, let alone at a desk. So storing a station produced no
   evidence that anything had been stored, and the panel could not answer "which
   of these three has something in it" at all.

   The states are now the three a real receiver has, and they are distinguished
   by the mechanism the panel already owns rather than by a percentage:

     empty     unlit glass over a dark bore, and a blank paper slip
     stored    the lamp behind the jewel is ON, and the slip is written on
     on air    the lamp is on AND it throws light back onto the panel

   The written slip is the part that makes this legible from across the room and
   is also the honest answer: a preset bank on a real receiver has a strip of
   paper under it with the station's name in pencil.
   ------------------------------------------------------------------------- */

const SLOTS: Preset['slot'][] = ['C', 'B', 'P'];
const HOLD_MS = 620;

/**
 * HOLDING A KEY IS HOLDING THE KEY.
 *
 * The panel is silkscreened PRESS RECALL · HOLD TO STORE and the jewel's
 * accessible name said "hold to store", and from the keyboard neither was true:
 * `pressAndHold` bound `keydown` alone and fired RECALL on the first one, so
 * holding Enter on a focused jewel for 2.04 s produced 34 keydown events, a
 * keyup, three dozen recalls of the same station and nothing stored. There WAS
 * a keyboard route — Shift+Enter — and it appeared in no label, no legend and
 * no help anywhere in the product. A gesture that only the source code knows is
 * not a gesture.
 *
 * So the jewel does its own key handling, and it is the same gesture the hand
 * makes with a mouse: the key goes down, the teal ring fills round the bezel,
 * and at HOLD_MS the slot is written. Let go early and it is a RECALL. The
 * autorepeat that used to fire thirty-four recalls is now what it looks like —
 * one continuous press — and Shift+Enter survives as the impatient form, now
 * that it is printed on the register's legend beside the rest of the keys.
 *
 * It is installed BEFORE `pressAndHold`, and stops the event dead, because
 * `pressAndHold`'s own `keydown` would otherwise recall on the way past. Same
 * element, so registration order is firing order, and
 * `stopImmediatePropagation` is what "the key has already been dealt with"
 * means between two listeners on one node.
 */
function keyHold(
  target: HTMLElement,
  opts: { holdMs: number; onClick(): void; onHold(): void; onProgress(t: number): void },
): () => void {
  let timer = 0;
  let raf = 0;
  let start = 0;
  /** A key is down and has not yet become a store. */
  let down = false;
  let stored = false;

  const clear = (): void => {
    if (timer) window.clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0;
    raf = 0;
    down = false;
    opts.onProgress(0);
  };

  const isActivation = (ev: KeyboardEvent): boolean => ev.key === 'Enter' || ev.key === ' ';

  const onDown = (ev: KeyboardEvent): void => {
    if (!isActivation(ev)) return;
    // Ours from here: nothing else on this node gets to interpret the key.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    // Space would otherwise scroll the panel, and the whole gesture is a hold.
    if (ev.shiftKey) {
      // The impatient form. No wait, no ring — it is a keystroke, not a hold.
      clear();
      stored = true;
      opts.onHold();
      return;
    }
    // Autorepeat is the key still being held, not a second press.
    if (ev.repeat || down) return;
    down = true;
    stored = false;
    start = performance.now();
    timer = window.setTimeout(() => {
      timer = 0;
      stored = true;
      clear();
      opts.onHold();
    }, opts.holdMs);
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / opts.holdMs);
      opts.onProgress(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const onUp = (ev: KeyboardEvent): void => {
    if (!isActivation(ev)) return;
    ev.stopImmediatePropagation();
    const wasDown = down;
    clear();
    // A store has already answered for this press; letting go must not then
    // also recall it.
    if (wasDown && !stored) opts.onClick();
    stored = false;
  };

  /* Focus can leave under a held key — Tab, a click elsewhere, the lid opening
     over the panel — and the keyup then never arrives. Without this the ring
     sits half-filled for ever and the next press starts from a stale state. */
  const onBlur = (): void => {
    clear();
    stored = false;
  };

  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  target.addEventListener('blur', onBlur);

  return () => {
    clear();
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    target.removeEventListener('blur', onBlur);
  };
}

/** Bezel and glass diameters, CSS px. The glass is seated 4px inside the ring. */
const JEWEL_D = 26;
const JEWEL_GLASS_D = 18;
/** Characters of station name a paper slip that narrow can carry. */
const SLIP_CHARS = 11;

export interface PresetsHandle {
  root: HTMLElement;
  update(presets: Preset[], activeStationId: string | undefined, powered: boolean): void;
  destroy(): void;
}

export function createPresets(handlers: {
  onRecall(slot: Preset['slot']): void;
  onStore(slot: Preset['slot']): void;
}): PresetsHandle {
  const cells = new Map<
    Preset['slot'],
    { wrap: HTMLElement; hold: HTMLElement; btn: HTMLElement; slip: HTMLElement }
  >();
  const glasses = new Map<Preset['slot'], HTMLCanvasElement>();
  const lastLamp = new Map<Preset['slot'], boolean>();
  const occupied = new Map<Preset['slot'], boolean>();
  const disposers: (() => void)[] = [];

  const bank = el('div', { class: 'presets' });
  /* Hold-to-store existed only inside an aria-label, i.e. it was discoverable
     by screen-reader users and by nobody else. On a real panel the instruction
     is silkscreened next to the keys, so here it is silkscreened next to the
     keys — and it now names the gesture that actually works from a keyboard as
     well as the one that works under a finger. It said HOLD 1S, which was wrong
     twice over: the hold is 620 ms, and from a keyboard it did not work at all.
     A legend has to be checkable against the control it is printed beside. */
  const root = el('div', { class: 'presets-unit' }, [
    bank,
    el('span', { class: 'silk silk--xs presets__legend' }, ['Press Recall · Hold Or Shift+Enter To Store']),
  ]);

  for (const slot of SLOTS) {
    const hold = el('div', { class: 'jewel__hold' });
    /* The jewel is a shaded optic, not a gradient stack: a spherical cap under
       an area light with a real environment horizon, Fresnel at the silhouette,
       transmission with a path length, and a caustic ring pooling against the
       LOWER inner wall — light entering the top of a dome refracts down and
       refocuses at the bottom, so the lower edge is brighter than the middle.
       A top-lit CSS gradient does the exact opposite, which is half of why the
       old jewel read as a web button. The bezel is 16 teeth on a 26 px ring,
       not the 164 a 2.2° conic gradient was asking a 0.5 px tooth to render. */
    const bezel = el('canvas', { class: 'jewel__bezel', 'aria-hidden': 'true' });
    const glass = el('canvas', { class: 'jewel__glass', 'aria-hidden': 'true' });
    mountBezel(bezel, JEWEL_D, { r0: 0.66, pitchPx: 5.2 });
    paintJewel(glass, slot, false, JEWEL_GLASS_D);
    const btn = el(
      'div',
      {
        class: 'jewel',
        role: 'button',
        tabindex: '0',
        // Names the gesture in the words of the device the hand is on: a
        // pointer holds the jewel, a keyboard holds Enter. Both are true, both
        // are printed on the panel beside it, and both are tested.
        'aria-label': `Preset ${slot}: press to recall. Hold, or press Shift+Enter, to store`,
      },
      [
        el('div', { class: 'mx-bounce' }),
        el('div', { class: 'mx-halo' }),
        bezel,
        glass,
        hold,
      ],
    );
    glasses.set(slot, glass);
    /* The paper slip. Blank stock with a ruled line when the slot is empty —
       an empty slip still reads as "there is a place for a name here", which is
       what teaches the control. */
    const slip = el('span', { class: 'preset__slip' }, ['']);
    const wrap = el('div', { class: 'preset', 'data-slot': slot, 'data-occupied': 'false', 'data-active': 'false' }, [
      silk(slot),
      btn,
      slip,
    ]);
    /** What the two gestures do, shared, so the hand cannot get two answers. */
    const recall = (): void => {
      // Law 4: pressing an empty slot is a designed state, not a no-op. The
      // host owns the words (it is the thing that knows whether there is
      // anything to store); the slip flinches here so the answer is
      // attached to the key that was actually pressed.
      if (!occupied.get(slot)) {
        wrap.classList.remove('is-blank');
        void wrap.offsetWidth;
        wrap.classList.add('is-blank');
        window.setTimeout(() => wrap.classList.remove('is-blank'), 800);
      }
      handlers.onRecall(slot);
    };
    const store = (): void => {
      handlers.onStore(slot);
      // The confirmation is on the slip, because the slip is the thing that
      // changed: it flashes as it is written.
      wrap.classList.remove('is-stored');
      void wrap.offsetWidth;
      wrap.classList.add('is-stored');
      window.setTimeout(() => wrap.classList.remove('is-stored'), 900);
    };
    const ring = (t: number): void => {
      if (t <= 0) hold.style.removeProperty('--hold');
      else hold.style.setProperty('--hold', `${t}turn`);
    };

    // Before `pressAndHold`, deliberately. See `keyHold`.
    disposers.push(keyHold(btn, { holdMs: HOLD_MS, onClick: recall, onHold: store, onProgress: ring }));
    disposers.push(
      pressAndHold(btn, {
        holdMs: HOLD_MS,
        onClick: recall,
        onHold: store,
        onHoldProgress: ring,
      }),
    );
    cells.set(slot, { wrap, hold, btn, slip });
    occupied.set(slot, false);
    bank.append(wrap);
  }

  return {
    root,
    update(presets, activeStationId, powered) {
      for (const slot of SLOTS) {
        const cell = cells.get(slot)!;
        const preset = presets.find((p) => p.slot === slot);
        const isOccupied = !!preset;
        occupied.set(slot, isOccupied);
        setAttr(cell.wrap, 'data-occupied', isOccupied ? 'true' : 'false');
        const active = !!preset && !!activeStationId && preset.station.id === activeStationId && powered;
        setAttr(cell.wrap, 'data-active', active ? 'true' : 'false');
        // The jewel is glass either way; what changes is the lamp behind it.
        // A slot that holds a station has its lamp ON — that is what "occupied"
        // means on a receiver, and it is a whole different optic rather than a
        // few per cent of alpha. The halo is a `screen` layer rather than a
        // blurred box-shadow, so the panel's own moulding tooth stays visible
        // inside the glow instead of being painted over by an airbrushed
        // sticker; that stays reserved for the slot actually on air.
        setAttr(cell.btn, 'data-lit', active ? 'true' : 'false');
        const lamp = isOccupied;
        if (lastLamp.get(slot) !== lamp) {
          lastLamp.set(slot, lamp);
          const glass = glasses.get(slot);
          if (glass) paintJewel(glass, slot, lamp, JEWEL_GLASS_D);
        }
        setText(cell.slip, preset ? slipName(preset.station.name) : '');
        setAttr(cell.slip, 'title', preset ? preset.station.name : '');
        setAttr(
          cell.btn,
          'aria-label',
          preset
            ? `Preset ${slot}: ${preset.station.name}. Press to recall. Hold, or press Shift+Enter, to store the current station.`
            : `Preset ${slot}: empty. Hold, or press Shift+Enter, to store the current station.`,
        );
      }
    },
    destroy() {
      for (const d of disposers) d();
    },
  };
}

/** A station name cut to what fits in pencil on a slip that narrow. */
function slipName(name: string): string {
  const clean = displayStationName(name).toUpperCase();
  return clean.length > SLIP_CHARS ? `${clean.slice(0, SLIP_CHARS - 1)}…` : clean;
}

/* ---------------------------------------------------------------------------
   The logbook.

   A receiver had no way back to a station you had already heard. `memory.json`
   has persisted `lastStation` across restarts since the beginning and no
   surface ever showed it; the three presets are the only memory on the panel,
   and they only hold what you deliberately put in them — which is no use at all
   for the case that actually happens, namely that something good went past
   while you were sweeping and you would like it back.

   The idiom is the operator's log, not a playlist: a paper strip above the
   tuning scale with what you heard written on it, most recent at the left. It
   is written by the *engine*, not by the click — an entry appears when audio
   was genuinely observed from that station (Law 2), so a station that was tuned
   and never came up is not in the log claiming to have been heard.
   ------------------------------------------------------------------------- */

/** Characters of station name a log tab carries before it is cut. */
const LOG_TAB_CHARS = 16;

export interface LogbookHandle {
  root: HTMLElement;
  set(entries: LogEntry[]): void;
}

export function createLogbook(onSelect: (stationId: string) => void): LogbookHandle {
  const strip = el('div', { class: 'logbook__strip' });
  const empty = el('span', { class: 'silk silk--xs logbook__empty' }, [
    'EMPTY — STATIONS YOU HEAR ARE WRITTEN HERE',
  ]);
  const root = el('div', { class: 'logbook', 'aria-label': 'Logbook — stations heard before' }, [
    el('span', { class: 'silk silk--xs logbook__label' }, ['Log']),
    strip,
    empty,
  ]);

  let printed = '';

  return {
    root,
    set(entries) {
      // The key is what is actually printed on the strip; rebuilding tabs on
      // every engine tick would restart their transitions ten times a second.
      const key = entries.map((e) => `${e.station.id}@${e.heardAt}`).join('|');
      if (key === printed) return;
      printed = key;

      empty.hidden = entries.length > 0;
      strip.replaceChildren();
      for (const entry of entries) {
        const name = displayStationName(entry.station.name);
        const tab = el(
          'button',
          {
            class: 'logbook__tab',
            type: 'button',
            title: `${entry.station.name} — heard at ${clockOf(entry.heardAt)}`,
            'aria-label': `Retune ${entry.station.name}, heard at ${clockOf(entry.heardAt)}`,
          },
          [
            el('span', { class: 'logbook__time' }, [clockOf(entry.heardAt)]),
            el('span', { class: 'logbook__name' }, [
              name.length > LOG_TAB_CHARS ? `${name.slice(0, LOG_TAB_CHARS - 1)}…` : name,
            ]),
          ],
        );
        tab.addEventListener('click', () => onSelect(entry.station.id));
        strip.append(tab);
      }
    },
  };
}

function clockOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------------------------------------------------------------------
   AFC lever switch.
   ------------------------------------------------------------------------- */

export interface LeverHandle {
  root: HTMLElement;
  set(on: boolean): void;
}

export function createLever(opts: {
  label: string;
  offLabel: string;
  onLabel: string;
  ariaLabel: string;
  onChange(on: boolean): void;
}): LeverHandle {
  const sw = el(
    'div',
    { class: 'lever', role: 'switch', tabindex: '0', 'aria-checked': 'false', 'aria-label': opts.ariaLabel },
    [el('div', { class: 'lever__paddle' })],
  );

  let on = false;
  const toggle = () => {
    on = !on;
    sw.setAttribute('aria-checked', String(on));
    opts.onChange(on);
  };
  sw.addEventListener('click', toggle);
  sw.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggle();
    }
  });

  const root = el('div', { class: 'lever-unit' }, [
    el('span', { class: 'silk silk--teal silk-rule' }, [opts.label]),
    el('div', { class: 'switch-row' }, [silk(opts.offLabel), sw, silk(opts.onLabel)]),
  ]);

  return {
    root,
    set(next) {
      if (next === on) return;
      on = next;
      sw.setAttribute('aria-checked', String(on));
    },
  };
}

/* ---------------------------------------------------------------------------
   Two-position piano selector (NARROW / WIDE).
   ------------------------------------------------------------------------- */

export interface PianoHandle {
  root: HTMLElement;
  set(value: string): void;
}

export function createPiano(opts: {
  label: string;
  options: { value: string; label: string; hint: string }[];
  ariaLabel: string;
  onChange(value: string): void;
}): PianoHandle {
  const keys = new Map<string, HTMLElement>();
  const bank = el('div', { class: 'piano', role: 'radiogroup', 'aria-label': opts.ariaLabel });
  let value = opts.options[0].value;

  for (const o of opts.options) {
    const key = el(
      'button',
      { class: 'piano__key', type: 'button', 'aria-pressed': 'false', title: o.hint },
      [silk(o.label)],
    );
    key.addEventListener('click', () => {
      if (value === o.value) return;
      value = o.value;
      paint();
      opts.onChange(value);
    });
    keys.set(o.value, key);
    bank.append(key);
  }

  const paint = () => {
    for (const [v, k] of keys) k.setAttribute('aria-pressed', String(v === value));
  };
  paint();

  const root = el('div', { class: 'piano-unit' }, [
    el('span', { class: 'silk silk-rule' }, [opts.label]),
    bank,
  ]);

  return {
    root,
    set(next) {
      if (next === value || !keys.has(next)) return;
      value = next;
      paint();
    },
  };
}

/* ---------------------------------------------------------------------------
   Push button with an optional lamp beside it.
   ------------------------------------------------------------------------- */

export interface ButtonHandle {
  root: HTMLElement;
  button: HTMLButtonElement;
  lamp?: HTMLElement;
  setLamp(on: boolean, pulsing?: boolean): void;
  setDisabled(disabled: boolean): void;
}

export function createButton(opts: {
  label: string;
  ariaLabel?: string;
  lamp?: 'amber' | 'fault' | 'none';
  wide?: boolean;
  onPress(): void;
}): ButtonHandle {
  const lamp =
    opts.lamp && opts.lamp !== 'none'
      ? el('span', { class: `mini-lamp${opts.lamp === 'fault' ? ' mini-lamp--fault' : ''}` })
      : undefined;

  const button = el(
    'button',
    {
      class: `btn-bevel pushbtn${opts.wide ? ' pushbtn--wide' : ''}`,
      type: 'button',
      'aria-label': opts.ariaLabel ?? opts.label,
    },
    [lamp ?? null, silk(opts.label)],
  );
  button.addEventListener('click', () => opts.onPress());

  return {
    root: button,
    button,
    lamp,
    setLamp(on, pulsing = false) {
      if (!lamp) return;
      setFlag(lamp, 'is-on', on);
      setFlag(lamp, 'is-pulsing', pulsing);
    },
    setDisabled(disabled) {
      button.disabled = disabled;
      setFlag(button, 'is-disabled', disabled);
    },
  };
}

/* ---------------------------------------------------------------------------
   Speaker grille.

   Real punched geometry, rasterised hole by hole into one canvas: each hole
   gets its own position jitter, radius, void depth and dirt, and each carries
   the punch's rolled entry lip (bright on the upper-left, where its normal
   turns into the lamp) and the bore's lit inner wall (lower-right, because the
   beam enters over the upper-left rim and lands opposite). Getting that pair
   backwards is precisely what turns a hole into an embossed dome, which is what
   four tiled radial gradients were producing.

   The web between the holes keeps the shell's own brushed grain, because it is
   the same sheet of metal. Until the canvas lands the CSS lattice stands in.
   ------------------------------------------------------------------------- */

export function createGrille(): HTMLElement {
  const field = el('div', { class: 'grille__field mx-grille', 'aria-hidden': 'true' });
  mountGrille(field);
  return el('div', { class: 'grille', 'aria-hidden': 'true' }, [
    el('div', { class: 'grille__sheet mat-alu' }),
    field,
    el('div', { class: 'grille-cavity' }),
  ]);
}

/** A headphone socket. Drawn because the case has one; it is not a control. */
export function createJack(label: string): HTMLElement {
  return el('div', { class: 'jack-unit' }, [
    el('div', { class: 'jack', 'aria-hidden': 'true' }),
    silk(label),
  ]);
}
