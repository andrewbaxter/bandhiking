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
  wtabs,
  WBindText
} from "./widgets";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async (): Promise<void> => {
  type Track = {
    id: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any;
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
        unique: true /* effectively */
      });
    },
    blocked() {},
    blocking() {},
    terminated() {}
  });

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
      const out = [];
      let matchCount = 0;
      while (cursor) {
        if (out.length >= count) break;
        const temp = cursor.value;
        if (temp.playedAt !== undefined) {
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
        if (v.playedAt !== undefined && v.star) {
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

  // Model setup
  //
  type Filter = {
    id: string;
    name: string;
    desc: string;
    on: Setting<boolean>;
    ratio: Setting<number>;
    children: Array<Filter>;
    playlist: AsyncIterator<Track> | null;
  };

  const settings = {
    volume: new Setting<number>("volume", 1.0),
    current: new Setting<[Track, string] | null>("track", null),
    filters: new Array<Filter>()
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
      for (let track of resp.tracks) {
        track.json = JSON.parse(track.json);
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
    const orderDesc = order.name;
    settings.filters.push({
      id: orderId,
      name: order.name,
      desc: orderDesc,
      on: new Setting<boolean>(orderId + ".on", order.value === "top"),
      ratio: new Setting<number>(orderId, 1.0),
      playlist: null,
      children: constantGenres.map(genre => {
        const genreId = orderId + "/" + genre.value;
        const genreDesc = orderDesc + " / " + genre.name;
        const out = {
          id: genreId,
          name: genre.name,
          desc: genreDesc,
          on: new Setting<boolean>(genreId + ".on", true),
          ratio: new Setting<number>(genreId, 1.0),
          playlist: null,
          children: genre.sub.map(subgenre => {
            const subgenreId = genreId + "/" + subgenre.value;
            const subgenreDesc = genreDesc + " / " + subgenre.name;
            return {
              id: subgenreId,
              name: subgenre.name,
              desc: subgenreDesc,
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
        const allId = genreId + "/all.on";
        out.children.splice(0, 0, {
          id: allId,
          name: "all",
          desc: genreDesc + " / all",
          on: new Setting<boolean>(allId, true),
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
      bindEvent(this.frame, "load", async _ => {
        interface X extends Window {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          HTML5Player: any;
        }
        const player = (this.frame.contentWindow! as X).HTML5Player;
        const oldChangeState = player.prototype._changestate;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        player.prototype._changestate = function(newstate: string): any {
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
        const artarea = this.frame.contentWindow!.document.getElementById(
          "artarea"
        )!;
        artarea.addEventListener("click", _ => {
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
          const {
            value,
            done
          }: {
            value: Track;
            done?: boolean | undefined;
          } = await filter.playlist!.next();
          if (done === true) break;
          hydrate(value);
          await settings.current.set([value, filter.desc]);
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
      return new WDetailLevel({
        title: at.name,
        open: new Setting("settingopen/" + at.id, at.id === "setting/top"),
        children: [
          whbox(
            new WToggleButton({
              klass: "enabled",
              text: "enabled",
              bind: at.on
            }),
            wtag(
              "combined",
              new WSlider({
                text: "combined",
                min: 0,
                max: 1,
                step: 0.01,
                bind: at.ratio
              })
            )
          ),
          ...at.children.map(settingsTree)
        ]
      });
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
                  wtag(
                    "info",
                    new WBindText("player;from", currentTrack, t =>
                      t !== null ? "From: " + t[1] : ""
                    )
                  ),
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
              return wtag(
                "settings",
                wvbox(...settings.filters.map(settingsTree))
              );
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
