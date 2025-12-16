/// <reference lib="dom" />

/*
 * ==========================================
 * 1. Constants & Configuration
 * ==========================================
 */

// Approximate full-scale voltages for ESP32C6/ESP32 ADC attenuations
// 0dB: ~950mV, 2.5dB: ~1250mV, 6dB: ~1750mV, 11dB: ~3100mV+ (use 3.3V)
/** @type {number[]} */
const ATTEN_TO_MAX_V = [0.95, 1.25, 1.75, 3.3];

// Data buffer size
/** @type {number} */
const countPoints = 4000;

/**
 * @typedef {Object} ActiveConfig
 * @property {number} desiredRate - Desired sample rate in Hz
 * @property {number} sample_rate - Actual hardware sample rate
 * @property {number} atten - Attenuation setting index
 * @property {number} bit_width - Bit width (e.g. 12)
 * @property {number} test_hz - Test signal frequency for simulation
 * @property {number} trigger - Trigger level (-1-4097)
 * @property {boolean} invert - Whether trigger logic is inverted
 */

/** @type {ActiveConfig} */
let activeConfig = {
  desiredRate: 10000,
  sample_rate: 10000,
  atten: 3, // 11dB Default
  bit_width: 12,
  test_hz: 100,
  trigger: 2048,
  invert: false
};

/**
 * @typedef {Object} LowRateState
 * @property {number} accMin - Accumulated minimum value
 * @property {number} accMax - Accumulated maximum value
 * @property {number} accSum - Accumulated sum for average
 * @property {number} accCount - Count of samples in accumulator
 * @property {number} progress - Fractional progress counter
 * @property {number} targetCount - Target samples per output point
 */

/** @type {LowRateState} */
let lowRateState = {
  accMin: 4096,
  accMax: 0,
  accSum: 0,
  accCount: 0,
  progress: 0.0,
  targetCount: 1.0
};


/*
 * ==========================================
 * 2. Global UI Elements & State
 * ==========================================
 */

/** @type {HTMLCanvasElement} */ const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('adcChart'));
/** @type {CanvasRenderingContext2D} */ const ctx = canvas.getContext('2d');
/** @type {HTMLElement} */ const statusEl = document.getElementById('status');
/** @type {HTMLElement} */ const triggerStatusEl = document.getElementById('trigger-status');
/** @type {HTMLElement} */ const deltaPanel = document.getElementById('deltaPanel');
/** @type {HTMLInputElement & { invert?: boolean, downValue?: string }} */ const triggerLevel = /** @type {HTMLInputElement & { invert?: boolean, downValue?: string }} */ (document.getElementById('triggerLevel'));

// Config Elements
/** @type {HTMLElement} */ const reconnectBtn = document.getElementById('reconnectBtn');
/** @type {HTMLSelectElement} */ const sampleRateSelect = /** @type {HTMLSelectElement} */ (document.getElementById('sampleRate'));
/** @type {HTMLSelectElement} */ const bitWidthSelect = /** @type {HTMLSelectElement} */ (document.getElementById('bitWidth'));
/** @type {HTMLSelectElement} */ const attenSelect = /** @type {HTMLSelectElement} */ (document.getElementById('atten'));
/** @type {HTMLSelectElement} */ const testHzSelect = /** @type {HTMLSelectElement} */ (document.getElementById('testHz'));
/** @type {HTMLButtonElement} */ const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById('resetBtn'));
/** @type {HTMLButtonElement} */ const powerOffBtn = /** @type {HTMLButtonElement} */ (document.getElementById('powerOff'));

// Wifi Elements
/** @type {HTMLElement} */ const wifiModal = document.getElementById('wifiModal');
/** @type {HTMLButtonElement} */ const wifiBtn = /** @type {HTMLButtonElement} */ (document.getElementById('wifiBtn'));
/** @type {HTMLElement} */ const closeWifiBtn = document.getElementById('closeWifi');
/** @type {HTMLButtonElement} */ const saveWifiBtn = /** @type {HTMLButtonElement} */ (document.getElementById('saveWifi'));
/** @type {HTMLInputElement} */ const wifiSsidInput = /** @type {HTMLInputElement} */ (document.getElementById('wifiSsid'));
/** @type {HTMLInputElement} */ const wifiPassInput = /** @type {HTMLInputElement} */ (document.getElementById('wifiPass'));

/**
 * @typedef {Object} DownsampledPoint
 * @property {number} min
 * @property {number} max
 * @property {number} avg
 */

