#!/usr/bin/env node
/**
 * Proves audio actually reached the operating system's output device.
 *
 * The engine's own AnalyserNode RMS proves the decoder produced samples, but it
 * cannot prove those samples left the process. This captures the system sink
 * itself with pw-record and measures the PCM that the OS actually played.
 *
 *   node tools/verify-audible.mjs [seconds] [outfile]
 *
 * Exit 0 = non-silent audio was captured. Exit 1 = silence (or capture failed).
 * Linux/PipeWire only; it is a verification tool, not part of the app.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const seconds = Number(process.argv[2] ?? 6);
const outFile = process.argv[3] ?? '/tmp/psppcpr-monitor.wav';

/** Find the default sink and derive its monitor source name. */
function findMonitor() {
  // execFileSync, not execSync: no shell, so nothing here can be interpolated into one.
  const objs = execFileSync('pw-cli', ['list-objects', 'Node'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Parse per object block. Sweeping the whole output for node.name and
  // media.class separately and zipping the two lists is wrong: nodes without a
  // media.class (Dummy-Driver, Freewheel-Driver) shift the alignment, and the
  // lists then disagree on which class belongs to which name.
  const blocks = objs.split(/^(?=\s*id \d+,)/m);
  const nodes = blocks
    .map((b) => ({
      name: b.match(/node\.name\s*=\s*"([^"]+)"/)?.[1],
      cls: b.match(/media\.class\s*=\s*"([^"]+)"/)?.[1],
    }))
    .filter((n) => n.name);

  const sink =
    nodes.find((n) => n.cls === 'Audio/Sink' && n.name.startsWith('alsa_output'))?.name ??
    nodes.find((n) => n.cls === 'Audio/Sink')?.name ??
    nodes.find((n) => n.name.startsWith('alsa_output'))?.name;

  if (!sink) throw new Error('no Audio/Sink node found');
  // PipeWire captures a sink's output by targeting the sink node itself with
  // stream.capture.sink=true. The trailing ".monitor" name is PulseAudio's
  // convention and silently yields an empty capture here.
  return sink;
}

/** Peak and RMS of 16-bit LE PCM, skipping the 44-byte WAV header. */
function analyse(path) {
  const buf = readFileSync(path);
  if (buf.length <= 44) return { samples: 0, peak: 0, rms: 0, nonSilentPct: 0 };
  let peak = 0;
  let sumSq = 0;
  let nonSilent = 0;
  const n = (buf.length - 44) >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(44 + i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a > 0.0005) nonSilent++;
    sumSq += s * s;
  }
  return {
    samples: n,
    peak,
    rms: Math.sqrt(sumSq / n),
    nonSilentPct: (nonSilent / n) * 100,
  };
}

const sinkNode = findMonitor();
console.log(`capture target : ${sinkNode}  (sink node, captured via stream.capture.sink)`);
console.log(`capturing      : ${seconds}s -> ${outFile}`);
if (existsSync(outFile)) unlinkSync(outFile);

const rec = spawn(
  'pw-record',
  [
    '--target', sinkNode,
    '-P', '{ stream.capture.sink=true }',
    '--rate', '44100',
    '--channels', '2',
    '--format', 's16',
    outFile,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

setTimeout(() => {
  rec.kill('SIGINT');
  setTimeout(() => {
    const r = analyse(outFile);
    const dbfs = r.peak > 0 ? (20 * Math.log10(r.peak)).toFixed(1) : '-inf';
    console.log(
      `\nsamples        : ${r.samples}\n` +
        `peak           : ${r.peak.toFixed(4)}  (${dbfs} dBFS)\n` +
        `rms            : ${r.rms.toFixed(4)}\n` +
        `non-silent     : ${r.nonSilentPct.toFixed(1)}% of samples`,
    );
    // A real music stream is continuously non-silent. A stalled or null-sink
    // capture reads flat zero; a click or pop would be a brief spike only.
    const audible = r.rms > 0.001 && r.nonSilentPct > 50;
    console.log(`\n${audible ? 'PASS' : 'FAIL'}: audio ${audible ? 'reached' : 'did NOT reach'} the OS output device`);
    process.exit(audible ? 0 : 1);
  }, 600);
}, seconds * 1000);
