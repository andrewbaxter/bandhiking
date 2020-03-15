import { depthFirst } from "./helper";

const isChainSource = (o: any): o is ChainSource<any> => {
  return "dests" in o && "set" in o;
};

export interface ChainSource<O> {
  dests: Set<ChainDest>;
  value(): O;
}

export interface ChainDest {
  process(): void;
}

export interface ChainAnchor<O> extends ChainSource<O> {
  set(value: O): void;
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
  set(value: O) {
    this._value = value;
    let earliestIntersection = -1;
    let order: Array<ChainDest> = [];
    depthFirst(this.dests, async d => {
      let intersection = dirty.indexOf(d);
      if (intersection === -1) {
        order.push(d);
        if (isChainSource(d)) {
          return d.dests[Symbol.iterator]();
        } else {
          return [][Symbol.iterator]();
        }
      } else {
        if (earliestIntersection === null) earliestIntersection = intersection;
        else
          earliestIntersection = Math.min(earliestIntersection, intersection);
        return [][Symbol.iterator]();
      }
    });
    if (earliestIntersection === -1) {
      earliestIntersection = dirty.length;
    }
    dirty.splice(earliestIntersection, 0, ...order);
  }
  destroy() {
    if (this.dests.size !== 0)
      throw new Error("Can't destroy anchor with remaining listeners!");
  }
}

export abstract class Listener<I> implements ChainDest {
  source: ChainSource<I>;
  constructor(source: ChainSource<I>) {
    this.source = source;
    this.source.dests.add(this);
    dirty.push(this);
  }

  process() {
    this.do(this.source.value());
  }

  abstract do(v: I): Promise<void>;

  destroy() {
    this.source.dests.delete(this);
  }
}

export abstract class IndirectChainAnchor<I extends any[], O>
  implements ChainAnchor<O>, ChainDest {
  dests: Set<ChainDest>;
  sources: { [P in keyof I]: ChainSource<I[P]> };
  current: ChainAnchor<O>;

  constructor(sources: { [P in keyof I]: ChainSource<I[P]> }) {
    this.sources = sources;
    this.dests = new Set();
    this.current = (null as unknown) as ChainAnchor<O>;
    for (const source of sources) source.dests.add(this);
    dirty.push(this);
  }

  value(): O {
    return this.current.value();
  }
  process() {
    this.current = this.do(
      ...(this.sources.map(source => source.value()) as I)
    );
  }
  set(value: O) {
    this.current.set(value);
  }

  abstract do(...values: I): ChainAnchor<O>;
}

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

export abstract class ChainLink<I extends any[], O>
  implements ChainDest, ChainSource<O> {
  current: O;
  sources: { [P in keyof I]: ChainSource<I[P]> };
  dests: Set<ChainDest>;

  constructor(sources: { [P in keyof I]: ChainSource<I[P]> }) {
    this.sources = sources;
    this.dests = new Set();
    this.current = (null as unknown) as O;
  }

  process(): void {
    this.current = this.do(
      ...(this.sources.map(source => source.value()) as I)
    );
  }

  value(): O {
    return this.current;
  }

  abstract do(...values: I): O;
}

let dirty: Array<ChainDest> = new Array();
let dirty2: Array<ChainDest> = new Array();

export const clean = () => {
  let temp = dirty;
  dirty = dirty2;
  for (const leaf of temp) {
    leaf.process();
  }
  dirty2.splice(0, dirty2.length);
  dirty.splice(0, dirty.length);
};

export const event = async (f: () => Promise<void>) => {
  await f();
  clean();
};