/** @type {Array<number|DownsampledPoint>} */
let dataBuffer = new Array(countPoints).fill(0);

/** @type {{x: number|null, y: number|null}} */
let lastMousePosition = { x: null, y: null };

/** @type {boolean} */
let isFrozen = false;

/** @type {{t: number, v: number}|null} */
let referencePosition = null; // Store the reference position for deltas

/**
 * @typedef {Object} ViewTransform
 * @property {number} scale
 * @property {number} offsetX
 * @property {number} offsetY
 */

/** @type {ViewTransform} */
let viewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0
};

// WebSocket vars
/** @type {WebSocket} */
let ws;
/** @type {number} */
let reconnectTimeout;


/*
 * ==========================================
 * 3. Coordinate System & Math Utils
 * ==========================================
 */

/**
 * Helper to get total time (width of buffer in ms)
 * @returns {number} Total time in milliseconds
 */
function getTotalTimeMs() {
  let msPerPoint;
  // If we are in low-rate mode (peak detect), we emit 1 point (object)
  // for every 'targetCount' samples of the hardware rate (which is 1kHz).
  if (activeConfig.desiredRate < 1000) {
    msPerPoint = lowRateState.targetCount;
  } else {
    // Normal mode: 1 point = 1 sample
    msPerPoint = 1000.0 / activeConfig.desiredRate;
  }

  // The total time displayed is simply the time-per-pixel * number-of-pixels
  // assuming 1 pixel = 1 point at scale 1.0.
  return msPerPoint * canvas.width;
}

/**
 * Helper to get max voltage
 * @returns {number} Max voltage stored in ATTEN_TO_MAX_V or 3.3
 */
function getMaxVoltage() {
  return ATTEN_TO_MAX_V[activeConfig.atten] || 3.3;
}

/**
 * Convert X pixel coordinate to Time (ms)
 * @param {number} px - Pixel X coordinate
 * @returns {number} Time in milliseconds
 */
function XtoTime(px) {
  const totalTime = getTotalTimeMs();
  if (canvas.width === 0) return 0;
  return ((px - viewTransform.offsetX) / viewTransform.scale) * (totalTime / canvas.width);
}

/**
 * Convert Time (ms) to X pixel coordinate
 * @param {number} t - Time in milliseconds
 * @returns {number} Pixel X coordinate
 */
function TimeToX(t) {
  const totalTime = getTotalTimeMs();
  if (totalTime === 0 || canvas.width === 0) return 0;
  const xp = (t / totalTime) * canvas.width;
  return xp * viewTransform.scale + viewTransform.offsetX;
}

/**
 * Convert Y pixel coordinate to Voltage
 * @param {number} py - Pixel Y coordinate
 * @returns {number} Voltage in volts
 */
function YtoVolts(py) {
  const maxV = getMaxVoltage();
  if (canvas.height === 0) return 0;
  const yp = (py - viewTransform.offsetY) / viewTransform.scale;
  return maxV * (1 - yp / canvas.height);
}

/**
 * Convert Voltage to Y pixel coordinate
 * @param {number} v - Voltage in volts
 * @returns {number} Pixel Y coordinate
 */
function VoltsToY(v) {
  const maxV = getMaxVoltage();
  const yp = canvas.height * (1 - v / maxV);
  return yp * viewTransform.scale + viewTransform.offsetY;
}

/**
 * Nice Number Generator for Grid
 * @param {number} range - Range of values
 * @param {boolean} round - Whether to round to nice fraction
 * @returns {number} Nice number interval
 */
