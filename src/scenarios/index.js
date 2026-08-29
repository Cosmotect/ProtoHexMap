// The scenario registry: every hand-authored map, by id. main.js resolves
// ?scenario=<id> (and the tutorial menu entry) through this table.
import { TUTORIAL_1 } from './tutorial1.js';
import { TUTORIAL_2 } from './tutorial2.js';
import { TUTORIAL_3 } from './tutorial3.js';

export const SCENARIOS = {
  [TUTORIAL_1.id]: TUTORIAL_1,
  [TUTORIAL_2.id]: TUTORIAL_2,
  [TUTORIAL_3.id]: TUTORIAL_3,
};

export function scenarioById(id) {
  return SCENARIOS[id] ?? null;
}
