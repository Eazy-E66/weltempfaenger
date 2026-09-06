#!/usr/bin/env node
/**
 * A directory and a station you control.
 *
 * Starts, on loopback, a stand-in Radio Browser directory (the four endpoints
 * the app uses) and an ICY stream server serving sixty "Rig Station N"
 * mounts, and prints the two environment variables that point the real app at
 * them. While the app runs, hit the control route to make either misbehave:
 *
 *   node tools/rig.mjs [--sample=<file.mp3>] [--dir-port=N] [--stream-port=N]
 *
 *   curl 'http://127.0.0.1:<dirport>/ctl?dir=http500'      directory: ok | refuse | hang | http404 | http429 |
 *                                                          http500 | http503 | malformed | html | wrong-shape |
 *                                                          empty | slow
 *   curl 'http://127.0.0.1:<dirport>/ctl?stream=3:stall'   station 3: ok | stall | drop | end | refuse | hang |
 *                                                          404 | 403 | 500 | html | redirect | wrong-type |
 *                                                          slow | garbage | garbage-now | silence
 *   curl 'http://127.0.0.1:<dirport>/ctl?streams=stall'    every station at once
 *   curl 'http://127.0.0.1:<dirport>/ctl?drop=all'         sever every live socket now
 *   curl 'http://127.0.0.1:<dirport>/ctl'                  what is set, and the request counts
 *
 * Without --sample the programme is silent MPEG frames, which the receiver
 * reports as DEAD AIR — enough to drive every transport and directory path,
 * not enough to see the meter move. Any MP3 file makes it audible.
 *
 * Every mode above corresponds to something a real station or mirror has done
 * to this app. The resilience fixes in the history were found by running the
 * packaged build against exactly this and provoking the failure on purpose.
 * Nothing here is imported by the app; it is a tool, and it is only reachable
 * when the app is launched with PSPPCPR_PROXY_ALLOW_PRIVATE=1.
 */
import http from 'node:http';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? '1'] : [a, '1'];
  }),
);

// One silent MPEG-1 Layer III frame (128 kbps, 44.1 kHz): header, then zeroed side info and main data.
const SILENT_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 0)]);
const SILENCE = Buffer.concat(new Array(400).fill(SILENT_FRAME));

function loadSample(file) {
  if (!file) return SILENCE;
  const d = fs.readFileSync(file);
  let i = 0;
  while (i < d.length - 1 && !(d[i] === 0xff && (d[i + 1] & 0xe0) === 0xe0)) i += 1; // skip ID3
  return d.subarray(i);
}

const TAGS = ['jazz', 'rock', 'news', 'pop', 'classical', 'talk', 'ambient', 'trip-hop', 'trip hop', 'triphop'];
const PLACES = [['DE', 'Germany'], ['FR', 'France'], ['US', 'The United States Of America'], ['JP', 'Japan'], ['BR', 'Brazil']];
const TONGUES = ['english', 'german', 'french', 'japanese', 'portuguese'];

export function makeStations(streamBase, n = 60) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const [countrycode, country] = PLACES[i % PLACES.length];
    const tags = [...new Set([TAGS[i % TAGS.length], TAGS[(i * 3) % TAGS.length]])];
    out.push({
      changeuuid: `c-${i}`,
      stationuuid: `st-${i}`,
      name: `Rig Station ${i}`,
      url: `${streamBase}/stream/${i}`,
      url_resolved: `${streamBase}/stream/${i}`,
      homepage: `${streamBase}/home/${i}`,
      favicon: '',
      tags: tags.join(','),
      country,
      countrycode,
      state: '',
      language: TONGUES[i % TONGUES.length] + (i % 7 === 0 ? ',english' : ''),
      languagecodes: 'en',
      votes: 1000 - i * 10,
      codec: i % 9 === 8 ? 'AAC' : 'MP3',
      bitrate: i % 4 === 3 ? 64 : 128,
      hls: 0,
      lastcheckok: 1,
      lastcheckoktime_iso8601: new Date().toISOString(),
      clickcount: 5000 - i * 50,
      clicktrend: 0,
      geo_lat: 10 + i,
      geo_long: -100 + i * 3,
    });
  }
  // The rows a real directory also contains.
  out[5].url = out[5].url_resolved = `${streamBase}/hls/5.m3u8`;
  out[5].hls = 1;
  out[6].lastcheckok = 0;
  out[7].name = '   Rig Station 7   ';
  out.push({ ...out[8] }); // duplicate uuid
  out.push({ stationuuid: 'st-nofields', name: 'Bare Station', url: `${streamBase}/stream/61` });
  out.push({ stationuuid: '', name: 'No Id', url: `${streamBase}/stream/62` });
  out.push({ stationuuid: 'st-nourl', name: 'No Url', url: '' });
  return out;
}

