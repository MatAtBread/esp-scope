const canvas = document.getElementById('adcChart');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const deltaPanel = document.getElementById('deltaPanel');
const infoEl = document.getElementById('info');
const triggerLevel = document.getElementById('triggerLevel');

// Current active configuration for display scaling
let activeConfig = {
  desiredRate: 10000,
  sample_rate: 10000,
  atten: 3, // 11dB Default
  bit_width: 12,
  test_hz: 100,
  trigger: 2048
};

// Accumulator for virtual low sample rates
let lowRateState = {
  accMin: 4096,
  accMax: 0,
  count: 0,
  targetCount: 1
};

// Approximate full-scale voltages for ESP32C6/ESP32 ADC attenuations
// 0dB: ~950mV, 2.5dB: ~1250mV, 6dB: ~1750mV, 11dB: ~3100mV+ (use 3.3V)
const ATTEN_TO_MAX_V = [0.95, 1.25, 1.75, 3.3];

// Resize canvas
function resize() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}
window.addEventListener('resize', resize);
resize();
let lastMousePosition = { x: null, y: null };

let isFrozen = false; // Track freeze state

function toggleFreeze() {
  isFrozen = !isFrozen;
}

canvas.addEventListener('click', toggleFreeze);

let referencePosition = null; // Store the reference position for deltas

// Helper function to calculate voltage
function calculateVoltage(offsetY) {
  const maxV = ATTEN_TO_MAX_V[activeConfig.atten] || 3.3;
  return ((canvas.height - offsetY) / canvas.height * maxV).toFixed(2);
}

// Helper function to calculate effective sample rate
function getEffectiveSampleRate() {
  return activeConfig.desiredRate < 1000
    ? activeConfig.desiredRate / lowRateState.targetCount
    : activeConfig.desiredRate;
}

// Helper function to calculate time offset
function calculateTimeOffset(offsetX, effectiveSampleRate) {
  let effectivePoints = maxPoints;
  if (activeConfig.desiredRate < 1000) {
    effectivePoints = maxPoints / (lowRateState.targetCount * 2);
  }

  const totalTimeMs = (effectivePoints / effectiveSampleRate) * 1000;
  return ((offsetX / canvas.width) * totalTimeMs).toFixed(2);
}

// Helper function to reset lowRateState
function resetLowRateState() {
  lowRateState.accMin = 4096;
  lowRateState.accMax = 0;
  lowRateState.count = 0;
}

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
  const voltage = calculateVoltage(event.offsetY);
  const effectiveSampleRate = getEffectiveSampleRate();
  const timeOffset = calculateTimeOffset(event.offsetX, effectiveSampleRate);
  infoEl.textContent = `Voltage: ${voltage}V, Time: ${timeOffset}ms`;

  // Store the last mouse position
  lastMousePosition.x = event.offsetX;
  lastMousePosition.y = event.offsetY;

  // Update delta panel position and content if frozen
  if (isFrozen && referencePosition) {
    const maxV = ATTEN_TO_MAX_V[activeConfig.atten] || 3.3;
    const deltaVoltage = (referencePosition.voltage - ((canvas.height - lastMousePosition.y) / canvas.height * maxV)).toFixed(2);
    const deltaTime = (referencePosition.time - ((lastMousePosition.x / canvas.width) * maxPoints / effectiveSampleRate * 1000)).toFixed(2);

    deltaPanel.style.left = `${event.pageX + 10}px`;
    deltaPanel.style.top = `${event.pageY + 10}px`;
    deltaPanel.style.display = 'block';
    deltaPanel.innerHTML = `<div>ΔVoltage: ${deltaVoltage}V</div><div>ΔTime: ${deltaTime}ms</div>`;
  } else {
    deltaPanel.style.display = 'none';
  }

  // Force redraw when frozen
  if (isFrozen) {
    draw();
  }
}
canvas.addEventListener('mousemove', updateInfo);

canvas.addEventListener('click', (event) => {
  if (isFrozen) {
    const voltage = calculateVoltage(event.offsetY);
    const effectiveSampleRate = getEffectiveSampleRate();
    const timeOffset = calculateTimeOffset(event.offsetX, effectiveSampleRate);

    // Set reference position for deltas
    referencePosition = {
      x: event.offsetX,
      y: event.offsetY,
      voltage,
      time: timeOffset
    };

    // draw(); // Removed: Animation loop handles this
  }
});

