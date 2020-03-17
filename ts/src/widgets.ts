import { ChainAnchor, Listener, event, bindEvent } from "./chain";

export interface Widget {
  getDOM(): Element;
  destroy(): void;
}

export class EWidget implements Widget {
  w: Element;
  constructor(w: Element) {
    this.w = w;
  }

  getDOM(): Element {
    return this.w;
  }

  destroy(): void {}
}

class ContainerWidget implements Widget {
  children: Widget[];
  w: Element;
  constructor(tag: string, klass: string, ...children: Widget[]) {
    this.children = children;
    this.w = document.createElement(tag);
    this.w.classList.add(klass);
    for (const child of children) {
      this.w.appendChild(child.getDOM());
    }
  }
  getDOM(): Element {
    return this.w;
  }
  destroy(): void {
    for (const child of this.children) child.destroy();
  }
}

export const wroot = (widget: Widget): void => {
  document.getElementById("root")!.replaceWith(widget.getDOM());
};

enum LabelMode {
  SHORT,
  ICON,
  TEXT,
  ICONTEXT
}

export class WTab implements Widget {
  dom: Element;
  builder: () => Promise<Widget>;
  widget: Widget | null;
  keep: boolean;
  constructor({
    icon = null,
    text,
    labelMode = LabelMode.SHORT,
    keep = false,
    builder
  }: {
    icon?: string | null;
    text: string;
    keep?: boolean;
    labelMode?: LabelMode;
    builder: () => Promise<Widget>;
  }) {
    this.keep = keep;
    const constructIcon = (): Element => {
      const dom0 = document.createElement("img");
      dom0.src = icon!;
      dom0.alt = text;
      return dom0;
    };
    const constructText = (): Element => {
      const dom0 = div();
      dom0.textContent = text;
      return dom0;
    };
    this.dom = div();
    switch (labelMode) {
      case LabelMode.SHORT: {
        if (icon !== null) this.dom.append(constructIcon());
        else this.dom.append(constructText());
        break;
      }
      case LabelMode.ICON: {
        if (icon === null)
          throw new Error("Internal error: missing icon for mode");
        this.dom.append(constructIcon());
        break;
      }
      case LabelMode.TEXT: {
        this.dom.append(constructText());
        break;
      }
      case LabelMode.ICONTEXT: {
        if (icon === null)
          throw new Error("Internal error: missing icon for mode");
        const icon0 = document.createElement("img");
        icon0.src = icon;
        const text0 = div();
        text0.textContent = text;
        this.dom.append(icon0, text0);
        break;
      }
    }
    this.dom.classList.add("w_tab");
    this.builder = builder;
    this.widget = null;
  }

  getDOM(): Element {
    return this.dom;
  }

  async getBodyDOM(): Promise<Element | null> {
    if (this.widget === null) {
      this.widget = await this.builder();
      return this.widget.getDOM();
    } else {
      (this.widget.getDOM() as HTMLElement).style.display = "";
      return null;
    }
  }

  destroyBody(): void {
    if (this.widget !== null) {
      if (this.keep) {
        (this.widget.getDOM() as HTMLElement).style.display = "none";
      } else {
        this.widget.getDOM().remove();
        this.widget.destroy();
        this.widget = null;
      }
    }
  }
  destroy(): void {
    if (this.widget !== null) {
      this.widget.destroy();
    }
  }
}

const isWTab = (v: Widget): v is WTab => {
  return "getBodyDOM" in v;
};

export const wtabs = async ({
  tabs
}: {
  tabs: (Widget | WTab)[];
}): Promise<WTabs> => {
  const out = new WTabs({ tabs: tabs });
  for (const tab of out.tabs) {
    if (!isWTab(tab)) continue;
    await out.select(tab);
    break;
  }
  return out;
};

class WTabs implements Widget {
  div: HTMLDivElement;
  tabs: (WTab | Widget)[];
  selected: WTab | null;
  tabsBody: HTMLDivElement;
  constructor({ tabs }: { tabs: (Widget | WTab)[] }) {
    this.div = vdiv();
    this.div.classList.add("w_tabs");
    const tabsHeader = hdiv();
    tabsHeader.classList.add("w_tabheader");
    this.tabsBody = vdiv();
    this.tabsBody.classList.add("w_tabbody");
    this.div.append(tabsHeader, this.tabsBody);
    this.tabs = tabs;
    let firstTab: WTab | null = null;
    for (const tab of tabs) {
      const dom = tab.getDOM();
      if (isWTab(tab)) {
        if (firstTab === null) firstTab = tab;
        bindEvent(dom, "click", async _ => {
          await this.select(tab);
        });
      }
      tabsHeader.append(dom);
    }
    this.selected = null;
  }
  getDOM(): Element {
    return this.div;
  }
  destroy(): void {
    for (const tab of this.tabs) tab.destroy();
  }
  async select(tab: WTab): Promise<void> {
    if (this.selected === tab) return;
    if (this.selected !== null) {
      this.selected.getDOM().classList.remove("w_selected");
      this.selected.destroyBody();
    }
    this.selected = tab;
    this.selected.getDOM().classList.add("w_selected");
    const bodyDOM = await tab.getBodyDOM(); // Null means already present, hidden
    if (bodyDOM !== null) this.tabsBody.append(bodyDOM);
  }
}

