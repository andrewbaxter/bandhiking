import { ChainAnchor, Listener, event, ChainSource } from "./chain";

export interface Widget {
  getDOM(): Element;
  destroy(): void;
}

class EWidget implements Widget {
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
    for (let child of this.children) child.destroy();
  }
}

export const wroot = (widget: Widget) => {
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
  builder: () => Widget;
  widget: Widget | null;
  constructor({
    icon = null,
    text,
    labelMode = LabelMode.SHORT,
    builder
  }: {
    icon?: string | null;
    text: string;
    labelMode?: LabelMode;
    builder: () => Widget;
  }) {
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
    switch (labelMode) {
      case LabelMode.SHORT: {
        if (icon !== null) this.dom = constructIcon();
        else this.dom = constructText();
        break;
      }
      case LabelMode.ICON: {
        if (icon === null)
          throw new Error("Internal error: missing icon for mode");
        this.dom = constructIcon();
        break;
      }
      case LabelMode.TEXT: {
        this.dom = constructText();
        break;
      }
      case LabelMode.ICONTEXT: {
        if (icon === null)
          throw new Error("Internal error: missing icon for mode");
        const icon0 = document.createElement("img");
        icon0.src = icon;
        const text0 = div();
        text0.textContent = text;
        const dom0 = hdiv();
        dom0.append(icon0, text0);
        this.dom = dom0;
        break;
      }
    }
    this.dom.classList.add("w.tab");
    this.builder = builder;
    this.widget = null;
  }
  getDOM(): Element {
    return this.dom;
  }
  getBodyDOM(): Element {
    if (this.widget === null) {
      this.widget = this.builder();
    }
    return this.widget.getDOM();
  }

  destroyBody(): void {
    if (this.widget !== null) {
      this.widget.getDOM().remove();
      this.widget.destroy();
      this.widget = null;
    }
  }
  destroy(): void {
    if (this.widget !== null) {
      this.widget.destroy();
    }
  }
}

const isWTab = (v: any): v is WTab => {
  return "getBodyDOM" in v;
};

export class WTabs implements Widget {
  div: HTMLDivElement;
  tabs: (WTab | Widget)[];
  selected: WTab | null;
  constructor({ tabs }: { tabs: (Widget | WTab)[] }) {
    this.div = vdiv();
    this.div.classList.add("w_tabs");
    const tabsHeader = hdiv();
    const tabsBody = vdiv();
    this.div.append(tabsHeader, tabsBody);
    this.tabs = tabs;
    const select = async (tab: WTab): Promise<void> => {
      if (this.selected === tab) return;
      if (this.selected !== null) {
        this.selected.destroyBody();
      }
      this.selected = tab;
      tabsBody.append(tab.getBodyDOM());
    };
    let firstTab: WTab | null = null;
    for (const tab of tabs) {
      const dom = tab.getDOM();
      if (isWTab(tab)) {
        if (firstTab === null) firstTab = tab;
        dom.addEventListener("click", e =>
          event(async () => {
            await select(tab);
          })
        );
      }
      tabsHeader.append(dom);
    }
    this.selected = null;
    if (firstTab !== null) select(firstTab);
  }
  getDOM(): Element {
    return this.div;
  }
  destroy(): void {
    for (const tab of this.tabs) tab.destroy();
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

export const wvbox = (...nodes: Widget[]) => {
  return new ContainerWidget("div", "w_vbox", ...nodes);
};

export const whbox = (...nodes: Widget[]) => {
  return new ContainerWidget("div", "w_hbox", ...nodes);
};

export const wslider = ({
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
}): Widget => {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "" + min;
  input.max = "" + max;
  input.step = "" + step;
  new (class extends Listener<number> {
    async do(v: number) {
      input.value = "" + v;
    }
  })(bind);
  input.addEventListener("input", e =>
    event(async () => {
      await bind.set(parseFloat(input.value));
    })
  );
  let out: Element;
  if (icon !== null) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = text;
    out = hdiv(image, input);
  } else {
    const label = document.createElement("label");
    label.textContent = text;
    out = hdiv(label, input);
  }
  out.classList.add("w_slider");
  return new EWidget(out);
};

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
  out.addEventListener("click", e => {
    event(action);
  });
  out.classList.add("w_button");
  return new EWidget(out);
};

