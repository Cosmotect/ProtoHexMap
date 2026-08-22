// Tiny tween helper: runs a function every frame for "duration" milliseconds
// with a value t going from 0 to 1 (eased). Like Godot's Tween, but 40 lines.

const active = [];

export const Ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
};

export function tween({ duration, onUpdate, onComplete, ease = Ease.outCubic, delay = 0 }) {
  const tw = { duration, onUpdate, onComplete, ease, delay, elapsed: -delay, done: false };
  active.push(tw);
  return tw;
}

export function cancelTween(tw) {
  if (tw) tw.done = true;
}

// Call once per frame with the time since the last frame in milliseconds.
export function updateTweens(deltaMs) {
  for (let i = active.length - 1; i >= 0; i--) {
    const tw = active[i];
    if (tw.done) { active.splice(i, 1); continue; }
    tw.elapsed += deltaMs;
    if (tw.elapsed < 0) continue; // still in delay
    const t = Math.min(1, tw.elapsed / tw.duration);
    tw.onUpdate(tw.ease(t), t);
    if (t >= 1) {
      tw.done = true;
      active.splice(i, 1);
      if (tw.onComplete) tw.onComplete();
    }
  }
}
