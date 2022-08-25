package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Jeffail/gabs/v2"
	"github.com/go-resty/resty/v2"
	"github.com/robfig/cron"

	"github.com/jmoiron/sqlx"
	"github.com/jmoiron/sqlx/reflectx"
	_ "github.com/lib/pq"
	psh "github.com/platformsh/config-reader-go/v2"
	pshsql "github.com/platformsh/config-reader-go/v2/libpq"
	migrate "github.com/rubenv/sql-migrate"
	"github.com/sirupsen/logrus"
)

type sorts []sort

type sort struct {
	Value string `json:"value"`
	Name  string `json:"name"`
}

type genres []genre

type genre struct {
	Value    string     `json:"value"`
	NormName string     `json:"norm_name"`
	Name     string     `json:"name"`
	ID       int        `json:"id"`
	Sub      []subgenre `json:"sub"`
}

type subgenre struct {
	Value    string `json:"value"`
	NormName string `json:"norm_name"`
	Name     string `json:"name"`
}

type track struct {
	ID                int64   `json:"id"`
	ArtId             string  `json:"art_id"`
	FeaturedTrackId   string  `json:"featured_track_id"`
	LocationText      *string `json:"location_text"`
	PrimaryText       string  `json:"primary_text"`
	SecondaryText     string  `json:"secondary_text"`
	Type              string  `json:"type"`
	UrlHintsSlug      string  `json:"url_hints_slug"`
	UrlHintsSubdomain string  `json:"url_hints_subdomain"`
	Refcount          int     `json:"refcount"`
}

