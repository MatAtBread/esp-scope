/// <reference lib="dom" />

/*
 * espScope - browser side of the oscilloscope.
 *
 * The ESP32 streams raw 12-bit ADC codes over a WebSocket (/signal). In 2-channel
 * mode the ADC alternates between CH1 and CH2 and each sample carries its channel
 * in bits 12-15. Everything else happens here: conversion to volts (using the
 * calibration table from /info), triggering, volts/div & time/div scaling,
 * measurements, phase between channels, autoset and FFT.
 *
 * Open index.html with "?demo" (or straight from disk) to use a simulated signal.
 */

/*
 * ==========================================
 * 1. Constants & Configuration
 * ==========================================
 */

const H_DIVS = 10;
const V_DIVS = 8;

// 1-2-5 sequences
const VDIV_STEPS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
const TDIV_STEPS = [10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3,
  0.1, 0.2, 0.5, 1, 2, 5, 10];

// Uncalibrated full-scale voltages per attenuation (only used if /info has no calibration)
const ATTEN_TO_MAX_V = [0.95, 1.25, 1.75, 3.1];

// Hardware limits (ESP32-S3; refreshed from /info). These are total ADC conversions/s,
// shared between the channels in 2-channel mode.
let RATE_MIN = 1000;   // below this the browser decimates instead
let RATE_MAX = 83333;

// Slowest ADC rate used in auto mode (below it the browser peak-detects)
const PEAK_MIN_RATE = 20000;

// Sample history kept in the browser per channel (power of two)
const RING_SIZE = 1 << 20;
const RING_MASK = RING_SIZE - 1;

// Time/div from which the display scrolls instead of triggering
const ROLL_TDIV = 0.2;

const CH_COLORS = ['#f5d90a', '#22d3ee'];
const REF_COLOR = '#e879f9';

const DEMO = location.protocol === 'file:' || new URLSearchParams(location.search).has('demo');
const STORAGE_KEY = 'espscope_cfg_v3';

/**
 * @typedef {Object} ChannelSettings
 * @property {number} vdiv - Volts per division (at the probe tip)
 * @property {number} vcenter - Voltage shown at the vertical centre of the screen
 * @property {'dc'|'ac'} coupling
 * @property {number} probe - Probe / divider factor
 */

/**
 * @typedef {Object} Settings
 * @property {ChannelSettings[]} ch - per channel vertical settings
 * @property {1|2} channels - number of active channels
 * @property {0|1} sel - channel the vertical controls apply to
 * @property {number} atten - ADC attenuation index 0..3 (both channels)
 * @property {number} tdiv - Seconds per division
 * @property {number} hpos - Trigger position as a fraction of the screen width (0..1)
 * @property {'auto'|'manual'} rateMode
 * @property {number} rateManual - per channel
 * @property {'auto'|'normal'|'none'} trigMode
 * @property {'rise'|'fall'} trigEdge
 * @property {0|1} trigSrc - trigger source channel
 * @property {number} trigLevel - Volts at the probe tip of the source channel
 * @property {boolean} fft
 * @property {number} avg
 * @property {boolean} dots
 * @property {number} testHz
 * @property {number} timeCal - Correction factor for the real sample rate
 */

/** @type {Settings} */
const DEFAULTS = {
  ch: [
    { vdiv: 0.5, vcenter: 1.65, coupling: 'dc', probe: 1 },
    { vdiv: 0.5, vcenter: 1.65, coupling: 'dc', probe: 1 }
  ],
  channels: 1,
  sel: 0,
  atten: 3,
  tdiv: 1e-3,
  hpos: 0.5,
  rateMode: 'auto',
  rateManual: 20000,
  trigMode: 'auto',
  trigEdge: 'rise',
  trigSrc: 0,
  trigLevel: 1.5,
  fft: false,
  avg: 1,
  dots: false,
  testHz: 1000,
  timeCal: 1
};

/** @type {Settings} */
let cfg = loadSettings();

/*
 * ==========================================
 * 2. Global UI Elements & State
 * ==========================================
 */

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

/** @type {HTMLCanvasElement} */ const canvas = $('scope');
/** @type {CanvasRenderingContext2D} */ const ctx = canvas.getContext('2d');
const readoutEl = $('readout');
const measEl = $('meas');

/**
 * @typedef {Object} Frame
 * @property {Float32Array} v - Volts at the probe tip (record around the trigger)
 * @property {number} dt - Seconds between samples
 * @property {number} t0 - Time of v[0] relative to the trigger point (s)
 * @property {boolean} triggered
 * @property {boolean} clipped
 */

/**
 * Per channel acquisition state
 * @typedef {Object} Channel
 * @property {Uint16Array} ring - raw ADC codes
 * @property {number} head - total number of samples stored (monotonic)
 * @property {number} start - `head` value at which the current rate became valid
 * @property {number} blkMin
 * @property {number} blkMax
 * @property {number} blkMinAt
 * @property {number} blkMaxAt
 * @property {number} blkN
 * @property {Frame|null} frame
 * @property {Float32Array|null} avgBuf
 * @property {number} avgCount
 * @property {any} meas - last measurements of what is on screen
 * @property {number} dcMean - mean of the screen, removed from the trace in AC coupling
 * @property {number} measStart - frame index where the measured window starts
 */

/** @returns {Channel} */
function makeChannel() {
  return {
    ring: new Uint16Array(RING_SIZE), head: 0, start: 0,
    blkMin: 0, blkMax: 0, blkMinAt: 0, blkMaxAt: 0, blkN: 0,
    frame: null, avgBuf: null, avgCount: 0, meas: null, dcMean: 0, measStart: 0
  };
}

/** @type {Channel[]} */
const chans = [makeChannel(), makeChannel()];

let hwRate = 20000;         // total ADC conversions/s the ESP32 is running at
let decim = 1;              // peak-detect block size (for rates below RATE_MIN), 1 = off

let running = true;
let single = false;         // waiting for one trigger, then stop
let singleArmHead = 0;
let lastTrigTime = 0;

/** @type {Float32Array} lookup table raw code -> volts at the ADC pin */
let lut = new Float32Array(4096);
let calibrated = false;

/** @type {{x:number,y:number}|null} */ let hover = null;
/** @type {{t:number,v:number,c:number}|null} */ let refCursor = null;

/** @type {{delay:number, deg:number}|null} */ let lastPhase = null;
let lastMeasTime = 0;
/** @type {{freq:number, mags:Float32Array, df:number, peakDb:number}|null} */ let lastFft = null;

let autosetBusy = false;
/** @type {WebSocket|null} */ let ws = null;
let reconnectTimeout = 0;
let lastDataTime = 0;

/** Channels currently shown */
const active = () => cfg.channels === 2 ? [0, 1] : [0];

/*
 * ==========================================
 * 3. Math & Formatting Utils
 * ==========================================
 */

/** @param {number} v */
function fmtV(v) {
  if (!isFinite(v)) return '---';
  const a = Math.abs(v);
  if (a < 1) return (v * 1000).toFixed(a < 0.01 ? 2 : a < 0.1 ? 1 : 0) + ' mV';
  return v.toFixed(a < 10 ? 3 : 2) + ' V';
}

/** @param {number} t */
function fmtT(t) {
  if (!isFinite(t)) return '---';
  const a = Math.abs(t);
  if (a === 0) return '0 s';
  if (a < 1e-3) return (t * 1e6).toPrecision(3) + ' µs';
  if (a < 1) return (t * 1e3).toPrecision(3) + ' ms';
  return t.toPrecision(3) + ' s';
}

/** @param {number} f */
function fmtF(f) {
  if (!isFinite(f) || f <= 0) return '---';
  if (f >= 1e6) return (f / 1e6).toPrecision(4) + ' MHz';
  if (f >= 1e3) return (f / 1e3).toPrecision(4) + ' kHz';
  return f.toPrecision(4) + ' Hz';
}

/** Volts/div or s/div label */
function fmtDiv(/** @type {number} */ v, /** @type {string} */ unit) {
  if (unit === 'V') return v < 1 ? (v * 1000).toFixed(0) + ' mV' : v + ' V';
  if (v < 1e-3) return (v * 1e6).toFixed(0) + ' µs';
  if (v < 1) return (v * 1e3).toFixed(0) + ' ms';
  return v + ' s';
}

/**
 * Smallest step >= value
 * @param {number[]} steps
 * @param {number} value
 */
