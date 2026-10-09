/**
 * Binary min-heap of (key, value) pairs in typed arrays: the one open list
 * for every A* in the engine (astar.ts, gridastar.ts, corridor.ts fineTrace).
 * Ordering: a pushed key stops under an equal parent, pop prefers the left
 * child and moves down only past strictly smaller keys, so the three
 * searches it replaced explore in exactly the order they did.
 */
export class MinHeap {
  private k: Float64Array;
  private v: Float64Array;
  size = 0;

  constructor(capacity = 1 << 14) {
    this.k = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
  }

  push(key: number, val: number): void {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.k.length * 2);
      k2.set(this.k);
      this.k = k2;
      const v2 = new Float64Array(this.v.length * 2);
      v2.set(this.v);
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }

  /** The smallest key (the heap must not be empty). */
  peekKey(): number {
    return this.k[0];
  }

  /** The value with the smallest key (the heap must not be empty). */
  pop(): number {
    const top = this.v[0];
    const lastK = this.k[--this.size];
    const lastV = this.v[this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const m = r < this.size && this.k[r] < this.k[l] ? r : l;
      if (this.k[m] >= lastK) break;
      this.k[i] = this.k[m];
      this.v[i] = this.v[m];
      i = m;
    }
    this.k[i] = lastK;
    this.v[i] = lastV;
    return top;
  }
}