function niceNum(range, round) {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

/**
 * Calculate nice tick marks for axis
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {number} maxTicks - Maximum number of ticks
 * @returns {number[]} Array of tick values
 */
function calculateNiceTicks(min, max, maxTicks) {
  const range = niceNum(max - min, false);
  const tickSpacing = niceNum(range / (maxTicks - 1), true);
  const niceMin = Math.floor(min / tickSpacing) * tickSpacing;
  const niceMax = Math.ceil(max / tickSpacing) * tickSpacing;
  const ticks = [];
  for (let t = niceMin; t <= niceMax + 0.00001; t += tickSpacing) {
    ticks.push(t);
  }
  return ticks;
}


/*
 * ==========================================
 * 4. Data Processing
 * ==========================================
 */

/**
 * Process incoming WebSocket data
 * @param {Uint16Array} newData - Array of ADC samples
 */
function processData(newData) {
  if (isFrozen) {
    return; // Skip updating the buffer when frozen
  }

  // Recalculate target count based on ratio
  // If virtual rate < 1000, we forced hardware to 1000
  if (activeConfig.desiredRate < 1000) {
    lowRateState.targetCount = activeConfig.sample_rate / activeConfig.desiredRate;
  } else {
    lowRateState.targetCount = 1;
  }

  if (lowRateState.targetCount <= 1) {
    // Passthrough mode
    pushToBuffer(/** @type {Array<number>} */(Array.from(newData)));
  } else {
    // Accumulation mode (Peak Detect) with Fractional Resampling
    /** @type {DownsampledPoint[]} */
    let pointsToPush = [];
    let idx = 0;

    // We add 1.0 "samples worth" of progress for each input sample.
    // When progress >= targetCount, we have enough input density to emit an output point.
    // We subtract targetCount (rather than reset to 0) to preserve fractional error (dither/phase).

    for (const val of newData) {
      if (val < lowRateState.accMin) lowRateState.accMin = val;
      if (val > lowRateState.accMax) lowRateState.accMax = val;
      lowRateState.accSum += val;
      lowRateState.accCount++;

      lowRateState.progress += 1.0;

      if (lowRateState.progress >= lowRateState.targetCount) {
        // Push object with min/max/avg
        const avg = lowRateState.accCount > 0 ? (lowRateState.accSum / lowRateState.accCount) : val;
        pointsToPush.push({
          min: lowRateState.accMin,
          max: lowRateState.accMax,
          avg: avg
        });

        // Reset Min/Max/Sum for next window
        lowRateState.accMin = 4096;
        lowRateState.accMax = 0;
        lowRateState.accSum = 0;
        lowRateState.accCount = 0;

        // Subtract one full window's worth of progress
        lowRateState.progress -= lowRateState.targetCount;
      }
    }
    if (pointsToPush.length > 0) {
      pushToBuffer(pointsToPush);
    }
  }
}

/**
 * Push new items to the rolling data buffer
 * @param {Array<number|DownsampledPoint>} newItems - New items to add
 */
function pushToBuffer(newItems) {
  if (newItems.length >= countPoints) {
    dataBuffer = Array.from(newItems.slice(-countPoints));
  } else {
    dataBuffer.splice(0, newItems.length);
    dataBuffer.push(...newItems);
  }
}


/*
 * ==========================================
 * 5. Visualization & Rendering
 * ==========================================
 */

/**
 * Draw the grid and axis labels
 * @param {number} w - Canvas width
 * @param {number} h - Canvas height
 */
function drawGrid(w, h) {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#fff';
  ctx.font = '15px monospace';

  // Helper to draw text with lozenge background
  const drawLabel = (text, x, y, align) => {
    ctx.save();
    const paddingX = 6;
    const paddingY = 3;
    const fontSize = 13;

    // Set font to measure correctly
    ctx.font = `${fontSize}px monospace`;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;

    // Calculate box position
    const boxHeight = fontSize + paddingY * 2;
    const boxWidth = textWidth + paddingX * 2;

    let boxX;
    if (align === 'left') boxX = x;
    else if (align === 'center') boxX = x - textWidth / 2;
    else if (align === 'right') boxX = x - textWidth;

    // Adjust for padding and visual centering
    boxX -= paddingX;
    const boxY = (y - 4) - boxHeight / 2;

    // Draw semi-transparent lozenge
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
    ctx.fill();

    // Draw text
    ctx.fillStyle = 'black';
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    ctx.restore();
  };

  // Determine Visible Voltage Range
  const minV = YtoVolts(h);
  const maxV = YtoVolts(0);

  // Calculate handy ticks in the visible range
  const ticks = calculateNiceTicks(minV, maxV, 8);

  for (let val of ticks) {
    const y = VoltsToY(val);

    // Skip if out of bounds (with a bit of margin)
    if (y < -20 || y > h + 20) continue;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    drawLabel(val.toFixed(2) + 'V', 5, y + 4, 'left');
  }

  // Determine Visible Time Range
  const minT = XtoTime(0);
  const maxT = XtoTime(w);

  const tTicks = calculateNiceTicks(minT, maxT, 8);

  for (let t of tTicks) {
    const x = TimeToX(t);

    if (x < -50 || x > w + 50) continue;

    let timeStr;
    if (Math.abs(t) >= 1000) {
      timeStr = (t / 1000).toFixed(2) + 's';
    } else {
      timeStr = t.toFixed(1) + 'ms';
    }

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    drawLabel(timeStr, x, h - 5, 'center');
  }
}

/**
 * Draw crosshairs at specific position
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} color - Color string
 */
function drawCrosshairs(x, y, color) {
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  // Draw vertical line
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();

  // Draw horizontal line
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvas.width, y);
  ctx.stroke();

  ctx.setLineDash([]);
}

