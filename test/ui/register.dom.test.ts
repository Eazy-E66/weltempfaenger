// @vitest-environment jsdom
/**
 * The register, driven through its real DOM.
 *
 * These exist because the three defects they pin were all found by *looking at
 * the register*, not by reading it: a critic polled the shipping DOM at 25 ms
 * through a real card pull and watched it publish `223 ENTRIES` — settled, no
 * spinner, no qualifier — for a scope that holds 5 629, then throw CUT BAND
 * inside that window and load a drum with 4 % of what was asked for. Anything
 * that can be asserted about that has to be asserted against the same surface
 * the critic read: `textContent`.
 *
 * The host is stubbed exactly as the real one behaves — including the two
 * things that produced the defect: it carries the *previous* rows forward while
 * `loading` is true, and it does not report `loading` until its debounce has
 * elapsed. The register is not allowed to rely on either.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SCOPE,
  INITIAL_PLAYBACK_STATE,
  emptyScope,
  type GenreTag,
  type PlaybackState,
  type RegisterIndex,
  type RegisterScope,
  type StationRef,
} from '../../src/shared/contracts';
import { createRegister, type RegisterHandle } from '../../src/renderer/ui/components/register';
import { supersetKey } from '../../src/renderer/ui/register/facets';

// --- the world the register runs in ----------------------------------------

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
// jsdom has no rAF budget worth honouring; the register must never *need* one.
vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
// jsdom implements no layout, so `scrollIntoView` does not exist on it. The
// register uses it to keep the focused row under the glass; there is no glass
// here, and everything these tests assert is attributes and text.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function noop(): void {};

function tag(name: string, stationCount: number, spellings = [name]): GenreTag {
  return { name, stationCount, spellings };
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

const index: RegisterIndex = {
  source: 'fixture',
  pulledAt: 1,
  totals: { stations: 12000, tags: 2477, countries: 241, languages: 600 },
  subjects: [tag('pop', 5629), tag('jazz', 1402), tag('rock', 900)],
  origins: [
    { code: 'FR', name: 'France', stationCount: 771 },
    { code: 'DE', name: 'Germany', stationCount: 1848 },
  ],
  tongues: [{ name: 'french', stationCount: 700 }, { name: 'german', stationCount: 1433 }],
};

/** The idle page: 1 808 most-listened stations, 223 of which happen to be pop. */
function idlePage(): StationRef[] {
  const rows: StationRef[] = [];
  for (let i = 0; i < 1808; i++) {
    rows.push(station({ id: `idle-${i}`, tags: i < 223 ? ['pop'] : ['jazz'], countryCode: 'FR', clickCount: 2000 - i }));
  }
  return rows;
}

/** What POP really holds: 5 629 rows, one fetch away. */
function popPopulation(): StationRef[] {
  const rows: StationRef[] = [];
  for (let i = 0; i < 5629; i++) {
    rows.push(station({ id: `pop-${i}`, tags: ['pop'], countryCode: 'DE', clickCount: 9000 - i }));
  }
  return rows;
}

interface Rig {
  handle: RegisterHandle;
  root: HTMLElement;
  scopes: RegisterScope[];
  cuts: Array<{ rows: StationRef[]; caption: string }>;
  /** How many times the register asked the host to reconnect (FIX 6). */
  reconnects: number;
  /** Everything the critic's poll reads, in one frame. */
  frame(): {
    count: string;
    combs: string[];
    cut: string;
    scope: string;
    bands: string;
    cutDead: boolean;
  };
  text(sel: string): string;
  destroy(): void;
}

function mount(): Rig {
  const scopes: RegisterScope[] = [];
  const cuts: Array<{ rows: StationRef[]; caption: string }> = [];
  // Counted through the rig object itself, so a test reads the same number the
  // register's own handler wrote.
  const tally = { reconnects: 0 };
  const handle = createRegister({
    onScope: (scope) => scopes.push(structuredClone(scope)),
    onSelect: () => {},
    onCut: (rows, caption) => cuts.push({ rows: [...rows], caption }),
    onReprint: () => {},
    onClose: () => {},
    onReconnect: () => {
      tally.reconnects += 1;
    },
  });
  document.body.append(handle.root);
  const root = handle.root;
  const text = (sel: string): string => (root.querySelector(sel)?.textContent ?? '').trim();
  return {
    handle,
    root,
    scopes,
    cuts,
    get reconnects() {
      return tally.reconnects;
    },
    text,
    frame: () => ({
      count: text('.sheet__count'),
      combs: Array.from(root.querySelectorAll('.comb__n')).map((n) => (n.textContent ?? '').trim()),
      cut: text('.cut__sub'),
      scope: text('.sheet__scope'),
      bands: text('.bandpreview__head .silk:last-child'),
      cutDead: !!root.querySelector('.cut.is-dead'),
    }),
    destroy: () => {
      handle.destroy();
      handle.root.remove();
    },
  };
}

let rig: Rig | null = null;
afterEach(() => {
  rig?.destroy();
  rig = null;
});

/** Bring the register to the state the critic started from: idle, settled. */
function settledIdle(): Rig {
  const r = mount();
  r.handle.setIndex(index, null);
  r.handle.setRows(idlePage(), { loading: false });
  return r;
}

