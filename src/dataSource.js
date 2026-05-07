/*
 * DATA SOURCE: Simulated office (Phase 1).
 *
 * The room runs a small first-order transition model:
 *  - Player commands set actuator targets (shade, setpoint, lights).
 *  - Actuators relax toward targets; AC runs by hysteresis around setpoint.
 *  - Indoor T, CO2, lux, humidity evolve from sun + actuators + occupant.
 *  - The occupant has hidden preferences and a patience budget.  When
 *    discomfort is sustained, they stand up and override one actuator.
 *
 * Public API kept stable for main.js:
 *  - getState()                 -> simulation snapshot
 *  - reportOccupantOverride()   -> kept for backwards compat (logs)
 *  - setShadeCmd / setSetpointCmd / setLightsCmd
 *  - getCommands()
 *  - applyOccupantOverride(target) / endOverride()
 */

const WORK_START = 8.0;
const WORK_END   = 18.0;

let _time     = WORK_START;
let _lastTick = performance.now();

// Player-issued commands (the "automation").
// _cmdSetpoint may be a number (°C) or null (thermostat OFF).
let _cmdShade    = 0.05;   // 0 = up, 1 = down
let _cmdSetpoint = 22.0;
let _cmdLights   = true;

// Actuator actual states (lagged from commands).
let _shadePos = 0.05;
let _setpoint = 22.0;
let _lights   = true;
let _acRunning = false;
let _acMode   = 'OFF';      // 'OFF' | 'COOL' | 'HEAT'

// Indoor environmental quality.
let _T   = 22.0;
let _CO2 = 450;
let _hum = 45;

// Hidden occupant preferences — randomized once per session.  Only
// preferences over directly controllable actuators, so the player can
// always reach a fully satisfied state.
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
const _tPref     = pick([null, 20, 22, 24]);   // null = wants thermostat OFF
const _shadePref = pick([0.05, 0.7]);          // open vs closed
const _lightPref = pick([true, false]);        // wants ceiling lights on or off

// Occupant FSM.
let _occState       = 'idle';   // 'idle' | 'annoyed' | 'overriding'
let _patience       = 0;        // seconds of integrated discomfort
let _pendingTarget  = null;     // 'shade' | 'thermostat' | 'lights'
const PATIENCE_THRESHOLD = 6.0; // seconds of strong sustained discomfort

// Cached aux for getState().
let _lux = 400, _pmv = 0, _discomfort = 0, _sunCurve = 0;

function tick() {
  const now = performance.now();
  const dt  = Math.min(0.05, (now - _lastTick) / 1000); // real seconds
  _lastTick = now;

  // Sim-time advances ~3 sim-min per real second; loop within working hours.
  _time += dt * 0.05;
  if (_time >= WORK_END) _time = WORK_START + (_time - WORK_END);

  const angle    = ((_time - 6) / 14) * Math.PI;
  _sunCurve      = Math.max(0, Math.sin(angle));
  // More variance: outside T swings wider over the day, plus a slow ripple
  // from passing clouds so passive load is never perfectly steady.
  const cloud    = 0.8 + 0.2 * Math.sin(_time * 1.3);
  const T_out    = 14 + 12 * _sunCurve;
  const sunOut   = 9000 * _sunCurve * cloud;

  // --- Actuator dynamics ---
  _shadePos += (_cmdShade - _shadePos) * (dt / 2.0);
  _setpoint  = _cmdSetpoint;
  _lights    = _cmdLights;
  // Thermostat off → AC is forced off.  Otherwise bidirectional HVAC drives
  // T toward setpoint, with hysteresis around a 0.4°C deadband.
  if (_setpoint === null) {
    _acRunning = false;
  } else {
    if (Math.abs(_T - _setpoint) > 0.4) _acRunning = true;
    if (Math.abs(_T - _setpoint) < 0.15) _acRunning = false;
  }
  // AC mode reflects what it's doing right now.
  if (!_acRunning || _setpoint === null)      _acMode = 'OFF';
  else if (_T > _setpoint)                    _acMode = 'COOL';
  else                                         _acMode = 'HEAT';

  // --- Thermal model (lumped, target-based, faster response) ---
  const passiveLoad = 7.0 * _sunCurve * (1 - _shadePos * 0.9) + 1.5 + (_lights ? 0.8 : 0);
  const T_passive   = T_out + passiveLoad;
  const T_target    = _acRunning ? _setpoint : T_passive;
  _T += (T_target - _T) * (dt / 4.0);
  _T  = Math.max(14, Math.min(34, _T));

  // --- CO2 (lumped) ---
  const co2Target = 700 + (_shadePos > 0.5 ? 200 : 0);
  _CO2 += (co2Target - _CO2) * (dt / 8.0);

  // --- Humidity ---
  _hum = 45 + 8 * _sunCurve;

  // --- Lux (instantaneous) ---
  _lux = sunOut * (1 - _shadePos * 0.92) * 0.4 + (_lights ? 350 : 0);

  // --- PMV (estimated, neutral 22°C / 50% RH) ---
  _pmv = (_T - 22) / 3 + (_hum - 50) / 200;

  // --- Discomfort (uses hidden preferences over controllable actuators) ---
  // Thermal: based on the *commanded* setpoint, so once the player picks
  // the right value (or OFF) the occupant is satisfied without waiting for
  // T to physically converge.  T still evolves toward setpoint via the AC.
  let cT;
  if (_setpoint === null && _tPref === null)       cT = 0;
  else if (_setpoint === null || _tPref === null)  cT = 0.6;   // wants OFF, got ON, or vice versa
  else                                              cT = Math.max(0, Math.abs(_setpoint - _tPref) - 0.5) * 0.5;
  const cShade = Math.abs(_shadePos - _shadePref) * 0.5;
  const cLight = (_lights !== _lightPref) ? 0.20 : 0;
  _discomfort  = cT + cShade + cLight;

  // --- Occupant FSM ---
  // Annoyance only — overrides are triggered by *wrong player commands*,
  // not by passive accumulation of bad conditions.
  if (_occState !== 'overriding') {
    if (_discomfort > 0.25) {
      _occState = 'annoyed';
      _patience = Math.min(PATIENCE_THRESHOLD, _patience + _discomfort * dt);
    } else {
      if (_occState === 'annoyed' && _discomfort < 0.10) _occState = 'idle';
      _patience = Math.max(0, _patience - dt * 0.4);
    }
  }
}

