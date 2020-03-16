package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"strconv"
	"strings"
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
	TrackID int64  `json:"trackId"`
	ArtURL  string `json:"artUrl"`
	URL     string `json:"url"`
	Name    string `json:"name"`
	Artist  string `json:"artist"`
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

	platform, err := psh.NewRuntimeConfig()
	if err != nil {
		panic("Not in a Platform.sh Environment.")
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

	dbstring0, err := platform.Credentials("postgresdatabase")
	if err != nil {
		logrus.Fatalf("Failed to get Platform db credentials string: %v", err)
	}
	dbstring, err := pshsql.FormattedCredentials(dbstring0)
	if err != nil {
		logrus.Fatalf("Failed to format Platform db credentials string: %v", err)
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
					"create table track (trackId bigint primary key, artUrl text, url text, name text, artist text)",
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
		// Handle errors!
	}

	myhttp := resty.New()
	myhttp.SetRetryCount(3)
	scrape := func() {
		date := time.Now()
		logrus.Tracef("Scraping, %v", date)

		rankpage := func(url string, rank int, sort string, topcat string, subcat string) int {
			logrus.Tracef("Fetching %v", url)
			res, err := myhttp.R().SetDoNotParseResponse(true).Get(url)
			if err != nil {
				logrus.Errorf("Failed to request page %v; %+v", url, err)
				return rank
			}
			data, err := gabs.ParseJSONBuffer(res.RawBody())
			if err != nil {
				logrus.Warnf("Failed to read response on %v: %+v", url, err)
				return rank
			}
			for _, trackdata := range data.Search("items").Children() {
				_type := trackdata.S("type").Data().(string)
				if _type != "a" {
					bytes, err := trackdata.MarshalJSON()
					if err != nil {
						logrus.Fatalf("Failed to reencode json, shouldn't happen; %+v", err)
					}
					logrus.Infof("Unhandled item type %v: %v", _type, string(bytes))
					continue
				}
				trackID := trackdata.Search("featured_track", "id").Data()
				artID := trackdata.Search("id").Data()
				name := trackdata.Search("primary_text").Data()
				artist := trackdata.Search("secondary_text").Data()
				urlSubdomain := trackdata.S("url_hints", "subdomain").Data()
				urlSlug := trackdata.S("url_hints", "slug").Data()
				if trackID == nil || artID == nil || name == nil || artist == nil || urlSubdomain == nil ||
					urlSlug == nil {
					logrus.Errorf("Failed to extract expected data from track: %+v", trackdata)
					continue
				}
				artURL := fmt.Sprintf(
					"https://f4.bcbits.com/img/%v%v_42.jpg",
					_type,
					int64(artID.(float64)),
				)
				url := fmt.Sprintf(
					"https://%v.bandcamp.com/album/%v",
					urlSubdomain,
					urlSlug,
				)
				track0 := track{
					TrackID: int64(trackID.(float64)),
					ArtURL:  artURL,
					URL:     url,
					Name:    name.(string),
					Artist:  artist.(string),
				}
				rows, err := db.Query(
					"insert into track (trackId, artUrl, url, name, artist) values ($1, $2, $3, $4, $5) on conflict (trackId) do nothing returning 1",
					int64(trackID.(float64)),
					artURL,
					url,
					name,
					artist,
				)
				if err != nil {
					logrus.Errorf("Failed to create track record; %+v", err)
					return -1
				}
				defer rows.Close()
				if rows.Next() {
					_, err = db.Exec(
						"insert into genreRank (date, \"primary\", secondary, sort, rank, track) values ($1, $2, $3, $4, $5, $6)",
						date,
						topcat,
						subcat,
						sort,
						int32(rank),
						track0.TrackID,
					)
					if err != nil {
						logrus.Errorf("Failed to create track rank record; %+v", err)
						return -1
					}
				}
				rank++
			}
			return rank
		}

		for _, sort := range []string{"top", "new", "rec"} {
			for _, topcat := range genres {
				{
					rank := 0
					for i := 0; i < 20; i++ {
						url := fmt.Sprintf(
							"https://bandcamp.com/api/discover/3/get_web?g=%v&s=%v&p=%v&gn=0&f=all&w=0",
							topcat.Value,
							sort,
							i,
						)
						rank = rankpage(url, rank, sort, topcat.Value, "all")
						time.Sleep(30 * time.Second)
					}
				}
				time.Sleep(30 * time.Second)
				for _, subcat := range topcat.Sub {
					rank := 0
					for i := 0; i < 20; i++ {
						url := fmt.Sprintf(
							"https://bandcamp.com/api/discover/3/get_web?g=%v&t=%v&s=%v&p=%v&gn=0&f=all&w=0",
							topcat.Value,
							subcat.Value,
							sort,
							i,
						)
						rank = rankpage(url, rank, sort, topcat.Value, subcat.Value)
						time.Sleep(30 * time.Second)
					}
				}
			}
		}
	}
	mycron := cron.New()
	mycron.AddFunc("@daily", scrape)
	mycron.Start()
	go scrape()

	static := http.FileServer(http.Dir("./static"))
	http.Handle("/", static)

	http.HandleFunc("/api/genres", func(w http.ResponseWriter, req *http.Request) {
		bytes, err := json.Marshal(genres)
		if err != nil {
			logrus.Errorf("Failed to serialize genres; %+v", err)
		}
		_, err = w.Write(bytes)
		if err != nil {
			logrus.Errorf("Failed to write genre json bytes; %+v", err)
		}
	})

	http.HandleFunc("/api/genrerank/", func(w http.ResponseWriter, req *http.Request) {
		var err error
		type ErrorRet struct {
			Error string `json:"error"`
		}
		RetJSON := func(v interface{}) {
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
		RetE := func(e string) {
			RetJSON(ErrorRet{
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
		logrus.Printf("query %v %v %v", sort, topcat, subcat)
		page := 0
		if len(splits) == 4 {
			got, err := strconv.Atoi(splits[3])
			if err == nil {
				page = int(got)
			}
		}
		pagesize := 100
		rows, err := db.Queryx(
			"select track.* from genreRank left join track on genreRank.track = track.trackId where sort = $1 and \"primary\" = $2 and secondary = $3 order by date desc, rank desc offset $4 limit $5",
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
		if len(tracks) < pagesize {
			nextpage = 0
		}
		RetJSON(TracksRet{
			Next:   fmt.Sprintf("/api/genrerank/%v/%v/%v/%v", sort, topcat, subcat, nextpage),
			Tracks: tracks,
		})
	})

	err = http.ListenAndServe(":"+platform.Port(), nil)
	if err != nil {
		logrus.Errorf("Http server exited with error", err)
	}
	logrus.Tracef("The end")
}