// ---------------------------------------------------------------------------
// FIX 1
// ---------------------------------------------------------------------------

describe('a card pull, polled the way the critic polled it', () => {
  it('never publishes a settled count that is not the final one', () => {
    rig = settledIdle();
    const before = rig.frame();
    expect(before.count).toBe('1 808 ENTRIES');
    expect(before.cut).toContain('1 808');

    const trace: Array<{ at: string; f: ReturnType<Rig['frame']> }> = [];
    // t=0: the pull. Everything from here to the real rows is an intermediate.
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    trace.push({ at: 'click+0ms', f: rig.frame() });

    // The host's debounce has not fired yet: it has not even said `loading`.
    trace.push({ at: 'debounce', f: rig.frame() });

    // The host reports loading, carrying the PREVIOUS rows forward — the exact
    // substitution that produced `223 ENTRIES`.
    rig.handle.setRows(idlePage(), { loading: true });
    trace.push({ at: 'loading', f: rig.frame() });

    // The real population lands.
    rig.handle.setRows(popPopulation(), { loading: false });
    const final = rig.frame();

    expect(final.count).toBe('5 629 ENTRIES');
    for (const { at, f } of trace) {
      // The scope caption may lead — that is the user's own input echoed back.
      expect(f.scope, at).toBe('POP');
      // No number, anywhere, that is not the final one.
      expect(f.count, at).toBe('PRINTING…');
      expect(f.count, at).not.toBe('223 ENTRIES');
      expect(f.combs, at).toEqual(['—', '—', '—']);
      expect(f.cut, at).toBe('NOTHING TO CUT');
      expect(f.bands, at).toBe('PRINTING…');
      expect(f.cutDead, at).toBe(true);
    }
  });

  it('voids the counts in the same task as the click, not a frame later', () => {
    rig = settledIdle();
    expect(rig.text('.sheet__count')).toBe('1 808 ENTRIES');
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    // No awaits, no timers, no rAF: read it right back.
    expect(rig.text('.sheet__count')).toBe('PRINTING…');
    expect(rig.text('.cut__sub')).toBe('NOTHING TO CUT');
  });

  it('will not cut a band while it does not know the population', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    const paddle = rig.root.querySelector('.cut__throw') as HTMLElement;
    paddle.click();
    paddle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(rig.cuts).toHaveLength(0);
    expect(paddle.getAttribute('aria-disabled')).toBe('true');

    rig.handle.setRows(popPopulation(), { loading: false });
    expect(rig.text('.cut__sub')).toContain('5 629');
    (rig.root.querySelector('.cut__throw') as HTMLElement).click();
    expect(rig.cuts).toHaveLength(1);
    // 5 629 > the drum, so the throw is the top 480 across all twelve bands —
    // never six bands of 223.
    expect(rig.cuts[0]!.rows).toHaveLength(5629);
  });

  it('keeps the terms readable while it prints, so it is not a blank pane', () => {
    rig = settledIdle();
    const namesBefore = Array.from(rig.root.querySelectorAll('.comb--subject .comb__name'))
      .filter((n) => (n.parentElement as HTMLElement).style.display !== 'none')
      .map((n) => n.textContent);
    expect(namesBefore.length).toBeGreaterThan(1);

    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    const namesDuring = Array.from(rig.root.querySelectorAll('.comb--subject .comb__name'))
      .filter((n) => (n.parentElement as HTMLElement).style.display !== 'none')
      .map((n) => n.textContent);
    expect(namesDuring).toEqual(namesBefore);
    // …and the pull itself registered instantly.
    expect(rig.text('.pulled__card')).toContain('POP');
    // …and the sheet says what is happening and for how long.
    expect(rig.text('.sheet__empty-big')).toBe('PRINTING');
    expect(rig.text('.sheet__empty span')).toContain('FETCHING THIS SCOPE');
  });

  it('does not blank for a change the rows in hand already answer', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    rig.handle.setRows(popPopulation(), { loading: false });
    expect(rig.text('.sheet__count')).toBe('5 629 ENTRIES');

    // ≥320 kbps is filtered locally over pop's own population: the answer is
    // known exactly and immediately, and blanking it would be its own defect.
    (rig.root.querySelectorAll('.reg-rail__group .piano__key')[4] as HTMLButtonElement).click();
    expect(rig.text('.sheet__count')).toBe('0 ENTRIES');
    expect(rig.text('.sheet__count')).not.toBe('PRINTING…');

    // The host re-pulls anyway; the numbers stay up because they are exact.
    rig.handle.setRows(popPopulation(), { loading: true });
    expect(rig.text('.sheet__count')).toBe('0 ENTRIES');
  });

  it('prints a fault instead of hanging on PRINTING for ever', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    expect(rig.text('.sheet__count')).toBe('PRINTING…');
    rig.handle.setRows([], { loading: false, fault: 'DIRECTORY UNREACHABLE' });
    expect(rig.text('.sheet__count')).toBe('NOT PRINTED');
    expect(rig.text('.sheet__empty-big')).toBe('NOT PRINTED');
  });

  it('starts life printing rather than claiming zero', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    expect(rig.text('.sheet__count')).toBe('PRINTING…');
    expect(rig.text('.cut__sub')).toBe('NOTHING TO CUT');
  });
});