/**
 * Main draw loop
 */
function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const maxAdcVal = 4096; // 12-bit fixed scale

  // Trigger values
  let drawIdx = dataBuffer.length - w;
  if (drawIdx < 0)
    drawIdx = 0;
  else {
    const triggerVal = (4096 - (parseInt(triggerLevel.value) || 2048));

    // Helper to extract value for trigger (handles numbers and avg objects)
    const getVal = (i) => {
      const v = dataBuffer[i];
      return (typeof v === 'object' && v !== null) ? v.avg : v;
    };

    if (triggerLevel.invert) {
      while (drawIdx >= 0) {
        // Look for falling edge
        if (getVal(drawIdx) < triggerVal && getVal(drawIdx + 1) > triggerVal) {
          break;
        }
        drawIdx -= 1;
      }
    } else {
      while (drawIdx >= 0) {
        // Look for rising edge
        if (getVal(drawIdx) > triggerVal && getVal(drawIdx + 1) < triggerVal) {
          break;
        }
        drawIdx -= 1;
      }
    }

    const triggerVolts = ((maxAdcVal - activeConfig.trigger) * getMaxVoltage() / maxAdcVal).toFixed(2) + "V";
    const triggerDir = triggerLevel.invert ? '&#x1F809;' : '&#x1F80B;';
    if (drawIdx < 0) {
      drawIdx = dataBuffer.length - w;
      triggerStatusEl.innerHTML = `<span style="color: #c22727;">${triggerVolts} ${triggerDir} No trigger</span>`;
    } else {
      triggerStatusEl.innerHTML = `<span style="color: #4ade80;">${triggerVolts} ${triggerDir} Triggered</span>`;
    }
  }

  // Pass 1: Draw Min/Max ranges for downsampled data
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#2b7044'; // Dark green
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const val = dataBuffer[i + drawIdx];
    if (typeof val === 'object' && val !== null) {
      const sx = i * viewTransform.scale + viewTransform.offsetX;
      const rawYMin = h - (val.min / maxAdcVal * h);
      const rawYMax = h - (val.max / maxAdcVal * h);

      const screenYMin = rawYMin * viewTransform.scale + viewTransform.offsetY;
      const screenYMax = rawYMax * viewTransform.scale + viewTransform.offsetY;

      ctx.moveTo(sx, screenYMin);
      ctx.lineTo(sx, screenYMax);
    }
  }
  ctx.stroke();

  // Pass 2: Draw Main Trace (Avg or raw value)
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4ade80'; // Bright green
  ctx.beginPath();

  for (let i = 0; i < w; i++) {
    const val = dataBuffer[i + drawIdx];
    const sx = i * viewTransform.scale + viewTransform.offsetX;
    /** @type {number} */ let rawVal;

    if (typeof val === 'object' && val !== null) {
      rawVal = val.avg;
    } else {
      rawVal = val;
    }

    const yp = h - (rawVal / maxAdcVal * h);
    const sy = yp * viewTransform.scale + viewTransform.offsetY;

    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }

  ctx.stroke();

  // Draw Background Grid
  drawGrid(w, h);

  // Draw Crosshairs if mouse is over the canvas
  if (lastMousePosition.x !== null && lastMousePosition.y !== null) {
    drawCrosshairs(lastMousePosition.x, lastMousePosition.y, '#4ade80');
  }

  // Draw reference crosshairs and deltas if frozen
  if (isFrozen && referencePosition) {
    // Convert World Reference to Screen
    const refX = TimeToX(referencePosition.t);
    const refY = VoltsToY(referencePosition.v);
    drawCrosshairs(refX, refY, '#eab308');
  }
}

/**
 * Loop the animation
 */
function animationLoop() {
  if (!isFrozen) {
    draw();
  }
  requestAnimationFrame(animationLoop);
}


/*
 * ==========================================
 * 6. User Interaction
 * ==========================================
 */

