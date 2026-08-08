# LIVE tests — not part of `npm test`

Everything in this directory opens real sockets to the public internet.

    npm run test:live      # this directory only, via vitest.live.config.ts
    npm test               # never runs this directory

These are **smoke checks**, not correctness gates. They fail for reasons that
have nothing to do with the code: a station retires, a Radio Browser mirror
reboots, a captive portal intercepts port 80, an office firewall blocks
non-standard ports. A red run here means "go and look", not "the build is
broken".

Anything these tests prove about behaviour is also proved offline, against
fixtures, in the deterministic suite. The only thing that can *only* be checked
here is that the real world still looks the way the offline fixtures claim it
does.

Known-good targets at the time of writing:

| Target | Why it is here |
|---|---|
| `https://ice1.somafm.com/groovesalad-128-mp3` | direct MP3 stream, ICY metadata |
| `https://de1.api.radio-browser.info` | a real Radio Browser mirror |
| `https://all.api.radio-browser.info/json/servers` | real mirror discovery |