// ---------------------------------------------------------------------------
// FIX 2
// ---------------------------------------------------------------------------

describe('CLEAR ALL', () => {
  it('emits a scope that deep-equals the idle one', () => {
    rig = settledIdle();
    // The dead end the critic hit by accident, rebuilt: a name search and a
    // SPIN-set origin, the two axes EMPTY_SCOPE did not mention.
    rig.handle.setScope({
      terms: ['jazz'],
      origin: 'FR',
      tongues: ['french'],
      text: 'radiodio 3',
      minKbps: 320,
      codec: 'FLAC',
      verifiedOnly: false,
      hideHls: false,
    });
    rig.handle.setRows([], { loading: false });

    (rig.root.querySelector('.pulled__return') as HTMLButtonElement).click();

    const last = rig.scopes.at(-1)!;
    expect(last).toEqual(EMPTY_SCOPE);
    expect(last).toEqual(emptyScope());
    // Named individually, because a deep-equal that passes for the wrong reason
    // is what let this ship: these two keys did not exist to be overwritten.
    expect(last.text).toBeUndefined();
    expect(last.origin).toBeUndefined();
    // Nothing that gets serialised to settings.json survives it — and what does
    // get written withholds nothing, which is the other half of FIX 4: both
    // levers used to be `true` here, so every fresh profile inherited two
    // filters its owner had never touched.
    expect(JSON.parse(JSON.stringify(last))).toEqual({
      terms: [], tongues: [], minKbps: 0, codec: 'ANY', verifiedOnly: false, hideHls: false,
    });
  });

  it('clears the type slots on screen as well as the scope underneath', () => {
    rig = settledIdle();
    const nameSlot = rig.root.querySelector('.sheet__slot .comb__input') as HTMLInputElement;
    const termSlot = rig.root.querySelector('.comb--subject .comb__input') as HTMLInputElement;
    nameSlot.value = 'radiodio 3';
    termSlot.value = 'trip';
    termSlot.dispatchEvent(new Event('input'));
    rig.handle.setScope({ ...emptyScope(), text: 'radiodio 3' });
    rig.handle.setRows([], { loading: false });

    (rig.root.querySelector('.pulled__return') as HTMLButtonElement).click();
    expect(nameSlot.value).toBe('');
    expect(termSlot.value).toBe('');
    expect(rig.text('.pulled__none')).toContain('whole edition');
  });

  it('is offered whenever it would do something, and hidden when it would not', () => {
    rig = settledIdle();
    const button = rig.root.querySelector('.pulled__return') as HTMLElement;
    expect(button.style.visibility).toBe('hidden');
    // A lever alone is still something to clear.
    rig.handle.setScope({ ...emptyScope(), hideHls: true });
    rig.handle.setRows(idlePage(), { loading: false });
    expect(button.style.visibility).toBe('visible');
  });
});

// ---------------------------------------------------------------------------
// FIX 3
// ---------------------------------------------------------------------------

describe('the notch, in the DOM', () => {
  it('cuts a term to the same depth whatever else is in the comb', () => {
    rig = settledIdle();
    const depth = (label: string): string => {
      const tab = Array.from(rig!.root.querySelectorAll('.comb--subject .comb__tab')).find(
        (t) => (t.querySelector('.comb__name')?.textContent ?? '').startsWith(label),
      ) as HTMLElement | undefined;
      return (tab?.querySelector('.comb__notch') as HTMLElement).style.getPropertyValue('--w');
    };
    const popAlone = depth('pop');
    const rockAlone = depth('rock');
    expect(popAlone).not.toBe(rockAlone);

    // Type at the head so `rock` is the deepest thing on screen. Under the old
    // rule it would jump to 62.0%; a cut card does not re-cut itself.
    const slot = rig.root.querySelector('.comb--subject .comb__input') as HTMLInputElement;
    slot.value = 'rock';
    slot.dispatchEvent(new Event('input'));
    expect(depth('rock')).toBe(rockAlone);
    expect(depth('rock')).not.toBe('62.0%');
  });

  it('closes every notch while the count is unknown', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    const widths = Array.from(rig.root.querySelectorAll('.comb--subject .comb__tab'))
      .filter((t) => (t as HTMLElement).style.display !== 'none')
      .map((t) => (t.querySelector('.comb__notch') as HTMLElement).style.getPropertyValue('--w'));
    expect(new Set(widths)).toEqual(new Set(['0%']));
  });
});

// ---------------------------------------------------------------------------
// FIX 5
// ---------------------------------------------------------------------------

function key(node: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(ev);
  return ev;
}

/** Every element a Tab press would stop on, in document order. */
function tabStops(root: HTMLElement): HTMLElement[] {
  const sel = 'a[href],button,input,select,textarea,[tabindex],[role="switch"],[role="button"]';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((n) => {
    if (n.style.display === 'none') return false;
    const ti = n.getAttribute('tabindex');
    if (ti !== null) return Number(ti) >= 0;
    return !(n as HTMLButtonElement).disabled;
  });
}

