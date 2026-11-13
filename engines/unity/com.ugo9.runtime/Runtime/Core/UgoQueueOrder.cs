// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Which render queues each drawing owner (a UgoBatch, or a UgoCharacter drawing itself) gets.
// Every model draws its runs of parts at increasing queues (Unity would otherwise sort same-depth
// transparent draws its own way). If every owner started at the same queue, the runs of two
// owners would interleave (one character's hair between another's body and face). So the owners
// get back-to-back ranges: lower sortingOrder first, then farther from the camera first, then the
// one that came first. No Unity API here (tests run it).
using System;
using System.Collections.Generic;

namespace Ugo9.Core
{
    public static class UgoQueueOrder
    {
        /// <summary>
        /// bases[i] = the first queue (from 0) of owner i, which needs slots[i] queues. Owners past limit
        /// share the last queues (they may interleave again, as before). Returns the queues used.
        /// </summary>
        public static int Assign(int[] orders, float[] distances, int[] slots, int count, int[] bases, int limit)
        {
            var idx = new List<int>(count);
            for (int i = 0; i < count; i++) idx.Add(i);
            idx.Sort((a, b) =>
                orders[a] != orders[b] ? orders[a].CompareTo(orders[b])
                : distances[a] != distances[b] ? distances[b].CompareTo(distances[a]) // farther first
                : a.CompareTo(b));
            int at = 0;
            foreach (int i in idx)
            {
                int need = Math.Max(1, slots[i]);
                bases[i] = Math.Max(0, Math.Min(at, limit - need));
                at += need;
            }
            return Math.Min(at, limit);
        }
    }
}
