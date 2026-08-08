/**
 * Law 2, corollary: "no fixture, mock, or demo mode may ever be reachable from
 * the shipping UI in a way that looks like real playback."
 *
 * That used to be enforced by a comment. It is now enforced here.
 *
 * The mock feeder (`ui/harness/mock.ts`) sets `phase: 'playing'`, hardcodes a
 * bitrate and a sample rate, invents ICY titles from a canned list, and drives
 * `signalLevel` from a sum of sines plus `Math.random()`. If any module the
 * production entry points can reach ever imports it again, Rollup emits it as a
 * chunk, electron-builder packs that chunk into app.asar, and a shipped build
 * once more contains a timer-driven needle. This test walks the static import
 * graph from the two `index.html` entry scripts and fails the moment the
 * harness becomes reachable — before a build is ever produced.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, '..', '..', 'src', 'renderer');

/** The scripts `src/renderer/index.html` loads. Everything shipped hangs off these. */
const PRODUCTION_ENTRIES = ['host/index.ts', 'ui/boot.ts'];

/** Anything under here is development-only and must never be shipped. */
const FORBIDDEN_DIR = path.join(RENDERER, 'ui', 'harness');

/**
 * Development-only stylesheets.
 *
 * The mock feeder was cut out of the JS graph and the CSS was missed: a single
 * `@import './harness.css'` in styles/index.css put four `.harness-focus-demo`
 * rules plus `.harness-bar` and `.harness-sep` into every shipped bundle, where
 * `.harness-focus-demo` in particular exists solely to *fake* a focus ring that
 * a headless capture window cannot receive. Nothing dev-only ships, and a
 * stylesheet is no more exempt than a module.
 */
const FORBIDDEN_STYLES = ['harness.css'];

/** Matches `@import '<spec>'` and `@import url(<spec>)`. */
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;

/** Every stylesheet reachable from `entry`, with the path that got there. */
function reachableStyles(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [path.relative(RENDERER, entry)] },
  ];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, trail);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    CSS_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CSS_IMPORT_RE.exec(source)) !== null) {
      const spec = match[1];
      if (!spec || !spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!seen.has(target)) queue.push({ file: target, trail: [...trail, path.relative(RENDERER, target)] });
    }
  }
  return seen;
}

/** Matches `import ... from '<spec>'`, `import '<spec>'` and `import('<spec>')`. */
const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(fromFile: string, spec: string): string | null {
  // Bare specifiers are npm packages; there are none in the renderer, and a
  // package could not reach into src/renderer/ui/harness anyway.
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    base.replace(/\.js$/, '.ts'),
    path.join(base, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module reachable from `entry`, with the path that got there. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [path.relative(RENDERER, entry)] },
  ];

  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, trail);
    if (!/\.[cm]?ts$/.test(file)) continue;

    const source = fs.readFileSync(file, 'utf8');
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const target = resolveSpecifier(file, spec);
      if (target && !seen.has(target)) {
        queue.push({ file: target, trail: [...trail, path.relative(RENDERER, target)] });
      }
    }
  }
  return seen;
}

describe('the mock feeder cannot be reached from the shipping UI', () => {
  it('has entry points that actually exist', () => {
    for (const entry of PRODUCTION_ENTRIES) {
      expect(fs.existsSync(path.join(RENDERER, entry))).toBe(true);
    }
  });

  it('is loaded by index.html in exactly the order the host relies on', () => {
    const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    const hostAt = html.indexOf('host/index.ts');
    const bootAt = html.indexOf('ui/boot.ts');
    expect(hostAt).toBeGreaterThan(-1);
    expect(bootAt).toBeGreaterThan(-1);
    expect(hostAt).toBeLessThan(bootAt);
    // The harness page is a separate document; production must not load it.
    expect(html).not.toContain('harness');
  });

  for (const entry of PRODUCTION_ENTRIES) {
    it(`reaches no development-only module from ${entry}`, () => {
      const reached = reachableFrom(path.join(RENDERER, entry));
      const offenders = [...reached.entries()]
        .filter(([file]) => file.startsWith(FORBIDDEN_DIR + path.sep))
        .map(([, trail]) => trail.join(' -> '));
      expect(offenders).toEqual([]);
    });
  }

  it('reaches no development-only stylesheet from the production CSS entry', () => {
    // ui/boot.ts imports exactly one stylesheet; everything the shipped bundle
    // contains hangs off that @import graph.
    const boot = fs.readFileSync(path.join(RENDERER, 'ui', 'boot.ts'), 'utf8');
    expect(boot).toMatch(/import\s+['"][^'"]*styles\/index\.css['"]/);

    const reached = reachableStyles(path.join(RENDERER, 'styles', 'index.css'));
    const offenders = [...reached.entries()]
      .filter(([file]) => FORBIDDEN_STYLES.includes(path.basename(file)))
      .map(([, trail]) => trail.join(' -> '));
    expect(offenders).toEqual([]);
  });

  it('keeps the dev-only stylesheets importable only by the harness', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(css|[cm]?ts)$/.test(full)) continue;
        if (full.startsWith(FORBIDDEN_DIR + path.sep)) continue;
        if (FORBIDDEN_STYLES.includes(path.basename(full))) continue;
        const source = fs.readFileSync(full, 'utf8');
        for (const style of FORBIDDEN_STYLES) {
          // An @import or an ES import of the file, by any relative path.
          if (new RegExp(`['"][^'"]*${style.replace('.', '\\.')}['"]`).test(source)) {
            offenders.push(`${path.relative(RENDERER, full)} -> ${style}`);
          }
        }
      }
    };
    walk(RENDERER);
    expect(offenders).toEqual([]);
  });

  it('leaves the mock with no importer outside the harness directory', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.[cm]?ts$/.test(full)) continue;
        if (full.startsWith(FORBIDDEN_DIR + path.sep)) continue;
        if (/from\s+['"][^'"]*harness\/|import\s*\(\s*['"][^'"]*harness\//.test(
          fs.readFileSync(full, 'utf8'),
        )) {
          offenders.push(path.relative(RENDERER, full));
        }
      }
    };
    walk(RENDERER);
    expect(offenders).toEqual([]);
  });
});
