// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The sample's parameter names, whichever it has (利用者の声 #409): the tests written with the older names (AngleX ...)
// ask sp('AngleX') and get the standard name (HeadTurnX) once samples/basic uses it, so they pass before and after.
import fs from 'node:fs';

const OLD_TO_STD = { AngleX: 'HeadTurnX', AngleY: 'HeadTurnY', AngleZ: 'HeadTilt', BodyAngleX: 'BodyTurnX', EyeBallX: 'PupilX', EyeBallY: 'PupilY', HairSway: 'HairSideSway' };
const have = new Set(JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8')).parameters.map((p) => p.id));

/** The name the sample has for a parameter given by its older name. */
export const sp = (old) => (!have.has(old) && OLD_TO_STD[old] && have.has(OLD_TO_STD[old]) ? OLD_TO_STD[old] : old);
