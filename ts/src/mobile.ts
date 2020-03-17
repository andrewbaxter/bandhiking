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
  bindEvent
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
  wtabs
} from "./widgets";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async (): Promise<void> => {
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
        unique: true /* effectively */
      });
    },
    blocked() {},
    blocking() {},
    terminated() {}
  });

  type Track = {
    id: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any;
    playedAt?: Date;
    star: boolean;
  };

  const trackUrl = (track: Track): string => {
    return `https://${track.json.url_hints.subdomain}.bandcamp.com/album/${track.json.url_hints.slug}`;
  };

  const trackArtist = (track: Track): string => {
    return track.json.secondary_text;
  };

  const trackName = (track: Track): string => {
    return track.json.primary_text;
  };

  const trackArtUrl = (track: Track): string => {
    return `https://f4.bcbits.com/img/${track.json.type}${track.json.art_id}_42.jpg`;
  };

  const trackPlayerUrl = (track: Track): string => {
    return `/api/embed/${track.json.id}~~~${track.json.featured_track.id}`;
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
      out = {
        track: t,
        star: new DBSetting(dbName, t, "star")
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
      if (start > 0) cursor = await cursor.advance(start);
      const out = [];
      let at = 0;
      while (cursor) {
        if (at >= count) break;
        const temp = cursor.value;
        if (temp.playedAt !== undefined) {
          out.push(hydrate(temp));
          at += 1;
        }
        cursor = await cursor.continue();
      }
      return out;
    }
  })();

  const trackFavorites = new (class implements DataSource<HydratedTrack> {
    async get(start: number, count: number): Promise<HydratedTrack[]> {
      const out: HydratedTrack[] = [];
      const current = currentTrack.value();
      if (current !== null && current.star.value()) out.push(current);
      let cursor = await db
        .transaction(dbName)
        .store.index("played")
        .openCursor(undefined, "prev");
      if (cursor === null) return out;
      if (start > 0) cursor = await cursor.advance(start);
      let at = 0;
      while (cursor) {
        if (at >= count) break;
        const v = cursor.value;
        if (v.playedAt !== undefined && v.star) {
          out.push(hydrate(v));
          at += 1;
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

  // Model setup
  //
  type Filter = {
    name: string;
    on: Setting<boolean>;
    ratio: Setting<number>;
    children: Array<Filter>;
    playlist: AsyncIterator<Track> | null;
  };

  const settings = {
    volume: new Setting<number>("volume", 1.0),
    current: new Setting<Track | null>("track", null),
    filters: new Array<Filter>()
  };

  const currentTrack = new (class extends ChainLink<
    [Track | null],
    HydratedTrack | null
  > {
    do(track: Track | null): HydratedTrack | null {
      if (track === null) return null;
      return hydrate(track);
    }
  })("currentTrack", [settings.current]);

  async function* genreTrackRequester(
    sort: string,
    genre: string,
    subgenre: string
  ): AsyncIterator<Track> {
    let next = null;
    while (true) {
      const url =
        next === null
          ? "/api/genrerank/" + sort + "/" + genre + "/" + subgenre
          : next;
      const resp: { next: string; tracks: Array<Track> } = await (
        await fetch(url)
      ).json();
      if (resp.tracks.length === 0) {
        console.log("No more tracks found for rank", sort, genre, subgenre);
        return;
      }
      next = resp.next;
      for (const track of resp.tracks) {
        track.json = JSON.parse(track.json);
        yield track;
      }
    }
  }

  const constantOrders: Array<{
    name: string;
    value: string;
  }> = await (await fetch("/api/sorts")).json();
  const constantGenres: Array<{
    value: string;
    // eslint-disable-next-line camelcase
    norm_name: string;
    name: string;
    id: number;
    // eslint-disable-next-line camelcase
    sub: Array<{ value: string; norm_name: string; name: string }>;
  }> = await (await fetch("/api/genres")).json();

  constantOrders.forEach(order => {
    const orderId = "filter/" + order.value;
    settings.filters.push({
      name: order.name,
      on: new Setting<boolean>(orderId + ".on", order.value === "top"),
      ratio: new Setting<number>(orderId, 1.0),
      playlist: null,
      children: constantGenres.map(genre => {
        const genreId = orderId + "/" + genre.value;
        const out = {
          name: genre.name,
          on: new Setting<boolean>(
            genreId + ".on",
            genre.value === "electronic" /* debug */
          ),
          ratio: new Setting<number>(genreId, 1.0),
          playlist: null,
          children: genre.sub.map(subgenre => {
            const subgenreId = genreId + "/" + subgenre.value;
            return {
              name: subgenre.name,
              on: new Setting<boolean>(subgenreId + ".on", false),
              ratio: new Setting<number>(subgenreId, 1.0),
              playlist: genreTrackRequester(
                order.value,
                genre.value,
                subgenre.value
              ),
              children: []
            };
          })
        };
        out.children.splice(0, 0, {
          name: "All",
          on: new Setting<boolean>(genreId + "/all.on", true),
          ratio: new Setting<number>(genreId + "/all", 1.0),
          playlist: genreTrackRequester(order.value, genre.value, "all"),
          children: []
        });
        return out;
      })
    });
  });

  // UI setup
  //
  let playBlocked = true;
  class WPlayer implements Widget {
    frame: HTMLIFrameElement;
    constructor(
      track: ChainSource<HydratedTrack | null>,
      onEnd: () => Promise<void>
    ) {
      this.frame = document.createElement("iframe");
      this.frame.classList.add("w_player");
      this.frame.style.border = "0";
      this.frame.style.width = "350px";
      this.frame.style.maxWidth = "100%";
      this.frame.style.height = "470px";
      this.frame.setAttribute("seamless", "");
      bindEvent(this.frame, "load", async _ => {
        interface X extends Window {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          HTML5Player: any;
        }
        const player = (this.frame.contentWindow! as X).HTML5Player;
        const oldChangeState = player.prototype._changestate;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        player.prototype._changestate = function(newstate: string): any {
          const this1 = this;
          const volListener = new (class extends Listener<number> {
            async do(v: number): Promise<void> {
              this1.setvol(v);
            }
          })("player;volume", settings.volume);
          if (newstate === "COMPLETED") {
            playBlocked = false;
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            event(async () => {
              settings.volume.dests.delete(volListener);
              await onEnd();
            });
          }
          // eslint-disable-next-line prefer-rest-params
          return oldChangeState.call(this, arguments);
        };
        if (!playBlocked)
          this.frame.contentWindow!.document.getElementById("artarea")!.click();
      });
      const this1 = this;
      // tslint:disable-next-line: no-unused-expression
      new (class extends Listener<HydratedTrack | null> {
        async do(v: HydratedTrack | null): Promise<void> {
          if (v === null) this1.frame.src = "";
          else this1.frame.src = trackPlayerUrl(v.track);
        }
      })("player;track", track);
    }
    getDOM(): Element {
      return this.frame;
    }
    destroy(): void {
      throw new Error("Method not implemented.");
    }
  }

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

  const advance = async (): Promise<void> => {
    let scoreSum = 0;
    const ranges: { max: number; filter: Filter }[] = [];
    await depthFirst(
      new CarryIterator(1, settings.filters),
      async ([carry, filter]: [number, Filter]) => {
        if (!filter.on.value()) return [][Symbol.iterator]();
        const scaledRatio = carry * filter.ratio.value();
        if (filter.children.length === 0 && filter.playlist !== null) {
          scoreSum += scaledRatio;
          ranges.push({ max: scoreSum, filter: filter });
        }
        return new CarryIterator(scaledRatio, filter.children)[
          Symbol.iterator
        ]();
      }
    );
    for (let i = 0; i < 10; ++i) {
      const target = Math.random() * scoreSum;
      for (const { max, filter } of ranges) {
        if (max < target) continue;
        while (true) {
          let {
            value,
            // eslint-disable-next-line prefer-const
            done
          }: {
            value: Track;
            done?: boolean | undefined;
          } = await filter.playlist!.next();
          if (done === true) break;
          const found = await db.get(dbName, value.id);
          if (found !== undefined) {
            if (found.playedAt !== undefined) {
              continue;
            }
            value = found;
          }
          hydrate(value);
          await settings.current.set(value);
          return;
        }
        break;
      }
    }
    await settings.current.set(null);
    console.log(
      "No more tracks matching filters!  Aborting advance.",
      scoreSum
    );
  };

  const finishCurrent = async (): Promise<void> => {
    const t = currentTrack.value();
    if (t === null) return;
    t.track.playedAt = new Date();
    await db.put("tracks", t.track);
    await advance();
  };

  const wimage = (src: string, alt: string): Widget => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    return new EWidget(img);
  };

  const wimageLink = (src: string, alt: string, href: string): Widget => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    const a = document.createElement("a");
    a.href = href;
    a.append(img);
    return new EWidget(a);
  };

  const player = new WPlayer(currentTrack, finishCurrent);

  class TrackListElement implements Widget {
    toggle: Widget;
    dom: HTMLDivElement;
    constructor(track: HydratedTrack) {
      const title = document.createElement("a");
      title.href = trackUrl(track.track);
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
        bind: track.star
      });
      this.dom = hdiv(image.getDOM(), vdiv(title, this.toggle.getDOM()));
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
      return whbox(
        new WToggleButton({ klass: "enabled", text: "enabled", bind: at.on }),
        new WSlider({
          text: at.name,
          min: 0,
          max: 1,
          step: 0.01,
          bind: at.ratio
        })
      );
    } else {
      return new WDetailLevel(
        at.name,
        whbox(
          new WToggleButton({ klass: "enabled", text: "enabled", bind: at.on }),
          new WSlider({
            text: "Overall",
            min: 0,
            max: 1,
            step: 0.01,
            bind: at.ratio
          })
        ),
        ...at.children.map(settingsTree)
      );
    }
  };

  const wtag = (tag: string, w: Widget): Widget => {
    w.getDOM().classList.add(tag);
    return w;
  };

  wroot(
    wtag(
      "maintabs",
      await wtabs({
        tabs: [
          wimage("logo.svg", "Bandhiking"),
          new WTab({
            icon: "play.svg",
            text: "Playing",
            keep: true,
            builder: async (): Promise<Widget> => {
              return wtag(
                "playbody",
                wvbox(
                  player,
                  wtag(
                    "controls",
                    whbox(
                      new WSlider({
                        icon: "volume-high.svg",
                        text: "Volume",
                        min: 0,
                        max: 1,
                        step: 0.01,
                        bind: settings.volume
                      }),
                      wbutton({
                        icon: "skip-next.svg",
                        text: "Skip",
                        action: async () => {
                          await finishCurrent();
                        }
                      }),
                      new WToggleButton({
                        klass: "star_check",
                        text: "Star",
                        bind: new (class extends IndirectChainAnchor<
                          [HydratedTrack | null],
                          boolean
                        > {
                          do(
                            track: HydratedTrack | null
                          ): ChainAnchor<boolean> {
                            if (track === null)
                              return new ValueChainAnchor(false);
                            return track.star;
                          }
                        })("main;star", [currentTrack])
                      })
                    )
                  )
                )
              );
            }
          }),
          new WTab({
            icon: "history.svg",
            text: "History",
            builder: (): Promise<Widget> => {
              return wbindList({
                source: trackHistory,
                create: (v): Widget => new TrackListElement(v)
              });
            }
          }),
          new WTab({
            icon: "star-outline.svg",
            text: "Favorites",
            builder: (): Promise<Widget> => {
              return wbindList({
                source: trackFavorites,
                create: (v): Widget => new TrackListElement(v)
              });
            }
          }),
          new WTab({
            icon: "cog.svg",
            text: "Settings",
            builder: async (): Promise<Widget> => {
              return wvbox(...settings.filters.map(settingsTree));
            }
          })
        ]
      })
    )
  );

  await chainClean();
  if (currentTrack.value() === null) {
    await advance();
  }
  await chainClean();
})();