/**
 * Update background color of trigger level slider
 */
function triggerColor() {
  activeConfig.trigger = parseInt(triggerLevel.value);
  const value = (activeConfig.trigger - parseInt(triggerLevel.min)) / (parseInt(triggerLevel.max) - parseInt(triggerLevel.min)) * 100;
  triggerLevel.style.background = triggerLevel.invert
    ? `linear-gradient(to bottom, #00000070 0%, #ff020270  ${value}%, #1302ff70 ${value}%, #00000070 100%)`
    : `linear-gradient(to bottom, #00000070 0%, #1302ff70 ${value}%, #ff020270  ${value}%, #00000070  100%)`
}

/**
 * Update Mouse info
 * @param {MouseEvent | {offsetX: number, offsetY: number, pageX: number, pageY: number}} event
 */
function updateInfo(event) {
  // Use raw coordinates or event helpers
  const voltage = YtoVolts(event.offsetY);
  const timeOffset = XtoTime(event.offsetX);
  let info = `<div>${voltage.toFixed(3)}V, ${timeOffset.toFixed(2)}ms</div>`;

  // Store the last mouse position
  lastMousePosition.x = event.offsetX;
  lastMousePosition.y = event.offsetY;

  // Update delta panel position and content if frozen
  if (isFrozen && referencePosition) {
    const deltaVoltage = Math.abs(referencePosition.v - voltage);
    const deltaTime = Math.abs(referencePosition.t - timeOffset);

    // avoid divide by zero
    const freq = deltaTime > 0.00001 ? (1000 / deltaTime).toFixed(2) : '---';
    info += `<div style='color: yellow'>ΔV ${deltaVoltage.toFixed(3)}V, ΔT ${deltaTime.toFixed(2)}ms (${freq} Hz)</div>`;
  }

  deltaPanel.style.left = `${event.pageX + 10}px`;
  deltaPanel.style.top = `${event.pageY + 10}px`;
  deltaPanel.innerHTML = info;

  // Force redraw when frozen
  if (isFrozen) {
    draw();
  }
}

// Trigger Level Events
triggerLevel.addEventListener('input', triggerColor);
triggerLevel.addEventListener('mousedown', function () {
  this.downValue = this.value;
});
triggerLevel.addEventListener('mouseup', function () {
  if (this.downValue == this.value) {
    this.invert = !this.invert;
    activeConfig.invert = this.invert;
    triggerColor();
    this.dispatchEvent(new Event("change"));
  }
  delete this.downValue;
});

// Canvas Interaction Events
canvas.addEventListener('click', (event) => {
  isFrozen = !isFrozen;
  if (isFrozen) {
    // Set reference position in World Coordinates
    referencePosition = {
      t: XtoTime(event.offsetX),
      v: YtoVolts(event.offsetY)
    };
  }
});

canvas.addEventListener('mousemove', updateInfo);
canvas.addEventListener('mouseenter', () => deltaPanel.style.display = 'block');
canvas.addEventListener('mouseleave', () => deltaPanel.style.display = 'none');

canvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  const zoomFactor = 1.1;
  const direction = e.deltaY < 0 ? 1 : -1;
  const factor = direction > 0 ? zoomFactor : 1 / zoomFactor;

  let newScale = viewTransform.scale * factor;

  if (newScale < 1.001) {
    // Snap to 100% and reset position
    newScale = 1.0;
    viewTransform.offsetX = 0;
    viewTransform.offsetY = 0;
  } else if (newScale > 50) {
    return; // Max limit
  } else {
    // Zoom centered on mouse
    const mx = e.offsetX;
    const my = e.offsetY;

    viewTransform.offsetX = mx - (mx - viewTransform.offsetX) * factor;
    viewTransform.offsetY = my - (my - viewTransform.offsetY) * factor;
  }

  viewTransform.scale = newScale;
  if (newScale < 1.001) {
    statusEl.textContent = 'Connected via WebSocket';
  } else {
    statusEl.textContent = 'Scaled to ' + newScale.toFixed(2) + 'x';
  }

  draw();
  if (isFrozen) {
    updateInfo({ offsetX: e.offsetX, offsetY: e.offsetY, pageX: e.pageX, pageY: e.pageY });
  }
});


/*
 * ==========================================
 * 7. Network & Configuration Management
 * ==========================================
 */

/**
 * Connect to WebSocket
 */