export async function startRig({ sample = null, streamPort = 0, dirPort = 0 } = {}) {
  const programme = loadSample(sample);
  const rig = {
    dirMode: 'ok',
    streamModes: new Map(),
    defaultStreamMode: 'ok',
    dirRequests: 0,
    streamRequests: 0,
    liveSockets: new Set(),
  };
  const garbage = Buffer.alloc(programme.length);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7919 + 13) & 0xff;

  // ---- the station -------------------------------------------------------
  let streamBase = '';
  const streamServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    rig.streamRequests += 1;
    if (url.pathname.startsWith('/hls/')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nchunklist.m3u8\n');
      return;
    }
    if (url.pathname === '/pls/1') {
      res.writeHead(200, { 'content-type': 'audio/x-scpls' });
      res.end(`[playlist]\nNumberOfEntries=1\nFile1=${streamBase}/stream/1\nTitle1=Rig 1\n`);
      return;
    }
    const m = /^\/stream\/(\d+)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such stream');
      return;
    }
    const id = Number(m[1]);
    serveStream(req, res, id, rig.streamModes.get(id) ?? rig.defaultStreamMode);
  });

  function serveStream(req, res, id, mode) {
    const plain = (status, body) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); };
    if (mode === '404') return plain(404, 'gone');
    if (mode === '500') return plain(500, 'boom');
    if (mode === '403') return plain(403, 'no');
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>This domain is parked</body></html>'); return; }
    if (mode === 'refuse') { req.socket.destroy(); return; }
    if (mode === 'hang') { rig.liveSockets.add(req.socket); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: `${streamBase}/stream/${(id + 1) % 60}` }); res.end(); return; }
    const wantMeta = String(req.headers['icy-metadata'] ?? '') === '1';
    const metaint = 16000;
    const headers = {
      'content-type': mode === 'wrong-type' ? 'video/mp4' : 'audio/mpeg',
      'icy-name': `Rig Station ${id}`,
      'icy-br': '128',
      'icy-genre': 'Rig',
      'cache-control': 'no-cache',
      connection: 'close',
    };
    if (wantMeta) headers['icy-metaint'] = String(metaint);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    rig.liveSockets.add(res.socket);
    const source = mode === 'silence' ? SILENCE : mode === 'garbage' ? garbage : programme;
    const bytesPerTick = mode === 'slow' ? 1500 : 4000; // 128 kbps is 16 000 B/s; the tick is 250 ms
    let burst = mode === 'slow' ? 0 : 3; // Icecast bursts a few seconds on connect; so does this
    let offset = 0;
    let sinceMeta = 0;
    const startedAt = Date.now();
    const write = (buf) => { if (!res.writableEnded) res.write(buf); };
    const timer = setInterval(() => {
      const state = rig.streamModes.get(id) ?? rig.defaultStreamMode;
      if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
      if (state === 'stall') return;
      if (state === 'drop') { clearInterval(timer); res.socket.destroy(); return; }
      if (state === 'end') { clearInterval(timer); res.end(); return; }
      const src = state === 'garbage-now' ? garbage : source;
      let n = burst > 0 ? (burst--, 64000) : bytesPerTick;
      while (n > 0) {
        const room = wantMeta ? Math.min(n, metaint - sinceMeta) : n;
        const chunk = src.subarray(offset, Math.min(src.length, offset + room));
        write(chunk);
        offset = offset + chunk.length >= src.length ? 0 : offset + chunk.length;
        n -= chunk.length;
        if (!wantMeta) continue;
        sinceMeta += chunk.length;
        if (sinceMeta === metaint) {
          sinceMeta = 0;
          const title = `StreamTitle='Rig Artist - Track ${id}.${Math.floor((Date.now() - startedAt) / 20000)}';`;
          const len = Math.ceil((title.length + 1) / 16);
          const block = Buffer.alloc(1 + len * 16, 0);
          block[0] = len;
          block.write(title, 1, 'latin1');
          write(block);
        }
      }
    }, 250);
    res.on('close', () => { clearInterval(timer); rig.liveSockets.delete(res.socket); });
  }

  await new Promise((r) => streamServer.listen(streamPort, '127.0.0.1', r));
  streamBase = `http://127.0.0.1:${streamServer.address().port}`;
  const rows = makeStations(streamBase);

  // ---- the directory -----------------------------------------------------
  const dirServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (url.pathname === '/ctl') {
      const q = url.searchParams;
      if (q.has('dir')) rig.dirMode = q.get('dir');
      if (q.has('streams')) { rig.defaultStreamMode = q.get('streams'); rig.streamModes.clear(); }
      if (q.has('stream')) { const [id, mode] = q.get('stream').split(':'); rig.streamModes.set(Number(id), mode); }
      if (q.get('drop') === 'all') { for (const s of rig.liveSockets) s.destroy(); rig.liveSockets.clear(); }
      return json(200, {
        dir: rig.dirMode,
        streams: rig.defaultStreamMode,
        overrides: Object.fromEntries(rig.streamModes),
        liveSockets: rig.liveSockets.size,
        dirRequests: rig.dirRequests,
        streamRequests: rig.streamRequests,
      });
    }
    rig.dirRequests += 1;
    const mode = rig.dirMode;
    if (mode === 'refuse') { req.socket.destroy(); return; }
    if (mode === 'hang') { rig.liveSockets.add(req.socket); return; }
    if (mode === 'http500') return json(500, { error: 'internal' });
    if (mode === 'http503') return json(503, { error: 'unavailable' });
    if (mode === 'http404') return json(404, { error: 'nope' });
    if (mode === 'http429') { res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '30' }); res.end('slow down'); return; }
    if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"this": [is not, json'); return; }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><h1>Captive portal</h1></body></html>'); return; }
    if (mode === 'empty') return json(200, []);
    if (mode === 'wrong-shape') return json(200, { stations: 'yes' });
    const answer = () => {
      const p = url.pathname;
      const has = (field, value) => (s) => (s[field] || '').split(',').map((t) => t.trim()).includes(value);
      if (p === '/json/countries') return json(200, PLACES.map(([code, name]) => ({ name, iso_3166_1: code, stationcount: rows.filter((s) => s.countrycode === code).length })));
      if (p === '/json/states') return json(200, []);
      if (p === '/json/languages') return json(200, TONGUES.map((name) => ({ name, iso_639: name.slice(0, 2), stationcount: rows.filter(has('language', name)).length })));
      if (p === '/json/tags') return json(200, TAGS.map((name) => ({ name, stationcount: rows.filter(has('tags', name)).length })));
      if (p === '/json/stats') return json(200, { stations: rows.length, tags: TAGS.length, countries: PLACES.length, languages: TONGUES.length });
      if (p.startsWith('/json/url/')) return json(200, { ok: 'true' });
      if (p === '/json/stations/search') {
        const q = url.searchParams;
        let list = rows.slice();
        if (q.get('tag')) list = list.filter(has('tags', q.get('tag').toLowerCase()));
        if (q.get('countrycode')) list = list.filter((s) => (s.countrycode || '').toUpperCase() === q.get('countrycode').toUpperCase());
        if (q.get('language')) list = list.filter(has('language', q.get('language')));
        if (q.get('name')) list = list.filter((s) => (s.name || '').toLowerCase().includes(q.get('name').toLowerCase()));
        const offset = Number(q.get('offset') || 0);
        const limit = Number(q.get('limit') || 100);
        return json(200, list.slice(offset, offset + limit));
      }
      return json(404, { error: `unknown route ${p}` });
    };
    if (mode === 'slow') { setTimeout(answer, 6000); return; }
    answer();
  });
  await new Promise((r) => dirServer.listen(dirPort, '127.0.0.1', r));
  const dirBase = `http://127.0.0.1:${dirServer.address().port}`;

  return {
    rig,
    rows,
    dirBase,
    streamBase,
    env: () => ({ PSPPCPR_DIRECTORY_MIRRORS: dirBase, PSPPCPR_PROXY_ALLOW_PRIVATE: '1' }),
    setDirMode: (mode) => { rig.dirMode = mode; },
    setStreamMode: (id, mode) => { rig.streamModes.set(id, mode); },
    setAllStreams: (mode) => { rig.defaultStreamMode = mode; rig.streamModes.clear(); },
    dropAll: () => { for (const s of rig.liveSockets) s.destroy(); rig.liveSockets.clear(); },
    liveCount: () => rig.liveSockets.size,
    close: async () => {
      for (const s of rig.liveSockets) s.destroy();
      await new Promise((r) => streamServer.close(r));
      await new Promise((r) => dirServer.close(r));
    },
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const R = await startRig({
    sample: args.sample ?? null,
    dirPort: Number(args['dir-port'] ?? 0),
    streamPort: Number(args['stream-port'] ?? 0),
  });
  console.log(`directory  ${R.dirBase}`);
  console.log(`station    ${R.streamBase}/stream/<0..59>`);
  console.log(`programme  ${args.sample ? args.sample : 'silent frames (pass --sample=<file.mp3> for audio)'}`);
  console.log('');
  console.log('launch the app with:');
  console.log(`  PSPPCPR_DIRECTORY_MIRRORS=${R.dirBase} PSPPCPR_PROXY_ALLOW_PRIVATE=1 npm start`);
  console.log('');
  console.log('control:');
  console.log(`  curl '${R.dirBase}/ctl?dir=http500'      curl '${R.dirBase}/ctl?stream=3:stall'`);
  console.log(`  curl '${R.dirBase}/ctl?streams=drop'     curl '${R.dirBase}/ctl?drop=all'`);
  process.on('SIGINT', () => { void R.close().then(() => process.exit(0)); });
}
