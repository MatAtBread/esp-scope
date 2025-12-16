// Current active configuration for display scaling
let activeConfig = {
  desiredRate: 10000,
  sample_rate: 10000,
  atten: 3, // 11dB Default
  bit_width: 12,
  test_hz: 100,
  trigger: 2048,
  invert: false
};

// Accumulator for virtual low sample rates
let lowRateState = {
  accMin: 4096,
  accMax: 0,
  progress: 0.0,
  targetCount: 1.0
};

// Approximate full-scale voltages for ESP32C6/ESP32 ADC attenuations
// 0dB: ~950mV, 2.5dB: ~1250mV, 6dB: ~1750mV, 11dB: ~3100mV+ (use 3.3V)
const ATTEN_TO_MAX_V = [0.95, 1.25, 1.75, 3.3];

// Data buffer
const countPoints = 4000;
/** @type Array<number> */
let dataBuffer = new Array(countPoints).fill(0);

/** @type HTMLCanvas */ const canvas = document.getElementById('adcChart');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const deltaPanel = document.getElementById('deltaPanel');
const triggerLevel = document.getElementById('triggerLevel');

function triggerColor() {
  activeConfig.trigger = triggerLevel.value;
  const value = (triggerLevel.value - triggerLevel.min) / (triggerLevel.max - triggerLevel.min) * 100;
  triggerLevel.style.background = triggerLevel.invert
    ? `linear-gradient(to bottom, #00000070 0%, #ff020270  ${value}%, #1302ff70 ${value}%, #00000070 100%)`
    : `linear-gradient(to bottom, #00000070 0%, #1302ff70 ${value}%, #ff020270  ${value}%, #00000070  100%)`
}

triggerLevel.addEventListener('input', triggerColor);
triggerLevel.addEventListener('mousedown', function() {
  this.downValue = this.value;
});
triggerLevel.addEventListener('mouseup', function() {
  if (this.downValue == this.value) {
    this.invert = !this.invert;
    activeConfig.invert = this.invert;
    triggerColor();
    this.dispatchEvent(new Event("change"));
  }
  delete this.downValue;
});
triggerColor();

// Resize canvas & data
function resize() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

window.addEventListener('resize', resize);
resize();

let lastMousePosition = { x: null, y: null };

let isFrozen = false; // Track freeze state
canvas.addEventListener('click', () => isFrozen = !isFrozen);

let viewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0
};

// Helper to get total time (width of buffer in ms)
function getTotalTimeMs() {
  const effectiveSampleRate = activeConfig.desiredRate < 1000
    ? activeConfig.desiredRate / lowRateState.targetCount
    : activeConfig.desiredRate;

  const effectivePoints = (activeConfig.desiredRate < 1000)
    ? countPoints / (lowRateState.targetCount * 2)
    : countPoints;

  return (effectivePoints / effectiveSampleRate) * 1000;
}

// Helper to get max voltage
function getMaxVoltage() {
  return ATTEN_TO_MAX_V[activeConfig.atten] || 3.3;
}

// Coordinate Transforms
function XtoTime(px) {
  const totalTime = getTotalTimeMs();
  // px = (t / totalTime * width) * scale + offsetX
  // t = ((px - offsetX) / scale) * (totalTime / width)
  if (canvas.width === 0) return 0;
  return ((px - viewTransform.offsetX) / viewTransform.scale) * (totalTime / canvas.width);
}

function TimeToX(t) {
  const totalTime = getTotalTimeMs();
  if (totalTime === 0) return 0;
  const xp = (t / totalTime) * canvas.width;
  return xp * viewTransform.scale + viewTransform.offsetX;
}

function YtoVolts(py) {
  const maxV = getMaxVoltage();
  // sy = yp * scale + offsetY
  // yp = (sy - offsetY) / scale
  // yp = h * (1 - v/maxV)
  // v = maxV * (1 - yp/h)
  if (canvas.height === 0) return 0;
  const yp = (py - viewTransform.offsetY) / viewTransform.scale;
  return maxV * (1 - yp / canvas.height);
}

function VoltsToY(v) {
  const maxV = getMaxVoltage();
  const yp = canvas.height * (1 - v / maxV);
  return yp * viewTransform.scale + viewTransform.offsetY;
}

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

  draw();
  // Update info if frozen to show correct values under cursor
  if (isFrozen) {
    updateInfo({ offsetX: e.offsetX, offsetY: e.offsetY, pageX: e.pageX, pageY: e.pageY });
  }
});

let referencePosition = null; // Store the reference position for deltas

// Helper function to schedule WebSocket reconnection
function scheduleReconnect() {
  statusEl.textContent = 'Disconnected. Retrying in 2s...';
  statusEl.style.color = '#ef4444';
  reconnectTimeout = setTimeout(connect, 2000);
}

