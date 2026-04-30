import { depthFirst } from "./helper";
import {
  ValueChainAnchor,
  ChainAnchor,
  ChainSource,
  Listener,
  event,
  clean as chainClean,
  IndirectChainAnchor,
  ChainLink,
  bindEvent,
  ChainDest,
} from "./chain";
import { openDB, DBSchema } from "idb";
import {
  wbutton,
  whbox,
  wvbox,
  WTab,
  wroot,
  WSlider,
  WToggleButton,
  Widget,
  DataSource,
  hdiv,
  vdiv,
  WDetailLevel,
  EWidget,
  wbindList,
  wtabs,
  WBindText,
  wspacer,
  spacer,
  wtext,
  whbar,
  wvboxTag,
} from "./widgets";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async (): Promise<void> => {
  type Track = {
    id: number;
    url_hints_subdomain: string;
    url_hints_slug: string;
    primary_text: string;
    secondary_text: string;
    type: string;
    art_id: string;
    featured_track_id: string;
    location: string;
    playedAt?: Date;
    star: boolean;
  };

  const dbName = "tracks";
  const dbVersion = 1;

  interface MyDB extends DBSchema {
    tracks: {
      key: number;
      value: Track;
      indexes: {
        played: Date;
      };
    };
  }

  const db = await openDB<MyDB>(dbName, dbVersion, {
    upgrade(db, _oldVersion, _newVersion, _transaction) {
      const objectStore = db.createObjectStore(dbName, { keyPath: "id" });
      objectStore.createIndex("played", "playedAt", {
        unique: true /* effectively */,
      });
    },
    blocked() {},
    blocking() {},
    terminated() {},
  });

  const trackUrl = (track: Track): string => {
    return `https://${track.url_hints_subdomain}.bandcamp.com/album/${track.url_hints_slug}`;
  };

  const trackArtist = (track: Track): string => {
    return track.secondary_text;
  };

  const trackName = (track: Track): string => {
    return track.primary_text;
  };

  const trackArtUrl = (track: Track): string => {
    return `https://f4.bcbits.com/img/${track.type}${track.art_id}_42.jpg`;
  };

  const trackPlayerUrl = (track: Track): string => {
    return `/api/embed/${track.id}~~~${track.featured_track_id}`;
  };

  class DBSetting<
    S extends keyof MyDB,
    K extends keyof MyDB[S]["value"]
  > extends ValueChainAnchor<MyDB[S]["value"][K]> {
    parent: MyDB[S]["value"];
    store: S;
    key: K;
    constructor(store: S, parent: MyDB[S]["value"], key: K) {
      super(parent[key]);
      this.parent = parent;
      this.store = store;
      this.key = key;
    }

    async set(v: MyDB[S]["value"][K]): Promise<void> {
      this.parent[this.key] = v;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises, @typescript-eslint/no-explicit-any
      db.put(this.store as any, this.parent);
      await super.set(v);
    }
  }

  type HydratedTrack = {
    track: Track;
    star: DBSetting<"tracks", "star">;
  };

  const hydratedTracks = new Map<number, HydratedTrack>();

  const hydrate = (t: Track): HydratedTrack => {
    let out = hydratedTracks.get(t.id);
    if (out === undefined) {
      const unkT = t as unknown as any;
      if (unkT.art_id == undefined) {
        t = {
          // pre-migration data
          id: t.id,
          url_hints_subdomain: unkT.json.url_hints.subdomain,
          url_hints_slug: unkT.json.url_hints.slug,
          primary_text: unkT.json.primary_text,
          secondary_text: unkT.json.secondary_text,
          type: unkT.json.type,
          art_id: unkT.json.art_id,
          featured_track_id: unkT.json.featured_track.id,
          location: "Unknown",
          playedAt: t.playedAt,
          star: t.star,
        };
      }
      out = {
        track: t,
        star: new DBSetting(dbName, t, "star"),
      };
      hydratedTracks.set(t.id, out);
    }
    return out;
  };

  const trackHistory = new (class implements DataSource<HydratedTrack> {
    async get(start: number, count: number): Promise<HydratedTrack[]> {
      let cursor = await db
        .transaction(dbName)
        .store.index("played")
        .openCursor(undefined, "prev");
      if (cursor === null) return [];
      const out = [];
      let matchCount = 0;
      while (cursor) {
        if (out.length >= count) break;
        const temp = cursor.value;
        if (
          temp.playedAt !== undefined &&
          temp.playedAt > settings.historyEpoch.value()
        ) {
          if (matchCount >= start) {
            out.push(hydrate(temp));
          }
          matchCount += 1;
        }
        cursor = await cursor.continue();
      }
      return out;
    }
  })();

  const trackFavorites = new (class implements DataSource<HydratedTrack> {
    async get(start: number, count: number): Promise<HydratedTrack[]> {
      const out: HydratedTrack[] = [];
      let matchCount = 0;
      const current = currentTrack.value();
      if (current !== null && current[0].star.value()) {
        if (start === 0) {
          out.push(current[0]);
          matchCount += 1;
        }
      }
      let cursor = await db
        .transaction(dbName)
        .store.index("played")
        .openCursor(undefined, "prev");
      if (cursor === null) return out;
      while (cursor) {
        if (out.length >= count) break;
        const v = cursor.value;
        if (
          v.playedAt !== undefined &&
          v.playedAt > settings.starEpoch.value() &&
          v.star
        ) {
          if (matchCount >= start) {
            out.push(hydrate(v));
          }
          matchCount += 1;
        }
        cursor = await cursor.continue();
      }
      return out;
    }
  })();

  class Setting<O> extends ValueChainAnchor<O> {
    name: string;
    constructor(name: string, initial: O) {
      const found = localStorage.getItem(name);
      super(found === null ? initial : JSON.parse(found));
      this.name = name;
    }

    async set(v: O): Promise<void> {
      localStorage.setItem(this.name, JSON.stringify(v));
      await super.set(v);
    }
  }

  class DateSetting extends ValueChainAnchor<Date> {
    name: string;
    constructor(name: string, initial: Date) {
      const found = localStorage.getItem(name);
      super(found === null ? initial : new Date(JSON.parse(found)));
      this.name = name;
    }

    async set(v: Date): Promise<void> {
      localStorage.setItem(this.name, JSON.stringify(v));
      await super.set(v);
    }
  }

  // Model setup
  //
  type Filter = {
    id: Array<string>;
    name: string;
    desc: string;
    on: Setting<boolean>;
    ratio: Setting<number>;
    children: Array<Filter>;
  };
  type LocationFilter = {
    id: number;
    name: string;
    on: Setting<boolean>;
  };

  const epoch = new Date(0, 0, 1, 0, 0, 0, 0);
  const settings = {
    volume: new Setting<number>("volume", 1.0),
    current: new Setting<[Track, string] | null>("track", null),
    orderFilters: new Array<Filter>(),
    genreFilters: new Array<Filter>(),
    locationFilters: new Array<LocationFilter>(),
    historyEpoch: new DateSetting("history_epoch", epoch),
    starEpoch: new DateSetting("history_epoch", epoch),
  };

  const currentTrack = new (class extends ChainLink<
    [[Track, string] | null],
    [HydratedTrack, string] | null
  > {
    do(track: [Track, string] | null): [HydratedTrack, string] | null {
      if (track === null) return null;
      return [hydrate(track[0]), track[1]];
    }
  })("currentTrack", [settings.current]);

  const trackRequesters = new Map<string, AsyncIterator<Track>>();
  setInterval(() => trackRequesters.clear(), 1000 * 60 * 60 * 24);

  async function* trackRequester(
    sort: string,
    genre: string,
    subgenre: string,
    locations: number[]
  ): AsyncIterator<Track> {
    const allLocations = locations.indexOf(-1) !== -1;
    let next = null;
    while (true) {
      const url =
        next === null
          ? `/api/genrerank/${sort}/${genre}${
              subgenre === "all" ? "" : `/${subgenre}`
            }${
              allLocations
                ? ""
                : `?l=${locations.map((l) => l.toString()).join(",")}`
            }`
          : next;
      const resp: { next: string; tracks: Array<Track> } = await (
        await fetch(url)
      ).json();
      if (resp.tracks.length === 0) {
        console.log("No more tracks found for rank", sort, genre, subgenre);
        return;
      }
      next = resp.next;
      for (let track of resp.tracks) {
        const found = await db.get(dbName, track.id);
        if (found !== undefined) {
          if (found.playedAt !== undefined) {
            continue;
          }
          track = found;
        }
        yield track;
        next = null;
      }
    }
  }

  const constantOrders: Array<{
    name: string;
    value: string;
  }> = await (await fetch("/api/sorts")).json();
  const constantLocations: Record<string, string> = await (
    await fetch("/api/locations")
  ).json();

  const constantGenres: Array<{
    value: string;
    // eslint-disable-next-line camelcase
    norm_name: string;
    name: string;
    id: number;
    // eslint-disable-next-line camelcase
    sub: Array<{ value: string; norm_name: string; name: string }>;
  }> = await (await fetch("/api/genres")).json();

  constantOrders.forEach((order) => {
    const orderSettingId = "filter/" + order.value;
    settings.orderFilters.push({
      id: [order.value],
      name: order.name,
      desc: order.name,
      on: new Setting<boolean>(orderSettingId + ".on", order.value === "top"),
      ratio: new Setting<number>(orderSettingId, 1.0),
      children: [],
    });
  });
  constantGenres.forEach((genre) => {
    const genreSettingId = "filter/top/" + genre.value;
    const genreDesc = genre.name;
    settings.genreFilters.push({
      id: [genre.value],
      name: genre.name,
      desc: genreDesc,
      on: new Setting<boolean>(genreSettingId + ".on", true),
      ratio: new Setting<number>(genreSettingId, 1.0),
      children: ((): Array<Filter> => {
        const allSettingId = genreSettingId + "/all.on";
        return [
          {
            id: [genre.value, "all"],
            name: "all",
            desc: genreDesc + " / " + "all",
            on: new Setting<boolean>(allSettingId, true),
            ratio: new Setting<number>(allSettingId + "/all", 1.0),
            children: [],
          },
        ];
      })()
        .concat(
          genre.sub.map((subgenre) => {
            const subgenreSettingId = genreSettingId + "/" + subgenre.value;
            const subgenreDesc = genreDesc + " / " + subgenre.name;
            return {
              id: [genre.value, subgenre.value],
              name: subgenre.name,
              desc: subgenreDesc,
              on: new Setting<boolean>(subgenreSettingId + ".on", false),
              ratio: new Setting<number>(subgenreSettingId, 1.0),
              children: [],
            };
          })
        )
        .concat(
          (() => {
            const otherSettingId = genreSettingId + "/other.on";
            return [
              {
                id: [genre.value, "other"],
                name: "other",
                desc: genreDesc + " / " + "other",
                on: new Setting<boolean>(otherSettingId, false),
                ratio: new Setting<number>(otherSettingId + "/other", 1.0),
                children: [],
              },
            ];
          })()
        ),
    });
  });
  {
    const allSettingId = "filter/location/all.on";
    settings.locationFilters.push({
      id: -1,
      name: "all",
      on: new Setting<boolean>(allSettingId, true),
    });
  }
  for (const id0 of Object.keys(constantLocations)) {
    const id = parseInt(id0);
    const name = constantLocations[id];
    const locationId = `filter/location/${id}`;
    const on = new Setting<boolean>(locationId + ".on", false);
    settings.locationFilters.push({
      id: id,
      name: name,
      on: on,
    });
    new Listener(`location ${name} reset generators`, on, async (v) =>
      trackRequesters.clear()
    );
  }

  // UI setup
  //
  let playBlocked = true;
  class WPlayer implements Widget {
    frame: HTMLIFrameElement;
    constructor(
      track: ChainSource<[HydratedTrack, string] | null>,
      onEnd: () => Promise<void>
    ) {
      this.frame = document.createElement("iframe");
      this.frame.classList.add("w_player");
      this.frame.style.border = "0";
      this.frame.style.width = "350px";
      this.frame.style.maxWidth = "100%";
      this.frame.style.height = "470px";
      this.frame.setAttribute("seamless", "");
      bindEvent(this.frame, "load", async (_) => {
        interface X extends Window {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          HTML5Player: any;
        }
        const player = (this.frame.contentWindow! as X).HTML5Player;
        const oldChangeState = player.prototype._changestate;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        player.prototype._changestate = function (newstate: string): any {
          const volListener = new Listener<number>(
            "player;volume",
            settings.volume,
            async (v: number): Promise<void> => {
              this.setvol(v);
            }
          );
          if (newstate === "COMPLETED") {
            playBlocked = false;
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            event(async () => {
              settings.volume.dests.delete(volListener);
              await onEnd();
            });
            return;
          }
          // eslint-disable-next-line prefer-rest-params
          return oldChangeState.apply(this, arguments);
        };
        const artarea =
          this.frame.contentWindow!.document.getElementById("artarea")!;
        artarea.addEventListener("click", (_) => {
          playBlocked = false;
        });
        if (!playBlocked) artarea.click();
      });
      // tslint:disable-next-line: no-unused-expression
      new Listener<[HydratedTrack, string] | null>(
        "player;track",
        track,
        async (v: [HydratedTrack, string] | null): Promise<void> => {
          if (v === null) this.frame.src = "";
          else this.frame.src = trackPlayerUrl(v[0].track);
        }
      );
    }
    getDOM(): Element {
      return this.frame;
    }
    destroy(): void {
      throw new Error("Method not implemented.");
    }
  }

  /**
   * Zips constant A with stream of B to produce pair elements of [A, B]
   */
  class CarryIterator<A, B> implements Iterable<[A, B]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generator: Iterator<[A, B], any, undefined>;
    constructor(carry: A, iterable: Iterable<B>) {
      function* out(): Iterator<[A, B]> {
        for (const value of iterable) {
          yield [carry, value];
        }
      }
      this.generator = out();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [Symbol.iterator](): Iterator<[A, B], any, undefined> {
      return this.generator;
    }
  }

  const weightedChoicesPush = <T extends unknown>(
    ranges: Array<{ max: number; v: T }>,
    weight: number,
    v: T
  ) => {
    const last = ranges[ranges.length - 1];
    const scoreSum = last == undefined ? 0 : last.max;
    ranges.push({ max: scoreSum + weight, v: v });
  };

  const randomChoice = <T extends unknown>(
    ranges: Array<{ max: number; v: T }>
  ): T | null => {
    const scoreSum = ranges[ranges.length - 1].max;
    const target = Math.random() * scoreSum;
    for (const { max, v } of ranges) {
      if (max < target) continue;
      return v;
    }
    return null;
  };

  const mapEnsure = <K, V>(map: Map<K, V>, key: K, supp: () => V): V => {
    if (map.has(key)) {
      return map.get(key)!;
    } else {
      const v = supp();
      map.set(key, v);
      return v;
    }
  };

  const advance = async (): Promise<void> => {
    const weightedOrders: { max: number; v: Filter }[] = [];
    settings.orderFilters.forEach((v) => {
      if (!v.on.value()) return;
      weightedChoicesPush(weightedOrders, v.ratio.value(), v);
    });

    const weightedGenres: { max: number; v: Filter }[] = [];
    for (let top of settings.genreFilters) {
      if (!top.on.value()) {
        continue;
      }
      const firstChild = top.children[0];
      if (firstChild.on.value()) {
        weightedChoicesPush(
          weightedGenres,
          top.ratio.value() * firstChild.ratio.value(),
          firstChild
        );
      } else {
        for (let sub of top.children.slice(1)) {
          if (!sub.on.value()) {
            continue;
          }
          weightedChoicesPush(
            weightedGenres,
            top.ratio.value() * sub.ratio.value(),
            sub
          );
        }
      }
    }

    const locations: number[] = [];
    settings.locationFilters.forEach((c) => {
      if (c.on.value()) {
        locations.push(c.id);
      }
    });

    for (let i = 0; i < 1000; ++i) {
      const order = randomChoice(weightedOrders);
      const genre = randomChoice(weightedGenres);
      if (order == null || genre == null) {
        console.log("No enabled orders/genres! Aborting advance.");
        return;
      }
      const gen = mapEnsure(
        trackRequesters,
        order.id[0] + "/" + genre.id.join("/"),
        () => trackRequester(order.id[0], genre.id[0], genre.id[1], locations)
      );
      const {
        value,
        done,
      }: {
        value: Track;
        done?: boolean | undefined;
      } = await gen.next();
      if (done === true) continue;
      hydrate(value);
      await settings.current.set([value, order.desc + " / " + genre.desc]);
      console.log(`Found next track after ${i} attempts`);
      return;
    }
    await settings.current.set(null);
    console.log("No more tracks matching filters!  Aborting advance.");
  };

  const finishCurrent = async (): Promise<void> => {
    const t = currentTrack.value();
    if (t !== null) {
      t[0].track.playedAt = new Date();
      await db.put("tracks", t[0].track);
    }
    await advance();
  };

  const wimageLink = (src: string, alt: string, href: string): Widget => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.append(img);
    a.classList.add("w_imagelink");
    return new EWidget(a);
  };

  const player = new WPlayer(currentTrack, finishCurrent);

  class TrackListElement implements Widget {
    toggle: Widget;
    dom: HTMLDivElement;
    constructor(track: HydratedTrack) {
      const title = document.createElement("a");
      title.href = trackUrl(track.track);
      title.target = "_blank";
      title.textContent = `${trackArtist(track.track)} - ${trackName(
        track.track
      )}`;
      const image = wimageLink(
        trackArtUrl(track.track),
        title.textContent,
        trackUrl(track.track)
      );
      this.toggle = new WToggleButton({
        klass: "star_check",
        text: "Star",
        bind: track.star,
      });
      let timeEls: Array<Element> = [];
      if (track.track.playedAt != undefined) {
        const dateText = document.createElement("div");
        dateText.classList.add("date");
        dateText.textContent = track.track.playedAt!.toLocaleDateString();
        const timeText = document.createElement("div");
        timeText.classList.add("time");
        timeText.textContent = track.track.playedAt!.toLocaleTimeString();
        timeEls = [dateText, timeText];
      }
      this.dom = hdiv(
        image.getDOM(),
        vdiv(
          title,
          tag("tool", hdiv(...timeEls, spacer(), this.toggle.getDOM()))
        )
      );
      this.dom.classList.add("trcklistelement");
    }
    getDOM(): Element {
      return this.dom;
    }
    destroy(): void {
      this.toggle.destroy();
    }
  }

  const settingsTree = (at: Filter): Widget => {
    if (at.children.length === 0) {
      return wtag(
        "detail",
        whbox(
          new WToggleButton({ klass: "enabled", text: "enabled", bind: at.on }),
          wtext(at.name),
          new WSlider({
            min: 0,
            max: 1,
            step: 0.01,
            bind: at.ratio,
          })
        )
      );
    } else {
      return new WDetailLevel({
        open: new Setting("settingopen/" + at.id, false),
        summ: whbox(
          new WToggleButton({
            klass: "enabled",
            text: "enabled",
            bind: at.on,
          }),
          wtext(at.name)
        ),
        childrenGenerator: () => [
          whbar(),
          new WSlider({
            min: 0,
            max: 1,
            step: 0.01,
            bind: at.ratio,
          }),
          wtag(
            "tool",
            whbox(
              wbutton({
                icon: "check-box-multiple-outline.svg",
                text: "All on",
                action: async () => {
                  for (const child of at.children) {
                    await child.on.set(true);
                  }
                },
              }),
              wbutton({
                icon: "checkbox-multiple-blank-outline.svg",
                text: "All off",
                action: async () => {
                  for (const child of at.children) {
                    await child.on.set(false);
                  }
                },
              })
            )
          ),
          ...at.children.map(settingsTree),
        ],
      });
    }
  };

  const tag = (tag: string, w: HTMLElement): HTMLElement => {
    w.classList.add(tag);
    return w;
  };

  const wtag = (tag: string, w: Widget): Widget => {
    w.getDOM().classList.add(tag);
    return w;
  };

  const errorText = new (class implements Widget {
    dom: HTMLDivElement;
    constructor() {
      this.dom = document.createElement("div");
      this.dom.classList.add("errors");

      const pairs: [string, { on: Setting<boolean> }[]][] = [
        ["Ranking", settings.orderFilters],
        ["Genre", settings.genreFilters],
        ["Location option", settings.locationFilters],
      ];
      for (const [choiceType, group] of pairs) {
        const xel = document.createElement("p");
        xel.textContent = `• Please check at least one ${choiceType}`;
        this.dom.appendChild(xel);
        const dest = new (class implements ChainDest {
          comment: string;
          group: { on: Setting<boolean> }[];
          constructor(choiceType: string, group: { on: Setting<boolean> }[]) {
            this.comment = "errors-" + choiceType;
            this.group = group;
            this.update();
          }
          update() {
            xel.style.display = !this.group.some((v) => v.on.value())
              ? ""
              : "none";
          }
          async process() {
            this.update();
          }
        })(choiceType, group);
        for (const f of group) {
          f.on.dests.add(dest);
        }
      }
    }
    getDOM(): Element {
      return this.dom;
    }
    destroy(): void {
      this.dom.remove();
    }
  })();

  wroot(
    wtag(
      "maintabs",
      await wtabs({
        tabs: [
          wimageLink(
            "logo.svg",
            "Bandhiking",
            "https://gitlab.com/rendaw/bandhiking"
          ),
          new WTab({
            icon: "play.svg",
            text: "Playing",
            keep: true,
            builder: async (): Promise<Widget> => {
              return wtag(
                "playbody",
                wvbox(
                  player,
                  wvboxTag({
                    tag: "info",
                    nodes: [
                      new WBindText("player;from", currentTrack, (t) =>
                        t !== null ? "From: " + t[1] : ""
                      ),
                      new WBindText("player;location", currentTrack, (t) =>
                        t !== null && !settings.locationFilters[0].on.value()
                          ? t[0].track.location
                          : ""
                      ),
                    ],
                  }),
                  wtag(
                    "controls",
                    whbox(
                      new WSlider({
                        icon: "volume-high.svg",
                        text: "Volume",
                        min: 0,
                        max: 1,
                        step: 0.01,
                        bind: settings.volume,
                      }),
                      wbutton({
                        icon: "skip-next.svg",
                        text: "Skip",
                        action: async () => {
                          await finishCurrent();
                        },
                      }),
                      new WToggleButton({
                        klass: "star_check",
                        text: "Star",
                        bind: new (class extends IndirectChainAnchor<
                          [[HydratedTrack, string] | null],
                          boolean
                        > {
                          do(
                            track: [HydratedTrack, string] | null
                          ): ChainAnchor<boolean> {
                            if (track === null)
                              return new ValueChainAnchor(false);
                            return track[0].star;
                          }
                        })("main;star", [currentTrack]),
                      })
                    )
                  )
                )
              );
            },
          }),
          new WTab({
            icon: "history.svg",
            text: "History",
            builder: async (): Promise<Widget> => {
              return wbindList({
                source: trackHistory,
                create: (v): Widget => new TrackListElement(v),
              });
            },
          }),
          new WTab({
            icon: "star-outline.svg",
            text: "Favorites",
            builder: async (): Promise<Widget> => {
              return wbindList({
                source: trackFavorites,
                create: (v): Widget => new TrackListElement(v),
              });
            },
          }),
          new WTab({
            icon: "cog.svg",
            text: "Settings",
            builder: async (): Promise<Widget> => {
              return wtag(
                "settings-outer",
                wvbox(
                  errorText,
                  wtag(
                    "settings",
                    wvbox(
                      new WDetailLevel({
                        open: new ValueChainAnchor<boolean>(false),
                        summ: whbox(wtext("Ranking")),
                        childrenGenerator: () => [
                          whbar(),
                          ...settings.orderFilters.map(settingsTree),
                        ],
                      }),
                      new WDetailLevel({
                        open: new ValueChainAnchor<boolean>(false),
                        summ: whbox(wtext("Genre")),
                        childrenGenerator: () => [
                          whbar(),
                          ...settings.genreFilters.map(settingsTree),
                        ],
                      }),
                      new WDetailLevel({
                        open: new ValueChainAnchor<boolean>(false),
                        summ: whbox(wtext("Location")),
                        childrenGenerator: () => [
                          whbar(),
                          ...settings.locationFilters.map((location) =>
                            wtag(
                              "detail",
                              whbox(
                                new WToggleButton({
                                  klass: "enabled",
                                  text: "enabled",
                                  bind: location.on,
                                }),
                                wtext(location.name)
                              )
                            )
                          ),
                        ],
                      })
                    )
                  ),
                  wtag(
                    "postfilters",
                    wvbox(
                      wbutton({
                        text: "Download settings",
                        action: async () => {
                          const data: Record<string, string> = {};
                          for (let i = 0; i < localStorage.length; i += 1) {
                            const k = localStorage.key(i)!;
                            data[k] = localStorage.getItem(k)!;
                          }
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(
                            new Blob([JSON.stringify(data)], {
                              type: "text/json",
                            })
                          );
                          a.download = `bandhiking_settings_${new Date().toISOString()}.bandhiking`;
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
                        },
                      }),
                      wbutton({
                        text: "Upload settings",
                        action: async () => {
                          const input = document.createElement("input");
                          input.setAttribute("type", "file");
                          input.setAttribute("accept", ".bandhiking");
                          input.style.display = "none";
                          input.addEventListener("change", (_) => {
                            if (input.files?.length === 0) {
                              return;
                            }
                            const reader = new FileReader();
                            reader.addEventListener("load", (e) => {
                              const settings = JSON.parse(
                                e.target!.result! as string
                              );
                              localStorage.clear();
                              for (const key of Object.keys(settings)) {
                                localStorage.setItem(key, settings[key]);
                              }
                              window.location.reload();
                            });
                            reader.readAsText(input.files![0]);
                          });
                          input.click();
                        },
                      }),
                      wbutton({
                        text: "Clear history",
                        action: async () => {
                          settings.historyEpoch.set(new Date());
                        },
                      }),
                      wbutton({
                        text: "Restore history",
                        action: async () => {
                          settings.historyEpoch.set(epoch);
                        },
                      }),
                      wbutton({
                        text: "Clear starred",
                        action: async () => {
                          settings.starEpoch.set(new Date());
                        },
                      }),
                      wbutton({
                        text: "Restore starred",
                        action: async () => {
                          settings.starEpoch.set(epoch);
                        },
                      })
                    )
                  )
                )
              );
            },
          }),
        ],
      })
    )
  );

  await chainClean();
  if (currentTrack.value() === null) {
    await advance();
  }
  await chainClean();
})();
