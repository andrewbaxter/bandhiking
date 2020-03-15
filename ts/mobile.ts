import {
  genres as constantGenres,
  orders as constantOrders
} from "./constants";
import { abort, depthFirst } from "./helper";
import {
  ValueChainAnchor,
  ChainAnchor,
  ChainSource,
  Listener,
  event,
  clean as chainClean,
  IndirectChainAnchor,
  ChainLink
} from "./chain";
import { openDB, DBSchema } from "idb";
import {
  wbutton,
  whbox,
  wvbox,
  WBindList,
  WTab,
  WTabs,
  wroot,
  wslider,
  wtoggleButton,
  Widget,
  DataSource,
  hdiv,
  div,
  vdiv,
  WDetailLevel
} from "./widgets";

(async () => {
  const dbName = "tracks";
  const dbVersion = 0;

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
    upgrade(db, oldVersion, newVersion, transaction) {
      let objectStore = db.createObjectStore(dbName, { keyPath: "id" });
      objectStore.createIndex("played", "played", { unique: false });
    },
    blocked() {},
    blocking() {},
    terminated() {}
  });

  type Track = {
    id: number;
    albumId: string;
    trackId: string;
    artId: string;
    name: string;
    image: string;
    playedAt?: Date;
    star: boolean;
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

    set(v: MyDB[S]["value"][K]) {
      this.parent[this.key] = v;
      db.put(this.store as any, this.parent);
      super.set(v);
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
      cursor = await cursor.advance(start);
      const out = [];
      let at = 0;
      while (cursor) {
        if (at >= count) break;
        out.push(hydrate(cursor.value));
        at += 1;
        cursor = await cursor.continue();
      }
      return out;
    }
  })();

  const trackFavorites = new (class implements DataSource<HydratedTrack> {
    async get(start: number, count: number): Promise<HydratedTrack[]> {
      let cursor = await db
        .transaction(dbName)
        .store.index("played")
        .openCursor(undefined, "prev");
      if (cursor === null) return [];
      cursor = await cursor.advance(start);
      const out = [];
      let at = 0;
      while (cursor) {
        if (at >= count) break;
        const v = cursor.value;
        if (v.star) {
          out.push(hydrate(v));
        }
        at += 1;
        cursor = await cursor.continue();
      }
      return out;
    }
  })();

  class Setting<O> extends ValueChainAnchor<O> {
    constructor(name: string, initial: O) {
      super(initial);
      const found = localStorage.getItem(name);
      this.value = found === null ? initial : JSON.parse(found);
    }

    set(v: O) {
      localStorage.setItem(name, JSON.stringify(v));
      super.set(v);
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
    constructor(source: ChainSource<Track | null>) {
      super([source]);
    }
    do(track: Track | null): HydratedTrack | null {
      if (track === null) return null;
      return hydrate(track);
    }
  })(settings.current);

  async function* genreTrackRequester(
    sort: string,
    genre: string,
    subgenre: string
  ): AsyncIterator<Track> {
    let next = null;
    while (true) {
      let url = "/api/" + sort + "/" + genre + "/" + subgenre;
      if (next !== null) url = url + "?next=" + next;
      const resp = await (await fetch(url)).json();
      next = resp.next;
      for (let track of resp.tracks) {
        yield track;
      }
    }
  }

  constantOrders.forEach(order => {
    const orderId = "filter/" + order.value;
    settings.filters.push({
      name: order.name,
      on: new Setting<boolean>(orderId + ".on", true),
      ratio: new Setting<number>(orderId, 1.0),
      playlist: null,
      children: constantGenres.map(genre => {
        const genreId = orderId + "/" + genre.value;
        const out = {
          name: genre.name,
          on: new Setting<boolean>(genreId + ".on", true),
          ratio: new Setting<number>(genreId, 1.0),
          playlist: null,
          children: genre.sub.map(subgenre => {
            const subgenreId = genreId + "/" + subgenre.value;
            return {
              name: subgenre.name,
              on: new Setting<boolean>(subgenreId + ".on", true),
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
        out.children.push({
          name: "Other",
          on: new Setting<boolean>(genreId + "/other.on", true),
          ratio: new Setting<number>(genreId + "/other", 1.0),
          playlist: genreTrackRequester(order.value, genre.value, "other"),
          children: []
        });
        return out;
      })
    });
  });

  // UI setup
  //
  class WPlayer implements Widget {
    frame: HTMLIFrameElement;
    constructor(
      track: ChainSource<HydratedTrack | null>,
      onEnd: (t: HydratedTrack | null) => Promise<void>
    ) {
      this.frame = document.createElement("iframe");
      this.frame.style.border = "0";
      this.frame.style.width = "350px";
      this.frame.style.height = "470px";
      this.frame.setAttribute("seamless", "");
      this.frame.addEventListener("load", ev => {
        this.frame.contentDocument!.getElementById("artarea")!.click();
        interface X extends Window {
          HTML5Player: any;
        }
        const player = (this.frame.contentWindow! as X)["HTML5Player"];
        const oldChangeState = player.prototype._changestate;
        player._changestate = (newstate: string) => {
          if (newstate == "COMPLETED")
            event(async () => {
              await onEnd(track.value());
            });
          oldChangeState(newstate);
        };
      });
      const this1 = this;
      new (class extends Listener<HydratedTrack | null> {
        async do(v: HydratedTrack | null): Promise<void> {
          if (v === null) this1.frame.src = "";
          else
            this1.frame.src =
              "https://bandcamp.com/EmbeddedPlayer/album=" +
              v.track.albumId +
              "/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/track=" +
              v.track.trackId +
              "/transparent=true/";
        }
      })(track);
    }
    getDOM(): Element {
      return this.frame;
    }
    destroy(): void {
      throw new Error("Method not implemented.");
    }
  }

  class CarryIterator<A, B> implements Iterable<[A, B]> {
    generator: Iterator<[A, B], any, undefined>;
    constructor(carry: A, iterable: Iterable<B>) {
      function* out(): Iterator<[A, B]> {
        for (let value of iterable) {
          yield [carry, value];
        }
      }
      this.generator = out();
    }
    [Symbol.iterator](): Iterator<[A, B], any, undefined> {
      return this.generator;
    }
  }

  const advance = async () => {
    let scoreSum = 0;
    let ranges: { max: number; filter: Filter }[] = [];
    await depthFirst(
      new CarryIterator(1, settings.filters),
      async ([carry, filter]: [number, Filter]) => {
        if (!filter.on.value) return [][Symbol.iterator]();
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
      for (let { max, filter } of ranges) {
        if (max < target) continue;
        const {
          value,
          done
        }: {
          value: Track;
          done?: boolean | undefined;
        } = await filter.playlist!.next();
        if (!done) {
          hydrate(value);
          settings.current.set(value);
          return;
        }
      }
    }
    console.log(
      "No more tracks matching filters!  Aborting advance.",
      scoreSum
    );
  };

  const player = new WPlayer(currentTrack, async t => {
    if (t === null) return;
    t.track.playedAt = new Date();
    await db.put("tracks", t.track);
    await advance();
  });

  class TrackListElement implements Widget {
    toggle: Widget;
    dom: HTMLDivElement;
    constructor(track: HydratedTrack) {
      const title = div();
      title.textContent = track.track.name;
      const image = document.createElement("img");
      image.src = "https://f4.bcbits.com/img/a" + track.track.artId + "_42.jpg";
      this.toggle = wtoggleButton({
        klass: "star_check",
        text: "Star",
        bind: track.star
      });
      this.dom = hdiv(image, vdiv(title, this.toggle.getDOM()));
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
        wtoggleButton({ klass: "enabled", text: "enabled", bind: at.on }),
        wslider({ text: at.name, min: 0, max: 1, step: 0.01, bind: at.ratio })
      );
    } else {
      return new WDetailLevel(
        at.name,
        whbox(
          wtoggleButton({ klass: "enabled", text: "enabled", bind: at.on }),
          wslider({
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

  wroot(
    new WTabs({
      tabs: [
        new WTab({
          icon: "play.png",
          text: "Playing",
          builder: () => {
            return wvbox(
              player,
              whbox(
                wslider({
                  icon: "volume.png",
                  text: "Volume",
                  min: 0,
                  max: 1,
                  step: 0.01,
                  bind: settings.volume
                }),
                wbutton({
                  icon: "right.png",
                  text: "Skip",
                  action: async () => {
                    await advance();
                  }
                }),
                wtoggleButton({
                  klass: "star_check",
                  text: "Star",
                  bind: new (class extends IndirectChainAnchor<
                    [HydratedTrack | null],
                    boolean
                  > {
                    do(track: HydratedTrack | null): ChainAnchor<boolean> {
                      if (track === null) return new ValueChainAnchor(false);
                      return track.star;
                    }
                  })([currentTrack])
                })
              )
            );
          }
        }),
        new WTab({
          icon: "clock.png",
          text: "History",
          builder: () => {
            return new WBindList({
              source: trackHistory,
              create: v => new TrackListElement(v)
            });
          }
        }),
        new WTab({
          icon: "star.png",
          text: "Favorites",
          builder: () => {
            return new WBindList({
              source: trackFavorites,
              create: v => new TrackListElement(v)
            });
          }
        }),
        new WTab({
          icon: "gear.png",
          text: "Settings",
          builder: () => {
            return wvbox(...settings.filters.map(settingsTree));
          }
        })
      ]
    })
  );

  advance();
  chainClean();
})();