export const div = (...nodes: Element[]): HTMLDivElement => {
  const out = document.createElement("div");
  out.append(...nodes);
  return out;
};

export const hdiv = (...nodes: Element[]): HTMLDivElement => {
  const out = document.createElement("div");
  out.classList.add("w__hdiv");
  out.append(...nodes);
  return out;
};

export const vdiv = (...nodes: Element[]): HTMLDivElement => {
  const out = document.createElement("div");
  out.classList.add("w__vdiv");
  out.append(...nodes);
  return out;
};

export const wvbox = (...nodes: Widget[]): Widget => {
  return new ContainerWidget("div", "w_vbox", ...nodes);
};

export const whbox = (...nodes: Widget[]): Widget => {
  return new ContainerWidget("div", "w_hbox", ...nodes);
};

export class WSlider implements Widget {
  dom: Element;
  bindListener: Listener<number>;
  bind: ChainAnchor<number>;
  constructor({
    icon = null,
    min,
    max,
    step,
    text,
    bind
  }: {
    icon?: string | null;
    min: number;
    max: number;
    step: number;
    text: string;
    bind: ChainAnchor<number>;
  }) {
    const input = document.createElement("input");
    input.type = "range";
    input.min = "" + min;
    input.max = "" + max;
    input.step = "" + step;
    this.bindListener = new (class extends Listener<number> {
      async do(v: number): Promise<void> {
        input.value = "" + v;
      }
    })(text, bind);
    this.bind = bind;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    bindEvent(input, "input", async _ => {
      bind.set(parseFloat(input.value));
    });
    if (icon !== null) {
      const image = document.createElement("img");
      image.src = icon;
      image.alt = text;
      this.dom = hdiv(image, input);
    } else {
      const label = document.createElement("label");
      label.textContent = text;
      this.dom = hdiv(label, input);
    }
    this.dom.classList.add("w_slider");
  }
  getDOM(): Element {
    return this.dom;
  }
  destroy(): void {
    this.bind.dests.delete(this.bindListener);
  }
}

export const wbutton = ({
  icon = null,
  text,
  action
}: {
  icon?: string | null;
  text: string;
  action: () => Promise<void>;
}): Widget => {
  let out: Element;
  if (icon !== null) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = text;
    out = image;
  } else {
    out = div();
    out.textContent = text;
  }
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  bindEvent(out, "click", _ => action());
  out.classList.add("w_button");
  return new EWidget(out);
};

export class WToggleButton implements Widget {
  bindListener: Listener<boolean>;
  dom: HTMLDivElement;
  bind: ChainAnchor<boolean>;
  constructor({
    klass,
    text,
    bind
  }: {
    klass: string;
    text: string;
    bind: ChainAnchor<boolean>;
  }) {
    const text0 = div();
    text0.textContent = text;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.alt = text;
    this.bindListener = new (class extends Listener<boolean> {
      async do(v: boolean): Promise<void> {
        check.checked = v;
      }
    })(klass, bind);
    this.bind = bind;
    bindEvent(check, "change", async _ => {
      bind.set(check.checked);
    });
    this.dom = hdiv(check, text0);
    this.dom.classList.add("w_toggle");
    this.dom.classList.add(klass);
  }

  getDOM(): Element {
    return this.dom;
  }

  destroy(): void {
    this.bind.dests.delete(this.bindListener);
  }
}

export interface DataSource<T> {
  get(start: number, count: number): Promise<T[]>;
}

type ListElement = {
  index: number;
  w: Widget;
};

export const wbindList = async <T>({
  source,
  create
}: {
  source: DataSource<T>;
  create: (e: T) => Widget;
}): Promise<WBindList<T>> => {
  const out = new WBindList({ source: source, create: create });
  await out.update(false);
  return out;
};

