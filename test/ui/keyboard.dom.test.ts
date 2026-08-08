// @vitest-environment jsdom
/**
 * WHAT THE RECEIVER DOES WITH A KEYBOARD.
 *
 * Four defects, all found on the packaged build with real XTEST key events and
 * `document.hasFocus() === true` throughout, all of the same family: a control
 * that works under a finger and does not work under a key, with nothing on the
 * panel admitting the difference.
 *
 *   · The tuning dial moved one arrow step and then jammed. Ten consecutive
 *     Right presses left `aria-valuenow` at `0.511` and `aria-valuetext`
 *     byte-identical, because a key press was a *throw* — `TuningModel.kick` —
 *     and the flywheel's detent spring engages at any speed below
 *     CAPTURE_SPEED, which a kick from rest always is. It pulled the dial back
 *     into the lock zone it had just left, whose capture radius
 *     (`slot.width * 1.35`, up to 0.074 on a real cut) is an order of magnitude
 *     wider than the 0.0085 step.
 *
 *   · With the register drawn out, Tab walked off the end of it and onto the
 *     faceplate underneath — BASS, TREBLE, VOLUME, POWER, the presets, the
 *     tuning knob — every one of them behind an opaque steel sheet and every
 *     one still operable with Enter. And closing left `document.activeElement`
 *     on BODY, so every trip through the register restarted the Tab count.
 *
 *   · PRESS RECALL · HOLD TO STORE is silkscreened on the panel and the jewel's
 *     accessible name said "hold to store", and holding Enter for 2.04 s
 *     produced 34 keydown events, a keyup and nothing stored. The gesture that
 *     did work — Shift+Enter — was named nowhere in the product.
 *
 *   · There were no shortcuts at all, and Enter in a filtered index did
 *     nothing.
 *
 * Every test below drives the shipping components through real KeyboardEvents.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SCOPE,
  emptyScope,
  type Band,
  type DialSlot,
  type GenreTag,
  type Preset,
  type RegisterIndex,
  type RegisterScope,
  type StationRef,
} from '../../src/shared/contracts';
import { TuningModel } from '../../src/renderer/ui/tuning';
import { createTuningKnob } from '../../src/renderer/ui/components/tuningKnob';
import { createPresets } from '../../src/renderer/ui/components/parts';
import { createRegister, type RegisterHandle } from '../../src/renderer/ui/components/register';
import { createLid, type LidHandle } from '../../src/renderer/ui/components/lid';

// --- the world these components run in --------------------------------------

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
vi.stubGlobal('requestIdleCallback', undefined);
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function noop(): void {};
if (!window.matchMedia) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function key(node: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(ev);
  return ev;
}
function keyUp(node: Element, k: string, init: KeyboardEventInit = {}): void {
  node.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
}

function station(over: Partial<StationRef> & { id: string }): StationRef {
  return {
    name: over.id,
    url: `http://example.invalid/${over.id}`,
    tags: [],
    popularity: 0.5,
    clickCount: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// FIX 1 — arrow tuning
// ---------------------------------------------------------------------------

/**
 * The geometry that jammed, and it is the ordinary one.
 *
 * `layoutBand` cuts lock zones between 0.012 and 0.055 wide. The renderer's
 * flywheel reads `width` as a RADIUS and reaches `width * 1.35` past it, so a
 * detent here catches anything within 0.032 of centre — against an arrow step
 * of 0.0085. Any key handler that hands the step to the physics loses.
 */
const WIDE_DETENTS: DialSlot[] = [
  { station: station({ id: 'a', name: 'Radio Kiss Kiss' }), position: 0.5, width: 0.024 },
  { station: station({ id: 'b', name: 'Radio Deejay' }), position: 0.56, width: 0.024 },
  { station: station({ id: 'c', name: 'SWR3' }), position: 0.62, width: 0.024 },
];

function dialBand(): Band {
  return {
    genre: 'pop',
    stationCount: WIDE_DETENTS.length,
    slots: WIDE_DETENTS,
    scaleMin: 2300,
    scaleMax: 2495,
    scaleUnit: 'kHz',
    scaleLabel: '120 m',
  };
}

interface DialRig {
  knob: HTMLElement;
  model: TuningModel;
  destroy(): void;
}