export const wtoggleButton = ({
  klass,
  text,
  bind
}: {
  klass: string;
  text: string;
  bind: ChainAnchor<boolean>;
}): Widget => {
  const text0 = div();
  text0.textContent = text;
  const check = document.createElement("input");
  check.type = "check";
  check.alt = text;
  new (class extends Listener<boolean> {
    async do(v: boolean) {
      check.checked = v;
    }
  })(bind);
  check.addEventListener("toggle", e =>
    event(async () => {
      await bind.set(check.checked);
    })
  );
  const out = hdiv(check, text0);
  out.classList.add("w_toggle");
  out.classList.add(klass);
  return new EWidget(out);
};

export interface DataSource<T> {
  get(start: number, count: number): Promise<T[]>;
}

export class DataSource<T> {
  constructor(source: string) {}
}

type ListElement = {
  index: number;
  w: Widget;
};

export class WBindList<T> implements Widget {
  // Show X
  // X before/after offscreen
  // Up to 2X before/after offscreen
  elements: ListElement[];
  div: HTMLDivElement;
  resizeListener: (e: any) => void;
  constructor({
    source,
    create
  }: {
    source: DataSource<T>;
    create: (e: T) => Widget;
  }) {
    this.div = div();
    this.div.classList.add("w_list");
    this.div.style.overflowY = "scroll";
    this.elements = [];
    const update = async (isRetry: boolean) => {
      const box = this.div.getBoundingClientRect();
      let firstVisibleIndex = 0;
      let firstVisible: [ListElement, DOMRect] | null = null;
      let lastVisible: [ListElement, DOMRect] | null = null;
      for (const e of this.elements) {
        const ebox = e.w.getDOM().getBoundingClientRect();
        if (ebox.bottom < box.top) continue;
        if (firstVisible == null) {
          firstVisible = [e, ebox];
          firstVisibleIndex = e.index;
        }
        lastVisible = [e, ebox];
        if (ebox.top > box.bottom) break;
      }
      let basecount = 30;
      if (firstVisible != null) {
        lastVisible = lastVisible!; // firstVisible -> lastVisible
        const usedCount = lastVisible[0].index - firstVisible[0].index;
        const visibleUsed = lastVisible[1].bottom - firstVisible[1].top;
        const visibleAvailable = box.bottom - box.top;
        basecount = Math.ceil(visibleAvailable / (visibleUsed / usedCount));
      } else if (!isRetry) {
        setTimeout(
          () =>
            event(async () => {
              await update(true);
            }),
          1
        );
      }

      const createMultiple = async (
        dstart: number,
        cstart: number,
        count: number
      ): Promise<void> => {
        const newData = await source.get(cstart, count);
        const nodes: Element[] = [];
        const elements: ListElement[] = [];
        for (let i = 0; i < newData.length; ++i) {
          const e = newData[i];
          const w = create(e);
          nodes.push(w.getDOM());
          elements.push({
            index: cstart + i,
            w: w
          });
        }
        if (dstart >= this.elements.length - 1) {
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

      const firstIndex = this.elements.length == 0 ? 0 : this.elements[0].index;
      const lastIndex =
        this.elements.length == 0
          ? 0
          : this.elements[this.elements.length - 1].index;
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
    };
    window.addEventListener(
      "resize",
      (this.resizeListener = e =>
        event(async () => {
          await update(false);
        }))
    );
    this.div.addEventListener("scroll", e =>
      event(async () => {
        await update(false);
      })
    );
    update(false);
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