function stepAtLeast(steps, value) {
  for (const s of steps) if (s >= value * 0.999) return s;
  return steps[steps.length - 1];
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Effective per-channel sample rate of the stored data (decimation and time calibration included) */
function effRate() {
  const perCh = hwRate / cfg.channels;
  // Each peak-detect block yields two points (its min and max)
  return (decim > 1 ? perCh / decim * 2 : perCh) * cfg.timeCal;
}

/** Time between a CH1 sample and the CH2 sample taken right after it */
function chSkew() {
  return decim > 1 ? 0 : 1 / (hwRate * cfg.timeCal);
}

/** Per-channel sample rate wanted for the current time base */
function desiredRate() {
  const max = RATE_MAX / cfg.channels;
  if (cfg.rateMode === 'manual') return clamp(cfg.rateManual, 1, max);
  const window = cfg.tdiv * H_DIVS;
  // Aim for ~2500 points per screen
  return clamp(Math.round(2500 / window), 1, max);
}

/** Samples available in both channels since the last rate change */
function available() {
  let a = RING_SIZE - 1;
  for (const c of active()) a = Math.min(a, chans[c].head - chans[c].start);
  return a;
}

/*
 * ==========================================
 * 4. Data Processing
 * ==========================================
 */

/**
 * Build raw->volts table from the calibration in /info (mv at raw 0,128,...,4096)
 * @param {number[]|undefined} mv
 */
function buildLut(mv) {
  calibrated = Array.isArray(mv) && mv.length >= 2;
  const fs = ATTEN_TO_MAX_V[cfg.atten] ?? 3.1;
  for (let raw = 0; raw < 4096; raw++) {
    if (calibrated) {
      const step = 4096 / (mv.length - 1);
      const i = Math.min(mv.length - 2, Math.floor(raw / step));
      const f = (raw - i * step) / step;
      lut[raw] = (mv[i] + (mv[i + 1] - mv[i]) * f) / 1000;
    } else {
      lut[raw] = raw / 4095 * fs;
    }
  }
}

/**
 * Store one raw sample for a channel (peak detect when decimating)
 * @param {Channel} ch
 * @param {number} x - 12 bit code
 */
function pushSample(ch, x) {
  if (decim <= 1) {
    ch.ring[ch.head & RING_MASK] = x;
    ch.head++;
    return;
  }
  // Low rate peak detect: keep min and max of each block (in time order) so
  // fast spikes and high frequencies are not lost or aliased
  if (ch.blkN === 0 || x < ch.blkMin) { ch.blkMin = x; ch.blkMinAt = ch.blkN; }
  if (ch.blkN === 0 || x > ch.blkMax) { ch.blkMax = x; ch.blkMaxAt = ch.blkN; }
  if (++ch.blkN >= decim) {
    const minFirst = ch.blkMinAt <= ch.blkMaxAt;
    ch.ring[ch.head & RING_MASK] = minFirst ? ch.blkMin : ch.blkMax;
    ch.ring[(ch.head + 1) & RING_MASK] = minFirst ? ch.blkMax : ch.blkMin;
    ch.head += 2;
    ch.blkN = 0;
  }
}

/**
 * Process incoming WebSocket data
 * @param {Uint16Array} data - Raw ADC samples, channel in bits 12-15
 */
function processData(data) {
  lastDataTime = performance.now();
  if (cfg.channels !== 2) {
    for (let i = 0; i < data.length; i++) pushSample(chans[0], data[i] & 0xfff);
    return;
  }
  // The ADC converts CH1, CH2, CH1, CH2... Keep sample k of both channels paired:
  // if one went missing (dropped DMA frame), repeat that channel's last value
  for (let i = 0; i < data.length; i++) {
    const s = data[i];
    const c = (s >> 12) & 1;
    const x = s & 0xfff;
    if (c !== expectCh) pushSample(chans[expectCh], lastRaw[expectCh]);
    pushSample(chans[c], x);
    lastRaw[c] = x;
    expectCh = c ^ 1;
  }
}

let expectCh = 0;           // channel of the next sample in 2-channel mode
const lastRaw = [0, 0];

/** Raw sample of a channel at absolute index converted to probe-tip volts */
function sampleV(/** @type {number} */ c, /** @type {number} */ i) {
  return lut[chans[c].ring[i & RING_MASK]] * cfg.ch[c].probe;
}

/**
 * Find the most recent trigger point on the source channel between [from, to).
 * @returns {number} fractional absolute sample index of the crossing, or -1
 */
function findTrigger(/** @type {number} */ from, /** @type {number} */ to) {
  const c = cfg.trigSrc;
  const level = cfg.trigLevel;
  // Hysteresis: ~1.5% of the screen height, at least ~3 ADC LSB
  const hyst = Math.max(cfg.ch[c].vdiv * V_DIVS * 0.015, 0.003 * cfg.ch[c].probe);
  const rise = cfg.trigEdge === 'rise';
  let armed = false;
  let found = -1;
  let prev = sampleV(c, from);
  for (let i = from + 1; i < to; i++) {
    const v = sampleV(c, i);
    if (rise) {
      if (v < level - hyst) armed = true;
      else if (armed && v >= level && prev < level) {
        found = i - 1 + (level - prev) / (v - prev);
        armed = false;
      }
    } else {
      if (v > level + hyst) armed = true;
      else if (armed && v <= level && prev > level) {
        found = i - 1 + (prev - level) / (prev - v);
        armed = false;
      }
    }
    prev = v;
  }
  return found;
}

/**
 * Copy the same record of samples from every active channel into new Frames
 * @param {number} start - absolute index of first sample
 * @param {number} count
 * @param {number} trigIdx - fractional absolute index used as t = 0
 * @param {boolean} triggered
 */
function makeFrames(start, count, trigIdx, triggered) {
  const dt = 1 / effRate();
  for (const c of active()) {
    const ch = chans[c];
    const v = new Float32Array(count);
    let clipped = false;
    const probe = cfg.ch[c].probe;
    for (let i = 0; i < count; i++) {
      const raw = ch.ring[(start + i) & RING_MASK];
      if (raw >= 4090 || raw <= 2) clipped = true;
      v[i] = lut[raw] * probe;
    }
    // CH2 is converted one ADC slot after CH1: shift it so both share one time axis
    const t0 = (start - trigIdx) * dt + (c - (triggered ? cfg.trigSrc : 0)) * chSkew();
    setFrame(ch, { v, dt, t0, triggered, clipped });
  }
}

/**
 * Called every animation frame while running: decide what goes on screen.
 */
function acquire() {
  const rate = effRate();
  const win = cfg.tdiv * H_DIVS;
  const n = Math.max(2, Math.ceil(win * rate));
  const avail = available();
  if (avail < 2) return;
  const head = Math.min(...active().map(c => chans[c].head));

  const pre = Math.ceil(n * cfg.hpos);
  const post = n - pre;
  // Record a bit more than the screen so a stopped capture can be zoomed/panned
  const extra = Math.min(n, 20000);

  const roll = cfg.tdiv >= ROLL_TDIV;
  if (roll || cfg.trigMode === 'none') {
    const count = Math.min(avail, n + (roll ? 0 : extra));
    // Right edge of the screen = newest sample
    makeFrames(head - count, count, head - post, false);
    setTrigStatus(roll ? 'ROLL' : 'FREE', 'warn');
    return;
  }

  // Search area: enough history to hold a full screen before/after the trigger
  const searchFrom = Math.max(head - avail + pre, head - Math.max(4 * n, Math.round(rate * 0.3)) - post);
  const searchTo = head - post;
  let trig = -1;
  if (searchTo - searchFrom > 2) {
    const from = single ? Math.max(searchFrom, singleArmHead) : searchFrom;
    if (searchTo - from > 2) trig = findTrigger(from, searchTo);
  }

  const now = performance.now();
  if (trig >= 0) {
    lastTrigTime = now;
    const start = Math.max(head - avail, Math.floor(trig) - pre - extra);
    const end = Math.min(head, Math.ceil(trig) + post + extra);
    makeFrames(start, end - start, trig, true);
    setTrigStatus(`TRIGGERED CH${cfg.trigSrc + 1}`, 'ok');
    if (single) {
      single = false;
      setRunning(false);
      setTrigStatus('SINGLE: captured', 'ok');
    }
    return;
  }

  if (single) {
    setTrigStatus('SINGLE: waiting…', 'warn');
    return;
  }

  // No trigger
  const autoTimeout = Math.max(150, win * 2000);
  if (cfg.trigMode === 'auto' && now - lastTrigTime > autoTimeout) {
    const count = Math.min(avail, n);
    makeFrames(head - count, count, head - post, false);
    setTrigStatus('AUTO (untriggered)', 'warn');
  } else if (cfg.trigMode === 'normal') {
    setTrigStatus('WAITING FOR TRIGGER', 'bad');
  }
}

/**
 * Store the new frame of a channel, applying averaging when enabled
 * @param {Channel} ch
 * @param {Frame} f
 */
function setFrame(ch, f) {
  if (cfg.avg > 1 && f.triggered && ch.frame && ch.avgBuf && ch.avgBuf.length === f.v.length &&
    Math.abs(ch.frame.t0 - f.t0) < f.dt) {
    ch.avgCount = Math.min(ch.avgCount + 1, cfg.avg);
    const k = 1 / ch.avgCount;
    for (let i = 0; i < f.v.length; i++) ch.avgBuf[i] += (f.v[i] - ch.avgBuf[i]) * k;
    f.v = ch.avgBuf.slice();
  } else {
    ch.avgBuf = f.v.slice();
    ch.avgCount = 1;
  }
  ch.frame = f;
}

function resetAverages() {
  for (const ch of chans) ch.avgBuf = null;
}

/*
 * ==========================================
 * 5. Measurements & FFT
 * ==========================================
 */

/**
 * Compute standard oscilloscope measurements on samples
 * @param {Float32Array} v
 * @param {number} dt
 * @param {number} probe - probe factor of the channel (for the noise floor)
 */
function measure(v, dt, probe) {
  const n = v.length;
  /** @type {any} */
  const m = { n, rises: [], falls: [] };
  if (n < 4) return m;

  let min = Infinity, max = -Infinity, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
    sum2 += x * x;
  }
  const mean = sum / n;
  m.max = max; m.min = min; m.pp = max - min; m.mean = mean;
  m.rms = Math.sqrt(sum2 / n);
  m.acrms = Math.sqrt(Math.max(0, sum2 / n - mean * mean));

  // Top / base from histogram (mode of upper and lower halves)
  const bins = 128;
  const hist = new Uint32Array(bins);
  const span = m.pp || 1e-9;
  for (let i = 0; i < n; i++) hist[Math.min(bins - 1, Math.floor((v[i] - min) / span * bins))]++;
  let topBin = bins / 2, baseBin = 0;
  for (let b = bins / 2; b < bins; b++) if (hist[b] > hist[topBin]) topBin = b;
  for (let b = 0; b < bins / 2; b++) if (hist[b] > hist[baseBin]) baseBin = b;
  // Flat tops only exist if the mode holds a meaningful share of samples (square-ish waves)
  m.top = hist[topBin] > n * 0.05 ? min + (topBin + 0.5) / bins * span : max;
  m.base = hist[baseBin] > n * 0.05 ? min + (baseBin + 0.5) / bins * span : min;
  m.amp = m.top - m.base;
  m.over = m.amp > 0 ? (max - m.top) / m.amp * 100 : NaN;
  m.pre = m.amp > 0 ? (m.base - min) / m.amp * 100 : NaN;

  // Edges: need a signal clearly above the noise floor (~8 LSB)
  const noise = 0.006 * probe;
  if (m.amp < noise) return m;

  const mid = (m.top + m.base) / 2;
  const hyst = m.amp * 0.1;
  const lo10 = m.base + m.amp * 0.1, hi90 = m.base + m.amp * 0.9;
  /** @type {number[]} */ const rises = m.rises;
  /** @type {number[]} */ const falls = m.falls;
  let state = v[0] > mid ? 1 : -1;
  for (let i = 1; i < n; i++) {
    const b = v[i];
    if (state < 0 && b > mid + hyst) {
      // walk back to the actual mid crossing
      let j = i;
      while (j > 0 && v[j - 1] > mid) j--;
      if (j > 0) rises.push(j - 1 + (mid - v[j - 1]) / (v[j] - v[j - 1] || 1e-9));
      state = 1;
    } else if (state > 0 && b < mid - hyst) {
      let j = i;
      while (j > 0 && v[j - 1] < mid) j--;
      if (j > 0) falls.push(j - 1 + (v[j - 1] - mid) / (v[j - 1] - v[j] || 1e-9));
      state = -1;
    }
  }

  if (rises.length >= 2) {
    m.period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1) * dt;
  } else if (falls.length >= 2) {
    m.period = (falls[falls.length - 1] - falls[0]) / (falls.length - 1) * dt;
  }
  // In peak-detect mode (slow time bases) only trust periods spanning many points
  if (m.period && decim > 1 && m.period < 12 * dt) {
    m.period = undefined;
    m.tooFast = true;
  }
  if (m.period) {
    m.freq = 1 / m.period;
    // Positive width: rise -> next fall
    let wsum = 0, wn = 0;
    for (const r of rises) {
      const f = falls.find(x => x > r);
      if (f !== undefined && (f - r) * dt < m.period) { wsum += f - r; wn++; }
    }
    if (wn) {
      m.pwidth = wsum / wn * dt;
      m.nwidth = m.period - m.pwidth;
      m.duty = m.pwidth / m.period * 100;
    }
    // Cycle RMS / mean over whole periods only (more accurate than full screen)
    const p0 = Math.ceil(rises.length >= 2 ? rises[0] : falls[0]);
    const pn = Math.floor(rises.length >= 2 ? rises[rises.length - 1] : falls[falls.length - 1]);
    if (pn - p0 > 4) {
      let s = 0, s2 = 0;
      for (let i = p0; i < pn; i++) { s += v[i]; s2 += v[i] * v[i]; }
      m.cmean = s / (pn - p0);
      m.crms = Math.sqrt(s2 / (pn - p0));
    }
  }

  // Rise / fall time (10% -> 90%)
  const edgeTime = (/** @type {number[]} */ list, /** @type {boolean} */ rising) => {
    let s = 0, c = 0;
    for (const e of list) {
      const k = Math.round(e);
      let a = k, b = k;
      if (rising) {
        while (a > 0 && v[a] > lo10) a--;
        while (b < n - 1 && v[b] < hi90) b++;
        if (a <= 0 || b >= n - 1) continue;
      } else {
        while (a > 0 && v[a] < hi90) a--;
        while (b < n - 1 && v[b] > lo10) b++;
        if (a <= 0 || b >= n - 1) continue;
      }
      s += b - a; c++;
    }
    return c ? s / c * dt : NaN;
  };
  m.rise = edgeTime(rises, true);
  m.fall = edgeTime(falls, false);
  return m;
}

