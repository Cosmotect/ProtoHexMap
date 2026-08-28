// ---------------------------------------------------------------------
//  Sound. Nothing is loaded from disk: every blip is synthesised on the
//  spot with the Web Audio API (an oscillator + a volume envelope + a
//  filter), the same idea as a tiny "Beep" node in a game engine.
//
//  Why synthesise instead of shipping a .wav: the fatigue bar plays one
//  blip per step, thousands of times per session. A synthesised tone lets
//  us shift its pitch and volume a hair on every play, so the ear never
//  hears the exact same sample twice and the sound does not turn into a
//  nail in the head. All the knobs live in CONFIG.audio (Settings > General).
//
//  The browser will not let any page make noise before the player has
//  clicked something, so the AudioContext is created lazily on the first
//  real user gesture and simply stays silent until then.
// ---------------------------------------------------------------------

let ctx = null;          // the AudioContext (created on the first gesture)
let master = null;       // one gain node everything goes through (the volume knob)
let cfg = null;          // CONFIG.audio, handed over by main.js

export function initAudio(config) {
  cfg = config.audio;
  // The first click / keypress anywhere unlocks audio for the whole session.
  const unlock = () => { ensureContext(); };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
}

function ensureContext() {
  if (!cfg || cfg.enabled === false) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = cfg.volume;
    master.connect(ctx.destination);
  }
  // Browsers suspend the context until a gesture; resume is a no-op afterwards.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  master.gain.value = cfg.volume;
  return ctx;
}

// A little seeded-ish jitter so no two plays are identical.
function jitter(amount) {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------
//  One soft blip.
//    semitones  how far above the base note (12 = one octave up)
//    gain       0..1 multiplier on top of the master volume
//    when       seconds from now (used to stagger a sequence)
//
//  The shape: a sine (a pure, round tone with no harsh edges), a very
//  short fade-in so it never clicks, an exponential fade-out, and a
//  low-pass filter that shaves off anything bright. That combination is
//  what makes it survive being heard a thousand times.
// ---------------------------------------------------------------------
export function blip({ semitones = 0, gain = 1, when = 0 } = {}) {
  const c = ensureContext();
  if (!c) return;
  const a = cfg;
  const t0 = c.currentTime + when;

  const freq = a.baseFreq * Math.pow(2, semitones / 12) * jitter(a.pitchJitter);
  const level = Math.max(0, Math.min(1, a.blipGain * gain * jitter(a.gainJitter)));
  const attack = a.attackMs / 1000;
  const decay = a.decayMs / 1000;

  const osc = c.createOscillator();
  osc.type = a.wave;                       // 'sine' is the softest; 'triangle' has a touch more body
  osc.frequency.setValueAtTime(freq, t0);
  // A tiny downward glide: makes the blip feel like a soft "tock" rather than a beep.
  osc.frequency.exponentialRampToValueAtTime(freq * a.glide, t0 + decay);

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = freq * a.filterRatio;
  filter.Q.value = 0.5;

  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(level, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

  osc.connect(filter);
  filter.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + decay + 0.05);
}

// The fatigue bar's two sounds. Step index is 0-based.
// Filling: the pitch climbs box by box. Clearing: it falls.
export function playFatigueStep(index, total) {
  if (!cfg) return;
  blip({ semitones: cfg.stepSemitones * index, gain: 1 });
}
export function playFatigueClear(index, total, when) {
  if (!cfg) return;
  // Same ladder, walked back down, and a touch quieter: the reset is a
  // relief, not an event.
  blip({ semitones: cfg.stepSemitones * index - cfg.clearDrop, gain: cfg.clearGain, when });
}