describe('the keyboard', () => {
  it('makes each index one tab stop instead of three hundred', () => {
    rig = settledIdle();
    const options = rig.root.querySelectorAll('.comb--subject .comb__tab');
    expect(options.length).toBeGreaterThan(1);
    const stops = Array.from(options).filter((n) => n.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);

    // The whole register, counted the way the critic counted it.
    const all = tabStops(rig.root);
    expect(all.length).toBeLessThan(40);
    // …and the ledger is one of them, not one per line.
    const entryStops = Array.from(rig.root.querySelectorAll('.entry')).filter(
      (n) => n.getAttribute('tabindex') === '0',
    );
    expect(entryStops).toHaveLength(1);
    // …and the map is one, not one per country.
    const dotStops = Array.from(rig.root.querySelectorAll('.map__den')).filter(
      (n) => n.getAttribute('tabindex') === '0',
    );
    expect(dotStops.length).toBeLessThanOrEqual(1);
  });

  it('moves the roving stop on Down, Up, Home and End', () => {
    rig = settledIdle();
    const list = rig.root.querySelector('.comb--subject .comb__list')!;
    const at = (): number =>
      Array.from(rig!.root.querySelectorAll('.comb--subject .comb__tab')).findIndex(
        (n) => n.getAttribute('tabindex') === '0',
      );
    expect(at()).toBe(0);
    expect(key(list, 'ArrowDown').defaultPrevented).toBe(true);
    expect(at()).toBe(1);
    key(list, 'ArrowDown');
    expect(at()).toBe(2);
    key(list, 'ArrowUp');
    expect(at()).toBe(1);
    key(list, 'End');
    expect(at()).toBe(2);
    key(list, 'Home');
    expect(at()).toBe(0);
  });

  it('jumps to a term by typing its first letters', () => {
    rig = settledIdle();
    const list = rig.root.querySelector('.comb--subject .comb__list')!;
    key(list, 'r');
    const active = Array.from(rig.root.querySelectorAll('.comb--subject .comb__tab')).find(
      (n) => n.getAttribute('tabindex') === '0',
    )!;
    expect(active.querySelector('.comb__name')!.textContent).toBe('rock');
  });

  it('walks the ledger and takes an entry on air from the keyboard', () => {
    rig = settledIdle();
    const body = rig.root.querySelector('.sheet__rows')!;
    const at = (): number =>
      Array.from(rig!.root.querySelectorAll('.entry')).findIndex((n) => n.getAttribute('tabindex') === '0');
    const first = at();
    key(body, 'ArrowDown');
    expect(at()).toBe(first + 1);
    expect(key(body, 'PageDown').defaultPrevented).toBe(true);
    expect(key(body, 'Enter').defaultPrevented).toBe(true);
  });

  it('lets Escape out of every type slot in the register', () => {
    rig = settledIdle();
    let escapes = 0;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') escapes += 1;
    };
    window.addEventListener('keydown', onKey);
    // The comb head is where the lid puts focus when it opens — the one place
    // Escape was swallowed, by the one element focus always landed in.
    key(rig.root.querySelector('.comb--subject .comb__input')!, 'Escape');
    key(rig.root.querySelector('.sheet__slot .comb__input')!, 'Escape');
    key(rig.root.querySelector('.comb--subject .comb__list')!, 'Escape');
    key(rig.root.querySelector('.sheet__rows')!, 'Escape');
    key(rig.root.querySelector('.piano')!, 'Escape');
    window.removeEventListener('keydown', onKey);
    expect(escapes).toBe(5);
  });

  it('still keeps ordinary typing out of the lid’s shortcuts', () => {
    rig = settledIdle();
    let leaked = 0;
    const onKey = (): void => {
      leaked += 1;
    };
    window.addEventListener('keydown', onKey);
    key(rig.root.querySelector('.comb--subject .comb__input')!, 'j');
    window.removeEventListener('keydown', onKey);
    expect(leaked).toBe(0);
  });
});