// True if the new command for this actuator mismatches the occupant's pref.
function isMismatch(target, v) {
  if (target === 'shade')  return Math.abs(v - _shadePref) > 0.3;
  if (target === 'lights') return v !== _lightPref;
  if (target === 'thermostat') {
    if (v === null && _tPref === null)      return false;
    if (v === null || _tPref === null)      return true;
    return Math.abs(v - _tPref) > 0.5;
  }
  return false;
}

// Called from the command setters: if the player picked the wrong value
// for an actuator, the occupant gets up to fix it.  Otherwise nothing
// happens — they stay seated and the patience bar is the only feedback.
function evaluatePlayerCommand(target, v) {
  if (_occState === 'overriding') return;
  if (isMismatch(target, v)) {
    _pendingTarget = target;
    _occState      = 'overriding';
  }
}

export function setShadeCmd(v) {
  _cmdShade = Math.max(0, Math.min(1, v));
  evaluatePlayerCommand('shade', _cmdShade);
}
export function setSetpointCmd(v) {
  _cmdSetpoint = (v === null) ? null : Math.max(16, Math.min(30, v));
  evaluatePlayerCommand('thermostat', _cmdSetpoint);
}
export function setLightsCmd(v) {
  _cmdLights = !!v;
  evaluatePlayerCommand('lights', _cmdLights);
}

export function getCommands() {
  return { shade: _cmdShade, setpoint: _cmdSetpoint, lights: _cmdLights };
}

// Called by main.js at the moment of the "reach" gesture during the override
// animation, so the actuator command snaps to the occupant's hidden preference.
export function applyOccupantOverride(target) {
  if (target === 'shade')           _cmdShade    = _shadePref;
  else if (target === 'thermostat') _cmdSetpoint = _tPref;
  else if (target === 'lights')     _cmdLights   = _lightPref;
}

// Called by main.js when the override animation finishes and occupant is back.
export function endOverride() {
  _occState      = 'idle';
  _pendingTarget = null;
  _patience      = 0;
}

export function getState() {
  tick();
  return {
    timeOfDay: _time,
    shadePosition: _shadePos,
    temperature: _T,
    co2: _CO2,
    illuminance: _lux,
    pmv: _pmv,
    humidity: _hum,
    hvacPower: _acRunning ? Math.abs(_T - _setpoint) * 120 + 200 : 0,
    lightingPower: _lights ? 60 : 0,
    cumulativeEnergy: 0,
    rlActive: true,
    occupantOverride: _occState === 'overriding',

    thermostatSetpoint: _setpoint,    // number or null (OFF)
    thermostatMode: _acMode,          // 'OFF' | 'COOL' | 'HEAT'
    lightingLevel: _lights ? 80 : 0,
    acRunning: _acRunning,
    lightsOn: _lights,

    occupant: {
      state: _occState,
      pendingTarget: _pendingTarget,
      patience01: _patience / PATIENCE_THRESHOLD,
      discomfort: _discomfort,
    },
  };
}

export function reportOccupantOverride(device, value) {
  console.log(`[DataSource] Occupant override: ${device} → ${value}`);
}