/**
 * Delay and phase from CH1 to CH2, using their rising edges on screen.
 * Positive = CH2 lags CH1 (e.g. +90° for two quadrature signals).
 */
function measurePhase() {
  const [a, b] = chans;
  if (cfg.channels !== 2 || !a.meas || !b.meas || !a.frame || !b.frame) return null;
  const period = a.meas.period || b.meas.period;
  if (!period || a.meas.rises.length < 1 || b.meas.rises.length < 1) return null;
  const toTime = (/** @type {Channel} */ ch, /** @type {number} */ r) => ch.frame.t0 + (ch.measStart + r) * ch.frame.dt;
  const tb = b.meas.rises.map((/** @type {number} */ r) => toTime(b, r));
  let sum = 0, n = 0;
  for (const r of a.meas.rises) {
    const ta = toTime(a, r);
    // Nearest CH2 edge, folded into (-T/2, T/2]
    let best = Infinity;
    for (const t of tb) {
      let d = t - ta;
      d -= Math.round(d / period) * period;
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    if (isFinite(best)) { sum += best; n++; }
  }
  if (!n) return null;
  const delay = sum / n;
  return { delay, deg: delay / period * 360 };
}

/**
 * In-place radix-2 FFT
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Spectrum of the newest samples of a channel (Hann window), in dBV */
function computeFft(/** @type {number} */ c) {
  const ch = chans[c];
  const avail = Math.min(ch.head - ch.start, RING_SIZE - 1);
  const head = ch.head;
  let n = 8192;
  while (n > 256 && n > avail) n >>= 1;
  if (avail < n) return null;
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sampleV(c, head - n + i);
  mean /= n;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    wsum += w;
    re[i] = (sampleV(c, head - n + i) - mean) * w;
  }
  fft(re, im);
  const half = n / 2;
  const mags = new Float32Array(half);
  let peak = 1;
  for (let i = 0; i < half; i++) {
    const a = 2 * Math.hypot(re[i], im[i]) / wsum / Math.SQRT2; // RMS volts
    mags[i] = 20 * Math.log10(a + 1e-9);
    if (i > 1 && mags[i] > mags[peak]) peak = i;
  }
  const df = effRate() / n;
  // Parabolic interpolation around the peak
  let freq = peak * df;
  if (peak > 0 && peak < half - 1) {
    const a = mags[peak - 1], b = mags[peak], c2 = mags[peak + 1];
    const d = (a - c2) / (2 * (a - 2 * b + c2) || 1e-9);
    freq = (peak + d) * df;
  }
  return { freq, mags, df, peakDb: mags[peak] };
}