describe('what the register tells assistive technology', () => {
  it('says the Subject and Tongue indexes take more than one term', () => {
    rig = settledIdle();
    expect(rig.root.querySelector('.comb--subject .comb__list')!.getAttribute('aria-multiselectable')).toBe('true');
    expect(rig.root.querySelector('.comb--tongue .comb__list')!.getAttribute('aria-multiselectable')).toBe('true');
    // ORIGIN is a single throw and must not claim otherwise.
    expect(rig.root.querySelector('.comb--origin .comb__list')!.getAttribute('aria-multiselectable')).toBeNull();
  });

  it('names both lever switches', () => {
    rig = settledIdle();
    const levers = Array.from(rig.root.querySelectorAll('[role="switch"]'));
    expect(levers).toHaveLength(2);
    for (const lever of levers) {
      const id = lever.getAttribute('aria-labelledby');
      expect(id, 'lever has no accessible name').toBeTruthy();
      expect((rig!.root.querySelector(`#${id}`)?.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
    expect(levers.map((l) => rig!.root.querySelector(`#${l.getAttribute('aria-labelledby')}`)!.textContent))
      .toEqual(['Verified Only', 'Hide HLS']);
  });

  it('makes the three key banks named radio groups', () => {
    rig = settledIdle();
    const groups = Array.from(rig.root.querySelectorAll('[role="radiogroup"]'));
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Order the entries by', 'Quality', 'Codec',
    ]);
    for (const group of groups) {
      const radios = Array.from(group.querySelectorAll('[role="radio"]'));
      expect(radios.length).toBeGreaterThan(1);
      expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
      expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    }
  });

  it('walks a key bank with the arrow keys', () => {
    rig = settledIdle();
    const bank = rig.root.querySelectorAll('.reg-rail__group .piano')[0]!;
    const checked = (): string | null =>
      bank.querySelector('[aria-checked="true"]')!.getAttribute('data-v');
    expect(checked()).toBe('0');
    key(bank, 'ArrowRight');
    expect(checked()).toBe('64');
    key(bank, 'ArrowLeft');
    expect(checked()).toBe('0');
  });

  it('never prints a count it does not have as if it had it', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    const labels = Array.from(rig.root.querySelectorAll('.comb--subject .comb__tab'))
      .filter((t) => (t as HTMLElement).style.display !== 'none')
      .map((t) => t.getAttribute('aria-label') ?? '');
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toContain('not yet known');
  });
});

// ---------------------------------------------------------------------------
// FIX 4
// ---------------------------------------------------------------------------