func main() {
	logrus.SetOutput(os.Stdout)
	logrus.SetLevel(logrus.TraceLevel)
	logrus.Tracef("The start")

	var err error

	var dbstring string
	var listenstring string

	platform, err := psh.NewRuntimeConfig()
	if err == nil {
		logrus.Infof("Found PSH config.\n")
		listenstring = ":" + platform.Port()
		dbstring0, err := platform.Credentials("postgresdatabase")
		if err != nil {
			logrus.Fatalf("Failed to get Platform db credentials string: %v", err)
		}
		dbstring, err = pshsql.FormattedCredentials(dbstring0)
		if err != nil {
			logrus.Fatalf("Failed to format Platform db credentials string: %v", err)
		}
	} else {
		listenstring = ":8080"
		dbstring = fmt.Sprintf(
			"host=%v port=5432 user=%v dbname=%v sslmode=disable password=%v",
			os.Getenv("DB_HOST"),
			os.Getenv("DB_USER"),
			os.Getenv("DB_NAME"),
			os.Getenv("DB_PASS"),
		)
	}

	var sorts sorts
	{
		data, err := ioutil.ReadFile("./sorts.json")
		if err != nil {
			logrus.Fatalf("Failed to load sorts file: %s", err)
			return
		}
		err = json.Unmarshal(data, &sorts)
		if err != nil {
			logrus.Fatalf("Couldn't parse json from sorts file")
			return
		}
	}
	var genres genres
	{
		data, err := ioutil.ReadFile("./genres.json")
		if err != nil {
			logrus.Fatalf("Failed to load genre file: %s", err)
			return
		}
		err = json.Unmarshal(data, &genres)
		if err != nil {
			logrus.Fatalf("Couldn't parse json from genres file")
			return
		}
	}

	db, err := sqlx.Connect("postgres", dbstring)
	if err != nil {
		logrus.Fatalf("Failed to open [%v]: %+v", dbstring, err)
		return
	}
	defer db.Close()
	db.Mapper = reflectx.NewMapperFunc("json", strings.ToLower)
	migrations := &migrate.MemoryMigrationSource{
		Migrations: []*migrate.Migration{
			{
				Id: "001",
				Up: []string{
					"create table track (id bigint primary key, blob json)",
					"create table genreRank (date timestamp, \"primary\" text, secondary text, sort text, rank integer, track bigint, primary key (\"primary\", secondary, sort, date, rank))",
				},
				Down: []string{"DROP TABLE track", "DROP TABLE genreRank"},
			},
			{
				Id: "002",
				Up: []string{
					"create table countryRank (date timestamp, \"primary\" text, sort text, rank integer, track bigint, primary key (\"primary\", sort, date, rank))",
					"alter table track add column lastSeen timestamp default '2020-12-26 00:00:00'",
				},
				Down: []string{},
			},
			{
				Id: "003",
				Up: []string{
					`alter table track
	add art_id bigint,
	add featured_track_id text,
	add location_text text,
	add primary_text text,
	add secondary_text text,
	add type text,
	add url_hints_slug text,
	add url_hints_subdomain text,
	add refcount int not null default 0`,
					`update track set
	art_id = cast (blob ->> 'art_id' as bigint),
	featured_track_id = blob -> 'featured_track' ->> 'id',
	location_text = blob ->> 'location_text',
	primary_text = blob ->> 'primary_text',
	secondary_text = blob ->> 'secondary_text',
	type = blob ->> 'type',
	url_hints_slug = blob -> 'url_hints' ->> 'slug',
	url_hints_subdomain = blob -> 'url_hints' ->> 'subdomain',
	refcount = coalesce(gr.c, 0)
	from
	(select track, count(*) as c from genreRank group by track) gr
	where gr.track = id`,
					`delete from track where refcount = 0`,
					`alter table track 
	alter art_id set not null,
	alter featured_track_id set not null,
	alter primary_text set not null,
	alter secondary_text set not null,
	alter type set not null,
	alter url_hints_slug set not null,
	alter url_hints_subdomain set not null,
	drop column blob,
	drop column lastSeen`,
					`delete from genreRank using (select distinct on ("primary", secondary, sort, track) track, "primary", secondary, sort, date, rank from genreRank order by "primary", secondary, sort, track, date desc, rank desc) as x where x.primary = genreRank.primary and x.secondary = genreRank.secondary and x.sort = genreRank.sort and x.track = genreRank.track and (x.date != genreRank.date or x.rank != genreRank.rank)`,
					`alter table genreRank add unique ("primary", secondary, sort, track)`,
					`drop table countryRank`,
					`create or replace function refadd() returns trigger as $$ begin update track set refcount = refcount + 1 where id = new.track; return null; end; $$ language plpgsql`,
					`create or replace function refsub() returns trigger as $$ begin update track set refcount = refcount - 1 where id = old.track; return null; end; $$ language plpgsql`,
					`create trigger genrerank_refadd after insert on genreRank for each row execute procedure refadd()`,
					`create trigger genrerank_refsub after delete on genreRank for each row execute procedure refsub()`,
				},
			},
		},
	}
	logrus.Tracef("Starting db migrations")
	_, err = migrate.Exec(db.DB, "postgres", migrations, migrate.Up)
	if err != nil {
		logrus.Fatalf("Failed to migrate db: %+v", err)
		return
	}
	logrus.Tracef("Db migrations done")

	/*
		var countries []string
		updateCountries := func() {
			countries = []string{}
			rows, err := db.Queryx(
				"select count(*) as card, \"primary\" from countryRank group by \"primary\" order by card desc limit 50",
			)
			if err != nil {
				logrus.Errorf("Failed to query countries: %+v", err)
				return
			}
			defer rows.Close()
			for rows.Next() {
				var row struct {
					Card    int
					Primary string
				}
				err = rows.StructScan(&row)
				if err != nil {
					logrus.Errorf("Failed to scan country count result: %+v", err)
					return
				}
				countries = append(countries, row.Primary)
			}
		}

		updateCountries()
	*/

	var isScraping int32

	myhttp := resty.New()
	myhttp.SetHeader("User-Agent", "https://gitlab.com/rendaw/bandhiking")
	myhttp.SetRetryCount(3)
	scrapeInner := func() {
		BeginningOfDay := func(t time.Time) time.Time {
			year, month, day := t.Date()
			return time.Date(year, month, day, 0, 0, 0, 0, t.Location())
		}
		date := BeginningOfDay(time.Now())

		logrus.Tracef("Deleting old data, %v", date)

		_, err = db.Exec(
			"delete from genreRank r using (select track, row_number() over (partition by \"primary\", \"secondary\", sort order by date desc, rank desc) rn from genreRank) r2 where r.track = r2.track and r2.rn > 1000",
		)
		if err != nil {
			logrus.Errorf("Failed to prune genreRank; %+v", err)
		}
		_, err = db.Exec(
			"delete from track where refcount = 0",
		)
		if err != nil {
			logrus.Errorf("Failed to prune tracks; %+v", err)
		}

		logrus.Tracef("Starting scrape, %v", date)

		type ScrapeState struct {
			Done      bool
			GenreRank int
			Page      int
		}
		pages := map[string]*ScrapeState{}

		rankpage := func(stateKey string, url string, sort string, topcat string, subcat string) bool {
			state, ok := pages[stateKey]
			if !ok {
				state = &ScrapeState{
					Done:      false,
					GenreRank: 0,
					Page:      0,
				}
				pages[stateKey] = state
			}
			if state.Done {
				return false
			}
			url = fmt.Sprintf(url, state.Page)
			genreRank := state.GenreRank
			logrus.Tracef("Fetching %v", url)
			res, err := myhttp.R().SetDoNotParseResponse(true).Get(url)
			if err != nil {
				logrus.Errorf("Failed to request page %v; %+v", url, err)
				return true
			}
			data, err := gabs.ParseJSONBuffer(res.RawBody())
			if err != nil {
				logrus.Warnf("Failed to read response on %v: %+v", url, err)
				return true
			}
			for _, trackdata := range data.Search("items").Children() {
				bytes, err := trackdata.MarshalJSON()
				if err != nil {
					logrus.Fatalf("Failed to reencode json, shouldn't happen; %+v", err)
				}
				_type := trackdata.S("type").Data().(string)
				if _type != "a" {
					logrus.Infof("Unhandled item type %v: %v", _type, string(bytes))
					continue
				}
				trackID0 := trackdata.Search(
					"id",
				).Data() // Not actually track - probably album id, but should be more consistent
				if trackID0 == nil {
					logrus.Errorf("Failed to extract expected data from track: %+v", trackdata)
					continue
				}
				trackID := int64(trackID0.(float64))
				type KV struct {
					key   string
					value interface{}
				}
				kvs := []KV{
					{key: "id", value: trackID},
					{key: "art_id", value: strconv.Itoa(int(trackdata.Search("art_id").Data().(float64)))},
					{key: "featured_track_id", value: trackdata.Search("featured_track", "id").Data().(string)},
					{key: "location_text", value: trackdata.Search("location_text").Data().(string)},
					{key: "primary_text", value: trackdata.Search("primary_text").Data().(string)},
					{key: "secondary_text", value: trackdata.Search("secondary_text").Data().(string)},
					{key: "type", value: _type},
					{key: "url_hints_slug", value: trackdata.Search("url_hints", "slug").Data().(string)},
					{key: "url_hints_subdomain", value: trackdata.Search("url_hints", "subdomain").Data().(string)},
				}
				query := strings.Builder{}
				query.WriteString("insert into track (")
				for i, kv := range kvs {
					last := i == len(kvs)-1
					query.WriteString(kv.key)
					if !last {
						query.WriteString(", ")
					}
				}
				query.WriteString(") values (")
				for i := range kvs {
					query.WriteString(fmt.Sprintf("$%d", i+1))
				}
				query.WriteString(") on conflict (id) do nothing")
				queryArgs := []interface{}{}
				for _, kv := range kvs {
					queryArgs = append(queryArgs, kv.value)
				}
				_, err = db.Exec(query.String(), queryArgs...)
				if err != nil {
					logrus.Errorf("Failed to create track record; %+v", err)
					return true
				}

				// Genre rank
				_, err = db.Exec(
					"delete from genreRank where \"primary\" = $1 and secondary = $2 and sort = $3 and track = $4",
					topcat,
					subcat,
					sort,
					trackID,
				)
				if err != nil {
					logrus.Errorf("Failed to delete conflicting rank record: %#v", err)
					return true
				}
				_, err = db.Exec(
					"insert into genreRank (date, \"primary\", secondary, sort, rank, track) values ($1, $2, $3, $4, $5, $6) on conflict (\"primary\", secondary, sort, track) do nothing",
					date,
					topcat,
					subcat,
					sort,
					int32(genreRank),
					trackID,
				)
				if err != nil {
					logrus.Errorf("Failed to create track rank record; %+v", err)
					return true
				}
				genreRank++

				// Country rank
				/*
					locationRaw := trackdata.S("location_text")
					if locationRaw.Data() != nil {
						locSplits := strings.Split(locationRaw.Data().(string), ", ")
						country := locSplits[len(locSplits)-1]
					}
				*/
			}

			state.Page++
			if genreRank == state.GenreRank {
				state.Done = true
			}
			state.GenreRank = genreRank

			return true
		}
		for pagei := 0; pagei < 2; pagei++ {
			for _, sort := range []string{"top", "new", "rec"} {
				for _, topcat := range genres {
					allKey := fmt.Sprintf("%v/%v", sort, topcat.Value)
					allURL := fmt.Sprintf(
						"https://bandcamp.com/api/discover/3/get_web?g=%v&s=%v&p=%%v&gn=0&f=all&w=0",
						strings.ReplaceAll(url.QueryEscape(topcat.Value), "%", "%%"),
						sort,
					)
					if rankpage(allKey, allURL, sort, topcat.Value, "all") {
						time.Sleep(30 * time.Second)
					}
					for _, subcat := range topcat.Sub {
						subKey := fmt.Sprintf("%v/%v", allKey, subcat.Value)
						subURL := fmt.Sprintf(
							"https://bandcamp.com/api/discover/3/get_web?g=%v&t=%v&s=%v&p=%%v&gn=0&f=all&w=0",
							strings.ReplaceAll(url.QueryEscape(topcat.Value), "%", "%%"),
							strings.ReplaceAll(url.QueryEscape(subcat.Value), "%", "%%"),
							sort,
						)
						if rankpage(
							subKey,
							subURL,
							sort,
							topcat.Value,
							subcat.Value,
						) {
							time.Sleep(30 * time.Second)
						}
					}
				}
			}
		}
		// updateCountries()
	}
	scrape := func() {
		if !atomic.CompareAndSwapInt32(&isScraping, 0, 1) {
			logrus.Infof("New scrape aborted; already scraping")
			return
		}
		scrapeInner()
		atomic.StoreInt32(&isScraping, 0)
	}
	mycron := cron.New()
	_ = mycron.AddFunc("@daily", scrape)
	mycron.Start()

	static := http.FileServer(http.Dir("./static"))
	http.Handle("/", static)

	http.HandleFunc("/scrape", func(w http.ResponseWriter, req *http.Request) {
		go scrape()
	})

	RetJSON := func(w http.ResponseWriter, v interface{}) {
		w.Header().Add("Content-Type", "application/json")
		w.WriteHeader(200)
		b, err := json.Marshal(v)
		if err != nil {
			logrus.Errorf("Failed to serialize error; %+v", err)
		}
		_, err = w.Write(b)
		if err != nil {
			logrus.Warnf("Failed to write json bytes; %+v", err)
		}
	}

	http.HandleFunc("/api/sorts", func(w http.ResponseWriter, req *http.Request) {
		RetJSON(w, sorts)
	})

	http.HandleFunc("/api/genres", func(w http.ResponseWriter, req *http.Request) {
		RetJSON(w, genres)
	})

	/*
		http.HandleFunc("/api/countries", func(w http.ResponseWriter, req *http.Request) {
			RetJSON(w, countries)
		})
	*/

	embedPrefix := "/api/embed/"
	http.HandleFunc(embedPrefix, func(w http.ResponseWriter, req *http.Request) {
		path := strings.TrimPrefix(req.URL.Path, embedPrefix)
		keys := strings.Split(path, "~~~")
		if len(keys) == 1 {
			logrus.Errorf("Trying to proxy non-html: %s", req.URL)
			w.WriteHeader(400)
			return
		}
		album, track := keys[0], keys[1]
		url := fmt.Sprintf(
			"https://bandcamp.com/EmbeddedPlayer/album=%v/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/track=%v/transparent=true/",
			album,
			track,
		)
		res, err := myhttp.R().SetDoNotParseResponse(true).Get(url)
		if err != nil {
			logrus.Errorf("Failed to request page %v; %+v", url, err)
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(200)
		w.Header().Add("Content-Type", "text/html")
		bytes, err := ioutil.ReadAll(res.RawBody())
		if err != nil {
			logrus.Errorf("Failed to request page %v; %+v", url, err)
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write(bytes)
	})

	http.HandleFunc("/api/genrerank/", func(w http.ResponseWriter, req *http.Request) {
		var err error
		type ErrorRet struct {
			Error string `json:"error"`
		}
		RetE := func(e string) {
			RetJSON(w, ErrorRet{
				Error: e,
			})
		}
		type TracksRet struct {
			Next   string  `json:"next"`
			Tracks []track `json:"tracks"`
		}
		splits := strings.Split(req.URL.Path, "/")[3:]
		if len(splits) < 3 {
			RetE("Not enough key params")
			return
		}
		sort, topcat, subcat := splits[0], splits[1], splits[2]
		page := 0
		if len(splits) == 4 {
			got, err := strconv.Atoi(splits[3])
			if err == nil {
				page = int(got)
			}
		}
		pagesize := 100
		rows, err := db.Queryx(
			"select track.* from genreRank left join track on genreRank.track = track.id where sort = $1 and \"primary\" = $2 and secondary = $3 order by date desc, rank desc offset $4 limit $5",
			sort,
			topcat,
			subcat,
			page*pagesize,
			pagesize,
		)
		if err != nil {
			logrus.Errorf("Failed to query ranks: %+v", err)
			RetE("Internal error")
			return
		}
		defer rows.Close()
		tracks := []track{}
		for rows.Next() {
			var track0 track
			err = rows.StructScan(&track0)
			if err != nil {
				logrus.Errorf("Failed to scan track result: %+v", err)
				RetE("Internal error")
				return
			}
			tracks = append(tracks, track0)
		}
		nextpage := page + 1
		RetJSON(w, TracksRet{
			Next:   fmt.Sprintf("/api/genrerank/%v/%v/%v/%v", sort, topcat, subcat, nextpage),
			Tracks: tracks,
		})
	})

	logrus.Infof("Starting on %v\n", listenstring)
	err = http.ListenAndServe(listenstring, nil)
	if err != nil {
		logrus.Errorf("Http server exited with error: %s", err)
	}
	logrus.Tracef("The end")
}
