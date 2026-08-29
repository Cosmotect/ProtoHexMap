// The scenario registry: every hand-authored map, by id. main.js resolves
// ?scenario=<id> (and, later, the tutorial menu entry) through this table.
import { TUTORIAL_1 } from './tutorial1.js';

export const SCENARIOS = {
  [TUTORIAL_1.id]: TUTORIAL_1,
};

export function scenarioById(id) {
  return SCENARIOS[id] ?? null;
}