/*
 * ==========================================
 * 6. Visualization & Rendering
 * ==========================================
 */

let W = 0, H = 0, dpr = 1;
const PAD_R = 22;   // room for the trigger marker
const PAD_L = 22;   // room for the ground markers

/** Plot area for the waveform */
function plotRect() {
  const fftH = cfg.fft ? Math.round(H * 0.38) : 0;
  return { x: PAD_L, y: 4, w: W - PAD_L - PAD_R, h: H - 8 - fftH, fftH };
}

/** Time relative to trigger -> X pixel */
function timeToX(/** @type {number} */ t) {
  const r = plotRect();
  const win = cfg.tdiv * H_DIVS;
  return r.x + (t / win + cfg.hpos) * r.w;
}

function xToTime(/** @type {number} */ x) {
  const r = plotRect();
  return ((x - r.x) / r.w - cfg.hpos) * cfg.tdiv * H_DIVS;
}

/** Display offset applied to a trace (AC coupling removes the mean) */
function traceOffset(/** @type {number} */ c) {
  return cfg.ch[c].coupling === 'ac' ? chans[c].dcMean : 0;
}

function voltsToY(/** @type {number} */ v, /** @type {number} */ c) {
  const r = plotRect();
  const s = cfg.ch[c];
  return r.y + r.h / 2 - (v - s.vcenter) / (s.vdiv * V_DIVS) * r.h;
}

function yToVolts(/** @type {number} */ y, /** @type {number} */ c) {
  const r = plotRect();
  const s = cfg.ch[c];
  return s.vcenter - (y - r.y - r.h / 2) / r.h * s.vdiv * V_DIVS;
}

