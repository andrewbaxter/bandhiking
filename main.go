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
	_ "github.com/lib/pq"
	psh "github.com/platformsh/config-reader-go/v2"
	pshsql "github.com/platformsh/config-reader-go/v2/libpq"
	migrate "github.com/rubenv/sql-migrate"
	"github.com/sirupsen/logrus"
	"golang.org/x/net/html"
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

func searchAttr(vals *[]html.Attribute, test func(v *html.Attribute) bool) *html.Attribute {
	for _, v := range *vals {
		if test(&v) {
			return &v
		}
	}
	return nil
}

type track struct {
	ID   int64  `json:"id"`
	Blob string `json:"json"`
}

type genreRank struct {
	date      time.Time
	sort      string
	primary   string
	secondary string
	rank      int32
	track     int64
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
			logrus.Fatalf("Failed to load sorts file", err)
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
			logrus.Fatalf("Failed to load genre file", err)
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
	migrations := &migrate.MemoryMigrationSource{
		Migrations: []*migrate.Migration{
			&migrate.Migration{
				Id: "001",
				Up: []string{
					"create table track (id bigint primary key, blob json)",
					"create table genreRank (date timestamp, \"primary\" text, secondary text, sort text, rank integer, track bigint, primary key (\"primary\", secondary, sort, date, rank))",
				},
				Down: []string{"DROP TABLE track", "DROP TABLE genreRank"},
			},
		},
	}
	_, err = migrate.Exec(db.DB, "postgres", migrations, migrate.Up)
	if err != nil {
		logrus.Fatalf("Failed to migrate db: %+v", err)
		return
	}

	isScraping := struct {
		scraping int32
	}{
		scraping: 0,
	}

	myhttp := resty.New()
	myhttp.SetHeader("User-Agent", "https://gitlab.com/rendaw/bandhiking")
	myhttp.SetRetryCount(3)
	scrapeInner := func() {
		BeginningOfDay := func(t time.Time) time.Time {
			year, month, day := t.Date()
			return time.Date(year, month, day, 0, 0, 0, 0, t.Location())
		}
		date := BeginningOfDay(time.Now())
		logrus.Tracef("Starting scrape, %v", date)

		type GenreState struct {
			Done bool
			Rank int
			Page int
		}
		pages := map[string]*GenreState{}

		rankpage := func(stateKey string, url string, sort string, topcat string, subcat string) bool {
			state, ok := pages[stateKey]
			if !ok {
				state = &GenreState{
					Done: false,
					Rank: 0,
					Page: 0,
				}
				pages[stateKey] = state
			}
			if state.Done {
				return false
			}
			url = fmt.Sprintf(url, state.Page)
			rank := state.Rank
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
				_, err = db.Exec(
					"insert into track (id, blob) values ($1, $2) on conflict (id) do nothing",
					trackID,
					bytes,
				)
				if err != nil {
					logrus.Errorf("Failed to create track record; %+v", err)
					return true
				}
				_, err = db.Exec(
					"insert into genreRank (date, \"primary\", secondary, sort, rank, track) values ($1, $2, $3, $4, $5, $6) on conflict (\"primary\", secondary, sort, date, rank) do nothing",
					date,
					topcat,
					subcat,
					sort,
					int32(rank),
					trackID,
				)
				if err != nil {
					logrus.Errorf("Failed to create track rank record; %+v", err)
					return true
				}
				rank++
			}

			state.Page++
			if rank == state.Rank {
				state.Done = true
			}
			state.Rank = rank

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
	}
	scrape := func() {
		if !atomic.CompareAndSwapInt32(&isScraping.scraping, 0, 1) {
			logrus.Infof("New scrape aborted; already scraping")
			return
		}
		scrapeInner()
		atomic.StoreInt32(&isScraping.scraping, 0)
	}
	mycron := cron.New()
	mycron.AddFunc("@daily", scrape)
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

	embedPrefix := "/api/embed/"
	http.HandleFunc(embedPrefix, func(w http.ResponseWriter, req *http.Request) {
		path := strings.TrimPrefix(req.URL.Path, embedPrefix)
		keys := strings.Split(path, "~~~")
		if len(keys) == 1 {
			logrus.Errorf("Trying to proxy non-html", req.URL)
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
		w.Write(bytes)
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

	err = http.ListenAndServe(listenstring, nil)
	if err != nil {
		logrus.Errorf("Http server exited with error", err)
	}
	logrus.Tracef("The end")
}