// Data buffer
const maxPoints = 4000;
/** @type Array<number> */
let dataBuffer = new Array(maxPoints).fill(0);

// WebSocket
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
        // draw(); // Removed: Drawing is now handled by animation loop
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
    // Accumulation mode (Peak Detect)
    let pointsToPush = new Uint16Array(newData.length * 2); // Worst case
    let idx = 0;
    for (const val of newData) {
      if (val < lowRateState.accMin) lowRateState.accMin = val;
      if (val > lowRateState.accMax) lowRateState.accMax = val;
      lowRateState.count++;

      if (lowRateState.count >= lowRateState.targetCount) {
        // Push min and max to draw a vertical line
        pointsToPush[idx++] = lowRateState.accMin;
        pointsToPush[idx++] = lowRateState.accMax;

        // Reset
        resetLowRateState();
      }
    }
    if (idx > 0) {
      pushToBuffer(pointsToPush.slice(0, idx));
    }
  }
}

function pushToBuffer(/** @type Uint16Array */ newItems) {
  if (newItems.length >= maxPoints) {
    dataBuffer = Array.from(newItems.slice(-maxPoints));
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

  // Y-Axis: Voltage (Nice Ticks)
  ctx.textAlign = 'left';
  const maxV = ATTEN_TO_MAX_V[activeConfig.atten] || 3.3;

  const ticks = calculateNiceTicks(0, maxV, 6); // Aim for ~6 ticks

  for (let val of ticks) {
    if (val > maxV) continue; // Don't draw above max

    const y = h - (val / maxV * h);

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    // Don't draw label at 0 (overlaps time)
    if (val > 0.01) ctx.fillText(val.toFixed(2) + 'V', 5, y + 3);
  }

  // X-Axis: Time
  // For peak detect mode, we push 2 points per 1 virtual sample.
  // So the buffer effectively holds (maxPoints / 2) * timePerSample
  let effectivePoints = maxPoints;
  const effectiveSampleRate = getEffectiveSampleRate();

  if (activeConfig.desiredRate < 1000) {
    effectivePoints = maxPoints / (lowRateState.targetCount * 2);
  }

  const totalTimeMs = (effectivePoints / effectiveSampleRate) * 1000;
  const xSteps = 5;
  ctx.textAlign = 'center';
  for (let i = 0; i <= xSteps; i++) {
    const x = (i / xSteps * w);
    const tMs = (i / xSteps * totalTimeMs);
    let timeStr;
    if (tMs >= 1000) {
      timeStr = (tMs / 1000).toFixed(2) + 's';
    } else {
      timeStr = tMs.toFixed(1) + 'ms';
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

  const step = w / (maxPoints - 1);
  const maxAdcVal = 4096; // 12-bit fixed scale

  // Trigger values
  let drawData = dataBuffer;
  const triggerVal = parseInt(triggerLevel.value) || 2048;
  for (let i = 0; i < dataBuffer.length; i++) {
    if (dataBuffer[i] < triggerVal && dataBuffer[i + 1] > triggerVal) {
      drawData = dataBuffer.slice(i);
      break;
    }
  }

  drawData.forEach((val, i) => {
    const x = i * step;
    const y = h - (val / maxAdcVal * h);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();

  // Draw Crosshairs if mouse is over the canvas
  if (lastMousePosition.x !== null && lastMousePosition.y !== null) {
    drawCrosshairs(lastMousePosition.x, lastMousePosition.y, '#4ade80');
  }

  // Draw reference crosshairs and deltas if frozen
  if (isFrozen && referencePosition) {
    drawCrosshairs(referencePosition.x, referencePosition.y, '#eab308');
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
  })
    .then(res => {
      if (res.ok) {
        resetLowRateState();

        // Update active config
        activeConfig = { ...payload, desiredRate, trigger: parseInt(triggerLevel.value) || 2048 };

        // Save to localStorage
        localStorage.setItem('esp32_adc_config', JSON.stringify(activeConfig));
      } else {
        alert('Error updating configuration');
      }
    })
    .catch(err => alert('Network error: ' + err));
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
      if (cfg.trigger) document.getElementById('triggerLevel').value = cfg.trigger;
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
document.getElementById('powerOff').addEventListener('click', () => {
  window.location.href = "/poweroff";
});
setParams();
connect();

