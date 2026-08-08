/**
 * Access to the preload bridge. Type-only import of the main-process IPC module,
 * so nothing from src/main ends up in the renderer bundle.
 */
import type { PsppcprBridge } from '../../main/ipc.js';

export type { PsppcprBridge };

export function getBridge(): PsppcprBridge {
  const b = window.psppcpr;
  if (!b) {
    throw new Error(
      'window.psppcpr is missing — the preload script did not run. The audio engine ' +
        'cannot work without the local stream proxy.',
    );
  }
  return b;
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && window.psppcpr !== undefined;
}
