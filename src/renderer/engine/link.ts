/**
 * The renderer's half of a proxy session: mints sessions, filters the main
 * process's broadcast telemetry down to the one that is current, and reports an
 * upstream drop.
 *
 * The engine keeps authority over *which* session is current — mint() does not
 * adopt, so a tune that was abandoned mid-await can discard its handle without
 * ever disturbing the session that replaced it.
 */

import type { PsppcprBridge } from './bridge.js';
import type {
  ProxyEvent,
  ProxyHandle,
  ProxyMetadata,
  ProxySessionStats,
} from '../../main/proxy/types.js';

export interface ProxyLinkHandlers {
  metadata(meta: ProxyMetadata): void;
  /**
   * Upstream went away on its own. Always a drop for an endless live stream.
   *
   * `raw` is what the socket actually said — `ProxyEvent.detail`, the Node
   * error text. It goes to `diagnostics()` and nowhere else: the panel prints
   * the designed sentence for `upstream-closed`, because "ECONNRESET" is not
   * something a listener can act on. Without it the diagnostic channel fell
   * back to the panel's own sentence, so the one place that exists to hold the
   * unvarnished cause held a paraphrase of itself.
   */
  dropped(message: string, raw?: string): void;
  /** Any event on the current session; a cue to re-derive state now. */
  changed(): void;
}

export class ProxyLink {
  private readonly unsubs: Array<() => void> = [];
  private handle?: ProxyHandle;
  private latest?: ProxySessionStats;
  private lastEvent?: ProxyEvent;
  private dropped = false;

  constructor(
    private readonly bridge: PsppcprBridge,
    private readonly handlers: ProxyLinkHandlers,
  ) {
    this.unsubs.push(bridge.proxy.onStats((s) => this.onStats(s)));
    this.unsubs.push(bridge.proxy.onMetadata((m) => this.onMetadata(m)));
    this.unsubs.push(bridge.proxy.onEvent((e) => this.onEvent(e)));
  }

  /** Asks the main process for a session. Nothing connects until the URL is loaded. */
  mint(upstreamUrl: string, prerollSeconds: number): Promise<ProxyHandle> {
    return this.bridge.proxy.start(upstreamUrl, { prerollSeconds });
  }

  /** Makes a minted handle the current session. */
  adopt(handle: ProxyHandle): void {
    this.handle = handle;
    this.latest = undefined;
    this.lastEvent = undefined;
    this.dropped = false;
  }

  /** Throws away a handle that was minted but never used. */
  discard(handle: ProxyHandle): void {
    void this.bridge.proxy.stop(handle.sessionId);
  }

  close(): void {
    if (this.handle) void this.bridge.proxy.stop(this.handle.sessionId);
    this.handle = undefined;
    this.latest = undefined;
    this.dropped = false;
  }

  get sessionId(): string | undefined {
    return this.handle?.sessionId;
  }

  get url(): string | undefined {
    return this.handle?.url;
  }

  get stats(): ProxySessionStats | undefined {
    return this.latest;
  }

  get lastProxyEvent(): ProxyEvent | undefined {
    return this.lastEvent;
  }

  get upstreamDropped(): boolean {
    return this.dropped;
  }

  get bytesReceived(): number {
    return this.latest?.bytesReceived ?? 0;
  }

  dispose(): void {
    this.close();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  private onStats(stats: ProxySessionStats): void {
    if (stats.sessionId !== this.sessionId) return;
    this.latest = stats;
  }

  private onMetadata(meta: ProxyMetadata): void {
    if (meta.sessionId !== this.sessionId) return;
    this.handlers.metadata(meta);
  }

  private onEvent(event: ProxyEvent): void {
    if (event.sessionId !== this.sessionId) return;
    this.lastEvent = event;
    if (event.kind === 'closed' && event.graceful !== true) {
      this.dropped = true;
      this.handlers.dropped(event.message ?? 'the station stopped sending', event.detail);
    }
    this.handlers.changed();
  }
}