// Helper function to draw crosshairs
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

// Refactor duplicated code to use helper functions
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
    // Delta uses World Coordinates now
    const deltaVoltage = Math.abs(referencePosition.v - voltage);
    const deltaTime = Math.abs(referencePosition.t - timeOffset);

    info += `<div style='color: yellow'>ΔV ${deltaVoltage.toFixed(3)}V, ΔT ${deltaTime.toFixed(2)}ms (${(1000/deltaTime).toFixed(2)} Hz)</div>`;
  }

  deltaPanel.style.left = `${event.pageX + 10}px`;
  deltaPanel.style.top = `${event.pageY + 10}px`;
  deltaPanel.innerHTML = info;

  // Force redraw when frozen
  if (isFrozen) {
    draw();
  }
}
canvas.addEventListener('mousemove', updateInfo);
canvas.addEventListener('mouseenter', () => deltaPanel.style.display = 'block');
canvas.addEventListener('mouseleave', () => deltaPanel.style.display = 'none');

canvas.addEventListener('click', (event) => {
  if (isFrozen) {
    // Set reference position in World Coordinates
    referencePosition = {
      t: XtoTime(event.offsetX),
      v: YtoVolts(event.offsetY)
    };
  }
});

// WebSocket
let ws;
let reconnectTimeout;