describe('the printed vocabulary', () => {
  it('does not use a noun the interface never labels', () => {
    rig = settledIdle();
    const printed = (rig.root.textContent ?? '').toLowerCase();
    // `comb`, `card` and `deck` were the three words the manual used and the
    // interface never printed. The register no longer says any of them.
    for (const word of [' comb', 'card', 'deck']) {
      expect(printed, `interface still prints "${word.trim()}"`).not.toContain(word);
    }
  });

  it('has no five-step tutorial on it any more', () => {
    rig = settledIdle();
    expect(rig.root.querySelector('.reg-legend__list')).toBeNull();
    expect(rig.root.querySelectorAll('.reg-legend li')).toHaveLength(0);
    expect((rig.root.textContent ?? '').toLowerCase()).not.toContain('to use this register');
  });

  it('labels the controls the legend refers to', () => {
    rig = settledIdle();
    const printed = (rig.root.textContent ?? '').toLowerCase();
    for (const word of ['index', 'entries', 'scope', 'cut band']) {
      expect(printed, `legend uses "${word}" but nothing is labelled with it`).toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// The hole left in FIX 1: rows have to say which population they are
// ---------------------------------------------------------------------------

describe('rows that answer a scope which is no longer on the page', () => {
  const POP = supersetKey({ ...EMPTY_SCOPE, terms: ['pop'] });
  const IDLE = supersetKey(EMPTY_SCOPE);

  it('refuses a settled fetch that names a different population', () => {
    rig = settledIdle();
    // The exact sequence: POP was pulled, the fetch went out, the card was
    // pushed back in before the answer came, and the answer is POP's 5 629 rows
    // arriving against an idle scope with `loading: false` on them.
    rig.handle.setRows(popPopulation(), { loading: false, key: POP });

    const f = rig.frame();
    expect(f.scope).toBe('ON AIR NOW · MOST LISTENED');
    expect(f.count).toBe('PRINTING…');
    expect(f.count).not.toBe('5 629 ENTRIES');
    expect(f.cut).toBe('NOTHING TO CUT');
    expect(f.combs).toEqual(['—', '—', '—']);
    expect(f.cutDead).toBe(true);
  });

  it('will not let CUT BAND commit that population to the drum', () => {
    rig = settledIdle();
    rig.handle.setRows(popPopulation(), { loading: false, key: POP });
    const paddle = rig.root.querySelector('.cut__throw') as HTMLElement;
    paddle.click();
    paddle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(rig.cuts).toHaveLength(0);
    expect(paddle.getAttribute('aria-disabled')).toBe('true');
  });

  it('accepts them the moment the key names the scope that is up', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    expect(rig.text('.sheet__count')).toBe('PRINTING…');
    rig.handle.setRows(popPopulation(), { loading: false, key: POP });
    expect(rig.text('.sheet__count')).toBe('5 629 ENTRIES');
    expect(rig.frame().cutDead).toBe(false);
  });

  it('takes the current scope’s word for it when no key is given', () => {
    // The permissive default is what keeps every other caller working; the
    // shipping host always names the population.
    rig = settledIdle();
    expect(rig.text('.sheet__count')).toBe('1 808 ENTRIES');
    rig.handle.setRows(idlePage(), { loading: false, key: IDLE });
    expect(rig.text('.sheet__count')).toBe('1 808 ENTRIES');
  });
});

// ---------------------------------------------------------------------------
// The map's redraw signature
// ---------------------------------------------------------------------------

describe('a country whose average position is still being learned', () => {
  /**
   * `learnGeography` keeps accumulating lat/lon sums, but the redraw signature
   * was keyed on `centroids.size` — it only ever changed when a *new* country
   * appeared. A country first seen from one outlier station therefore kept that
   * outlier's position for the whole session, however many later stations
   * corrected the average.
   *
   * Both rounds below carry one French station, so the origin comb's counts are
   * identical and the *only* thing that differs is where the dot belongs.
   */
  function frenchDot(r: Rig): { cx: string; cy: string } | null {
    const dot = r.root.querySelector('.map__den');
    if (!dot) return null;
    return { cx: dot.getAttribute('cx') ?? '', cy: dot.getAttribute('cy') ?? '' };
  }

  it('moves the dot as the average is corrected', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    // One outlier: a French station whose record puts it off Iceland.
    rig.handle.setRows([station({ id: 'outlier', countryCode: 'FR', geo: { lat: 64, lon: -22 } })], {
      loading: false,
    });
    const first = frenchDot(rig);
    expect(first).not.toBeNull();

    // A second station, really in France. The comb still counts one FR row, so
    // nothing but the centroid has changed.
    rig.handle.setRows([station({ id: 'real', countryCode: 'FR', geo: { lat: 46, lon: 2 } })], {
      loading: false,
    });
    const second = frenchDot(rig);
    expect(second).not.toEqual(first);
  });

  it('still skips the redraw when nothing about the picture changed', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    const rows = [station({ id: 'fr-1', countryCode: 'FR', geo: { lat: 46, lon: 2 } })];
    rig.handle.setRows(rows, { loading: false });
    const node = rig.root.querySelector('.map__den');
    // The identical population again: same count, same centroid, same dots — and
    // the same DOM nodes, because rebuilding two hundred circles is by a wide
    // margin the most expensive thing in a repaint.
    rig.handle.setRows(rows, { loading: false });
    expect(rig.root.querySelector('.map__den')).toBe(node);
  });
});

// ---------------------------------------------------------------------------
// FIX 1, in the DOM: typing a spelling the directory does not use
// ---------------------------------------------------------------------------

describe('typing at the subject index head', () => {
  /** An edition whose biggest term is folded from three spellings. */
  const foldedIndex: RegisterIndex = {
    ...index,
    subjects: [tag('trip-hop', 46, ['trip-hop', 'trip hop', 'triphop']), tag('jazz', 1402)],
  };

  /** A keystroke, and the frame it repaints in. */
  async function typed(text: string): Promise<{ cards: string[]; none: string }> {
    const slot = rig!.root.querySelector('.comb--subject .comb__input') as HTMLInputElement;
    slot.value = text;
    slot.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      cards: Array.from(rig!.root.querySelectorAll('.comb--subject .comb__tab'))
        .filter((t) => (t as HTMLElement).style.display !== 'none')
        .map((t) => (t.querySelector('.comb__name')?.textContent ?? '')),
      none: rig!.text('.comb--subject .comb__none'),
    };
  }

  it('finds the folded group from any spelling, and never the red no-match', async () => {
    rig = mount();
    rig.handle.setIndex(foldedIndex, null);
    rig.handle.setRows(idlePage(), { loading: false });

    // `jazz` is the control: it is in the same comb and must be filtered out,
    // so a passing row here really is the search working rather than the comb
    // printing everything it has.
    for (const spelling of ['trip hop', 'triphop', 'trip-hop', 'trip']) {
      const shown = await typed(spelling);
      expect(shown.cards, spelling).toEqual(['trip-hop · 3 SPELLINGS']);
      expect(shown.none, spelling).toBe('');
    }
  });

  it('pulls the same card whichever spelling was typed', async () => {
    for (const spelling of ['trip hop', 'triphop', 'trip-hop', 'trip']) {
      rig?.destroy();
      rig = mount();
      rig.handle.setIndex(foldedIndex, null);
      rig.handle.setRows(idlePage(), { loading: false });
      await typed(spelling);
      (rig.root.querySelector('.comb--subject .comb__tab') as HTMLButtonElement).click();
      expect(rig.scopes.at(-1)!.terms, spelling).toEqual(['trip-hop']);
    }
  });

  it('points at the edition instead of only refusing, when the scope excludes it', async () => {
    rig = mount();
    rig.handle.setIndex(foldedIndex, null);
    // A scope whose rows carry no subject term at all: the comb is empty, but
    // the edition still holds trip-hop.
    rig.handle.setScope({ ...emptyScope(), origin: 'DE' });
    rig.handle.setRows([station({ id: 'plain', countryCode: 'DE' })], {
      loading: false,
      key: supersetKey({ ...EMPTY_SCOPE, origin: 'DE' }),
    });
    const shown = await typed('trip hop');
    expect(shown.cards).toEqual([]);
    expect(shown.none).toContain('IS NOT IN THIS SCOPE');
    expect(shown.none).toContain('TRIP-HOP 46');
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — CUT BAND is a throw again
// ---------------------------------------------------------------------------

/** A pointer gesture, as jsdom can express one: MouseEvent carries clientX. */
function pointer(node: Element, type: string, x: number): void {
  node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 0 }));
}

describe('CUT BAND', () => {
  it('throws from a click on the words, not only on the paddle', () => {
    rig = settledIdle();
    // The exact target the critic clicked: the centre of the engraved legend,
    // which had `cursor: default` and no listener of any kind.
    (rig.root.querySelector('.cut__legend') as HTMLElement).click();
    expect(rig.cuts).toHaveLength(1);
    expect(rig.cuts[0]!.caption).toBe('ON AIR NOW · MOST LISTENED');
  });

  it('throws from a click on the promise line too', () => {
    rig = settledIdle();
    (rig.root.querySelector('.cut__sub') as HTMLElement).click();
    expect(rig.cuts).toHaveLength(1);
  });

  it('still throws from the paddle, and only once', () => {
    rig = settledIdle();
    (rig.root.querySelector('.cut__throw') as HTMLElement).click();
    expect(rig.cuts).toHaveLength(1);
  });

  it('throws on a drag, because the copy says THROW', () => {
    rig = settledIdle();
    const cut = rig.root.querySelector('.cut') as HTMLElement;
    const paddle = rig.root.querySelector('.cut__paddle') as HTMLElement;
    pointer(paddle, 'pointerdown', 100);
    pointer(paddle, 'pointermove', 118);
    // Tracking the hand: the paddle is where the pointer is, not easing to it.
    expect(paddle.style.left).toBe('21px');
    expect(rig.cuts).toHaveLength(0);
    pointer(paddle, 'pointermove', 140);
    pointer(paddle, 'pointerup', 140);
    expect(rig.cuts).toHaveLength(1);
    // The paddle is back in its slot and the click trailing the drag was eaten,
    // so one gesture is one throw.
    expect(paddle.style.left).toBe('');
    cut.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(rig.cuts).toHaveLength(1);
  });

  it('does not throw on a drag that never reaches the latch', () => {
    rig = settledIdle();
    const paddle = rig.root.querySelector('.cut__paddle') as HTMLElement;
    pointer(paddle, 'pointerdown', 100);
    pointer(paddle, 'pointermove', 108);
    pointer(paddle, 'pointerup', 108);
    expect(rig.cuts).toHaveLength(0);
    expect(paddle.style.left).toBe('');
  });

  it('is inert everywhere while the register does not know the population', () => {
    rig = settledIdle();
    (rig.root.querySelectorAll('.comb--subject .comb__tab')[0] as HTMLButtonElement).click();
    (rig.root.querySelector('.cut__legend') as HTMLElement).click();
    (rig.root.querySelector('.cut__sub') as HTMLElement).click();
    (rig.root.querySelector('.cut') as HTMLElement).click();
    const paddle = rig.root.querySelector('.cut__paddle') as HTMLElement;
    pointer(paddle, 'pointerdown', 100);
    pointer(paddle, 'pointermove', 160);
    pointer(paddle, 'pointerup', 160);
    expect(rig.cuts).toHaveLength(0);
    expect(paddle.style.left).toBe('');
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — the IN SCOPE line names any engaged lever
// ---------------------------------------------------------------------------

describe('the IN SCOPE line', () => {
  it('says the whole edition is in scope only when it really is', () => {
    rig = settledIdle();
    expect(rig.text('.pulled__none')).toContain('whole edition');
    expect(rig.text('.pulled')).not.toContain('HIDE HLS');
  });

  it('names an engaged lever as a chip, like every other filter', () => {
    rig = settledIdle();
    rig.handle.setScope({ ...emptyScope(), hideHls: true, verifiedOnly: true });
    rig.handle.setRows(idlePage(), { loading: false });
    const chips = Array.from(rig.root.querySelectorAll('.pulled__card')).map(
      (c) => (c.textContent ?? '').replace('×', '').trim(),
    );
    expect(chips).toContain('VERIFIED ONLY');
    expect(chips).toContain('HIDE HLS');
    // …and the sentence that could not be true is not printed.
    expect(rig.root.querySelector('.pulled__none')).toBeNull();
  });

  it('takes a lever back out of the scope from its own chip', () => {
    rig = settledIdle();
    rig.handle.setScope({ ...emptyScope(), hideHls: true });
    rig.handle.setRows(idlePage(), { loading: false });
    const chip = Array.from(rig.root.querySelectorAll('.pulled__card')).find((c) =>
      (c.textContent ?? '').includes('HIDE HLS'),
    ) as HTMLButtonElement;
    chip.click();
    expect(rig.scopes.at(-1)!.hideHls).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 5 — the empty state names the remedy that works
// ---------------------------------------------------------------------------

describe('an empty sheet', () => {
  /** The critic's scenario: five HLS mounts for a name search, HIDE HLS on. */
  function bbcHls(): StationRef[] {
    return [1, 2, 3, 4, 5].map((i) =>
      station({ id: `bbc-${i}`, name: 'BBC Radio 3', hls: true, tags: ['jazz'] }),
    );
  }

  it('names the switch that emptied it, and how many rows it holds back', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    const scope: RegisterScope = { ...emptyScope(), text: 'BBC Radio 3', hideHls: true };
    rig.handle.setScope(scope);
    rig.handle.setRows(bbcHls(), { loading: false, key: supersetKey(scope) });

    expect(rig.text('.sheet__count')).toBe('0 ENTRIES');
    const empty = rig.text('.sheet__empty');
    expect(empty).toContain('HIDE HLS 5');
    expect(empty).toContain('TAKE ONE OUT AND THEY RETURN');
    // The remedy that does not work is no longer offered as the only one.
    expect(empty).not.toContain('lower the quality bar');
  });

  it('says so plainly when the directory returned nothing at all', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    const scope: RegisterScope = { ...emptyScope(), text: 'nothing at all' };
    rig.handle.setScope(scope);
    rig.handle.setRows([], { loading: false, key: supersetKey(scope) });
    expect(rig.text('.sheet__empty')).toContain('returned no station at all');
  });

  it('admits when no single filter is to blame', () => {
    rig = mount();
    rig.handle.setIndex(index, null);
    const scope: RegisterScope = { ...emptyScope(), hideHls: true, minKbps: 320 };
    rig.handle.setScope(scope);
    rig.handle.setRows([station({ id: 'both', hls: true, claimedBitrate: 64, tags: ['jazz'] })], {
      loading: false,
      key: supersetKey(scope),
    });
    expect(rig.text('.sheet__empty')).toContain('NO SINGLE FILTER IS RESPONSIBLE');
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — a failure at the point of action is visible at the point of action
// ---------------------------------------------------------------------------

/** The regex the critic tested `register.innerText` against, and got false. */
const CRITIC = /HLS ONLY|CANNOT DECODE|FAULT/i;

describe('a click that fails', () => {
  const hlsStation = station({ id: 'idle-0', name: 'BBC Radio 3', tags: ['pop'], hls: true });

  function faulted(): PlaybackState {
    return {
      ...INITIAL_PLAYBACK_STATE,
      phase: 'error',
      station: hlsStation,
      error: {
        kind: 'hls',
        message: 'This station is HLS, which this receiver cannot decode.',
        attempts: 1,
      },
    };
  }

  it('is answered on the register itself, in the register’s own text', () => {
    rig = settledIdle();
    // The measured starting point: the fault is on the faceplate, which the
    // open lid completely covers, so the register says nothing about it.
    expect(rig.root.textContent ?? '').not.toMatch(CRITIC);

    rig.handle.setPlayback(faulted());

    const bar = rig.root.querySelector('.reg-fault') as HTMLElement;
    expect(bar.style.display).not.toBe('none');
    expect(rig.root.textContent ?? '').toMatch(CRITIC);
    expect(rig.text('.reg-fault__big')).toBe('FAULT · HLS ONLY — THIS RECEIVER CANNOT DECODE IT');
    expect(rig.text('.reg-fault__why')).toContain('cannot decode');
    expect(rig.text('.reg-fault__where')).toContain('DID NOT COME UP');
  });

  it('carries RECONNECT, right where the click was made', () => {
    rig = settledIdle();
    rig.handle.setPlayback(faulted());
    const act = rig.root.querySelector('.reg-fault__act') as HTMLButtonElement;
    expect(act).not.toBeNull();
    act.click();
    expect(rig.reconnects).toBe(1);
  });

  it('marks the ledger line that did not come up', () => {
    rig = settledIdle();
    rig.handle.setPlayback(faulted());
    const marked = Array.from(rig.root.querySelectorAll('.entry.is-faulted'));
    expect(marked).toHaveLength(1);
    // The ledger keeps printing its own row; what changes is that the line is
    // struck as the one that did not come up. `idle-0` is the entry whose id
    // the engine reported the fault for.
    expect(marked[0]!.querySelector('.entry__name')!.textContent).toBe('idle-0');
  });

  it('clears when the receiver recovers', () => {
    rig = settledIdle();
    rig.handle.setPlayback(faulted());
    rig.handle.setPlayback({ ...INITIAL_PLAYBACK_STATE, phase: 'playing', station: hlsStation });
    expect((rig.root.querySelector('.reg-fault') as HTMLElement).style.display).toBe('none');
    expect(rig.root.querySelectorAll('.entry.is-faulted')).toHaveLength(0);
  });

  it('prints dead air, and an amber note while the AFC is re-locking', () => {
    rig = settledIdle();
    rig.handle.setPlayback({ ...INITIAL_PLAYBACK_STATE, phase: 'stalled', station: hlsStation });
    expect(rig.text('.reg-fault__big')).toBe('FAULT · SIGNAL LOST');
    expect(rig.root.querySelector('.reg-fault.is-advice')).toBeNull();

    rig.handle.setPlayback({
      ...INITIAL_PLAYBACK_STATE,
      phase: 'reconnecting',
      station: hlsStation,
      retry: { attempt: 2, budget: 4, mount: 1, mounts: 3 },
    });
    expect(rig.text('.reg-fault__big')).toBe('RE-LOCKING');
    expect(rig.text('.reg-fault__why')).toBe('ATTEMPT 2 OF 4 · MOUNT 1 OF 3');
    expect(rig.root.querySelector('.reg-fault.is-advice')).not.toBeNull();
  });

  it('says nothing at all while the receiver is idle or running', () => {
    rig = settledIdle();
    for (const phase of ['idle', 'resolving', 'connecting', 'buffering', 'playing'] as const) {
      rig.handle.setPlayback({ ...INITIAL_PLAYBACK_STATE, phase, station: hlsStation });
      expect((rig.root.querySelector('.reg-fault') as HTMLElement).style.display, phase).toBe('none');
    }
  });
});
