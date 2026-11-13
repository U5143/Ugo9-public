// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The standard parameter names (docs/パラメータの名前.md, the users' voices #409) and the names the tools used before.
// New parameters get the standard name; a model that has only the old one keeps it (its files are not renamed), and
// whatever reads a parameter by its role finds either.

/** standard name -> the name used before */
export const OLD_NAME = {
  HeadTurnX: 'AngleX', HeadTurnY: 'AngleY', HeadTilt: 'AngleZ',
  BodyTurnX: 'BodyAngleX', BodyTurnY: 'BodyAngleY', BodyTilt: 'BodyAngleZ',
  PupilX: 'EyeBallX', PupilY: 'EyeBallY',
};
/** standard name -> one old name that stood for several standard ones (the brows: one BrowY for both sides) */
export const OLD_GROUP = { BrowHeightL: 'BrowY', BrowHeightR: 'BrowY' };
const STD_OF = Object.fromEntries(Object.entries(OLD_NAME).map(([s, o]) => [o, s]));

/** Both names of a role, the standard one first (a name that is in neither list: itself). */
export const namesOf = (id) => (OLD_NAME[id] ? [id, OLD_NAME[id]] : OLD_GROUP[id] ? [id, OLD_GROUP[id]] : STD_OF[id] ? [STD_OF[id], id] : [id]);
// (an old name standing for several — BrowY — reads as itself: which side is meant is the caller's to say)

/**
 * The name to use for a role in this model: the one it has (standard first), else the standard one (to be made).
 * has: a Set / Map of ids, or the model data ({ parameters }).
 */
export function nameIn(has, id) {
  const set = has instanceof Set || has instanceof Map ? has : new Set((has?.parameters || []).map((p) => p.id));
  const both = namesOf(id);
  return both.find((n) => set.has(n)) ?? both[0];
}

/**
 * The name to give a role in this model, keeping its naming: the name it has (standard first); else, in a model named
 * the old way (an old turn name and no standard one), the old name, so a model is never a mix; else the standard name.
 */
export function nameFor(data, id) {
  const has = new Set((data?.parameters || []).map((p) => p.id)), both = namesOf(id);
  const found = both.find((n) => has.has(n));
  if (found) return found;
  const oldModel = Object.values(OLD_NAME).some((n) => has.has(n)) && !Object.keys(OLD_NAME).some((n) => has.has(n));
  return oldModel && both[1] ? both[1] : both[0];
}

/** A regular expression source matching the face / body turn names, standard and old (for "not a turn" filters). */
export const TURN_RE = '^(Angle|BodyAngle|HeadTurn|HeadTilt|BodyTurn|BodyTilt|Pupil|EyeBall)';
