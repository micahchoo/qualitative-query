/** Retain the best K items. compare(a,b) < 0 means a ranks before b. */
export class TopK<T> {
  private heap: T[] = [];
  constructor(private readonly limit: number, private readonly compare: (a: T, b: T) => number) {}

  add(value: T): void {
    if (this.limit < 1) return;
    if (this.heap.length < this.limit) {
      this.heap.push(value);
      let index = this.heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.compare(this.heap[index], this.heap[parent]) <= 0) break;
        [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
        index = parent;
      }
    } else if (this.compare(value, this.heap[0]) < 0) {
      this.heap[0] = value;
      let index = 0;
      while (index * 2 + 1 < this.heap.length) {
        let worse = index * 2 + 1;
        if (worse + 1 < this.heap.length && this.compare(this.heap[worse + 1], this.heap[worse]) > 0) worse++;
        if (this.compare(this.heap[worse], this.heap[index]) <= 0) break;
        [this.heap[index], this.heap[worse]] = [this.heap[worse], this.heap[index]];
        index = worse;
      }
    }
  }

  /** The current worst retained item, once the heap is full. */
  get cutoff(): T | undefined { return this.heap.length >= this.limit ? this.heap[0] : undefined; }

  sorted(): T[] { return this.heap.sort(this.compare); }
}
