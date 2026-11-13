// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Deform path (Live2D's "deform path"; an editor tool): a line drawn over a part (points in model space) is
// bent into another line with the same number of points, and the part's vertices near it follow, keeping
// where they sit along the line and how far they are from it. The result is a morph (the format's vertex
// deltas, nothing new), so a parameter or an animation can then play the bend.
//
//   import { pathMorph } from './tools/deform_path.mjs';
//   const morph = pathMorph(part.vertices, from, to, { radius: 60 });   // { vertices: [...], deltas: [...] }
//   deformer.morphs[part.id] = morph;
//
// Each vertex takes its nearest point on `from` (segment i, fraction u along it, signed distance d across
// it); its new place is the same i, u on `to`, d across `to` there. The move fades out with distance from
// the line: full within `inner`, nothing at `radius` and beyond (smoothstep), and past the line's ends.
// Plain ES module.

function nearest(path, x, y) {
  let best = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    u = Math.min(1, Math.max(0, u));
    const px = ax + dx * u, py = ay + dy * u, dist = Math.hypot(x - px, y - py);
    if (!best || dist < best.dist) {
      const len = Math.sqrt(len2) || 1, nx = -dy / len, ny = dx / len; // the left normal
      best = { i, u, dist, across: (x - px) * nx + (y - py) * ny, along: (x - px) * dx / len + (y - py) * dy / len };
    }
  }
  return best;
}

/**
 * vertices [x0, y0, ...], from / to [[x, y], ...] (the same number of points, 2 or more) ->
 * { vertices: [numbers of the vertices that move], deltas: [dx, dy, ...] } (a sparse morph).
 */
export function pathMorph(vertices, from, to, { radius = 50, inner = 0, minMove = 1e-4 } = {}) {
  if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || from.length !== to.length) throw new Error('ugo deform path: from and to must be lines of the same number of points (2 or more)');
  if (!(radius > 0) || !(inner >= 0) || inner >= radius) throw new Error('ugo deform path: need 0 <= inner < radius');
  const out = { vertices: [], deltas: [] };
  for (let v = 0; v < vertices.length / 2; v++) {
    const x = vertices[2 * v], y = vertices[2 * v + 1], n = nearest(from, x, y);
    const far = n.dist; // (past an end of the line this is the distance to that end)
    if (far >= radius) continue;
    const s = far <= inner ? 1 : 1 - (far - inner) / (radius - inner), w = s * s * (3 - 2 * s);
    // the same place on the bent line: along the segment by u, across it by the same distance, past an end by the same amount
    const [ax, ay] = to[n.i], [bx, by] = to[n.i + 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const tx = dx / len, ty = dy / len, nx = -ty, ny = tx;
    // (inside a segment `along` is 0; past an end of the line it is how far past, kept along the bent end)
    const px = ax + dx * n.u, py = ay + dy * n.u;
    const qx = px + tx * n.along + nx * n.across, qy = py + ty * n.along + ny * n.across;
    const mx = (qx - x) * w, my = (qy - y) * w;
    if (Math.hypot(mx, my) < minMove) continue;
    out.vertices.push(v);
    out.deltas.push(mx, my);
  }
  return out;
}
