/** Tiny DOM helpers. No framework, no diffing — this is a control panel. */

type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: (Node | string | null | undefined)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendAll(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: (Node | string | null | undefined)[],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendAll(node, children);
  return node;
}

function applyAttrs(node: Element, attrs?: Attrs): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendAll(node: Element, children?: (Node | string | null | undefined)[]): void {
  if (!children) return;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** A silkscreened label: tiny, wide-tracked, all caps, never pure white. */
export function silk(text: string, variant: 'default' | 'teal' | 'maroon' = 'default'): HTMLElement {
  return el('span', { class: `silk silk--${variant}` }, [text]);
}

/** Set text only when it actually changed — avoids needless layout invalidation. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Toggle a class only on change. */
export function setFlag(node: Element, name: string, on: boolean): void {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

export function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Maps v in [inLo,inHi] to [outLo,outHi], clamped. */
export function remap(v: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  if (inHi === inLo) return outLo;
  return clamp(outLo + ((v - inLo) / (inHi - inLo)) * (outHi - outLo), Math.min(outLo, outHi), Math.max(outLo, outHi));
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Pointer drag helper with capture. Returns a disposer.
 * `onMove` receives deltas in CSS px plus the raw event for modifier keys.
 */
export interface DragHandlers {
  onStart?(ev: PointerEvent): void;
  onMove(dx: number, dy: number, ev: PointerEvent): void;
  onEnd?(ev: PointerEvent): void;
}

export function draggable(target: HTMLElement, handlers: DragHandlers): () => void {
  let lastX = 0;
  let lastY = 0;
  let active = false;

  const down = (ev: PointerEvent) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    active = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    target.setPointerCapture(ev.pointerId);
    target.classList.add('is-grabbed');
    handlers.onStart?.(ev);
    ev.preventDefault();
  };
  const move = (ev: PointerEvent) => {
    if (!active) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    handlers.onMove(dx, dy, ev);
  };
  const up = (ev: PointerEvent) => {
    if (!active) return;
    active = false;
    try {
      target.releasePointerCapture(ev.pointerId);
    } catch {
      /* pointer already gone */
    }
    target.classList.remove('is-grabbed');
    handlers.onEnd?.(ev);
  };

  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);

  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
}

/** Press-and-hold detector: click fires short, hold fires long. */
export function pressAndHold(
  target: HTMLElement,
  opts: { holdMs: number; onClick(): void; onHold(): void; onHoldProgress?(t: number): void },
): () => void {
  let timer = 0;
  let raf = 0;
  let start = 0;
  let held = false;

  const cancelTimers = () => {
    if (timer) window.clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0;
    raf = 0;
    opts.onHoldProgress?.(0);
  };

  const begin = () => {
    held = false;
    start = performance.now();
    timer = window.setTimeout(() => {
      held = true;
      cancelTimers();
      opts.onHold();
    }, opts.holdMs);
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / opts.holdMs);
      opts.onHoldProgress?.(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const end = () => {
    const wasHeld = held;
    cancelTimers();
    if (!wasHeld) opts.onClick();
    held = false;
  };

  const down = (ev: PointerEvent) => {
    target.setPointerCapture(ev.pointerId);
    begin();
    ev.preventDefault();
  };
  const up = (ev: PointerEvent) => {
    try {
      target.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    end();
  };
  const leave = () => {
    cancelTimers();
    held = false;
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    if (ev.repeat) return;
    if (ev.shiftKey) opts.onHold();
    else opts.onClick();
  };

  target.addEventListener('pointerdown', down);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', leave);
  target.addEventListener('keydown', key);

  return () => {
    cancelTimers();
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', leave);
    target.removeEventListener('keydown', key);
  };
}