function dialRig(): DialRig {
  // Wired exactly as the chassis wires it: the model reports, the knob syncs.
  // Without that edge the slider's `aria-valuenow` is a decoration, and the
  // whole defect this file is about was only ever visible in `aria-valuenow`.
  let handle: ReturnType<typeof createTuningKnob> | null = null;
  const model = new TuningModel({
    onPosition(): void {
      handle?.sync();
    },
    onSettle(): void {},
  });
  model.setSlots(WIDE_DETENTS);
  handle = createTuningKnob(model);
  handle.setBand(dialBand());
  model.setPosition(0.5);
  const knob = handle.root.querySelector('[role="slider"]') as HTMLElement;
  return { knob, model, destroy: () => handle?.destroy() };
}

describe('arrow tuning moves, and keeps moving', () => {
  it('walks ten consecutive Right presses to ten distinct, strictly increasing positions', () => {
    const rig = dialRig();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      key(rig.knob, 'ArrowRight');
      seen.push(Number(rig.knob.getAttribute('aria-valuenow')));
    }
    expect(new Set(seen).size).toBe(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    rig.destroy();
  });

  it('walks ten Left presses back down, strictly decreasing', () => {
    const rig = dialRig();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      key(rig.knob, 'ArrowLeft');
      seen.push(Number(rig.knob.getAttribute('aria-valuenow')));
    }
    expect(new Set(seen).size).toBe(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThan(seen[i - 1]!);
    rig.destroy();
  });

  it('leaves no physics running, so nothing can pull the dial back after the press', () => {
    const rig = dialRig();
    key(rig.knob, 'ArrowRight');
    // `isLive` is true while the flywheel is coasting or a detent is pulling.
    // A key step is a detent, not a throw: there is nothing left to settle, and
    // that is precisely why the next press starts from where this one landed.
    expect(rig.model.isLive).toBe(false);
    rig.destroy();
  });

  it('crosses a printed blip and says the station it crossed onto', () => {
    const rig = dialRig();
    const spoken = new Set<string>();
    for (let i = 0; i < 12; i++) {
      key(rig.knob, 'ArrowRight');
      spoken.add(rig.knob.getAttribute('aria-valuetext') ?? '');
    }
    // Not just "the text changed" — the *station* named in it changed, which is
    // what a listener hears when the cursor crosses a blip.
    expect([...spoken].some((t) => t.includes('Radio Kiss Kiss'))).toBe(true);
    expect([...spoken].some((t) => t.includes('Radio Deejay'))).toBe(true);
    rig.destroy();
  });

  it('still answers Home, End and the page keys, and each lands somewhere different', () => {
    const rig = dialRig();
    key(rig.knob, 'Home');
    expect(Number(rig.knob.getAttribute('aria-valuenow'))).toBe(0);
    key(rig.knob, 'End');
    expect(Number(rig.knob.getAttribute('aria-valuenow'))).toBe(1);
    key(rig.knob, 'PageDown');
    const paged = Number(rig.knob.getAttribute('aria-valuenow'));
    expect(paged).toBeLessThan(1);
    key(rig.knob, 'PageDown');
    expect(Number(rig.knob.getAttribute('aria-valuenow'))).toBeLessThan(paged);
    rig.destroy();
  });

  it('refuses every one of them on a drum with nothing printed on it', () => {
    let refusals = 0;
    const model = new TuningModel({ onPosition(): void {}, onSettle(): void {} });
    const handle = createTuningKnob(model, () => {
      refusals += 1;
    });
    const knob = handle.root.querySelector('[role="slider"]') as HTMLElement;
    for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']) key(knob, k);
    expect(refusals).toBe(6);
    expect(knob.getAttribute('aria-valuetext')).toBe('no band cut');
    handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — hold to store, from a keyboard
// ---------------------------------------------------------------------------

interface PresetRig {
  root: HTMLElement;
  jewel: HTMLElement;
  recalls: Preset['slot'][];
  stores: Preset['slot'][];
  destroy(): void;
}

function presetRig(): PresetRig {
  const recalls: Preset['slot'][] = [];
  const stores: Preset['slot'][] = [];
  const handle = createPresets({
    onRecall: (slot) => recalls.push(slot),
    onStore: (slot) => stores.push(slot),
  });
  document.body.append(handle.root);
  return {
    root: handle.root,
    jewel: handle.root.querySelectorAll('.jewel')[0] as HTMLElement,
    recalls,
    stores,
    destroy: () => {
      handle.destroy();
      handle.root.remove();
    },
  };
}

describe('storing a preset from the keyboard', () => {
  it('stores when Enter is HELD, exactly once, however many autorepeats arrive', async () => {
    const rig = presetRig();
    key(rig.jewel, 'Enter');
    // The 34 keydown events the critic measured, as the browser delivers them.
    for (let i = 0; i < 33; i++) key(rig.jewel, 'Enter', { repeat: true });
    await sleep(760);
    keyUp(rig.jewel, 'Enter');
    expect(rig.stores).toEqual(['C']);
    // …and letting go after a store must not then also recall it.
    expect(rig.recalls).toEqual([]);
    rig.destroy();
  });

  it('recalls when Enter is TAPPED, and stores nothing', async () => {
    const rig = presetRig();
    key(rig.jewel, 'Enter');
    await sleep(40);
    keyUp(rig.jewel, 'Enter');
    expect(rig.recalls).toEqual(['C']);
    expect(rig.stores).toEqual([]);
    // The autorepeat is over; nothing may fire late.
    await sleep(700);
    expect(rig.stores).toEqual([]);
    rig.destroy();
  });

  it('stores immediately on Shift+Enter, the documented shortcut', () => {
    const rig = presetRig();
    key(rig.jewel, 'Enter', { shiftKey: true });
    keyUp(rig.jewel, 'Enter', { shiftKey: true });
    expect(rig.stores).toEqual(['C']);
    expect(rig.recalls).toEqual([]);
    rig.destroy();
  });

  it('holds Space too, because Space is how the panel activates everything else', async () => {
    const rig = presetRig();
    key(rig.jewel, ' ');
    await sleep(760);
    keyUp(rig.jewel, ' ');
    expect(rig.stores).toEqual(['C']);
    rig.destroy();
  });

  it('drops a half-finished hold when focus leaves under the key', async () => {
    const rig = presetRig();
    key(rig.jewel, 'Enter');
    await sleep(120);
    rig.jewel.dispatchEvent(new FocusEvent('blur'));
    await sleep(760);
    expect(rig.stores).toEqual([]);
    expect(rig.recalls).toEqual([]);
    rig.destroy();
  });

  it('prints the gesture it actually performs, on the panel and in the label', () => {
    const rig = presetRig();
    const legend = rig.root.querySelector('.presets__legend')!.textContent ?? '';
    const label = rig.jewel.getAttribute('aria-label') ?? '';
    // The legend used to say HOLD 1S TO STORE, which was wrong twice over: the
    // hold is 620 ms, and from a keyboard it did not work at all.
    expect(legend).toMatch(/hold/i);
    expect(legend).toMatch(/shift\+enter/i);
    expect(legend).not.toMatch(/1s/i);
    expect(label).toMatch(/hold/i);
    expect(label).toMatch(/shift\+enter/i);
    rig.destroy();
  });
});

// ---------------------------------------------------------------------------
// FIX 2 / FIX 4 — the register: what a key reaches, and what it says
// ---------------------------------------------------------------------------

function tag(name: string, stationCount: number): GenreTag {
  return { name, stationCount, spellings: [name] };
}

const index: RegisterIndex = {
  source: 'fixture',
  pulledAt: 1,
  totals: { stations: 900, tags: 30, countries: 12, languages: 9 },
  subjects: [tag('pop', 400), tag('jazz', 120)],
  origins: [
    { code: 'FR', name: 'France', stationCount: 771 },
    { code: 'DE', name: 'Germany', stationCount: 300 },
  ],
  tongues: [{ name: 'english', stationCount: 300 }],
};

const ROWS = [
  station({ id: 'bbc6', name: 'BBC Radio 6 Music', countryCode: 'GB', clickCount: 90 }),
  station({ id: 'fip', name: 'FIP', countryCode: 'FR', clickCount: 40 }),
];

interface RegRig {
  register: RegisterHandle;
  scopes: RegisterScope[];
  selected: string[];
  destroy(): void;
}

function regRig(): RegRig {
  const scopes: RegisterScope[] = [];
  const selected: string[] = [];
  const register = createRegister({
    onScope: (scope) => scopes.push(scope),
    onSelect: (id) => selected.push(id),
    onCut: () => {},
    onReprint: () => {},
    onClose: () => {},
  });
  document.body.append(register.root);
  register.setIndex(index, null);
  register.setScope(emptyScope());
  register.setRows(ROWS, { loading: false, key: undefined });
  return {
    register,
    scopes,
    selected,
    destroy: () => {
      register.destroy();
      register.root.remove();
    },
  };
}

describe('the index type slots commit what they have filtered to', () => {
  it('throws the top term on Enter, without needing Down first', () => {
    const rig = regRig();
    const slot = rig.register.root.querySelector('.comb--origin .comb__input') as HTMLInputElement;
    slot.value = 'france';
    slot.dispatchEvent(new Event('input', { bubbles: true }));
    const ev = key(slot, 'Enter');
    expect(ev.defaultPrevented).toBe(true);
    expect(rig.scopes.at(-1)?.origin).toBe('FR');
    rig.destroy();
  });

  it('leaves Enter alone when the slot has filtered everything away', () => {
    const rig = regRig();
    const slot = rig.register.root.querySelector('.comb--origin .comb__input') as HTMLInputElement;
    slot.value = 'zzzzzz';
    slot.dispatchEvent(new Event('input', { bubbles: true }));
    const before = rig.scopes.length;
    key(slot, 'Enter');
    expect(rig.scopes.length).toBe(before);
    rig.destroy();
  });

  it('spends the name slot’s debounce on Enter rather than making the hand wait', () => {
    const rig = regRig();
    const slot = rig.register.root.querySelector('.sheet__slot .comb__input') as HTMLInputElement;
    slot.value = 'bbc';
    slot.dispatchEvent(new Event('input', { bubbles: true }));
    const before = rig.scopes.length;
    key(slot, 'Enter');
    // Synchronously, in the same task as the key — not 260 ms later.
    expect(rig.scopes.length).toBe(before + 1);
    expect(rig.scopes.at(-1)?.text).toBe('bbc');
    rig.destroy();
  });

  it('takes the hand to the ledger once the entries that answer the name arrive', async () => {
    const rig = regRig();
    const slot = rig.register.root.querySelector('.sheet__slot .comb__input') as HTMLInputElement;
    slot.value = 'bbc';
    slot.dispatchEvent(new Event('input', { bubbles: true }));
    key(slot, 'Enter');
    // The rows that answer it land a moment later, as a real fetch does.
    rig.register.setRows(ROWS, { loading: false, key: undefined });
    await sleep(20);
    expect(document.activeElement?.classList.contains('entry')).toBe(true);
    rig.destroy();
  });

  it('prints the keys on the lid, because a shortcut nobody can find is not one', () => {
    const rig = regRig();
    const legend = rig.register.root.querySelector('.reg-legend')!.textContent ?? '';
    expect(legend).toMatch(/ctrl\+k/i);
    expect(legend).toMatch(/\bspace\b/i);
    expect(legend).toMatch(/esc/i);
    expect(legend).toMatch(/shift\+enter/i);
    rig.destroy();
  });

  it('puts the hand in the NAME slot when that is what was asked for', () => {
    const rig = regRig();
    rig.register.focusSearch('name');
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toBe('Search station names');
    rig.register.focusSearch();
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toMatch(/Subject index/);
    rig.destroy();
  });
});

describe('what the lid does to the surface underneath it', () => {
  let lid: LidHandle | null = null;
  afterEach(() => {
    lid?.destroy();
    lid = null;
  });

  it('tells the chassis when to seal the faceplate, and when to unseal it', async () => {
    const settled: boolean[] = [];
    lid = createLid({
      onToggle: () => {},
      onSelect: () => {},
      onScope: () => {},
      onCut: () => {},
      onReprint: () => {},
      onSettled: (open) => settled.push(open),
    });
    document.body.append(lid.lip, lid.root);
    lid.setOpen(true);
    // Nothing expensive may happen inside the travel.
    expect(settled).toEqual([]);
    await sleep(420);
    expect(settled).toEqual([true]);
    lid.setOpen(false);
    await sleep(420);
    expect(settled).toEqual([true, false]);
  });

  it('takes the case latches out of the Tab ring while the sheet is out, but leaves them clickable', async () => {
    let toggles = 0;
    lid = createLid({
      onToggle: () => {
        toggles += 1;
      },
      onSelect: () => {},
      onScope: () => {},
      onCut: () => {},
      onReprint: () => {},
    });
    document.body.append(lid.lip, lid.root);
    const latch = lid.lip.querySelector('.lip__latch') as HTMLElement;
    expect(latch.getAttribute('tabindex')).not.toBe('-1');
    lid.setOpen(true);
    expect(latch.getAttribute('tabindex')).toBe('-1');
    latch.click();
    expect(toggles).toBe(1);
    lid.setOpen(false);
    expect(latch.getAttribute('tabindex')).toBe('0');
    await sleep(420);
  });

  it('hands the register the slot the gesture asked for', async () => {
    lid = createLid({
      onToggle: () => {},
      onSelect: () => {},
      onScope: () => {},
      onCut: () => {},
      onReprint: () => {},
    });
    document.body.append(lid.lip, lid.root);
    lid.setIndex(index, null);
    lid.setScope(EMPTY_SCOPE);
    lid.setRows(ROWS, { loading: false });
    lid.setOpen(true, 'name');
    await sleep(420);
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toBe('Search station names');
  });
});
