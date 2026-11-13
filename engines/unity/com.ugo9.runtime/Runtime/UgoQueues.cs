// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The render queue ranges of every drawing owner (UgoBatch, a UgoCharacter drawing itself), once a
// frame (UgoQueueOrder): owners draw one after another instead of interleaving their runs of parts.
// An owner reports how many queues its drawers used, and where it is (for the distance to the
// camera), in the frame before.
using System.Collections.Generic;
using UnityEngine;
using Ugo9.Core;

namespace Ugo9
{
    internal static class UgoQueues
    {
        internal sealed class Owner
        {
            public int Order;
            public Vector3 Center;
            public int Slots = 1;
            internal int Base;
        }

        // the queues from Transparent (3000) up to below Overlay (4000)
        const int Limit = 1000;
        static readonly List<Owner> owners_ = new List<Owner>();
        static int frame_ = -1;
        static int[] orders_ = new int[0], slots_ = new int[0], bases_ = new int[0];
        static float[] dist_ = new float[0];

        public static Owner Add() { var o = new Owner(); owners_.Add(o); frame_ = -1; return o; }
        public static void Remove(Owner o) { if (o != null && owners_.Remove(o)) frame_ = -1; }

        /// <summary>This owner's first queue (from 0) this frame.</summary>
        public static int BaseFor(Owner o)
        {
            if (frame_ != Time.frameCount) Assign();
            return o.Base;
        }

        static void Assign()
        {
            frame_ = Time.frameCount;
            int n = owners_.Count;
            if (orders_.Length < n) { orders_ = new int[n]; slots_ = new int[n]; bases_ = new int[n]; dist_ = new float[n]; }
            var cam = Camera.main;
            for (int i = 0; i < n; i++)
            {
                var o = owners_[i];
                orders_[i] = o.Order;
                slots_[i] = o.Slots;
                dist_[i] = cam != null ? Vector3.Dot(o.Center - cam.transform.position, cam.transform.forward) : 0;
            }
            UgoQueueOrder.Assign(orders_, dist_, slots_, n, bases_, Limit);
            for (int i = 0; i < n; i++) owners_[i].Base = bases_[i];
        }
    }
}
