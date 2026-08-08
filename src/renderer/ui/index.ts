/**
 * mountFaceplate — the whole receiver, assembled.
 *
 * THE ONE RULE: this module renders `PlaybackState`, `Band` and `Settings`, and
 * nothing else. It has no idea whether audio is playing; it knows what the
 * engine last told it. Pressing POWER emits an intent and changes nothing on
 * screen except the button's own travel under the finger. If the host never
 * answers, the panel sits there looking exactly as dead as the radio is.
 *
 * Dial position is the one piece of state the faceplate does own, because it is
 * an input — the same way a scroll offset is. It is reported outwards through
 * onTune, and it re-syncs to the host's station whenever the flywheel is at
 * rest, so a preset recall visibly winds the drum round to the new channel.
 */

import type {
  Band,
  Cut,
  LogEntry,
  PlaybackState,
  Preset,
  RegisterIndex,
  Settings,
  StationRef,
} from '../../shared/contracts';
import { EMPTY_SCOPE, INITIAL_PLAYBACK_STATE, DEFAULT_SETTINGS } from '../../shared/contracts';
import type { BrowseResults, FaceplateHandle, FaceplateHandlers, PanelNotice } from './types';
import { PHASE_LABEL, airStateOf, isPowered } from './types';
import { clamp, el, setAttr, setFlag, setText, silk } from './dom';
import { installTextureDefs, textureLayer } from './textures';
import { installMaterials, mountBezel, mountDust, mountHandle, mountScrew, mountWear, paintPowerDome } from './materials';
import { TuningModel } from './tuning';
import { createKnob } from './components/knob';
import { createMeterBand } from './components/meterBand';
import { createTuningKnob } from './components/tuningKnob';
import { createDrumDial } from './components/drumDial';
import { createMeter } from './components/meter';
import { createReadout } from './components/readout';
import {
  createButton,
  createGrille,
  createJack,
  createLever,
  createLogbook,
  createPiano,
  createPresets,
} from './components/parts';
import { createLid } from './components/lid';
import type { RegisterSearchField } from './components/register';
import { METER_BANDS } from '../../main/tuning/bandLayout';

export type { FaceplateHandle, FaceplateHandlers, BrowseResults } from './types';

/** The power button's collar and its dome, CSS px — the dome is seated 4px in. */
const POWER_D = 46;
const POWER_DOME_D = 38;
/** The fasteners holding each carry handle to its cheek. */
const CHEEK_BOSS_D = 13;
const EMPTY_BAND: Band = {
  genre: '',
  stationCount: 0,
  slots: [],
  scaleMin: 88,
  scaleMax: 108,
  scaleUnit: 'MHz',
};

