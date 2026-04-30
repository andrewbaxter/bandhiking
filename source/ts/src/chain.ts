import { depthFirst } from "./helper";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isChainSource = (o: any): o is ChainSource<any> => {
  return "dests" in o;
};

export interface ChainSource<O> {
  dests: Set<ChainDest>;
  value(): O;
}

export interface ChainDest {
  comment: string;
  process(): Promise<void>;
}

export interface ChainAnchor<O> extends ChainSource<O> {
  set(value: O): Promise<void>;
}

export class ValueChainAnchor<O> implements ChainSource<O> {
  dests: Set<ChainDest>;
  _value: O;
  constructor(value: O) {
    this._value = value;
    this.dests = new Set();
  }
  value(): O {
    return this._value;
  }
  async set(value: O): Promise<void> {
    this._value = value;
    let earliestIntersection = dirty.length;
    const order: Array<ChainDest> = [];
    await depthFirst(this.dests, async d => {
      const intersection = dirty.indexOf(d);
      if (intersection === -1) {
        order.push(d);
        if (isChainSource(d)) {
          return d.dests[Symbol.iterator]();
        } else {
          return [][Symbol.iterator]();
        }
      } else {
        earliestIntersection = Math.min(earliestIntersection, intersection);
        return [][Symbol.iterator]();
      }
    });
    dirty.splice(earliestIntersection, 0, ...order);
  }
  destroy(): void {
    if (this.dests.size !== 0)
      throw new Error("Can't destroy anchor with remaining listeners!");
  }
}

export class Listener<I> implements ChainDest {
  comment: string;
  source: ChainSource<I>;
  cb: (v: I) => Promise<void>;
  constructor(
    comment: string,
    source: ChainSource<I>,
    cb: (v: I) => Promise<void>
  ) {
    this.cb = cb;
    this.comment = comment;
    this.source = source;
    this.source.dests.add(this);
    dirty.push(this);
  }

  async process(): Promise<void> {
    await this.cb(this.source.value());
  }

  destroy(): void {
    this.source.dests.delete(this);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class IndirectChainAnchor<I extends any[], O>
  implements ChainAnchor<O>, ChainDest {
  dests: Set<ChainDest>;
  sources: { [P in keyof I]: ChainSource<I[P]> };
  current: ChainAnchor<O>;
  comment: string;

  constructor(comment: string, sources: { [P in keyof I]: ChainSource<I[P]> }) {
    this.comment = comment;
    this.sources = sources;
    this.dests = new Set();
    this.current = (null as unknown) as ChainAnchor<O>;
    for (const source of sources) source.dests.add(this);
    dirty.push(this);
  }

  value(): O {
    return this.current.value();
  }

  async process(): Promise<void> {
    this.current = this.do(
      ...(this.sources.map(source => source.value()) as I)
    );
  }

  async set(value: O): Promise<void> {
    await this.current.set(value);
  }

  abstract do(...values: I): ChainAnchor<O>;
}

/*
export abstract class BiChainLink<I, O> implements ChainDest, ChainAnchor<O> {
  source: ChainAnchor<I>;
  dests: Set<ChainDest>;
  current: O;
  constructor(source: ChainAnchor<I>) {
    this.source = source;
    this.source.dests.add(this);
    dirty.push(this);
    this.dests = new Set();
    this.current = (null as unknown) as O;
  }
  set(value: O): void {
    this.source.set(this.up(value));
  }
  process(): void {
    this.current = this.down(this.source.value());
  }
  value(): O {
    return this.current;
  }

  abstract down(v: I): O;
  abstract up(v: O): I;
}
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class ChainLink<I extends any[], O>
  implements ChainDest, ChainSource<O> {
  current: O;
  sources: { [P in keyof I]: ChainSource<I[P]> };
  dests: Set<ChainDest>;
  comment: string;

  constructor(comment: string, sources: { [P in keyof I]: ChainSource<I[P]> }) {
    this.comment = comment;
    this.sources = sources;
    for (const source of this.sources) source.dests.add(this);
    this.dests = new Set();
    this.current = (null as unknown) as O;
    dirty.push(this);
  }

  async process(): Promise<void> {
    this.current = this.do(
      ...(this.sources.map(source => source.value()) as I)
    );
  }

  value(): O {
    return this.current;
  }

  abstract do(...values: I): O;
}

// Algorithm
// Dirty represents the serialization of a walk of the tree that makes sure for link A, A appears in the graph before all dests of A
// New dests/link created -> append to dirty
// Dest linked to source -> insert before any subsequent deps, append if not already there
// Source changed -> walk dest tree, find earliest index of all dep/transitive deps that occur in three, insert linearized tree up to those points together before index
let dirty: Array<ChainDest> = new Array();
const dirty2: Array<ChainDest> = new Array();

export const clean = async (): Promise<void> => {
  const temp = dirty;
  dirty = dirty2;
  for (const leaf of temp) {
    await leaf.process();
  }
  dirty2.splice(0, dirty2.length);
  dirty.splice(0, dirty.length);
};

export const event = async (f: () => Promise<void>): Promise<void> => {
  await f();
  await clean();
};

export const bindEvent = <
  T extends Element,
  K extends keyof HTMLElementEventMap
>(
  e: T,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => Promise<void>
): void => {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e.addEventListener as any)(
    type,
    (ev: HTMLElementEventMap[K]): Promise<void> => event(() => handler(ev))
  );
};