class WBindList<T> implements Widget {
  // Show X
  // X before/after offscreen
  // Up to 2X before/after offscreen
  elements: ListElement[];
  div: HTMLDivElement;
  resizeListener: (e: Event) => void;
  createElement: (e: T) => Widget;
  source: DataSource<T>;
  constructor({
    source,
    create
  }: {
    source: DataSource<T>;
    create: (e: T) => Widget;
  }) {
    this.div = div();
    this.div.classList.add("w_list");
    this.div.style.overflowY = "auto";
    this.elements = [];
    this.createElement = create;
    this.source = source;
    window.addEventListener(
      "resize",
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      (this.resizeListener = (_): Promise<void> =>
        event(async () => {
          await this.update(false);
        }))
    );
    bindEvent(this.div, "scroll", async _ => {
      await this.update(false);
    });
  }
  async update(isRetry: boolean): Promise<void> {
    const box = this.div.getBoundingClientRect();
    let firstVisibleIndex = 0;
    let firstVisible: [ListElement, DOMRect] | null = null;
    let lastVisible: [ListElement, DOMRect] | null = null;
    for (const e of this.elements) {
      const ebox = e.w.getDOM().getBoundingClientRect();
      if (ebox.bottom < box.top) continue;
      if (firstVisible === null) {
        firstVisible = [e, ebox];
        firstVisibleIndex = e.index;
      }
      lastVisible = [e, ebox];
      if (ebox.top > box.bottom) break;
    }
    let basecount = 30;
    if (firstVisible !== null) {
      lastVisible = lastVisible!; // firstVisible -> lastVisible
      const usedCount = lastVisible[0].index - firstVisible[0].index;
      const visibleUsed = lastVisible[1].bottom - firstVisible[1].top;
      const visibleAvailable = box.bottom - box.top;
      basecount = Math.ceil(visibleAvailable / (visibleUsed / usedCount));
    }

    const createMultiple = async (
      dstart: number,
      cstart: number,
      count: number
    ): Promise<void> => {
      const newData = await this.source.get(cstart, count);
      const nodes: Element[] = [];
      const elements: ListElement[] = [];
      for (let i = 0; i < newData.length; ++i) {
        const e = newData[i];
        const w = this.createElement(e);
        nodes.push(w.getDOM());
        elements.push({
          index: cstart + i,
          w: w
        });
      }
      if (dstart >= this.elements.length) {
        this.div.append(...nodes);
      } else {
        const ref = this.elements[dstart].w.getDOM();
        for (let i = 0; i < newData.length; ++i) {
          this.div.insertBefore(ref, nodes[i]);
        }
      }
      this.elements.splice(dstart, 0, ...elements);
    };

    const removeMultiple = (dstart: number, count: number): void => {
      for (const e of this.elements.slice(dstart, count)) {
        e.w.getDOM().remove();
        e.w.destroy();
      }
      this.elements.splice(dstart, count);
    };

    if (this.elements.length === 0) {
      await createMultiple(0, 0, basecount * 3);
    } else {
      const firstIndex = this.elements[0].index;
      const lastIndex = this.elements[this.elements.length - 1].index;
      const needBeforeStart = Math.max(0, firstVisibleIndex - basecount);
      const needBefore = firstIndex - needBeforeStart;
      if (needBefore < -basecount) {
        const excess = -needBefore - basecount;
        removeMultiple(0, excess);
      } else if (needBefore > 0) {
        await createMultiple(0, Math.max(0, firstIndex - basecount), basecount);
      }
      const needAfterEnd = firstVisibleIndex + basecount * 2;
      const needAfter = needAfterEnd - lastIndex;
      if (needAfter < -basecount) {
        const excess = -needAfter - basecount;
        removeMultiple(this.elements.length - excess, excess);
      } else if (needAfter > 0) {
        await createMultiple(this.elements.length, lastIndex + 1, basecount);
      }

      if (firstVisible === null && !isRetry) {
        // Figure out real size after rendering first batch
        setTimeout(
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          () =>
            event(async () => {
              await this.update(true);
            }),
          1
        );
      }
    }
  }
  getDOM(): Element {
    return this.div;
  }
  destroy(): void {
    for (const e of this.elements) e.w.destroy();
    window.removeEventListener("resize", this.resizeListener);
  }
}

export class WDetailLevel implements Widget {
  dom: HTMLDetailsElement;
  children: Widget[];
  constructor(title: string, ...children: Widget[]) {
    this.dom = document.createElement("details");
    const summ = document.createElement("summary");
    summ.textContent = title;
    this.dom.append(summ);
    this.dom.append(...children.map(c => c.getDOM()));
    this.children = children;
  }
  getDOM(): Element {
    return this.dom;
  }
  destroy(): void {
    for (const c of this.children) c.destroy();
  }
}
