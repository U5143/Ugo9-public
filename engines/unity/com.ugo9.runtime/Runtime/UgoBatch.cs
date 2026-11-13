// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoBatch: draws every UgoCharacter below it with a few draws per model (one
// per run of blend modes, not one per character). Characters are drawn by
// UgoCharacter.sortingOrder, then (with sortByY) lower ones in front, then in
// hierarchy order. Runs after game scripts' LateUpdate, so values set there
// show in the same frame.
using System.Collections.Generic;
using UnityEngine;

namespace Ugo9
{
    [DefaultExecutionOrder(1000)]
    [ExecuteAlways]
    public sealed class UgoBatch : MonoBehaviour
    {
        readonly List<UgoCharacter> found_ = new List<UgoCharacter>();
        readonly List<UgoDrawer> drawers_ = new List<UgoDrawer>();
        readonly List<List<UgoCharacter>> lists_ = new List<List<UgoCharacter>>();
        readonly List<(int order, float y, int index, UgoCharacter c)> sort_ = new List<(int, float, int, UgoCharacter)>();

        [Tooltip("Characters lower on the screen (smaller y) draw in front of higher ones with the same sortingOrder (top-down games).")]
        public bool sortByY;
        [Tooltip("Between UgoBatches (and characters drawing themselves): a higher order draws in front; equal orders: the nearer to the camera in front.")]
        public int sortingOrder;
        UgoQueues.Owner queue_;

        /// <summary>Draw calls of the last frame.</summary>
        public int DrawCount { get; private set; }
        /// <summary>Characters drawn in the last frame.</summary>
        public int CharacterCount { get; private set; }
        /// <summary>CPU time of the last frame, in milliseconds: running the core for every character
        /// (animation, parameters, physics) and handing the frame blocks to the GPU (upload and draws).</summary>
        public float EvaluateMs { get; private set; }
        public float UploadMs { get; private set; }
        readonly System.Diagnostics.Stopwatch clock_ = new System.Diagnostics.Stopwatch();

        void LateUpdate()
        {
            clock_.Restart();
            GetComponentsInChildren(false, found_); // hierarchy order
            SortForDrawing(found_, sortByY, sort_);
            foreach (var l in lists_) l.Clear();
            // once per frame, not per character: a model whose GPU data was made again needs a new drawer
            for (int d = 0; d < drawers_.Count; d++)
            {
                if (!drawers_[d].Current) { var m = drawers_[d].Model; drawers_[d].Dispose(); drawers_[d] = new UgoDrawer(m); }
            }
            int drawn = 0;
            foreach (var c in found_)
            {
                if (!c.CanDraw) continue;
                int d = 0;
                while (d < drawers_.Count && drawers_[d].Model != c.model) d++;
                if (d == drawers_.Count)
                {
                    drawers_.Add(new UgoDrawer(c.model));
                    lists_.Add(new List<UgoCharacter>());
                    d = drawers_.Count - 1;
                }
                c.Evaluate(c.RelativeTo(transform));
                lists_[d].Add(c);
                drawn++;
            }
            EvaluateMs = (float)clock_.Elapsed.TotalMilliseconds;
            clock_.Restart();
            int draws = 0, queue = UgoQueues.BaseFor(queue_ ??= UgoQueues.Add()), used = 0;
            Vector3 center = transform.position;
            for (int d = 0; d < drawers_.Count;)
            {
                if (lists_[d].Count == 0) // model no longer used here
                {
                    drawers_[d].Dispose();
                    drawers_.RemoveAt(d);
                    lists_.RemoveAt(d);
                    continue;
                }
                // this batch's models one after another, inside this batch's queues
                drawers_[d].QueueBase = queue + used;
                drawers_[d].Draw(lists_[d], transform, gameObject.layer);
                used += drawers_[d].QueuesUsed;
                if (d == 0) center = drawers_[d].Center;
                draws += drawers_[d].DrawCount;
                d++;
            }
            DrawCount = draws;
            CharacterCount = drawn;
            queue_.Order = sortingOrder;
            queue_.Center = center;
            queue_.Slots = used;
            UploadMs = (float)clock_.Elapsed.TotalMilliseconds;
        }

        /// <summary>Puts characters in drawing order: sortingOrder, then (byY) higher y first, then the list's order (stable).</summary>
        internal static void SortForDrawing(List<UgoCharacter> list, bool byY, List<(int order, float y, int index, UgoCharacter c)> scratch)
        {
            bool needed = byY;
            for (int i = 1; i < list.Count && !needed; i++) needed = list[i].sortingOrder != list[0].sortingOrder;
            if (!needed) return;
            scratch.Clear();
            for (int i = 0; i < list.Count; i++) scratch.Add((list[i].sortingOrder, byY ? list[i].transform.position.y : 0, i, list[i]));
            scratch.Sort((a, b) => a.order != b.order ? a.order.CompareTo(b.order) : a.y != b.y ? b.y.CompareTo(a.y) : a.index.CompareTo(b.index));
            for (int i = 0; i < list.Count; i++) list[i] = scratch[i].c;
        }

        void OnDisable()
        {
            UgoQueues.Remove(queue_);
            queue_ = null;
            foreach (var d in drawers_) d.Dispose();
            drawers_.Clear();
            lists_.Clear();
        }
    }
}