export function mountFaceplate(root: HTMLElement, handlers: FaceplateHandlers): FaceplateHandle {
  installTextureDefs();

  // -------------------------------------------------------------------------
  // Model held for rendering. Read-only as far as this module is concerned.
  let state: PlaybackState = INITIAL_PLAYBACK_STATE;
  let band: Band = EMPTY_BAND;
  let settings: Settings = DEFAULT_SETTINGS;
  let presets: Preset[] = [];
  let cut: Cut | null = null;
  let cutBandIndex = 0;
  let lidOpen = false;
  /** True while the annunciator is carrying a message. Drives the REGISTER lamp. */
  let noticeUp = false;
  /** Set while pushing host state into controls, so they do not echo back. */
  let applying = false;

  // -------------------------------------------------------------------------
  // Tuning: the flywheel, shared by the big knob and the drum.

  const tuning = new TuningModel({
    onPosition(position, phase) {
      drum.setPosition(position);
      tuningKnob.sync();
      if (!applying) handlers.onTune(position, phase);
    },
    onSettle() {
      /* The host resolves position → station; we do not guess for it. */
    },
  });

  // -------------------------------------------------------------------------
  // Controls

  /* The power button is a moulded translucent dome, and it is the one part on
     the panel the brief singles out as an anti-goal if it is done as gradients:
     a soft radial highlight on a colour ramp is the Aqua button. What makes a
     photographed dome a photograph is the room in it — a bright ceiling, a dark
     desk, and a hard horizon between them, reflected across a curved surface —
     plus Fresnel at the silhouette, transmission that deepens with path length,
     and, when it is lit, a caustic pooling against the LOWER inner wall rather
     than a glow at the top. None of that is expressible in CSS, which has no
     notion of a surface normal. */
  const powerDome = el('canvas', { class: 'power-btn__dome', 'aria-hidden': 'true' });
  const powerCollar = el('canvas', { class: 'power-btn__collar', 'aria-hidden': 'true' });
  paintPowerDome(powerDome, false, POWER_DOME_D);
  mountBezel(powerCollar, POWER_D, { r0: 0.8, smooth: true });
  const power = el(
    'button',
    { class: 'power-btn', type: 'button', 'aria-label': 'Radio power', 'aria-pressed': 'false' },
    [powerCollar, el('span', { class: 'mx-halo power-btn__halo' }), powerDome],
  );
  power.addEventListener('click', () => handlers.onPower(!isPowered(state)));
  let powerLit: boolean | null = null;

  const powerCluster = el('div', { class: 'power' }, [
    silk('Radio'),
    silk('On', 'teal'),
    power,
    silk('Standby'),
  ]);

  const meter = createMeter();
  const meterBand = createMeterBand((i) => handlers.onSelectMeterBand(i));

  const volume = createKnob({
    label: 'Volume',
    min: 0,
    max: 1,
    value: settings.volume,
    step: 0.05,
    scale: { kind: 'numeric', from: 0, to: 8, ticks: 8 },
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => handlers.onSetVolume(v),
  });

  const bass = createKnob({
    label: 'Bass',
    min: -12,
    max: 12,
    value: settings.bassDb,
    step: 1,
    scale: { kind: 'centered', minLabel: '−', midLabel: '0', maxLabel: '+' },
    tealTickAt: 0.5,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`,
    onInput: (v) => handlers.onSetBass(v),
  });

  const treble = createKnob({
    label: 'Treble',
    min: -12,
    max: 12,
    value: settings.trebleDb,
    step: 1,
    scale: { kind: 'centered', minLabel: '−', midLabel: '0', maxLabel: '+' },
    tealTickAt: 0.5,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`,
    onInput: (v) => handlers.onSetTreble(v),
  });

  const rfGain = createKnob({
    label: 'AM RF Gain',
    ariaLabel: 'AM RF gain — inter-station noise floor',
    min: 0,
    max: 1,
    value: settings.noiseFloor,
    step: 0.05,
    scale: { kind: 'minmax', minLabel: 'Min', maxLabel: 'Max' },
    tealTickAt: 0.35,
    readout: true,
    format: (v) => `${Math.round(v * 100)}`,
    onInput: (v) => handlers.onSetNoiseFloor(v),
  });

  const afc = createLever({
    label: 'AFC',
    offLabel: 'Off',
    onLabel: 'On',
    ariaLabel: 'AFC — automatically reconnect when the stream drops',
    onChange: (on) => handlers.onToggleAfc(on),
  });

  const bufferSel = createPiano({
    label: 'Bandwidth',
    ariaLabel: 'Buffer depth',
    options: [
      { value: 'narrow', label: 'Narrow', hint: 'Shallow buffer — snappy tuning, less tolerant of a bad link' },
      { value: 'wide', label: 'Wide', hint: 'Deep buffer — robust over a poor link, slower to start' },
    ],
    onChange: (v) => handlers.onSetBufferDepth(v as 'narrow' | 'wide'),
  });

  const lightBtn = createButton({
    label: 'Light',
    ariaLabel: 'Dial lamp',
    lamp: 'amber',
    onPress: () => handlers.onToggleDialLamp(!settings.dialLampOn),
  });

  const reconnectBtn = createButton({
    label: 'Reconnect',
    ariaLabel: 'Reconnect to the stream',
    lamp: 'fault',
    wide: true,
    onPress: () => handlers.onReconnect(),
  });

  const presetBank = createPresets({
    onRecall: (slot) => handlers.onRecallPreset(slot),
    onStore: (slot) => handlers.onStorePreset(slot),
  });

  // The log strip rides on the dial head, above the scale it refers to, which
  // is where a receiver's paper log actually lives. Selecting a line is an
  // ordinary station selection — the host looks it up in the log the same way
  // it looks one up in the band.
  const logbook = createLogbook((id) => handlers.onSelectStation(id));

  const readout = createReadout();

  /**
   * Whether the flywheel has anything to turn.
   *
   * Law 1, applied to the largest control on the panel. An uncut drum has no
   * scale, no stations and no lock zones, so the shaft has no job — and it was
   * nonetheless fully live: a real four-turn arc drag wound the printed scale
   * from 9590–9710 kHz to 9740–9860 kHz with the pointer lit while
   * `document.body.innerText` stayed byte-identical. Nothing moved that meant
   * anything, and nothing said so.
   */
  const dialLive = (): boolean => band.slots.length > 0;

  const drum = createDrumDial({
    // The drum scrubs the same flywheel the knob does, so it answers to the same
    // lock. Refusing here rather than inside the model keeps the model a physics
    // object: it is the *chassis* that knows the drum is blank.
    onScrubStart: () => {
      if (!dialLive()) {
        tuningKnob.refuse();
        return;
      }
      tuning.beginDrag();
    },
    onScrub: (delta, fine) => {
      if (!dialLive()) return;
      tuning.dragBy(delta * (fine ? 0.22 : 1));
    },
    onScrubEnd: () => {
      if (!dialLive()) return;
      tuning.endDrag();
    },
    onPickStation: (id) => handlers.onSelectStation(id),
  });

  const tuningKnob = createTuningKnob(tuning, () => handlers.onDialLocked());

  const lid = createLid({
    onToggle: (open) => handlers.onLidToggle(open),
    onSelect: (id) => handlers.onSelectStation(id),
    onScope: (scope) => handlers.onScope(scope),
    onCut: (rows, caption, quality) => handlers.onCut(rows, caption, quality),
    onReprint: () => handlers.onReprint(),
    // RECONNECT, reachable from the surface the failing click was made on. Same
    // handler as the front panel's button — one recovery action, two places to
    // reach it, because the open lid hides one of them.
    onReconnect: () => handlers.onReconnect(),
    onSettled: (open) => sealFaceplate(open),
  });

  /* The lamp is a real state, not decoration (Law 1): it is lit exactly when
     the drum is empty and the thing that fills it is behind this button, and it
     pulses while the panel is actively saying so. A first-time user reading
     "PRESS REGISTER" on the annunciator should not then have to hunt the panel
     for which of eleven controls that is. */
  const registerBtn = createButton({
    label: 'Stations',
    ariaLabel: 'Open the world station register',
    lamp: 'amber',
    onPress: () => handlers.onLidToggle(!lidOpen),
  });

  // -------------------------------------------------------------------------
  // Layout

  const speaker = el('section', { class: 'speaker' }, [
    el('div', { class: 'speaker__brand' }, [
      el('span', { class: 'brand' }, ['Weltempfänger']),
    ]),
    createGrille(),
    el('div', { class: 'speaker__model' }, [
      silk('Internet Multi Band Receiver'),
      silk('PSP-6800W', 'teal'),
    ]),
    el('div', { class: 'tone' }, [
      createJack('Phones'),
      bass.root,
      treble.root,
      volume.root,
    ]),
  ]);

  /* ---------------------------------------------------------------------
     THE SHORT WAVE BAND PLAN — printed matter, and the answer to what a wide
     window buys.

     It is not a control and it has no job to do under Law 1, because it is not
     a control: it is silkscreen, which is what the reference device is covered
     in. What it is *for* is the defect it replaces. `.zone--sw` used to be a
     `space-between` row, so every pixel of extra window width went into the
     gaps between the switch groups — 14 px at 880, 135 px at 1280, 300 px at
     1918 — and the reference device's defining quality is density. Now the
     groups hold their spacing and the surplus goes here, where more width buys
     more graduations and more legible band legends rather than more void.

     The data is real: the twelve ITU shortwave broadcasting allocations the
     dial actually prints on, at their true logarithmic positions between 1.8
     and 30 MHz, with the band the drum is currently cut to marked in teal.
     ------------------------------------------------------------------- */
  const PLAN_LO = 1800;
  const PLAN_HI = 30_000;
  const planAt = (khz: number): number =>
    (Math.log(clamp(khz, PLAN_LO, PLAN_HI)) - Math.log(PLAN_LO)) /
    (Math.log(PLAN_HI) - Math.log(PLAN_LO));

  const planCursor = el('span', { class: 'plan__cursor' });
  const planScale = el('div', { class: 'plan' }, [
    el('div', { class: 'plan__rule' }),
    planCursor,
  ]);
  for (const meterBandEntry of METER_BANDS) {
    const a = planAt(meterBandEntry.scaleMin) * 100;
    const b = planAt(meterBandEntry.scaleMax) * 100;
    const seg = el('span', { class: 'plan__seg' });
    seg.style.left = `${a.toFixed(2)}%`;
    seg.style.width = `${Math.max(0.5, b - a).toFixed(2)}%`;
    // Alternating legends, so a narrow plan can drop half of them rather than
    // printing twelve labels through each other.
    const minor = METER_BANDS.indexOf(meterBandEntry) % 2 === 1;
    const lab = el('span', { class: `plan__lab${minor ? ' plan__lab--minor' : ''}` }, [
      meterBandEntry.label.replace(/\s+/g, ''),
    ]);
    lab.style.left = `${((a + b) / 2).toFixed(2)}%`;
    planScale.append(seg, lab);
  }
  const bandPlan = el('div', { class: 'sw-plan', 'aria-hidden': 'true' }, [
    el('span', { class: 'silk silk--teal silk-rule' }, ['Short Wave Band Plan · 1.8 – 30 MHz']),
    planScale,
  ]);

  /** Mark where on the printed plan the drum is currently cut. */
  function paintBandPlan(): void {
    const cut1 = band.scaleUnit === 'kHz' && band.scaleMax >= PLAN_LO && band.scaleMin <= PLAN_HI;
    setFlag(planCursor, 'is-on', cut1);
    if (!cut1) return;
    const a = planAt(band.scaleMin) * 100;
    const b = planAt(band.scaleMax) * 100;
    planCursor.style.left = `${a.toFixed(2)}%`;
    planCursor.style.width = `${Math.max(0.8, b - a).toFixed(2)}%`;
  }

  const panel = el('section', { class: 'panel mat-black' }, [
    textureLayer('matte'),
    el('div', { class: 'panel__grid' }, [
      el('div', { class: 'zone zone--power' }, [powerCluster]),
      el('div', { class: 'zone zone--meter' }, [meter.root]),
      el('div', { class: 'zone zone--genre' }, [meterBand.root]),
      el('div', { class: 'zone zone--aux' }, [rfGain.root]),
      el('div', { class: 'zone zone--info' }, [readout.root]),
      el('div', { class: 'zone zone--dial' }, [
        el('div', { class: 'dial-head' }, [
          silk('MW/SW Tuning Dial'),
          logbook.root,
          el('span', { class: 'silk silk--teal dial-head__band' }, ['—']),
        ]),
        drum.root,
      ]),
      el('div', { class: 'zone zone--tune' }, [
        el('div', { class: 'sw-group sw-group--memory' }, [
          el('span', { class: 'silk silk--lg silk-rule' }, ['Memory']),
          presetBank.root,
        ]),
        tuningKnob.root,
      ]),
      el('div', { class: 'zone zone--sw' }, [
        afc.root,
        bufferSel.root,
        bandPlan,
        el('div', { class: 'sw-group sw-group--btns' }, [
          el('span', { class: 'silk silk--teal silk-rule' }, ['Light / Recovery / Index']),
          el('div', { class: 'sw-btns' }, [lightBtn.root, reconnectBtn.root, registerBtn.root]),
        ]),
      ]),
    ]),
  ]);

  // The case's side cheeks and fold-out carry handles. They are on the real
  // object — a chunky bracket each side — and they are what a very wide window
  // gets instead of empty desk: more radio, not more void. The reflow reveals
  // them by giving `.shell` a cheek width; at narrow widths they are zero.
  const cheek = (side: 'l' | 'r'): HTMLElement => {
    /* The cheek is a real plane with a real normal, so its brightness is
       `ambient + N·L` from the one light vector — written into `--face-left` /
       `--face-right` at boot. The left cheek turns toward the lamp and is
       BRIGHTER than the front; the right turns away and is darker. Neither is
       hand-picked, so growing a face can never produce a flat panel: it
       produces a bigger box under the same lamp.

       The handle is a different material from the shell, and must not be shaded
       like it: moulded satin plastic has a broad low-exponent specular with a
       soft edge and no anisotropy. It is bolted on, so it gets fasteners and a
       contact shadow that is tight where it touches and opens out away. */
    const handle = el('div', { class: 'cheek__handle mx-handle' });
    const bossT = el('canvas', { class: 'cheek__boss cheek__boss--t' });
    const bossB = el('canvas', { class: 'cheek__boss cheek__boss--b' });
    mountHandle(handle);
    mountScrew(bossT, CHEEK_BOSS_D);
    mountScrew(bossB, CHEEK_BOSS_D);
    const root = el(
      'div',
      { class: `cheek cheek--${side} mx-face--${side === 'l' ? 'left' : 'right'}`, 'aria-hidden': 'true' },
      [el('div', { class: 'mx-grain' }), el('div', { class: 'mx-wear' }), handle, bossT, bossB],
    );
    // The arris — where the front face wraps round to the cheek — is the single
    // most worn line on a real case, so that is the edge the wear map favours.
    mountWear(root, side === 'l' ? ['right', 'top'] : ['left', 'top']);
    return root;
  };

  const lidBay = el('div', { class: 'shell__bay', 'aria-hidden': 'true' });

  /**
   * Everything the drawn-out register stands in front of.
   *
   * Held as its own node because it is the thing that gets sealed: with the
   * sheet out it covers this element completely, and a control you cannot see
   * is not a control you may Tab onto. See `sealFaceplate`.
   */
  const shellBody = el('div', { class: 'shell__body' }, [cheek('l'), speaker, panel, cheek('r')]);

  const shell = el(
    'div',
    { class: 'shell mat-alu mx-alu', 'data-width': 'standard' },
    [
      // The grain is one seamless stochastic tile, not a periodic gradient, and
      // the wear is placed rather than sprinkled. Both arrive after first paint.
      el('div', { class: 'mx-grain' }),
      el('div', { class: 'mx-wear' }),
      lid.lip,
      lidBay,
      shellBody,
      el('div', { class: 'shell__footer' }, [
        el('span', { class: 'silk silk--maroon' }, ['Stream Synthesized Dual Conversion Receiver']),
        el('span', { class: 'silk silk--maroon' }, ['PSP-6800W']),
      ]),
      el('div', { class: 'feet', 'aria-hidden': 'true' }),
      lid.root,
      el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', id: 'wf-phase-live' }),
    ],
  );

  const phaseLive = shell.querySelector('#wf-phase-live') as HTMLElement;
  const bandLabel = shell.querySelector('.dial-head__band') as HTMLElement;

  /**
   * WHAT MAY BE REACHED WHILE THE REGISTER IS OUT.
   *
   * The lid already applies this discipline in the other direction and has done
   * correctly since it was written: with the sheet home, `inert` on the sheet
   * means a Tab walk finds the three "open the register" controls and nothing
   * else. Drawn out, nothing was doing the same job for the surface UNDERNEATH
   * — and the register is only ~16 tab stops long, so a keyboard walked off the
   * end of it and straight onto the faceplate: BASS, TREBLE, VOLUME, POWER,
   * METER BAND, RF GAIN, all three presets, the tuning knob, AFC and BANDWIDTH,
   * every one of them behind an opaque steel sheet, every one of them still
   * operable with Enter. Pressing one changed the radio with no visible cause.
   *
   * So the seal is symmetric: exactly one of the two surfaces is reachable, and
   * it is the one you can see. `inert` rather than a focus trap, because it is
   * the same mechanism the sheet uses, it takes the subtree out of the
   * accessibility tree and out of pointer reach in the same stroke, and it
   * cannot be walked out of by any route a trap has to enumerate.
   *
   * Timing: called from the lid's own end-of-travel task (`onSettled`), for the
   * reason set out there — `inert` over a subtree this size is a style change
   * on every node in it and may not land inside the 200 ms travel.
   */
  function sealFaceplate(sealed: boolean): void {
    shellBody.toggleAttribute('inert', sealed);
    setAttr(shellBody, 'aria-hidden', String(sealed));
    if (sealed) return;
    /* CLOSING RETURNS THE HAND TO WHERE IT LEFT.
     *
     * Escape (or CUT BAND, or CLOSE LID) used to leave `document.activeElement`
     * on BODY, so every trip through the register cost the user their place in
     * the Tab ring and restarted the count from zero. REGISTER is the button
     * that opens this thing and the one the panel's own lamp points at, so it
     * is where the hand comes back to — whichever of the four ways out was
     * taken, because they all land here.
     *
     * Only if focus is currently nowhere: a close that happened while the user
     * was already somewhere deliberate must not yank them off it.
     */
    const at = document.activeElement;
    if (at && at !== document.body && shell.contains(at) && !lid.root.contains(at)) return;
    registerBtn.button.focus();
  }

  root.classList.add('faceplate-root');
  root.append(shell);

  /* The material layer. Nothing bakes here: this registers the surfaces and
     lets the panel paint first, then assembles them across idle callbacks in
     order of visible area per millisecond. Launch is a hard gate and 300 ms of
     rasterising between the window appearing and the panel being on it would
     be a regression in the only number the user actually experiences. */
  const materials = installMaterials(shell);
  // Wear on the front face concentrates where hands are: a polished annulus and
  // thumb-sweep arcs around every knob, entered from the lower right.
  mountWear(shell, ['left', 'right', 'top', 'bottom'], () => {
    const box = shell.getBoundingClientRect();
    return [...shell.querySelectorAll('.knob')].map((k) => {
      const r = k.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r: r.width / 2 };
    });
  });
  mountDust(drum.root);
  mountDust(meter.root);

  // -------------------------------------------------------------------------
  // Reflow.
  //
  // The chassis fills the window. Edge to edge, at every size and every shape,
  // with no letterbox and no dead desk around it — a fixed aspect with black
  // surround is the app admitting it is a picture of a radio rather than a
  // radio, and this is a native application whose window the user owns.
  //
  // Surplus space is absorbed into the object's own anatomy, never into
  // padding, and the three rules below are all the reflow is:
  //
  //   HEIGHT → THE LID. A receiver of this family genuinely is taller with its
  //   lid raised, so height above what the faceplate needs raises the lid,
  //   continuously, until the register is legible standing up behind the panel.
  //
  //   WIDTH → THE CABINET. Width beyond what the panel needs brings the case's
  //   side cheeks and their fold-out carry handles into view. They are on the
  //   real object. An ultrawide window shows more radio.
  //
  //   SIZE → DENSITY. A physically larger dial carries more graduations, not
  //   bigger ones. `--dial-px` is published to the drum and the meter so their
  //   tick generation is a function of real pixel width; a uniform scale-up
  //   produces a cartoon.
  //
  // Below the minimum the panel stops reflowing and scales as one unit, because
  // a control panel squeezed past legibility is worse than a small one.

  /** Chassis width below which the panel is scaled rather than reflowed. */
  const MIN_W = 900;
  /**
   * Chassis HEIGHT below which the same thing happens.
   *
   * This used to be 470, which is 170 px less than the faceplate's own content
   * height, so every window shorter than 640 chassis px silently clipped the
   * bottom of the control panel. Measured at 1390×300: the main tuning knob cut
   * in half, 35 px of it off the bottom of the window, no scrollbar. Measured
   * at the 860×560 MINIMUM: the three memory jewels and the flywheel clipped by
   * 8 px by `.panel`'s own overflow. A minimum smaller than the thing it is the
   * minimum for is not a minimum.
   *
   * 640 is measured, not guessed: the panel's natural content height tops out
   * at 583.5 px across every width from 900 to 3600, plus 12 px of body
   * padding, 26 px of lip and 18.5 px of footer and feet. The 20 px over that
   * is slack, so a rounding error can never put a control back under the edge.
   */
  const MIN_H = 660;
  /**
   * …and the ceiling it may learn its way up to.
   *
   * 660 is measured against today's panel. A panel that grows — a new zone, a
   * taller readout, a denser dial — would silently start clipping again, so the
   * floor is a starting guess that the faceplate is allowed to raise when it
   * reports that it did not fit. The ceiling stops a runaway from scaling the
   * whole chassis into a postage stamp.
   */
  const MIN_H_CEIL = 900;
  let minH = MIN_H;
  let relaying = false;
  /** Height the faceplate wants before any of it goes to the lid. */
  const PANEL_H = 640;
  /** The closed lip, and the hem of case left showing below an open lid. */
  const LIP_H = 26;
  const LID_HEM = 15;
  /** Width past which the cabinet's cheeks start to come into view. */
  const CHEEK_FROM = 1180;
  /**
   * Share of surplus width the two cheeks take between them, and the most one
   * cheek may ever be as a fraction of the case.
   *
   * The cheeks used to stop growing at 108 px, which is why widening the window
   * past about 1700 px bought nothing but panel: the gap between the WIDE key
   * and the LIGHT button measured 14 px at 880, 135 px at 1280 and 300 px at
   * 1918 — +638 px of window buying +286 px of empty panel. Density is the
   * reference device's defining quality and `space-between` spreading is its
   * opposite, so surplus width now goes to the cabinet and to printed matter
   * (`.sw-plan`, which gains graduations rather than gaining space), never to
   * the gaps between control groups.
   */
  const CHEEK_RATE = 0.42;
  const CHEEK_MAX_RATIO = 0.115;

  const panelGrid = shell.querySelector('.panel__grid') as HTMLElement;

  /** Publish a bay depth to the chassis and to the lid, in one place. */
  function applyBay(bay: number, h: number): void {
    shell.style.setProperty('--lid-bay', `${Math.round(bay)}px`);
    // The lid is as long as the face it covers when it is shut: hinge under
    // the lip, hem at the bottom of the case.
    lid.setBay(bay, h - LIP_H - LID_HEM);
  }

  function reflow(width: number, height: number): void {
    // --- below the minimum: one uniform scale, never a squeeze -------------
    const scale = Math.min(1, width / MIN_W, height / minH);
    const w = scale < 1 ? width / scale : width;
    const h = scale < 1 ? height / scale : height;
    shell.style.transform = scale < 1 ? `scale(${scale.toFixed(4)})` : '';
    shell.style.transformOrigin = 'top left';
    shell.style.width = `${Math.round(w)}px`;
    shell.style.height = `${Math.round(h)}px`;

    // --- width → the cabinet ----------------------------------------------
    const cheekW = clamp(((w - CHEEK_FROM) * CHEEK_RATE) / 2, 0, w * CHEEK_MAX_RATIO);
    shell.style.setProperty('--cheek-w', `${Math.round(cheekW)}px`);
    const next = w >= 1240 ? 'wide' : w >= 940 ? 'standard' : 'compact';
    if (shell.getAttribute('data-width') !== next) shell.setAttribute('data-width', next);

    // --- height → the lid --------------------------------------------------
    // Only genuine surplus is offered to the lid; the faceplate is never
    // shortened to raise it, because that would be padding wearing a costume.
    let bay = Math.max(0, h - PANEL_H);
    applyBay(bay, h);

    // --- and then the faceplate gets to disagree ---------------------------
    // `PANEL_H` is a constant and the faceplate's height is not: a wider dial
    // is a TALLER dial, because the drum keeps its printed aspect, so the room
    // the panel needs is a function of the width it got. Measured at 1960 px of
    // chassis the panel came up 13 px short and clipped the flywheel — which is
    // exactly the class of defect this reflow is supposed to have stopped.
    //
    // So the constant is a starting guess and the panel is asked. Whatever it
    // is short by comes back off the bay, because the lid is the part of this
    // object with slack in it and the control panel is not. One pass: the grid
    // is max-content rows plus one flexible one, so the shortfall it reports is
    // exact rather than iterative. `root` is fixed to the viewport and does not
    // resize when the shell does, so this cannot drive the observer.
    const short = panelGrid.scrollHeight - panelGrid.clientHeight;
    if (short > 0 && bay > 0) {
      bay = Math.max(0, bay - short);
      applyBay(bay, h);
    } else if (short > 0 && minH < MIN_H_CEIL) {
      // No bay left to give: the window itself is too short for the faceplate,
      // which is what the uniform scale is for. Raise the floor by what the
      // panel says it is missing and lay out once more. It only ever rises, it
      // is capped, and the re-entry is guarded, so this converges on the first
      // window that is short enough to need it and costs nothing after that.
      minH = Math.min(MIN_H_CEIL, minH + short + 2);
      if (!relaying) {
        relaying = true;
        try {
          reflow(width, height);
        } finally {
          relaying = false;
        }
        return;
      }
    }
    pushBandContext();

    // --- size → density ----------------------------------------------------
    // Published, not applied, and not pushed: each instrument owns its own
    // print rule and measures the width it actually got. The drum and the meter
    // each carry a ResizeObserver, which cannot go stale the way a chassis-side
    // estimate of "how much the dial probably has" can — and did. See
    // ui/density.ts for the rule they both answer to.
    const dialPx = Math.max(240, w - cheekW * 2 - 360);
    shell.style.setProperty('--dial-px', `${Math.round(dialPx)}px`);
  }

  const ro = new ResizeObserver((entries) => {
    const cr = entries[0]!.contentRect;
    if (cr.width < 2 || cr.height < 2) return;
    reflow(cr.width, cr.height);
  });
  ro.observe(root);

  /* ---------------------------------------------------------------------
     THE SHORTCUTS.

     Measured on the shipped build: `Ctrl+F`, `Ctrl+K`, `Ctrl+L`, `/` and `F3`
     were all no-ops, so the only route to a station was the Tab ring — eleven
     keypresses to reach a first station and twenty to find a named one, on a
     panel whose whole premise is that you reach for the control directly.

     Three of them, no more, and each is the one thing its key means everywhere
     else on the machine:

       Ctrl+K, and `/`   find a station. Draws the register out and puts the
                         hand straight in the ledger's NAME slot, which is the
                         slot that answers "where is BBC".
       Space             play / standby, the transport key.
       Escape            put the register away (the lid has always owned this).

     They are printed in the register's legend, because a shortcut nobody can
     find is the defect this replaces, not the fix for it.
     --------------------------------------------------------------------- */

  /** Which type slot the next open of the register hands focus to. */
  let pendingSearchField: RegisterSearchField = 'subject';

  /** Somewhere text goes when you type. Typing is never a shortcut. */
  function isTypingInto(node: Element | null): boolean {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /**
   * A control that already answers to the key being pressed.
   *
   * SPACE is the transport key, but it is also how every button, jewel, lever
   * and piano key on this panel is operated from the keyboard — so it is only
   * the transport key when the hand is not on one of them. Testing the *role*
   * rather than keeping a list of elements is what makes that true for controls
   * added later, and `tabindex` catches this panel's several `div`s that carry
   * a role by hand.
   */
  function isControl(node: Element | null): boolean {
    if (!(node instanceof HTMLElement)) return false;
    if (isTypingInto(node)) return true;
    if (node.tagName === 'BUTTON' || (node.tagName === 'A' && node.hasAttribute('href'))) return true;
    return node.hasAttribute('tabindex') || node.hasAttribute('role');
  }

  /** Draw the register out with the hand already in the NAME slot. */
  function openStationSearch(): void {
    pendingSearchField = 'name';
    if (lidOpen) {
      // Already out: no travel to wait for, so the hand moves now.
      pendingSearchField = 'subject';
      lid.focusSearch('name');
      return;
    }
    handlers.onLidToggle(true);
  }

  const onShortcut = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.repeat || ev.altKey) return;
    const target = ev.target instanceof Element ? ev.target : document.activeElement;
    const accel = ev.ctrlKey || ev.metaKey;

    if (accel && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      openStationSearch();
      return;
    }
    if (accel) return;
    // `/` is the same request without a modifier, so it is only a shortcut
    // where a `/` is not a character the user is trying to type.
    if (ev.key === '/' && !isTypingInto(target)) {
      ev.preventDefault();
      openStationSearch();
      return;
    }
    if (ev.key === ' ' && !isControl(target)) {
      ev.preventDefault();
      handlers.onPower(!isPowered(state));
    }
  };
  // Capture, so a shortcut is not eaten by the `stopPropagation` the register's
  // type slots use to keep ordinary typing away from the lid's own keys.
  window.addEventListener('keydown', onShortcut, true);

  // -------------------------------------------------------------------------
  // Render

  let lastPhase: PlaybackState['phase'] | null = null;
  let lastBandKey = '';
  /**
   * The station the drum was last wound to on the host's behalf.
   *
   * Not "the station playing": the drum follows a *change* of station, once.
   * See the note where it is used. `null` also means "wind to whatever is
   * playing at the next opportunity", which is why a re-cut clears it — a new
   * band is a new set of positions, so the last wind said nothing about it.
   */
  let pinnedStationId: string | null = null;

  /**
   * The REGISTER lamp: on while the dial has nothing on it and the cards are
   * shut away behind this button, pulsing while the panel is telling the user
   * so. Both halves are measured — an empty band is an empty band — and both
   * go out the moment either stops being true.
   */
  function paintRegisterLamp(): void {
    const stranded = band.slots.length === 0 && !lidOpen;
    registerBtn.setLamp(stranded, stranded && noticeUp);
  }

  function pushBandContext(): void {
    meterBand.setContext({
      // The register is on screen when the lid is OPEN and at no other time.
      // A raised lid is printing — map, meter-band chart, timezone strip — and
      // is inert, so anything that points at "the register" while the lid is
      // merely standing in its bay is pointing at something that is not there.
      registerVisible: lidOpen,
      // Measured. This used to be `isPowered(state) && !!state.station`, which
      // is "a station has been asked for" — see `airStateOf`.
      air: state.station ? airStateOf(state) : 'off',
    });
  }

  function render(nextState: PlaybackState, nextBand: Band, nextSettings: Settings): void {
    applying = true;
    try {
      state = nextState;
      band = nextBand;
      settings = nextSettings;

      const powered = isPowered(state);

      // --- band / dial layout ---
      const bandKey = `${band.genre}|${band.slots.length}|${band.scaleMin}|${band.scaleMax}|${band.slots
        .map((s) => s.station.id)
        .join(',')}`;
      if (bandKey !== lastBandKey) {
        lastBandKey = bandKey;
        // New positions: whatever the drum was wound to was wound on the old
        // cut, so it is not an answer about this one.
        pinnedStationId = null;
        paintBandPlan();
        drum.setBand(band);
        tuning.setSlots(band.slots);
        // The flywheel's lock and its spoken position are both functions of what
        // is printed on the drum, so they are revised with the drum and nowhere
        // else.
        tuningKnob.setBand(band);
        setText(
          bandLabel,
          band.slots.length
            ? `${(band.scaleLabel ?? '').replace(/\s/g, '').toUpperCase()} · ${band.stationCount} STN · ${Math.round(band.scaleMin + tuning.position * (band.scaleMax - band.scaleMin))} kHz`
            : '—',
        );
      }

      // --- power ---
      setFlag(power, 'is-on', powered);
      /* `setAttr`, not `setAttribute`, everywhere in this function.
         `render()` is called at frame rate — the host reads the analyser every
         frame so the needle can track real RMS — and an attribute write with an
         unchanged value is not free in Blink: it queues a mutation record and
         runs the style-invalidation check for that element. Measured on the
         shipped build with a station playing, this function was performing
         about 800 such writes a second, including `data-lamp` on <html>, whose
         invalidation walks the whole document. Every one of them wrote the value
         that was already there. */
      setAttr(power, 'data-lit', powered ? 'true' : 'false');
      if (powerLit !== powered) {
        powerLit = powered;
        paintPowerDome(powerDome, powered, POWER_DOME_D);
      }
      setAttr(power, 'aria-pressed', String(powered));
      setAttr(power, 'aria-label', powered ? 'Radio power: on' : 'Radio power: standby');
      setFlag(shell, 'is-powered', powered);

      // --- settings-driven controls (host is the source of truth) ---
      volume.setValue(settings.volume);
      bass.setValue(settings.bassDb);
      treble.setValue(settings.trebleDb);
      rfGain.setValue(settings.noiseFloor);
      afc.set(settings.afcEnabled);
      bufferSel.set(settings.bufferDepth);
      lightBtn.setLamp(settings.dialLampOn);
      drum.setLamp(settings.dialLampOn);
      setAttr(document.documentElement, 'data-lamp', settings.dialLampOn ? 'on' : 'off');

      // --- engine-driven displays ---
      drum.setPowered(powered);
      meter.setPowered(powered);
      meter.setLevel(state.signalLevel);
      drum.setActiveStation(powered ? state.station?.id : undefined);
      readout.update(state);
      presetBank.update(presets, state.station?.id, powered);

      // The fault lamp is red because the engine said 'error' or 'stalled'.
      const faulted = state.phase === 'error' || state.phase === 'stalled';
      reconnectBtn.setLamp(faulted || state.phase === 'reconnecting', state.phase === 'reconnecting');

      /* --- the drum winds to the host's station, ONCE, WHEN IT CHANGES ---
       *
       * A preset recall, a register click or a logbook tab has to visibly wind
       * the drum round to the new channel, and that is all this is for.
       *
       * It used to run on the *value*: any render in which the dial was more
       * than 1e-4 from the playing station's slot centre put it back. `render`
       * is called at frame rate, so that is not a re-sync, it is a servo — it
       * held the dial on the station against the user's own hand. Tune one
       * detent off a playing station and the next frame pulled it back;
       * combined with the flywheel's own detent spring (see tuningKnob.ts)
       * that was the second of the two locks that made arrow tuning jam.
       *
       * So it runs on the *identity* instead: the drum winds when the station
       * the host is playing is a different station from the one the drum was
       * last wound to, and never otherwise. Tuning away from a station leaves
       * the identity alone, so nothing follows the hand back. The capture
       * radius, not 1e-4, is the "already there" test, because it is the one
       * the host's own commit uses to decide the dial is on a station at all —
       * winding a dial that is already inside the lock zone would move it off
       * the exact spot the user tuned it to.
       */
      const airStationId = state.station?.id ?? null;
      if (airStationId !== pinnedStationId && !tuning.isLive) {
        pinnedStationId = airStationId;
        const slot = airStationId
          ? band.slots.find((s) => s.station.id === airStationId)
          : undefined;
        if (slot && Math.abs(slot.position - tuning.position) > slot.width * 1.35) {
          tuning.setPosition(slot.position);
        }
      }

      // --- what the register's ledger says about the row that was clicked ---
      //
      // ON AIR MEANS THE DECODER IS PRODUCING AUDIO. Nothing else.
      //
      // This line used to read `powered ? state.station?.id : undefined`, where
      // `powered` is `phase !== 'idle'` — so `resolving`, `connecting`,
      // `buffering`, `reconnecting` and **`error`** all marked the row. Measured
      // on the running product: a station clicked in the register failed with
      // `phase: "error"` and its ledger row still carried the orange on-air
      // marker and `aria-selected="true"` thirty-six seconds later. Law 2 names
      // this exact defect — the marker was asserted from intent, not measured.
      //
      // Then it read `airStateOf(state) === 'on' ? id : undefined`, which is
      // true but says only half of it: three of the four honest states collapse
      // into "not marked", so a row the engine is resolving and a row that just
      // failed both looked exactly like a row nobody had touched. The whole
      // tri-state now goes over, and the ledger prints all of it.
      lid.setAir(state.station?.id, airStateOf(state));
      // The words for a failure, on the surface the failing click was made on.
      // The open lid covers the faceplate completely, so the annunciator that
      // Law 4 relies on is behind it and the register has to answer for itself.
      lid.setPlayback(state);
      // The band plate's hint and the REGISTER lamp are statements about the
      // panel, so they are revised whenever the panel is.
      pushBandContext();
      paintRegisterLamp();

      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        setText(
          phaseLive,
          `${PHASE_LABEL[state.phase]}${state.station ? `. ${state.station.name}` : ''}${
            state.error ? `. ${state.error.message}` : ''
          }`,
        );
      }
    } finally {
      applying = false;
    }
  }

  /**
   * THE NEEDLE'S FAST PATH.
   *
   * `signalLevel` is the only thing on this panel that moves at frame rate, and
   * it drives exactly two things: the movement, and the readout's silence guard
   * (the timer that stops the badge printing LOCKED over a needle sitting on
   * its zero stop). Everything else `render()` revises is a function of the
   * engine's phase, the band, the settings or a hand — none of which can change
   * without the host marking itself dirty and taking a full render.
   *
   * So the frame loop calls this instead. It is not a cheaper render; it is a
   * smaller instrument for a smaller measurement, and it is forbidden to paint
   * anything that is not a pure function of `level`. The closure's `state` is
   * deliberately NOT updated here: it is what the engine last reported, and the
   * level is a reading taken since. Anything that wants both gets both — the
   * host hands the fresh level into `render()` too.
   */
  function renderLevel(level: number): void {
    // No `applying` guard: that flag exists to stop `render()` re-entering
    // `onTune` through the tuning model, and neither of these two can move the
    // flywheel. Two calls, both already no-ops when the value has not changed.
    meter.setLevel(level);
    readout.setLevel(level);
  }

  // -------------------------------------------------------------------------

  return {
    render,
    renderLevel,

    setIndex(index: RegisterIndex | null, fault: string | null) {
      lid.setIndex(index, fault);
    },

    setScope(scope) {
      lid.setScope(scope);
    },

    setCut(next, bandIndex, struck) {
      cut = next;
      cutBandIndex = bandIndex;
      meterBand.setCut(
        cut && cut.bands.length
          ? {
              caption: cut.caption,
              quality: cut.quality,
              total: cut.total,
              filled: cut.bands.length,
              index: cutBandIndex,
            }
          : null,
      );
      if (struck) meterBand.strike();
    },

    setPresets(next) {
      presets = next;
      presetBank.update(presets, state.station?.id, isPowered(state));
    },

    setNotice(notice: PanelNotice | null) {
      // Straight through, synchronously. The whole defect this replaces was a
      // message that took a scenic route and never arrived, so this one has no
      // route: the press writes the panel before the call returns.
      readout.setNotice(notice);
      noticeUp = !!notice;
      paintRegisterLamp();
    },

    setLog(entries: LogEntry[]) {
      logbook.set(entries);
    },

    setBrowseResults(next: BrowseResults) {
      lid.setRows(next.stations, {
        loading: next.loading,
        key: next.key,
        fault: next.error,
        warning: next.warning,
      });
    },

    setLidOpen(open) {
      lidOpen = open;
      // Which slot the hand lands in is a property of the gesture that opened
      // the register, and the gesture is three calls upstream of here — so the
      // shortcut leaves it here and the next open consumes it.
      lid.setOpen(open, pendingSearchField);
      pendingSearchField = 'subject';
      setFlag(shell, 'is-lid-open', open);
      pushBandContext();
      paintRegisterLamp();
    },

    isLidOpen: () => lidOpen,

    destroy() {
      window.removeEventListener('keydown', onShortcut, true);
      ro.disconnect();
      materials.destroy();
      tuning.destroy();
      drum.destroy();
      meter.destroy();
      meterBand.destroy();
      tuningKnob.destroy();
      volume.destroy();
      bass.destroy();
      treble.destroy();
      rfGain.destroy();
      presetBank.destroy();
      readout.destroy();
      lid.destroy();
      shell.remove();
    },
  };
}

/** Convenience for hosts that keep a station list rather than a Band. */
export function stationsToBand(
  genre: string,
  stations: StationRef[],
  scale: { min: number; max: number; unit: 'MHz' | 'kHz' },
): Band {
  const sorted = [...stations].sort((a, b) => b.popularity - a.popularity);
  const n = Math.max(1, sorted.length);
  return {
    genre,
    stationCount: stations.length,
    scaleMin: scale.min,
    scaleMax: scale.max,
    scaleUnit: scale.unit,
    slots: sorted.map((station, i) => ({
      station,
      position: clamp((i + 0.5) / n, 0.01, 0.99),
      width: clamp(0.004 + station.popularity * 0.012, 0.004, 0.02),
    })),
  };
}
