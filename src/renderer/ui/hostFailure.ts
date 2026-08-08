/**
 * The hard-failure card.
 *
 * Law 4 says failure is a designed state, not an exception, and Law 2's
 * corollary says nothing may be shown that *looks like* a working receiver
 * when there is nothing behind it. When the host never published itself, both
 * apply at once: the engine does not exist, the directory does not exist, and
 * no control on the panel could do anything if it were drawn.
 *
 * So no panel is drawn. What appears instead is a legible statement of what
 * broke, what it means, and the one thing the user can actually do. It is
 * deliberately not styled like the faceplate: a dead receiver must not be
 * mistakeable for a live one at a glance.
 */

import { el } from './dom';

export function renderHostFailure(root: HTMLElement, detail?: string): HTMLElement {
  const card = el('div', { class: 'hostfail', role: 'alert' }, [
    el('p', { class: 'hostfail__kicker' }, ['Weltempfänger']),
    el('h1', { class: 'hostfail__title' }, ['RECEIVER DID NOT START']),
    el('p', { class: 'hostfail__body' }, [
      'The audio engine and the station directory failed to initialise, so this ' +
        'window has no receiver behind it. Nothing is playing, and no control on ' +
        'the panel would do anything — which is why the panel is not shown.',
    ]),
    el('p', { class: 'hostfail__detail' }, [detail ? detail : 'HOST MODULE DID NOT PUBLISH ITSELF']),
    el('p', { class: 'hostfail__action' }, ['Quit and restart the application.']),
  ]);
  root.replaceChildren(card);
  return card;
}