function connect() {
  loadStoredConfig();

  clearTimeout(reconnectTimeout);
  if (reconnectBtn) reconnectBtn.style.display = 'none';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/signal`;
  // For local testing without ESP hardware, uncomment next line:
  // const wsUrl = 'ws://localhost:8080/signal';

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    statusEl.textContent = 'Connected via WebSocket';
    statusEl.style.color = '#4ade80';
    if (ws.readyState === WebSocket.OPEN) ws.send("hello");
  };

  ws.onclose = () => {
    scheduleReconnect();
  };

  ws.onmessage = (event) => {
    try {
      const arr = new Uint16Array(event.data);
      if (arr?.length) {
        processData(arr);
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  };
}

/**
 * Schedule a reconnect attempt
 */
function scheduleReconnect() {
  statusEl.textContent = 'Disconnected. Retrying in 2s...';
  statusEl.style.color = '#ef4444';
  reconnectTimeout = window.setTimeout(connect, 2000); // Use window.setTimeout explicit
}

/**
 * Send configuration to ESP32
 */
function setParams() {
  const desiredRate = parseInt(sampleRateSelect.value);
  const hardwareRate = desiredRate < 1000 ? 1000 : desiredRate;

  const payload = {
    sample_rate: hardwareRate,
    bit_width: parseInt(bitWidthSelect.value),
    atten: parseInt(attenSelect.value),
    test_hz: parseInt(testHzSelect.value)
  };

  fetch('/params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(res => {
    if (res.ok) {
      lowRateState.accMin = 4096;
      lowRateState.accMax = 0;
      lowRateState.accSum = 0;
      lowRateState.accCount = 0;

      // Update active config
      activeConfig = { ...payload, desiredRate, trigger: parseInt(triggerLevel.value) || 2048, invert: triggerLevel.invert };

      // Save to localStorage
      localStorage.setItem('esp32_adc_config', JSON.stringify(activeConfig));
    } else {
      alert('Error updating configuration');
    }
  }).catch(err => alert('Network error: ' + err));
}

/**
 * Load configuration from LocalStorage
 */
function loadStoredConfig() {
  const stored = localStorage.getItem('esp32_adc_config');
  if (stored) {
    try {
      const cfg = JSON.parse(stored);
      if (cfg.desiredRate) sampleRateSelect.value = cfg.desiredRate;
      if (cfg.bit_width) bitWidthSelect.value = cfg.bit_width;
      if (cfg.atten !== undefined) attenSelect.value = cfg.atten;
      if (cfg.test_hz) testHzSelect.value = cfg.test_hz;
      if (cfg.invert) triggerLevel.invert = Boolean(cfg.invert);
      if (cfg.trigger) triggerLevel.value = String(cfg.trigger);
      triggerColor();
      setParams();
    } catch (e) {
      console.error("Failed to load config", e);
    }
  }
}

// Config Listeners
if (reconnectBtn) reconnectBtn.addEventListener('click', connect);
[sampleRateSelect, bitWidthSelect, attenSelect, testHzSelect].forEach(input => {
  if (input) input.addEventListener('change', setParams)
});
triggerLevel.addEventListener('change', () => localStorage.setItem('esp32_adc_config', JSON.stringify(activeConfig)));
if (resetBtn) resetBtn.addEventListener('click', () => {
  localStorage.clear();
  window.location.reload();
});
if (powerOffBtn) powerOffBtn.addEventListener('click', () => window.location.href = "/poweroff");

/**
 * Setup WiFi modal listeners
 */
function setupWifiListeners() {
  if (wifiBtn) wifiBtn.onclick = () => {
    wifiModal.style.display = "flex";
    wifiSsidInput.focus();
  };
  if (closeWifiBtn) closeWifiBtn.onclick = () => wifiModal.style.display = "none";
  if (saveWifiBtn) saveWifiBtn.onclick = () => {
    const ssid = wifiSsidInput.value;
    const pass = wifiPassInput.value;

    if (!ssid) {
      alert("SSID is required");
      return;
    }

    saveWifiBtn.innerText = "Saving...";
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
        alert("Error: " + err);
        saveWifiBtn.innerText = "Save";
      });
  };
}


/*
 * ==========================================
 * 8. Initialization
 * ==========================================
 */

/**
 * Resize canvas to fit container
 */
function resize() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

window.addEventListener('resize', resize);

// Startup sequence
resize();
setupWifiListeners();
loadStoredConfig();
connect();
requestAnimationFrame(animationLoop);
