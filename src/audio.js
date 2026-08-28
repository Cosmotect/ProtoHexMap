// ---------------------------------------------------------------------
//  Sound. Nothing is loaded from disk: every blip is synthesised on the
//  spot with the Web Audio API (an oscillator + a volume envelope + a
//  filter), the same idea as a tiny "Beep" node in a game engine.
//
//  Why synthesise instead of shipping a .wav: the fatigue bar plays one
//  blip per step, thousands of times per session. A synthesised tone lets
//  us shift its pitch and volume a hair on every play, so the ear never
//  hears the exact same sample twice and the sound does not turn into a
//  nail in the head.
//
//  Only ONE thing is a setting: the volume (Settings > Audio). Everything
//  that shapes the tone is fixed below - those are voicing decisions, not
//  knobs a designer needs during a tuning session. Change them here.
//
//  The browser will not let any page make noise before the player has
//  clicked something, so the AudioContext is created lazily on the first
//  real user gesture and simply stays silent until then.
// ---------------------------------------------------------------------

// ----- the voice of the fatigue blip ---------------------------------
// Muted and woody, like a soft mallet on felt rather than a plucked string.
// The two numbers that matter most: ATTACK_MS (a slow onset is what removes
// the "pluck") and FILTER_RATIO (how much of the brightness is shaved off).
const VOICE = {
  wave: 'sine',        // the roundest waveform there is
  baseFreq: 262,       // pitch of the FIRST box, Hz (262 = C4, an octave under the old one)
  stepSemitones: 1.5,  // each following box sounds this much higher
  gain: 0.55,          // loudness of one blip before the master volume
  attackMs: 26,        // slow fade-in: no click, no pluck, just a swell
  holdMs: 30,          // a moment at full level before it starts to fade
  decayMs: 300,        // long, soft fade-out
  filterRatio: 1.7,    // low-pass cutoff as a multiple of the pitch (low = dull)
  filterFall: 0.55,    // the cutoff drops to this fraction while fading: the tone darkens
  pitchJitter: 0.012,  // +-1.2% random pitch per play, so repeats never sound identical
  gainJitter: 0.09,    // +-9% random volume per play
};
// The reset sweep: the ladder walked back down, lower and quieter.
const CLEAR = { staggerMs: 55, drop: 3, gain: 0.5 };

let ctx = null;          // the AudioContext (created on the first gesture)
let master = null;       // one gain node everything goes through (the volume knob)
let cfg = null;          // CONFIG.audio - just { volume }

export function initAudio(config) {
  cfg = config.audio;
  // The first click / keypress anywhere unlocks audio for the whole session.
  const unlock = () => { ensureContext(); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function ensureContext() {
  if (!cfg || !(cfg.volume > 0)) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  // Browsers suspend the context until a gesture; resume is a no-op afterwards.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  master.gain.value = cfg.volume;
  return ctx;
}

// A little jitter so no two plays are identical.
function jitter(amount) {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------
//  One soft blip.
//    semitones  how far above the base note (12 = one octave up)
//    gain       0..1 multiplier on top of the master volume
//    when       seconds from now (used to stagger a sequence)
// ---------------------------------------------------------------------
export function blip({ semitones = 0, gain = 1, when = 0 } = {}) {
  const c = ensureContext();
  if (!c) return;
  const v = VOICE;
  const t0 = c.currentTime + when;

  const freq = v.baseFreq * Math.pow(2, semitones / 12) * jitter(v.pitchJitter);
  const level = Math.max(0, Math.min(1, v.gain * gain * jitter(v.gainJitter)));
  const attack = v.attackMs / 1000;
  const hold = v.holdMs / 1000;
  const decay = v.decayMs / 1000;

  const osc = c.createOscillator();
  osc.type = v.wave;
  osc.frequency.setValueAtTime(freq, t0);

  // The low-pass both dulls the tone and closes further as the note fades,
  // which is what a real damped sound does and why this reads as "muted".
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.4;
  const cutoff = freq * v.filterRatio;
  filter.frequency.setValueAtTime(cutoff, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * v.filterFall), t0 + attack + hold + decay);

  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(level, t0 + attack);
  env.gain.setValueAtTime(level, t0 + attack + hold);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);

  osc.connect(filter);
  filter.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + hold + decay + 0.05);
}

// The fatigue bar's two sounds. Step index is 0-based.
// Filling: the pitch climbs box by box. Clearing: it falls.
export function playFatigueStep(index) {
  blip({ semitones: VOICE.stepSemitones * index });
}
export function playFatigueClear(index, total, when) {
  // Same ladder, walked back down, and a touch quieter: the reset is a
  // relief, not an event.
  blip({ semitones: VOICE.stepSemitones * index - CLEAR.drop, gain: CLEAR.gain, when });
}

// How long the reset sweep waits between boxes (ui.js drives the visuals).
export const clearStaggerMs = CLEAR.staggerMs;