function connect() {
  loadStoredConfig();

  clearTimeout(reconnectTimeout);
  const btn = document.getElementById('reconnectBtn');
  if (btn) btn.style.display = 'none';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/signal`;
  // For local testing without ESP hardware, uncomment next line:
  // const wsUrl = 'ws://localhost:8080/signal';

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    statusEl.textContent = 'Connected via WebSocket';
    statusEl.style.color = '#4ade80';
    ws.send("hello");
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

// Animation loop
function animationLoop() {
  if (!isFrozen) {
    draw();
  }
  requestAnimationFrame(animationLoop);
}
// Start the loop
requestAnimationFrame(animationLoop);

function processData(/** @type Uint16Array */newData) {
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
    pushToBuffer(newData);
  } else {
    // Accumulation mode (Peak Detect) with Fractional Resampling
    let pointsToPush = new Uint16Array(newData.length * 2); // Worst case
    let idx = 0;

    // We add 1.0 "samples worth" of progress for each input sample.
    // When progress >= targetCount, we have enough input density to emit an output point.
    // We subtract targetCount (rather than reset to 0) to preserve fractional error (dither/phase).

    for (const val of newData) {
      if (val < lowRateState.accMin) lowRateState.accMin = val;
      if (val > lowRateState.accMax) lowRateState.accMax = val;

      lowRateState.progress += 1.0;

      if (lowRateState.progress >= lowRateState.targetCount) {
        // Push min and max to draw a vertical line
        pointsToPush[idx++] = lowRateState.accMin;
        pointsToPush[idx++] = lowRateState.accMax;

        // Reset Min/Max for next window
        lowRateState.accMin = 4096;
        lowRateState.accMax = 0;

        // Subtract one full window's worth of progress
        lowRateState.progress -= lowRateState.targetCount;
      }
    }
    if (idx > 0) {
      pushToBuffer(pointsToPush.slice(0, idx));
    }
  }
}

function pushToBuffer(/** @type Uint16Array */ newItems) {
  if (newItems.length >= countPoints) {
    dataBuffer = Array.from(newItems.slice(-countPoints));
  } else {
    dataBuffer.splice(0, newItems.length);
    dataBuffer.push(...newItems);
  }
}

// Nice Number Generator
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

function drawGrid(w, h) {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#fff';
  ctx.font = '15px monospace';

  // Determine Visible Voltage Range
  const minV = YtoVolts(h); // Bottom of screen (normally 0 if unzoomed, or higher/lower if zoomed/panned)
  const maxV = YtoVolts(0); // Top of screen

  // Calculate handy ticks in the visible range
  const ticks = calculateNiceTicks(minV, maxV, 12);

  ctx.textAlign = 'left';
  for (let val of ticks) {
    const y = VoltsToY(val);

    // Skip if out of bounds (with a bit of margin)
    if (y < -20 || y > h + 20) continue;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    ctx.fillText(val.toFixed(2) + 'V', 5, y + 3);
  }

  // Determine Visible Time Range
  const minT = XtoTime(0);
  const maxT = XtoTime(w);

  // Create ticks for time
  // Re-use logic or simple logic
  const tTicks = calculateNiceTicks(minT, maxT, 12);

  ctx.textAlign = 'center';
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

    ctx.fillText(timeStr, x, h - 5);
  }
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Draw Background Grid
  drawGrid(w, h);

  // Always draw the last waveform data
  ctx.beginPath();
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 2;

  const maxAdcVal = 4096; // 12-bit fixed scale

  // Trigger values
  let drawIdx = dataBuffer.length - w;
  if (drawIdx < 0)
    drawIdx = 0;
  else {
    const triggerVal = (4096 - (parseInt(triggerLevel.value) || 2048));
    if (triggerLevel.invert) {
      while (drawIdx >= 0) {
        if (dataBuffer[drawIdx] < triggerVal && dataBuffer[drawIdx + 1] > triggerVal) {
          break;
        }
        drawIdx -= 1;
      }

    } else {
      while (drawIdx >= 0) {
        if (dataBuffer[drawIdx] > triggerVal && dataBuffer[drawIdx + 1] < triggerVal) {
          break;
        }
        drawIdx -= 1;
      }
    }
    if (drawIdx < 0) {
      drawIdx = dataBuffer.length - w;
    }
  }
  // NOTE: dataBuffer index 'i' maps to x pixel in initial scale.
  // sx = i * scale + offsetX
  // sy : VoltsToY(val_in_volts) Or simpler:
  // yp = h - (val / maxAdcVal * h)
  // sy = yp * scale + offsetY

  ctx.beginPath();
  // Using loop for continuous line
  // To avoid performance hit with huge offsets, we window the loop
  dataBuffer.slice(drawIdx).forEach((val, i) => {
    // Original X pixel position (before zoom) was just 'i' (because buffer size ~ canvas width)
    // Actually, update buffer size is 'countPoints'.
    // Let's assume 'i' is the initial X coordinate.
    const sx = i * viewTransform.scale + viewTransform.offsetX;

    // Normalized y calculation from original draw
    // val is 0..4096.
    const yp = h - (val / maxAdcVal * h);
    const sy = yp * viewTransform.scale + viewTransform.offsetY;

    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });

  ctx.stroke();

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

function setParams() {
  const desiredRate = parseInt(document.getElementById('sampleRate').value);
  const hardwareRate = desiredRate < 1000 ? 1000 : desiredRate;

  const payload = {
    sample_rate: hardwareRate,
    bit_width: parseInt(document.getElementById('bitWidth').value),
    atten: parseInt(document.getElementById('atten').value),
    test_hz: parseInt(document.getElementById('testHz').value)
  };

  fetch('/params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(res => {
    if (res.ok) {
      lowRateState.accMin = 4096;
      lowRateState.accMax = 0;
      lowRateState.accMax = 0;

      // Update active config
      activeConfig = { ...payload, desiredRate, trigger: parseInt(triggerLevel.value) || 2048 };

      // Save to localStorage
      localStorage.setItem('esp32_adc_config', JSON.stringify(activeConfig));
    } else {
      alert('Error updating configuration');
    }
  }).catch(err => alert('Network error: ' + err));
};

// Load config from localStorage on startup
function loadStoredConfig() {
  const stored = localStorage.getItem('esp32_adc_config');
  if (stored) {
    try {
      const cfg = JSON.parse(stored);
      if (cfg.desiredRate) document.getElementById('sampleRate').value = cfg.desiredRate;
      if (cfg.bit_width) document.getElementById('bitWidth').value = cfg.bit_width;
      if (cfg.atten !== undefined) document.getElementById('atten').value = cfg.atten;
      if (cfg.test_hz) document.getElementById('testHz').value = cfg.test_hz;
      if (cfg.invert) triggerLevel.invert = Boolean(cfg.invert);
      if (cfg.trigger) triggerLevel.value = cfg.trigger;
      triggerColor();
      setParams();
    } catch (e) {
      console.error("Failed to load config", e);
    }
  }
}

document.getElementById('reconnectBtn').addEventListener('click', connect);
document.querySelectorAll('#sampleRate, #bitWidth, #atten, #testHz, #triggerLevel').forEach(input => input.addEventListener('change', setParams));
document.getElementById('resetBtn').addEventListener('click', () => {
  localStorage.clear();
  window.location.reload();
});
document.getElementById('powerOff').addEventListener('click', () => window.location.href = "/poweroff");

function setupWifiListeners() {
  const modal = document.getElementById('wifiModal');
  const btn = document.getElementById('wifiBtn');
  const closeBtn = document.getElementById('closeWifi');
  const saveBtn = document.getElementById('saveWifi');

  if (btn) btn.onclick = () => {
    modal.style.display = "flex";
    document.getElementById('wifiSsid').focus();
  };
  if (closeBtn) closeBtn.onclick = () => modal.style.display = "none";
  if (saveBtn) saveBtn.onclick = () => {
    const ssid = document.getElementById('wifiSsid').value;
    const pass = document.getElementById('wifiPass').value;

    if (!ssid) {
      alert("SSID is required");
      return;
    }

    saveBtn.innerText = "Saving...";
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
        saveBtn.innerText = "Save";
      });
  };
}
setupWifiListeners();
setParams();
connect();
