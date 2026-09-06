// @vitest-environment jsdom
/**
 * The band plate's station count against a drum that holds 480.
 *
 * Measured on the live directory: a POP scope of 1 026 entries was cut, the
 * register said `TOP 480 OF 1 026 · SCOPE WIDER THAN THE DRUM` before the
 * throw, and the plate then printed `1026 STN` over a dial carrying 480. The
 * plate is the surface the listener looks at while tuning; it must not print
 * the scope's size as though all of it were on the dial.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMeterBand } from '../../src/renderer/ui/components/meterBand';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the band plate count', () => {
  it('says how many of the scope actually made it onto the drum when the scope overflowed', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const plate = createMeterBand(() => {});
    document.body.append(plate.root);
    plate.setCut({ caption: 'POP', quality: 'ANY RATE', total: 1026, printed: 480, filled: 12, index: 0 });
    expect(plate.root.querySelector('.plate__meta')!.textContent).toContain('480 OF 1026 STN');
    plate.setCut({ caption: 'JAZZ · FRANCE', quality: 'ANY RATE', total: 110, printed: 110, filled: 3, index: 0 });
    expect(plate.root.querySelector('.plate__meta')!.textContent).toContain('110 STN');
    expect(plate.root.querySelector('.plate__meta')!.textContent).not.toContain('OF');
    plate.root.remove();
  });
});
