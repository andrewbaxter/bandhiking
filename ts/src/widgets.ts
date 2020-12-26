import { ChainAnchor, Listener, event, bindEvent, ChainSource } from "./chain";

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
  constructor(
    tag: string,
    klass: string | Array<string>,
    ...children: Widget[]
  ) {
    this.children = children;
    this.w = document.createElement(tag);
    if (Array.isArray(klass)) this.w.classList.add(...klass);
    else this.w.classList.add(klass);
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
  document.body.append(widget.getDOM());
};

enum LabelMode {
  SHORT,
  ICON,
  TEXT,
  ICONTEXT,
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
    builder,
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
  tabs,
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
        bindEvent(dom, "click", async (_) => {
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

export const wvboxTag = ({
  tag,
  nodes,
}: {
  tag: string;
  nodes: Widget[];
}): Widget => {
  return new ContainerWidget("div", ["w_vbox", tag], ...nodes);
};

export const whbox = (...nodes: Widget[]): Widget => {
  return new ContainerWidget("div", "w_hbox", ...nodes);
};

export const spacer = (): HTMLDivElement => {
  const out = document.createElement("div");
  out.classList.add("w__space");
  return out;
};

export const wspacer = (): Widget => {
  return new EWidget(spacer());
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
    bind,
  }: {
    icon?: string | null;
    min: number;
    max: number;
    step: number;
    text?: string | null;
    bind: ChainAnchor<number>;
  }) {
    const input = document.createElement("input");
    input.type = "range";
    input.min = "" + min;
    input.max = "" + max;
    input.step = "" + step;
    this.bindListener = new Listener<number>(
      text === null ? "?slider" : text!,
      bind,
      async (v: number): Promise<void> => {
        input.value = "" + v;
      }
    );
    this.bind = bind;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    bindEvent(input, "input", async (_) => {
      await bind.set(parseFloat(input.value));
    });
    if (icon !== null) {
      const image = document.createElement("img");
      image.src = icon;
      if (text !== null) image.alt = text!;
      this.dom = hdiv(image, input);
    } else if (text !== null) {
      const label = document.createElement("label");
      label.textContent = text!;
      this.dom = hdiv(label, input);
    } else {
      this.dom = hdiv(input);
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
  action,
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
  bindEvent(out, "click", (_) => action());
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
    bind,
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
    this.bindListener = new Listener<boolean>(
      klass,
      bind,
      async (v: boolean): Promise<void> => {
        check.checked = v;
      }
    );
    this.bind = bind;
    check.addEventListener("click", (e) => e.stopPropagation());
    bindEvent(check, "change", async (_) => {
      await bind.set(check.checked);
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

export const whbar = (): Widget => {
  const out = div();
  out.classList.add("w__hbar");
  return new EWidget(out);
};

export const wtext = (text: string): Widget => {
  const out = div();
  out.textContent = text;
  out.classList.add("w_text");
  return new EWidget(out);
};

export class WBindText<T> implements Widget {
  dom: HTMLDivElement;
  bind: ChainSource<T>;
  bindListener: Listener<T>;
  constructor(comment: string, text: ChainSource<T>, format: (t: T) => string) {
    this.dom = div();
    this.dom.classList.add("w_text");
    this.bind = text;
    this.bindListener = new Listener<T>(
      comment,
      text,
      async (v: T): Promise<void> => {
        this.dom.textContent = format(v);
      }
    );
  }
  getDOM(): Element {
    return this.dom;
  }
  destroy(): void {
    this.bind.dests.delete(this.bindListener);
  }
}

export const wbindList = async <T>({
  source,
  create,
}: {
  source: DataSource<T>;
  create: (e: T) => Widget;
}): Promise<WBindList<T>> => {
  const out = new WBindList({ source: source, create: create });
  out.update();
  return out;
};

class WBindList<T> implements Widget {
  // Show X
  // X before/after offscreen
  // Up to 2X before/after offscreen
  elements: ListElement[];
  div: HTMLDivElement;
  pendingUpdates: number;
  updatePromise: Promise<any> | null;
  resizeListener: (e: Event) => void;
  createElement: (e: T) => Widget;
  source: DataSource<T>;
  constructor({
    source,
    create,
  }: {
    source: DataSource<T>;
    create: (e: T) => Widget;
  }) {
    this.div = div();
    this.div.classList.add("w_list");
    this.div.style.overflowY = "auto";
    this.pendingUpdates = 0;
    this.updatePromise = null;
    this.elements = [];
    this.createElement = create;
    this.source = source;
    window.addEventListener(
      "resize",
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      (this.resizeListener = (_): Promise<void> =>
        event(async () => {
          this.update();
        }))
    );
    bindEvent(this.div, "scroll", async (_) => {
      this.update();
    });
  }

  async updateInner(): Promise<void> {
    const getAndPrep = async (
      startIndex: number,
      count: number
    ): Promise<[Element[], ListElement[]]> => {
      const newData = await this.source.get(startIndex, count);
      const nodes: Element[] = [];
      const elements: ListElement[] = [];
      for (let i = 0; i < newData.length; ++i) {
        const e = newData[i];
        const w = this.createElement(e);
        nodes.push(w.getDOM());
        elements.push({
          index: startIndex + i,
          w: w,
        });
      }
      return [nodes, elements];
    };

    const removeIndexRange = (startIndex: number, endIndex: number): void => {
      let removed: ListElement[] = [];
      this.elements = this.elements.filter((e) => {
        if (e.index < startIndex || e.index > endIndex) {
          return true;
        } else {
          removed.push(e);
          return false;
        }
      });
      for (const e of removed) {
        e.w.getDOM().remove();
        e.w.destroy();
      }
    };

    if (this.elements.length === 0) {
      const [nodes, elements] = await getAndPrep(0, 60);
      this.div.append(...nodes);
      this.elements.push(...elements);
      // Redo in a second after things are properly layed out
      setTimeout(
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        () =>
          event(async () => {
            await this.update();
          }),
        1
      );
    } else {
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
      firstVisible = firstVisible!;
      lastVisible = lastVisible!;
      const usedCount = lastVisible[0].index - firstVisible[0].index;
      const visibleUsed = lastVisible[1].bottom - firstVisible[1].top;
      const visibleAvailable = box.bottom - box.top;
      const screenworth = Math.ceil(
        visibleAvailable / (visibleUsed / usedCount)
      );
      const removeThreshold = screenworth * 2;
      const firstIndex = this.elements[0].index;
      const lastIndex = this.elements[this.elements.length - 1].index;

      const needEnd = firstVisibleIndex + screenworth * 2;
      const needEndMissing = needEnd - lastIndex;
      if (-needEndMissing > removeThreshold) {
        removeIndexRange(needEnd + removeThreshold, lastIndex);
      } else if (needEndMissing > 0) {
        const [nodes, elements] = await getAndPrep(lastIndex + 1, screenworth);
        this.div.append(...nodes);
        this.elements.splice(this.elements.length, 0, ...elements);
      }

      /*
      // Removed: Messes with scrolling, need some workaround
      const needStart = Math.max(0, firstVisibleIndex - screenworth * 0.5);
      const needStartMissing = firstIndex - needStart;
      if (-needStartMissing > removeThreshold) {
        removeIndexRange(0, needStart - removeThreshold);
      } else if (needStartMissing > 0) {
        const cstart = Math.max(0, firstIndex - screenworth);
        const [nodes, elements] = await getAndPrep(cstart, firstIndex - cstart);
        const ref = this.div.childNodes.item(0);
        for (let x of nodes) {
          this.div.insertBefore(x, ref);
        }
        this.elements.splice(0, 0, ...elements);
      }
      */
    }
    this.pendingUpdates -= 1;
    if (this.pendingUpdates == 0) {
      this.updatePromise = null;
    }
  }

  update() {
    if (this.pendingUpdates == 0) {
      this.updatePromise = this.updateInner();
    } else {
      this.updatePromise = this.updatePromise!.then((_) => this.updateInner());
    }
    this.pendingUpdates += 1;
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
  children: Widget[];
  childrenGenerator: () => Widget[];
  openBind: ChainAnchor<boolean> | null;
  openListener: Listener<boolean> | null;
  dom: HTMLDivElement;
  sumDOM: Element;
  summ: Widget;
  constructor({
    open,
    summ,
    childrenGenerator,
  }: {
    open: ChainAnchor<boolean>;
    summ: Widget;
    childrenGenerator: () => Widget[];
  }) {
    this.dom = div();
    this.dom.classList.add("w_details");
    this.summ = summ;
    this.sumDOM = summ.getDOM();
    const expand = div();
    expand.classList.add("w_expand");
    this.sumDOM.insertBefore(expand, this.sumDOM.firstChild);
    this.sumDOM.classList.add("w_detailssummary");
    this.children = [];
    this.childrenGenerator = childrenGenerator;
    this.openBind = open;
    this.openListener = new Listener<boolean>(
      "settingdetails;open",
      open,
      async (v: boolean): Promise<void> => {
        this.update(v);
      }
    );
    bindEvent(this.sumDOM, "click", async (_) => {
      await open.set(!open.value());
    });
    this.update(open.value());
  }

  update(openState: boolean) {
    if (openState) {
      this.dom.append(this.sumDOM);
      this.children = this.childrenGenerator();
      this.dom.append(...this.children.map((c) => c.getDOM()));
    } else {
      this.dom.innerHTML = "";
      this.dom.append(this.sumDOM);
      this.children = [];
    }
    this.dom.setAttribute("open", "" + openState);
  }

  getDOM(): Element {
    return this.dom;
  }
  destroy(): void {
    this.summ.destroy();
    for (const c of this.children) c.destroy();
    if (this.openListener !== null) {
      (this.openBind as ChainAnchor<boolean>).dests.delete(this.openListener);
    }
  }
}