function drawGrid() {
  const r = plotRect();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= H_DIVS; i++) {
    const x = Math.round(r.x + r.w * i / H_DIVS) + 0.5;
    ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h);
  }
  for (let i = 0; i <= V_DIVS; i++) {
    const y = Math.round(r.y + r.h * i / V_DIVS) + 0.5;
    ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y);
  }
  ctx.stroke();

  // Minor ticks on the centre axes
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  const cx = Math.round(r.x + r.w / 2) + 0.5, cy = Math.round(r.y + r.h / 2) + 0.5;
  for (let i = 0; i <= H_DIVS * 5; i++) {
    const x = Math.round(r.x + r.w * i / (H_DIVS * 5)) + 0.5;
    ctx.moveTo(x, cy - 3); ctx.lineTo(x, cy + 3);
  }
  for (let i = 0; i <= V_DIVS * 5; i++) {
    const y = Math.round(r.y + r.h * i / (V_DIVS * 5)) + 0.5;
    ctx.moveTo(cx - 3, y); ctx.lineTo(cx + 3, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawTrace(/** @type {number} */ c) {
  const frame = chans[c].frame;
  if (!frame) return;
  const r = plotRect();
  const { v, dt, t0 } = frame;
  const off = traceOffset(c);
  const n = v.length;
  const win = cfg.tdiv * H_DIVS;
  const pxPerSample = dt / win * r.w;

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = CH_COLORS[c];
  ctx.fillStyle = CH_COLORS[c];
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';

  // Index range that is visible
  const tLeft = xToTime(r.x), tRight = xToTime(r.x + r.w);
  const i0 = clamp(Math.floor((tLeft - t0) / dt) - 1, 0, n - 1);
  const i1 = clamp(Math.ceil((tRight - t0) / dt) + 1, 0, n - 1);

  if (pxPerSample < 0.7) {
    // Many samples per pixel: draw min/max envelope per column
    const cols = Math.ceil(r.w);
    ctx.beginPath();
    let first = true;
    for (let col = 0; col < cols; col++) {
      const ta = xToTime(r.x + col), tb = xToTime(r.x + col + 1);
      const a = clamp(Math.floor((ta - t0) / dt), i0, i1);
      const b = clamp(Math.ceil((tb - t0) / dt), i0, i1);
      if (b <= a) continue;
      let lo = Infinity, hi = -Infinity;
      for (let i = a; i < b; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
      const yLo = voltsToY(lo - off, c), yHi = voltsToY(hi - off, c);
      const x = r.x + col + 0.5;
      if (first) { ctx.moveTo(x, yLo); first = false; }
      else ctx.lineTo(x, yLo);
      ctx.lineTo(x, yHi - 0.5);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = timeToX(t0 + i * dt);
      const y = voltsToY(v[i] - off, c);
      if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (cfg.dots || pxPerSample > 12) {
      for (let i = i0; i <= i1; i++) {
        ctx.beginPath();
        ctx.arc(timeToX(t0 + i * dt), voltsToY(v[i] - off, c), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawMarkers() {
  const r = plotRect();
  ctx.save();
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';

  // Ground (0 V) markers on the left
  for (const c of active()) {
    const gy = clamp(voltsToY(0 - traceOffset(c), c), r.y + 6, r.y + r.h - 6);
    ctx.fillStyle = CH_COLORS[c];
    ctx.globalAlpha = c === cfg.sel || cfg.channels === 1 ? 1 : 0.7;
    ctx.beginPath();
    ctx.moveTo(2, gy - 7); ctx.lineTo(14, gy - 7); ctx.lineTo(20, gy); ctx.lineTo(14, gy + 7); ctx.lineTo(2, gy + 7);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillText(String(c + 1), 6, gy + 4);
  }

  // Trigger level marker on the right (in the source channel's scale)
  const src = cfg.trigSrc;
  if (cfg.trigMode !== 'none' && cfg.tdiv < ROLL_TDIV) {
    const ty = voltsToY(cfg.trigLevel - traceOffset(src), src);
    const cy = clamp(ty, r.y + 6, r.y + r.h - 6);
    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    const x0 = W - 2;
    ctx.moveTo(x0, cy - 7); ctx.lineTo(x0 - 12, cy - 7); ctx.lineTo(x0 - 18, cy); ctx.lineTo(x0 - 12, cy + 7); ctx.lineTo(x0, cy + 7);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillText(cfg.channels === 2 ? String(src + 1) : 'T', x0 - 11, cy + 4);
    if (hoverTrig || dragMode === 'trig') {
      ctx.strokeStyle = 'rgba(255,138,61,.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(r.x, ty); ctx.lineTo(r.x + r.w, ty); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trigger time marker at the top
    const tx = timeToX(0);
    if (tx >= r.x && tx <= r.x + r.w) {
      ctx.fillStyle = '#ff8a3d';
      ctx.beginPath();
      ctx.moveTo(tx - 6, r.y); ctx.lineTo(tx + 6, r.y); ctx.lineTo(tx, r.y + 8);
      ctx.closePath(); ctx.fill();
    }
  }

  // Scale labels
  const labels = [];
  for (const c of active()) {
    const s = cfg.ch[c];
    labels.push({ t: `CH${c + 1} ${fmtDiv(s.vdiv, 'V')}/div ${s.coupling.toUpperCase()}${s.probe !== 1 ? ' x' + s.probe : ''}`, c: CH_COLORS[c] });
  }
  labels.push({ t: `${fmtDiv(cfg.tdiv, 's')}/div`, c: '#e4e6e8' });
  for (const c of active()) {
    if (chans[c].frame && chans[c].frame.clipped) labels.push({ t: `⚠ CH${c + 1} out of ADC range`, c: '#ef4444' });
  }
  if (!calibrated && !DEMO) labels.push({ t: 'ADC not calibrated', c: '#9aa1a9' });
  let lx = r.x + 6;
  for (const l of labels) {
    const w = ctx.measureText(l.t).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(lx, r.y + r.h - 20, w, 17);
    ctx.fillStyle = l.c;
    ctx.fillText(l.t, lx + 5, r.y + r.h - 8);
    lx += w + 6;
  }
  ctx.restore();
}

function drawCursors() {
  const r = plotRect();
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1;
  if (refCursor) {
    ctx.strokeStyle = REF_COLOR;
    const x = timeToX(refCursor.t), y = voltsToY(refCursor.v, refCursor.c);
    ctx.beginPath();
    ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h);
    ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
  }
  if (hover && !dragMode) {
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.beginPath();
    ctx.moveTo(hover.x, r.y); ctx.lineTo(hover.x, r.y + r.h);
    ctx.moveTo(r.x, hover.y); ctx.lineTo(r.x + r.w, hover.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFft() {
  if (!cfg.fft) return;
  const r = plotRect();
  const y0 = r.y + r.h + 4, h = r.fftH - 4;
  const color = CH_COLORS[cfg.sel];
  ctx.save();
  ctx.fillStyle = '#05080a';
  ctx.fillRect(r.x, y0, r.w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.strokeRect(r.x + 0.5, y0 + 0.5, r.w - 1, h - 1);
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  if (!lastFft) { ctx.restore(); return; }

  const { df } = lastFft;
  // Show up to ~10 harmonics of the main peak (1-2-5 span), or the whole band
  const fmax = Math.min(lastFft.mags.length * df,
    stepAtLeast([100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4], Math.max(lastFft.freq * 10, 20 * df)));
  const mags = lastFft.mags.subarray(0, Math.max(8, Math.round(fmax / df)));
  const top = Math.ceil((lastFft.peakDb + 5) / 10) * 10;
  const span = 80;
  // Grid every 20 dB
  ctx.fillStyle = '#9aa1a9';
  for (let db = top; db >= top - span; db -= 20) {
    const y = y0 + (top - db) / span * h;
    ctx.fillRect(r.x, y, r.w, 1);
    ctx.fillText(db + ' dBV', r.x + 4, y + 11);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const cols = Math.ceil(r.w);
  for (let col = 0; col < cols; col++) {
    const a = Math.floor(col / cols * mags.length), b = Math.max(a + 1, Math.floor((col + 1) / cols * mags.length));
    let mx = -200;
    for (let i = a; i < b && i < mags.length; i++) if (mags[i] > mx) mx = mags[i];
    const y = y0 + clamp((top - mx) / span, 0, 1) * h;
    if (col === 0) ctx.moveTo(r.x + col, y); else ctx.lineTo(r.x + col, y);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  const label = `FFT CH${cfg.sel + 1} 0–${fmtF(fmax)}  ·  peak ${fmtF(lastFft.freq)} (${lastFft.peakDb.toFixed(1)} dBV)  ·  res ${fmtF(df)}`;
  ctx.fillText(label, r.x + 70, y0 + 13);
  ctx.restore();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawGrid();
  // Selected channel on top
  for (const c of active().sort((a, b) => (a === cfg.sel ? 1 : 0) - (b === cfg.sel ? 1 : 0))) drawTrace(c);
  drawCursors();
  drawMarkers();
  drawFft();
}

/*
 * ==========================================
 * 7. Main loop
 * ==========================================
 */

function updateMeasurements() {
  const r = plotRect();
  for (const c of active()) {
    const ch = chans[c];
    const frame = ch.frame;
    if (!frame) continue;
    // Measure only what's on screen (like a real scope)
    const tLeft = xToTime(r.x), tRight = xToTime(r.x + r.w);
    const a = clamp(Math.floor((tLeft - frame.t0) / frame.dt), 0, frame.v.length);
    const b = clamp(Math.ceil((tRight - frame.t0) / frame.dt), 0, frame.v.length);
    let data = frame.v.subarray(a, b);
    let mean = 0;
    for (let i = 0; i < data.length; i++) mean += data[i];
    ch.dcMean = data.length ? mean / data.length : 0;
    if (cfg.ch[c].coupling === 'ac') data = data.map(x => x - ch.dcMean);
    ch.meas = measure(data, frame.dt, cfg.ch[c].probe);
    ch.measStart = a;
  }
  lastPhase = measurePhase();
}

function animationLoop() {
  if (running && !autosetBusy) acquire();

  const now = performance.now();
  if (chans[0].frame && now - lastMeasTime > 200) {
    lastMeasTime = now;
    updateMeasurements();
    if (cfg.fft && running) lastFft = computeFft(cfg.sel);
    renderMeasurements();
  }
  if (now - lastDataTime > 1500 && !DEMO) {
    setConn(ws && ws.readyState === WebSocket.OPEN ? 'No data…' : 'Disconnected', 'bad');
  }

  draw();
  updateReadout();
  requestAnimationFrame(animationLoop);
}

/*
 * ==========================================
 * 8. UI
 * ==========================================
 */

/** @type {Array<[string, (m: any, c: number) => string]>} */
const MEAS_LIST = [
  ['Frequency', (m) => m.tooFast ? 'slow t/div' : fmtF(m.freq)],
  ['Period', (m) => fmtT(m.period)],
  ['V peak‑peak', (m) => fmtV(m.pp)],
  ['V max', (m) => fmtV(m.max)],
  ['V min', (m) => fmtV(m.min)],
  ['V amplitude', (m) => fmtV(m.amp)],
  ['V top', (m) => fmtV(m.top)],
  ['V base', (m) => fmtV(m.base)],
  ['V mean', (m) => fmtV(m.cmean ?? m.mean)],
  ['V RMS', (m) => fmtV(m.crms ?? m.rms)],
  ['V RMS (AC)', (m) => fmtV(m.acrms)],
  ['Duty cycle', (m) => isFinite(m.duty) ? m.duty.toFixed(1) + ' %' : '---'],
  ['+ Width', (m) => fmtT(m.pwidth)],
  ['− Width', (m) => fmtT(m.nwidth)],
  ['Rise time', (m) => fmtT(m.rise)],
  ['Fall time', (m) => fmtT(m.fall)],
  ['Overshoot', (m) => isFinite(m.over) && m.freq ? m.over.toFixed(1) + ' %' : '---']
];

function buildMeasurements() {
  const cells = MEAS_LIST.map(([k], i) =>
    `<div class="m"><div class="k">${k}</div><div class="v" id="m${i}a">---</div><div class="v v2" id="m${i}b">---</div></div>`);
  cells.push('<div class="m dual"><div class="k">Phase CH1→CH2</div><div class="v vp" id="mPhase">---</div></div>');
  cells.push('<div class="m dual"><div class="k">Delay CH1→CH2</div><div class="v vp" id="mDelay">---</div></div>');
  cells.push('<div class="m"><div class="k">FFT freq.</div><div class="v" id="mFft">---</div></div>');
  measEl.innerHTML = cells.join('');
}

function renderMeasurements() {
  const dual = cfg.channels === 2;
  measEl.classList.toggle('two', dual);
  MEAS_LIST.forEach(([, f], i) => {
    for (const c of [0, 1]) {
      const el = document.getElementById('m' + i + (c ? 'b' : 'a'));
      const m = chans[c].meas;
      if (el) el.textContent = m && (c === 0 || dual) ? f(m, c) : '---';
    }
  });
  if (lastPhase) {
    $('mPhase').textContent = (lastPhase.deg >= 0 ? '+' : '') + lastPhase.deg.toFixed(1) + '°';
    $('mDelay').textContent = fmtT(lastPhase.delay);
  } else {
    $('mPhase').textContent = '---';
    $('mDelay').textContent = '---';
  }
  $('mFft').textContent = cfg.fft && lastFft ? `CH${cfg.sel + 1} ${fmtF(lastFft.freq)}` : '(FFT off)';
}

function updateReadout() {
  if (!hover) { readoutEl.style.display = 'none'; return; }
  const c = cfg.sel;
  const t = xToTime(hover.x), v = yToVolts(hover.y, c);
  let html = `<div>t ${fmtT(t)} · <span style="color:${CH_COLORS[c]}">CH${c + 1} ${fmtV(v)}</span></div>`;
  if (refCursor) {
    const dT = Math.abs(t - refCursor.t), dV = Math.abs(v - yToVolts(voltsToY(refCursor.v, refCursor.c), c));
    html += `<div class="ref">ΔT ${fmtT(dT)} · 1/ΔT ${fmtF(dT > 0 ? 1 / dT : NaN)} · ΔV ${fmtV(dV)}</div>`;
  }
  readoutEl.innerHTML = html;
  readoutEl.style.display = 'block';
}

/** @param {string} text @param {string} cls */
function setTrigStatus(text, cls) {
  const el = $('trigStatus');
  if (el.textContent !== text) el.textContent = text;
  el.className = 'pill ' + cls;
}

/** @param {string} text @param {string} cls */
function setConn(text, cls) {
  const el = $('connStatus');
  if (el.textContent !== text) el.textContent = text;
  el.className = 'pill ' + cls;
}

function setRunning(/** @type {boolean} */ on) {
  running = on;
  const b = $('runBtn');
  b.textContent = on ? 'RUN' : 'STOP';
  b.className = on ? 'run' : 'stop';
  if (!on && !single) setTrigStatus('STOPPED', 'bad');
}

/** Vertical settings of the channel the controls apply to */
const selCh = () => cfg.ch[cfg.sel];

/** Refresh all control widgets from cfg */
function syncUi() {
  if (cfg.channels === 1) { cfg.sel = 0; cfg.trigSrc = 0; }
  const s = selCh();
  const color = CH_COLORS[cfg.sel];
  $('vdivVal').textContent = fmtDiv(s.vdiv, 'V') + '/div';
  $('vposVal').textContent = fmtV(s.vcenter);
  $('vdivVal').style.color = color;
  $('vposVal').style.color = color;
  $('tdivVal').textContent = fmtDiv(cfg.tdiv, 's') + '/div';
  $('hposVal').textContent = Math.round(cfg.hpos * 100) + ' %';
  $('sumV').innerHTML = active().map(c =>
    `<span style="color:${CH_COLORS[c]}">${fmtDiv(cfg.ch[c].vdiv, 'V')}</span>`).join(' · ');
  $('sumH').textContent = fmtDiv(cfg.tdiv, 's') + '/div';
  $('sumT').textContent = (cfg.channels === 2 ? `CH${cfg.trigSrc + 1} ` : '') +
    (cfg.trigEdge === 'rise' ? '↑ ' : '↓ ') + fmtV(cfg.trigLevel);
  $('atten').value = String(cfg.atten);
  const probeSel = $('probe');
  if (['1', '2', '5', '10'].includes(String(s.probe))) {
    probeSel.value = String(s.probe);
    $('probeCustom').style.display = 'none';
  } else {
    probeSel.value = 'custom';
    $('probeCustom').style.display = '';
    $('probeCustom').value = String(s.probe);
  }
  $('rateMode').value = cfg.rateMode;
  $('rateManual').style.display = cfg.rateMode === 'manual' ? '' : 'none';
  $('rateManual').value = String(cfg.rateManual);
  $('rateManual').max = String(Math.floor(RATE_MAX / cfg.channels));
  if (document.activeElement !== $('trigLevel')) $('trigLevel').value = cfg.trigLevel.toFixed(3);
  $('testHz').value = String(cfg.testHz);
  $('avg').value = String(cfg.avg);
  $('dots').checked = cfg.dots;
  $('fftBtn').textContent = cfg.fft ? 'On' : 'Off';
  $('fftBtn').className = 'small' + (cfg.fft ? ' on' : '');
  $('timeCalVal').textContent = cfg.timeCal.toFixed(4);
  /** @type {Array<[string, string]>} */
  const segs = [['coupling', s.coupling], ['trigMode', cfg.trigMode], ['trigEdge', cfg.trigEdge],
    ['channelsSel', String(cfg.channels)], ['chSel', String(cfg.sel)], ['trigSrc', String(cfg.trigSrc)]];
  for (const [id, val] of segs) {
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('sel', b.dataset.v === val);
  }
  for (const id of ['chSelRow', 'trigSrcRow']) $(id).style.display = cfg.channels === 2 ? '' : 'none';
  $('rateHint').innerHTML = cfg.channels === 2
    ? 'With <b>2 channels</b> each one samples up to <b>41 666 S/s</b>: clean waveform up to ~<b>2 kHz</b>, frequency up to ~20 kHz.'
    : 'With <b>1 channel</b> it samples up to <b>83 333 S/s</b>: clean waveform up to ~<b>4 kHz</b>, frequency up to ~40 kHz.';
  $('rateStatus').textContent = `Fs ${fmtF(effRate()).replace('Hz', 'S/s')}${cfg.channels === 2 ? ' ×2' : ''}`;
  saveSettings();
}

function stepVdiv(/** @type {number} */ dir) {
  const s = selCh();
  const i = VDIV_STEPS.indexOf(stepAtLeast(VDIV_STEPS, s.vdiv));
  s.vdiv = VDIV_STEPS[clamp(i + dir, 0, VDIV_STEPS.length - 1)];
  syncUi();
}

function stepTdiv(/** @type {number} */ dir) {
  const i = TDIV_STEPS.indexOf(stepAtLeast(TDIV_STEPS, cfg.tdiv));
  cfg.tdiv = TDIV_STEPS[clamp(i + dir, 0, TDIV_STEPS.length - 1)];
  resetAverages();
  syncUi();
  scheduleParams();
}

// --- Buttons ---
$('runBtn').onclick = () => { single = false; setRunning(!running); };
$('singleBtn').onclick = () => {
  single = true;
  singleArmHead = Math.min(...active().map(c => chans[c].head));
  setRunning(true);
  setTrigStatus('SINGLE: waiting…', 'warn');
};
$('autoBtn').onclick = () => autoset();
$('vdivUp').onclick = () => stepVdiv(1);
$('vdivDown').onclick = () => stepVdiv(-1);
$('vposUp').onclick = () => { selCh().vcenter -= selCh().vdiv / 2; syncUi(); };
$('vposDown').onclick = () => { selCh().vcenter += selCh().vdiv / 2; syncUi(); };
$('vposZero').onclick = () => { selCh().vcenter = 0; syncUi(); };
$('vposMid').onclick = () => {
  const m = chans[cfg.sel].meas;
  if (m && isFinite(m.max)) selCh().vcenter = selCh().coupling === 'ac' ? 0 : (m.max + m.min) / 2;
  syncUi();
};
$('tdivUp').onclick = () => stepTdiv(1);
$('tdivDown').onclick = () => stepTdiv(-1);
$('hposLeft').onclick = () => { cfg.hpos = clamp(cfg.hpos - 0.1, 0, 1); syncUi(); };
$('hposRight').onclick = () => { cfg.hpos = clamp(cfg.hpos + 0.1, 0, 1); syncUi(); };
$('trig50').onclick = () => {
  const m = chans[cfg.trigSrc].meas;
  if (m && isFinite(m.max)) cfg.trigLevel = (m.top + m.base) / 2 + traceOffset(cfg.trigSrc);
  syncUi();
};
$('fftBtn').onclick = () => { cfg.fft = !cfg.fft; lastFft = null; syncUi(); };

/** Segmented buttons */
for (const id of ['coupling', 'trigMode', 'trigEdge', 'channelsSel', 'chSel', 'trigSrc']) {
  $(id).addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    const v = b.dataset.v;
    if (id === 'coupling') {
      selCh().coupling = /** @type {any} */ (v);
      if (v === 'ac') selCh().vcenter = 0;
    }
    if (id === 'trigMode') cfg.trigMode = /** @type {any} */ (v);
    if (id === 'trigEdge') cfg.trigEdge = /** @type {any} */ (v);
    if (id === 'chSel') { cfg.sel = /** @type {0|1} */ (parseInt(v)); lastFft = null; }
    if (id === 'trigSrc') {
      cfg.trigSrc = /** @type {0|1} */ (parseInt(v));
      const m = chans[cfg.trigSrc].meas;
      if (m && isFinite(m.max)) cfg.trigLevel = (m.top + m.base) / 2;
    }
    if (id === 'channelsSel') {
      const n = /** @type {1|2} */ (parseInt(v));
      if (n !== cfg.channels) {
        cfg.channels = n;
        if (n === 2) cfg.sel = 1;
        resetAverages();
        chans[1].frame = null;
        chans[1].meas = null;
        lastPhase = null;
        scheduleParams();
      }
    }
    syncUi();
  });
}

$('probe').onchange = () => {
  const v = $('probe').value;
  const old = selCh().probe;
  selCh().probe = v === 'custom' ? (parseFloat($('probeCustom').value) || old) : parseFloat(v);
  if (v === 'custom') $('probeCustom').style.display = '';
  rescaleForProbe(old);
};
$('probeCustom').onchange = () => {
  const old = selCh().probe;
  selCh().probe = Math.max(0.01, parseFloat($('probeCustom').value) || 1);
  rescaleForProbe(old);
};

/** Keep the picture the same when the probe factor of the selected channel changes */
function rescaleForProbe(/** @type {number} */ old) {
  const s = selCh();
  const k = s.probe / old;
  s.vdiv = stepAtLeast(VDIV_STEPS, s.vdiv * k);
  s.vcenter *= k;
  if (cfg.trigSrc === cfg.sel) cfg.trigLevel *= k;
  syncUi();
}

$('atten').onchange = () => { cfg.atten = parseInt($('atten').value); syncUi(); scheduleParams(); };
$('rateMode').onchange = () => { cfg.rateMode = $('rateMode').value; syncUi(); scheduleParams(); };
$('rateManual').onchange = () => {
  cfg.rateManual = clamp(parseInt($('rateManual').value) || 20000, 1, RATE_MAX / cfg.channels);
  syncUi(); scheduleParams();
};
$('trigLevel').onchange = () => { cfg.trigLevel = parseFloat($('trigLevel').value) || 0; syncUi(); };
$('testHz').onchange = () => { cfg.testHz = clamp(parseInt($('testHz').value) || 1000, 1, 40000); syncUi(); scheduleParams(); };
$('avg').onchange = () => { cfg.avg = parseInt($('avg').value); resetAverages(); syncUi(); };
$('dots').onchange = () => { cfg.dots = $('dots').checked; syncUi(); };

$('timeCalBtn').onclick = async () => {
  // Measure the test signal (exact LEDC frequency) to learn the real sample rate
  const btn = $('timeCalBtn');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  const oldCal = cfg.timeCal;
  cfg.timeCal = 1;
  await sleep(1200);
  const f = computeFft(cfg.sel);
  const expected = cfg.testHz;
  if (f && f.freq > 0 && Math.abs(f.freq / expected - 1) < 0.1) {
    cfg.timeCal = expected / f.freq;
    alert(`Calibrated: factor ${cfg.timeCal.toFixed(4)} (measured ${fmtF(f.freq)}, expected ${fmtF(expected)})`);
  } else {
    cfg.timeCal = oldCal;
    alert(`Test signal not detected on CH${cfg.sel + 1}. Connect the test signal pin to that input and try again.`);
  }
  btn.disabled = false;
  btn.textContent = 'Calibrate with test signal';
  syncUi();
};
$('timeCalReset').onclick = () => { cfg.timeCal = 1; syncUi(); };

$('resetBtn').onclick = () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  window.location.reload();
};
$('powerOff').onclick = () => {
  if (confirm('Power off the esp-scope? You will need to press RESET to start it again.')) window.location.href = '/poweroff';
};

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (/** @type {HTMLElement} */ (e.target).closest('input, select, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); $('runBtn').click(); }
  else if (e.key === 'a' || e.key === 'A') autoset();
  else if (e.key === 's' || e.key === 'S') $('singleBtn').click();
  else if ((e.key === '1' || e.key === '2') && cfg.channels === 2) { cfg.sel = e.key === '1' ? 0 : 1; syncUi(); }
});

// --- Canvas interaction ---
/** @type {null|'pending'|'trig'|'vpos'|'hpos'} */ let dragMode = null;
let hoverTrig = false;
let dragStart = { x: 0, y: 0, vcenter: 0, hpos: 0 };

function canvasPos(/** @type {PointerEvent|WheelEvent} */ e) {
  const b = canvas.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = canvasPos(e);
  canvas.setPointerCapture(e.pointerId);
  if (p.x < PAD_L + 4 && cfg.channels === 2) {
    // Grab the nearest ground marker: selects that channel and moves it
    const r = plotRect();
    const dist = (/** @type {number} */ c) => Math.abs(clamp(voltsToY(-traceOffset(c), c), r.y + 6, r.y + r.h - 6) - p.y);
    cfg.sel = dist(0) <= dist(1) ? 0 : 1;
    syncUi();
  }
  dragStart = { x: p.x, y: p.y, vcenter: selCh().vcenter, hpos: cfg.hpos };
  dragMode = p.x > W - PAD_R - 8 ? 'trig' : p.x < PAD_L + 4 ? 'vpos' : 'pending';
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  const pr = plotRect();
  hover = p.y <= pr.y + pr.h ? p : null;
  hoverTrig = p.x > W - PAD_R - 8;
  if (!dragMode) return;
  const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
  if (dragMode === 'pending' && Math.hypot(dx, dy) > 6) dragMode = Math.abs(dy) > Math.abs(dx) ? 'vpos' : 'hpos';
  const r = plotRect();
  if (dragMode === 'trig') {
    cfg.trigLevel = yToVolts(p.y, cfg.trigSrc) + traceOffset(cfg.trigSrc);
    syncUi();
  } else if (dragMode === 'vpos') {
    selCh().vcenter = dragStart.vcenter + dy / r.h * selCh().vdiv * V_DIVS;
    syncUi();
  } else if (dragMode === 'hpos') {
    cfg.hpos = clamp(dragStart.hpos + dx / r.w, 0, 1);
    syncUi();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (dragMode === 'pending') {
    const p = canvasPos(e);
    refCursor = refCursor ? null : { t: xToTime(p.x), v: yToVolts(p.y, cfg.sel), c: cfg.sel };
  }
  dragMode = null;
});

canvas.addEventListener('pointerleave', () => { if (!dragMode) { hover = null; hoverTrig = false; } });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dir = e.deltaY > 0 ? 1 : -1;
  if (e.shiftKey) stepVdiv(dir); else stepTdiv(dir);
}, { passive: false });

/*
 * ==========================================
 * 9. Autoset
 * ==========================================
 */

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * Analyse the newest `seconds` of data of a channel
 * @param {number} c
 * @param {number} seconds
 */
function analyseRecent(c, seconds) {
  const ch = chans[c];
  const n = Math.min(Math.round(seconds * effRate()), ch.head - ch.start, RING_SIZE - 1);
  if (n < 16) return null;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = sampleV(c, ch.head - n + i);
  return measure(v, 1 / effRate(), cfg.ch[c].probe);
}

/** Analyse all active channels; returns per-channel measurements */
function analyseAll(/** @type {number} */ seconds) {
  return active().map(c => analyseRecent(c, seconds));
}

async function autoset() {
  if (autosetBusy) return;
  autosetBusy = true;
  const btn = $('autoBtn');
  btn.textContent = 'SETTING UP…';
  single = false;
  setRunning(true);
  setTrigStatus('AUTOSET…', 'warn');
  try {
    // Pass 1: fastest sampling, catches anything from ~20 Hz up
    await setRateNow(RATE_MAX / cfg.channels);
    await sleep(350);
    let ms = analyseAll(0.25);
    const periodic = (/** @type {any[]} */ list) => list.some(m => m && m.freq > 0 && m.freq * 0.25 >= 3);
    // Pass 2: slow signals (down to ~1 Hz)
    if (!periodic(ms)) {
      await setRateNow(2000);
      await sleep(2300);
      const ms2 = analyseAll(2.2);
      if (ms2.some(m => m)) ms = ms2;
    }
    if (!ms[0] || !isFinite(ms[0].max)) throw new Error('sin datos');

    // Time base and trigger from the first channel with a periodic signal
    const srcIdx = ms.findIndex(m => m && m.freq > 0);
    const dual = cfg.channels === 2;
    if (srcIdx >= 0) {
      const m = ms[srcIdx];
      cfg.tdiv = stepAtLeast(TDIV_STEPS, 2.5 / m.freq / H_DIVS);
      cfg.trigSrc = /** @type {0|1} */ (srcIdx);
      cfg.trigLevel = (m.top + m.base) / 2;
      cfg.trigMode = 'auto';
      cfg.trigEdge = 'rise';
    } else {
      cfg.tdiv = 1e-3;
      cfg.trigSrc = 0;
      cfg.trigLevel = ms[0].mean;
    }

    // Vertical: one channel uses ~6 divisions; two channels share the screen (CH1 top, CH2 bottom)
    ms.forEach((m, c) => {
      if (!m || !isFinite(m.max)) return;
      const s = cfg.ch[c];
      const pp = Math.max(m.pp, 0.02 * s.probe);
      const room = dual ? 3 : 6;
      s.vdiv = m.freq > 0
        ? stepAtLeast(VDIV_STEPS, pp / room)
        : stepAtLeast(VDIV_STEPS, Math.max(pp, Math.abs(m.mean) * 0.5, 0.05) / (room * 0.66));
      const mid = s.coupling === 'ac' ? 0 : (m.max + m.min) / 2;
      // vcenter is the voltage at the screen centre: put CH1 two divisions up, CH2 two down
      s.vcenter = dual ? mid + (c === 0 ? -2 : 2) * s.vdiv : mid;
    });
    cfg.hpos = 0.5;
    cfg.rateMode = 'auto';
    refCursor = null;
    resetAverages();
  } catch (e) {
    console.warn('Autoset failed', e);
  }
  syncUi();
  await setRateNow(desiredRate());
  lastTrigTime = 0;
  btn.textContent = 'AUTO SET';
  autosetBusy = false;
}

/*
 * ==========================================
 * 10. Network & Configuration Management
 * ==========================================
 */

let paramsTimer = 0;
function scheduleParams() {
  clearTimeout(paramsTimer);
  paramsTimer = window.setTimeout(() => setRateNow(desiredRate()), 120);
}

/**
 * Send rate/atten/channels/test settings to the ESP32 and reset the history
 * @param {number} rate - wanted effective sample rate per channel
 */
async function setRateNow(rate) {
  const nch = cfg.channels;
  // In auto mode the ADC never runs slower than PEAK_MIN_RATE: slower time bases use
  // peak detect so signals faster than the screen rate show as an envelope, not an alias
  const floor = cfg.rateMode === 'auto' ? PEAK_MIN_RATE : RATE_MIN;
  const hw = Math.max(floor, Math.min(RATE_MAX, Math.round(rate * nch)));
  const ratio = hw / nch / Math.max(1, rate);
  const newDecim = ratio >= 2 ? Math.round(2 * ratio) : 1;
  const payload = { sample_rate: hw, atten: cfg.atten, bit_width: 12, test_hz: cfg.testHz, channels: nch };
  if (!DEMO) {
    try {
      const res = await fetch('/params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(res.statusText);
      await fetchInfo();
    } catch (err) {
      setConn('Configuration error', 'bad');
      return;
    }
  } else {
    demo.rate = hw;
    demo.slot = 0;
    buildLut(undefined);
  }
  hwRate = hw;
  decim = newDecim;
  // Start both channels at the same index so sample k of CH1 and CH2 stay paired
  const h = Math.max(chans[0].head, chans[1].head);
  for (const ch of chans) {
    ch.head = h;
    ch.start = h;
    ch.blkN = 0;
  }
  expectCh = 0;
  resetAverages();
  syncUi();
}

/** Read device info and ADC calibration */
async function fetchInfo() {
  try {
    const res = await fetch('/info', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const info = await res.json();
    RATE_MIN = Math.max(1000, info.rate_min || 1000);
    RATE_MAX = info.rate_max || RATE_MAX;
    buildLut(info.mv);
    const ch2 = info.adc_gpio2 >= 0 ? ` · CH2: <b>GPIO${info.adc_gpio2}</b>` : '';
    $('pinInfo').innerHTML = `CH1: <b>GPIO${info.adc_gpio}</b>${ch2} · Test signal: <b>GPIO${info.test_gpio}</b> · common GND`;
    $('devInfo').textContent = `Chip ${info.target} · ADC ${info.calibrated ? 'calibrated (eFuse)' : 'not calibrated'} · max Fs ${info.rate_max} (total)`;
  } catch (e) {
    // Older firmware without /info
    buildLut(undefined);
  }
}

function connect() {
  clearTimeout(reconnectTimeout);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/signal`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    setConn('Connected', 'ok');
    ws && ws.send('hello');
    setRateNow(desiredRate());
  };
  ws.onclose = () => {
    setConn('Disconnected, retrying…', 'bad');
    reconnectTimeout = window.setTimeout(connect, 2000);
  };
  ws.onmessage = (event) => {
    const arr = new Uint16Array(event.data);
    if (arr.length) {
      if (performance.now() - lastDataTime > 1500) setConn('Connected', 'ok');
      processData(arr);
    }
  };
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const ch = DEFAULTS.ch.map((d, i) => ({ ...d, ...((s.ch && s.ch[i]) || {}) }));
    return { ...DEFAULTS, ...s, ch };
  } catch (e) {
    return { ...DEFAULTS, ch: DEFAULTS.ch.map(d => ({ ...d })) };
  }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
}

function setupWifiListeners() {
  const wifiModal = $('wifiModal');
  $('wifiBtn').onclick = () => {
    wifiModal.style.display = 'flex';
    $('wifiSsid').focus();
  };
  $('closeWifi').onclick = () => wifiModal.style.display = 'none';
  $('saveWifi').onclick = () => {
    const ssid = $('wifiSsid').value;
    const pass = $('wifiPass').value;
    if (!ssid) {
      alert('SSID is required');
      return;
    }
    $('saveWifi').innerText = 'Saving…';
    fetch('/api/save_wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password: pass })
    })
      .then(res => res.text())
      .then(text => {
        alert(text);
        window.location.reload();
      })
      .catch(err => {
        alert('Error: ' + err);
        $('saveWifi').innerText = 'Save';
      });
  };
}

/*
 * ==========================================
 * 11. Demo signal (no hardware needed)
 * ==========================================
 */

// "?demo" square wave (CH2: same wave 90° behind), "?demo=sine" sine wave
const demo = { rate: 20000, phase: 0, slot: 0, state: [0, 0], shape: new URLSearchParams(location.search).get('demo') || 'square' };

/** Simulated signal of one channel at a phase (0..1) */
function demoValue(/** @type {number} */ c, /** @type {number} */ phase, /** @type {number} */ dt) {
  if (demo.shape === 'sine') {
    return 1.6 + 1.1 * Math.sin(2 * Math.PI * phase) + 0.15 * Math.sin(6 * Math.PI * phase);
  }
  // Square wave 0.2..2.9 V through an RC filter (CH1 30 % duty, CH2 50 %)
  const target = phase < (c === 0 ? 0.3 : 0.5) ? 2.9 : 0.2;
  demo.state[c] += (target - demo.state[c]) * Math.min(1, dt / 12e-6);
  return demo.state[c];
}

function startDemo() {
  setConn('DEMO (simulated)', 'warn');
  fetchInfoDemo();
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const n = Math.min(Math.round((now - last) / 1000 * demo.rate), 200000);
    last = now;
    const out = new Uint16Array(n);
    const nch = cfg.channels;
    const f = cfg.testHz;
    const fs = ATTEN_TO_MAX_V[cfg.atten];
    const dt = 1 / demo.rate;
    for (let i = 0; i < n; i++) {
      // The ADC converts CH1, CH2, CH1, CH2... so every slot advances time by one conversion
      demo.phase = (demo.phase + f * dt) % 1;
      const c = nch === 2 ? (demo.slot++) % 2 : 0;
      const ph = c === 0 ? demo.phase : (demo.phase + 0.75) % 1;
      let v = demoValue(c, ph, dt * nch);
      v += (Math.random() - 0.5) * 0.012;
      out[i] = clamp(Math.round(v / fs * 4095), 0, 4095) | (c << 12);
    }
    processData(out);
  }, 20);
}

function fetchInfoDemo() {
  buildLut(undefined);
  $('pinInfo').innerHTML = 'DEMO mode: simulated signal. On the ESP32‑S3: CH1 <b>GPIO1</b>, CH2 <b>GPIO2</b>, test <b>GPIO21</b>.';
  $('devInfo').textContent = 'Demo mode (no hardware)';
}

/*
 * ==========================================
 * 12. Initialization
 * ==========================================
 */

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}

new ResizeObserver(resize).observe(canvas);
resize();
buildMeasurements();
setupWifiListeners();
buildLut(undefined);
syncUi();
if (DEMO) {
  startDemo();
  setRateNow(desiredRate());
} else {
  connect();
}
requestAnimationFrame(animationLoop);
