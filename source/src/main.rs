use {
    chrono::Utc,
    good_ormning::{
        good_module,
        sqlite::good_query,
    },
    http::Response,
    htwrap::{
        handler,
        htserve::{
            handler::{
                PathRouter,
                root_handle_http,
            },
            responses::{
                Body,
                body_full,
                response_200,
                response_200_json,
                response_400,
                response_404,
                response_503,
            },
        },
    },
    loga::{
        ErrContext,
        Log,
        ResultContext,
        ea,
    },
    mime_guess::from_path,
    reqwest::Client,
    rusqlite::vtab::array,
    rust_embed::RustEmbed,
    serde::{
        Deserialize,
        Serialize,
    },
    serde_json::Value,
    std::{
        collections::HashMap,
        sync::{
            Arc,
            Mutex,
            atomic::{
                AtomicBool,
                Ordering,
            },
        },
    },
    tokio::{
        net::TcpListener,
        task::spawn_blocking,
        time::{
            Duration,
            sleep,
        },
    },
    unicode_normalization::UnicodeNormalization,
    urlencoding,
};

good_module!(pub dbm);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct Sort {
    value: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct Subgenre {
    value: String,
    norm_name: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct Genre {
    value: String,
    norm_name: String,
    name: String,
    id: i64,
    sub: Vec<Subgenre>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct CountRow {
    sort: String,
    #[serde(rename = "primary")]
    genre: String,
    secondary: String,
    location: i64,
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct TrackOut {
    id: i64,
    art_id: String,
    featured_track_id: i64,
    location: String,
    primary_text: String,
    secondary_text: String,
    #[serde(rename = "type")]
    track_type: String,
    url_hints_slug: String,
    url_hints_subdomain: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct TracksRet {
    next: String,
    tracks: Vec<TrackOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct ErrorRet {
    error: String,
}

struct ScrapeState {
    done: bool,
    genre_rank: i32,
    page: i32,
}

struct State {
    log: loga::Log,
    db: Arc<Mutex<rusqlite::Connection>>,
    http_client: Client,
    sorts: Vec<Sort>,
    genres: Vec<Genre>,
    locations_id_to_name: Arc<[Option<String>]>,
    locations_raw_to_id: HashMap<String, i32>,
    is_scraping: Arc<AtomicBool>,
}

fn suss_location(t: &str, raw_to_id: &HashMap<String, i32>) -> i32 {
    let parts: Vec<String> = t.split(',').map(|part| {
        let normalized: String =
            part
                .trim()
                .to_lowercase()
                .nfd()
                .filter(
                    |c| !matches!(
                        *c,
                        '\u{0300}'..= '\u{036F}' | '\u{1AB0}'..= '\u{1AFF}' | '\u{1DC0}'..= '\u{1DFF}' | '\u{20D0}'..= '\u{20FF}' | '\u{FE20}'..= '\u{FE2F}'
                    ),
                )
                .collect();
        let mut p = normalized.as_str();
        for prefix in &["the ", "federated states of ", "kingdom of ", "republic of "] {
            if let Some(stripped) = p.strip_prefix(prefix) {
                p = stripped;
            }
        }
        let mut p = p.to_string();
        for suffix in &[" prefecture", " city"] {
            if let Some(stripped) = p.strip_suffix(suffix) {
                p = stripped.to_string();
            }
        }
        return p.replace('.', "").replace('-', "");
    }).collect();
    let key = parts.join(",");
    return *raw_to_id.get(&key).unwrap_or(&0);
}

async fn do_get_json(log: &Log, client: &Client, url: &str) -> Option<Value> {
    let mut last_err = loga::err("No attempts made");
    for _ in 0 .. 3usize {
        match client.get(url).send().await {
            Err(e) => {
                last_err = loga::err(e.to_string());
            },
            Ok(resp) => match resp.json::<Value>().await {
                Err(e) => {
                    last_err = loga::err(e.to_string());
                },
                Ok(v) => return Some(v),
            },
        }
    }
    log.log_err(loga::WARN, last_err.context_with("Retries exhausted fetching", ea!(url = url)));
    return None;
}

async fn scrape_inner(log: &Log, state: &Arc<State>) {
    let date = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    log.log_with(loga::INFO, "Deleting old data", ea!(date = date));
    {
        let db = state.db.clone();
        match spawn_blocking(move || {
            let mut db = db.lock().map_err(|_| loga::err("DB mutex poisoned"))?;
            good_query!(
                r#"delete from "genrerank"
                        where ("genre", "secondary", "sort", "track") in (
                            select "genre", "secondary", "sort", "track" from (
                                select 
                                    "genrerank"."genre" as "genre", 
                                    "genrerank"."secondary" as "secondary", 
                                    "genrerank"."sort" as "sort", 
                                    "genrerank"."track" as "track", 
                                    row_number()
                                    over (
                                        partition by 
                                            "genrerank"."genre", 
                                            "genrerank"."secondary", 
                                            "genrerank"."sort", 
                                            "track"."location" 
                                        order by 
                                            "genrerank"."date" desc, 
                                            "genrerank"."rank" desc
                                    )
                                    as "rn"
                                    from "genrerank"
                                left join "track" on "genrerank"."track" = "track"."id"
                            )
                            where "rn" > ?1
                        )
                "#;
                dbm::Db1(&mut *db),
                p1: i64 = 5000i64
            ).context("Failed to delete pruned genrerank rows")?;
            good_query!(
                r#"delete from "track" where "id" not in (select distinct "track" from "genrerank")"#;
                dbm::Db1(&mut *db)
            ).context("Failed to delete orphan tracks")?;
            return Ok(()) as Result<(), loga::Error>;
        }).await {
            Ok(Ok(())) => { },
            Ok(Err(e)) => log.log_err(loga::WARN, e.context("Prune failed")),
            Err(e) => log.log_err(loga::WARN, loga::err(format!("Prune task failed: {}", e))),
        }
    }
    log.log_with(loga::INFO, "Starting scrape", ea!(date = date));
    let mut pages: HashMap<String, ScrapeState> = HashMap::new();
    for _page_i in 0 .. 2usize {
        for sort in &["top", "new", "rec"] {
            for topcat in &state.genres {
                let all_key = format!("{}/{}", sort, topcat.value);
                let all_url =
                    format!(
                        "https://bandcamp.com/api/discover/3/get_web?g={}&s={}&p={{page}}&gn=0&f=all&w=0",
                        urlencoding::encode(&topcat.value),
                        sort,
                    );
                if rankpage(log, state, &mut pages, date, &all_key, &all_url, sort, &topcat.value, "other").await {
                    sleep(Duration::from_secs(30)).await;
                }
                for subcat in &topcat.sub {
                    let sub_key = format!("{}/{}", all_key, subcat.value);
                    let sub_url =
                        format!(
                            "https://bandcamp.com/api/discover/3/get_web?g={}&t={}&s={}&p={{page}}&gn=0&f=all&w=0",
                            urlencoding::encode(&topcat.value),
                            urlencoding::encode(&subcat.value),
                            sort,
                        );
                    if rankpage(
                        log,
                        state,
                        &mut pages,
                        date,
                        &sub_key,
                        &sub_url,
                        sort,
                        &topcat.value,
                        &subcat.value,
                    ).await {
                        sleep(Duration::from_secs(30)).await;
                    }
                }
            }
        }
    }
    let db = state.db.clone();
    match spawn_blocking(move || {
        let db = db.lock().map_err(|_| loga::err("DB mutex poisoned"))?;
        db.execute_batch("VACUUM").context("Vacuum failed")?;
        return Ok(()) as Result<(), loga::Error>;
    }).await {
        Ok(Ok(())) => { },
        Ok(Err(e)) => log.log_err(loga::WARN, e),
        Err(e) => log.log_err(loga::WARN, loga::err(format!("Vacuum task failed: {}", e))),
    }
}

async fn rankpage(
    log: &Log,
    state: &Arc<State>,
    pages: &mut HashMap<String, ScrapeState>,
    date: i64,
    state_key: &str,
    url_template: &str,
    sort: &str,
    topcat: &str,
    subcat: &str,
) -> bool {
    let page_state = pages.entry(state_key.to_string()).or_insert(ScrapeState {
        done: false,
        genre_rank: 0,
        page: 0,
    });
    if page_state.done {
        return false;
    }
    let url = url_template.replace("{page}", &page_state.page.to_string());
    let prev_genre_rank = page_state.genre_rank;
    let mut genre_rank = page_state.genre_rank;
    log.log_with(loga::DEBUG, "Fetching", ea!(url = url));
    let data = match do_get_json(log, &state.http_client, &url).await {
        Some(v) => v,
        None => return true,
    };
    let items = match data.get("items").and_then(|v| v.as_array()) {
        Some(v) => v.clone(),
        None => {
            log.log_err(loga::WARN, loga::err_with("Response missing items array", ea!(url = url)));
            return true;
        },
    };
    for item in &items {
        let item_type = match item.get("type").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => continue,
        };
        if item_type != "a" {
            log.log_with(loga::INFO, "Unhandled item type", ea!(item_type = item_type));
            continue;
        }
        let track_id = match item.get("id").and_then(|v| v.as_f64()).map(|v| v as i64) {
            Some(v) => v,
            None => {
                log.log_err(loga::WARN, loga::err_with("Item missing id", ea!(item = item.to_string())));
                continue;
            },
        };
        let art_id = match item.get("art_id").and_then(|v| v.as_f64()).map(|v| v as i64) {
            Some(v) => v,
            None => {
                log.log_err(loga::WARN, loga::err_with("Item missing art_id", ea!(track_id = track_id)));
                continue;
            },
        };
        let featured_track_id =
            match item
                .get("featured_track")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_f64())
                .map(|v| v as i64) {
                Some(v) => v,
                None => {
                    log.log_err(
                        loga::WARN,
                        loga::err_with("Item missing featured_track.id", ea!(track_id = track_id)),
                    );
                    continue;
                },
            };
        let location_text: Option<String> =
            item.get("location_text").and_then(|v| v.as_str()).map(|s| s.to_string());
        let location = location_text.as_deref().map(|t| suss_location(t, &state.locations_raw_to_id)).unwrap_or(0);
        let primary_text = match item.get("primary_text").and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => {
                log.log_err(loga::WARN, loga::err_with("Item missing primary_text", ea!(track_id = track_id)));
                continue;
            },
        };
        let secondary_text = match item.get("secondary_text").and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => {
                log.log_err(loga::WARN, loga::err_with("Item missing secondary_text", ea!(track_id = track_id)));
                continue;
            },
        };
        let url_hints_slug = match item.get("url_hints").and_then(|v| v.get("slug")).and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => {
                log.log_err(loga::WARN, loga::err_with("Item missing url_hints.slug", ea!(track_id = track_id)));
                continue;
            },
        };
        let url_hints_subdomain =
            match item.get("url_hints").and_then(|v| v.get("subdomain")).and_then(|v| v.as_str()) {
                Some(v) => v.to_string(),
                None => {
                    log.log_err(
                        loga::WARN,
                        loga::err_with("Item missing url_hints.subdomain", ea!(track_id = track_id)),
                    );
                    continue;
                },
            };
        let db = state.db.clone();
        let sort2 = sort.to_string();
        let topcat2 = topcat.to_string();
        let subcat2 = subcat.to_string();
        match spawn_blocking(move || {
            let mut db = db.lock().map_err(|_| loga::err("DB mutex poisoned"))?;
            good_query!(
                r#"
                    insert into "track"
                        (
                            "id", 
                            "art_id", 
                            "featured_track_id", 
                            "location_text", 
                            "location", 
                            "primary_text", 
                            "secondary_text", 
                            "type", 
                            "url_hints_slug", 
                            "url_hints_subdomain"
                        )
                        values (
                            $id, 
                            $art_id, 
                            $featured_track_id, 
                            $location_text, 
                            $location, 
                            $primary_text, 
                            $secondary_text, 
                            'a', 
                            $url_hints_debug, 
                            $url_hints_subdomain
                        )
                    on conflict do nothing
                "#;
                dbm::Db1(&mut *db),
                id: i64 = track_id,
                art_id: i64 = art_id,
                featured_track_id: i64 = featured_track_id,
                location_text: opt string = location_text.as_deref(),
                location: i32 = location,
                primary_text: string = & primary_text,
                secondary_text: string = & secondary_text,
                url_hints_debug: string = & url_hints_slug,
                url_hints_subdomain: string = & url_hints_subdomain
            ).context("Failed to insert track")?;
            good_query!(
                r#"
                    insert into "genrerank"
                        (
                            "date", 
                            "genre", 
                            "secondary", 
                            "sort", 
                            "rank", 
                            "track"
                        )
                        values (
                            $date,
                            $genre,
                            $secondary,
                            $sort,
                            $rank,
                            $track
                        )
                    on conflict ("genre", "secondary", "sort", "track")
                        do update set "date" = $date, "rank" = $rank
                "#;
                dbm::Db1(&mut *db),
                date: i64 = date,
                genre: string = & topcat2,
                secondary: string = & subcat2,
                sort: string = & sort2,
                rank: i32 = genre_rank,
                track: i64 = track_id
            ).context("Failed to insert genrerank")?;
            return Ok(()) as Result<(), loga::Error>;
        }).await {
            Ok(Ok(())) => { },
            Ok(Err(e)) => {
                log.log_err(loga::WARN, e.context("DB insert failed"));
                return true;
            },
            Err(e) => {
                log.log_err(loga::WARN, loga::err(format!("DB insert task failed: {}", e)));
                return true;
            },
        }
        genre_rank += 1;
    }
    page_state.page += 1;
    if genre_rank == prev_genre_rank {
        page_state.done = true;
    }
    page_state.genre_rank = genre_rank;
    return true;
}

fn serve_static(subpath: &str) -> Response<Body> {
    let path = subpath.trim_start_matches('/');
    let path = if path.is_empty() {
        "index.html"
    } else {
        path
    };

    #[derive(RustEmbed)]
    #[folder = "$STATIC_DIR"]
    struct StaticAssets;

    let Some(content) = StaticAssets::get(path) else {
        return response_404();
    };
    let mime = from_path(path).first_or_octet_stream();
    return Response::builder()
        .status(200)
        .header("content-type", mime.as_ref())
        .body(body_full(content.data.into_owned()))
        .unwrap();
}

fn location_name(id_to_name: &[Option<String>], id: i32) -> String {
    return id_to_name.get(id as usize).and_then(|v| v.as_deref()).unwrap_or("").to_string();
}

#[tokio::main]
async fn main() {
    let log = Log::new().fork(ea!(source = "bandhiking"));
    let sorts: Vec<Sort> = serde_json::from_str(include_str!("./sorts.json")).expect("Failed to parse sorts.json");
    let genres: Vec<Genre> =
        serde_json::from_str(include_str!("./genres.json")).expect("Failed to parse genres.json");
    let raw_to_id_data: HashMap<String, i32> =
        serde_json::from_str(
            include_str!("locations_raw_to_id.json"),
        ).expect("Failed to parse locations_raw_to_id.json");
    let id_to_name_pairs: Vec<(i32, String)> =
        serde_json::from_str(
            include_str!("locations_id_to_name.json"),
        ).expect("Failed to parse locations_id_to_name.json");
    let max_id = id_to_name_pairs.iter().map(|(id, _)| *id).max().unwrap_or(0) as usize;
    let mut id_to_name_vec: Vec<Option<String>> = vec![
        None;
        max_id + 1
    ];
    for (id, name) in id_to_name_pairs {
        id_to_name_vec[id as usize] = Some(name);
    }
    let id_to_name: Arc<[Option<String>]> = id_to_name_vec.into();
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "bandhiking.db".to_string());
    let mut conn = rusqlite::Connection::open(&db_path).expect("Failed to open database");
    array::load_module(&conn).expect("Failed to load array module");
    conn.execute_batch("PRAGMA journal_mode=WAL").expect("Failed to set WAL mode");
    dbm::migrate(&mut conn, None).expect("Failed to migrate database");
    let db = Arc::new(Mutex::new(conn));
    let http_client =
        reqwest::Client::builder()
            .user_agent("https://gitlab.com/andrewbaxter/bandhiking")
            .build()
            .expect("Failed to build HTTP client");
    let state = Arc::new(State {
        log: log.clone(),
        db: db,
        http_client: http_client,
        sorts: sorts,
        genres: genres,
        locations_id_to_name: id_to_name,
        locations_raw_to_id: raw_to_id_data,
        is_scraping: Arc::new(AtomicBool::new(false)),
    });

    // Daily scrape cron
    {
        let state = state.clone();
        let log = log.clone();
        tokio::spawn(async move {
            loop {
                let now = Utc::now();
                let next_midnight =
                    (now.date_naive() + chrono::Duration::days(1)).and_hms_opt(0, 0, 0).unwrap().and_utc();
                let secs = (next_midnight - now).num_seconds().max(0) as u64;
                sleep(Duration::from_secs(secs)).await;
                if !state.is_scraping.swap(true, Ordering::SeqCst) {
                    scrape_inner(&log, &state).await;
                    state.is_scraping.store(false, Ordering::SeqCst);
                }
            }
        });
    }
    let mut router: PathRouter<Body> = PathRouter::default();

    // Static file catch-all
    router.insert("", Box::new(handler!(()(args -> Body) serve_static(args.subpath)))).unwrap();

    // Scrape trigger
    {
        let state = state.clone();
        router.insert("/scrape", Box::new(handler!((state: Arc < State >)(args -> Body) {
            if !args.subpath.is_empty() {
                return response_404();
            }
            if !state.is_scraping.swap(true, Ordering::SeqCst) {
                let state = state.clone();
                let log = Log::new().fork(ea!(source = "scrape"));
                tokio::spawn(async move {
                    scrape_inner(&log, &state).await;
                    state.is_scraping.store(false, Ordering::SeqCst);
                });
            }
            response_200()
        }))).unwrap();
    }

    // /count
    {
        let state = state.clone();
        router.insert("/count", Box::new(handler!((state: Arc < State >)(args -> Body) {
            if !args.subpath.is_empty() {
                return response_404();
            }
            let db = state.db.clone();
            let rows = match spawn_blocking(move || {
                let mut db = db.lock().map_err(|_| loga::err("DB mutex poisoned"))?;
                let rows = good_ormning::sqlite::good_query_many!(
                    r#"
                        select 
                            "genrerank"."sort" as "sort", 
                            "genrerank"."genre" as "genre", 
                            "genrerank"."secondary" as "secondary", 
                            "track"."location" as "location", 
                            count(1) as "count" 
                        from "genrerank"
                        inner join 
                            "track" on "genrerank"."track" = "track"."id" 
                        group by 
                            "genrerank"."sort", 
                            "genrerank"."genre", 
                            "genrerank"."secondary", 
                            "track"."location"
                    "#;
                    dbm::Db1(&mut *db)
                ).context("Count query failed")?;
                return Ok(rows.into_iter().map(|row| CountRow {
                    sort: row.sort,
                    genre: row.genre,
                    secondary: row.secondary,
                    location: row.location as i64,
                    count: row.count,
                }).collect(),) as Result<Vec<CountRow>, loga::Error>;
            }).await {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    state.log.log_err(loga::WARN, e.context("DB error"));
                    return response_503();
                },
                Err(e) => {
                    state.log.log_err(loga::WARN, e.context("Task error"));
                    return response_503();
                },
            };
            response_200_json(&rows)
        }))).unwrap();
    }

    // /api/sorts
    {
        let state = state.clone();
        router.insert("/api/sorts", Box::new(handler!((state: Arc < State >)(args -> Body) {
            if !args.subpath.is_empty() {
                return response_404();
            }
            response_200_json(&state.sorts)
        }))).unwrap();
    }

    // /api/genres
    {
        let state = state.clone();
        router.insert("/api/genres", Box::new(handler!((state: Arc < State >)(args -> Body) {
            if !args.subpath.is_empty() {
                return response_404();
            }
            response_200_json(&state.genres)
        }))).unwrap();
    }

    // /api/locations
    {
        let state = state.clone();
        router.insert("/api/locations", Box::new(handler!((state: Arc < State >)(args -> Body) {
            if !args.subpath.is_empty() {
                return response_404();
            }
            let map: HashMap<usize, &str> =
                state
                    .locations_id_to_name
                    .iter()
                    .enumerate()
                    .filter_map(|(i, v)| v.as_deref().map(|name| (i, name)))
                    .collect();
            response_200_json(&map)
        }))).unwrap();
    }

    // /api/embed/
    {
        let state = state.clone();
        router.insert("/api/embed/", Box::new(handler!((state: Arc < State >)(args -> Body) {
            let keys: Vec<&str> = args.subpath.splitn(2, "~~~").collect();
            if keys.len() < 2 {
                return response_400("Missing ~~~ separator");
            }
            let embed_url =
                format!(
                    "https://bandcamp.com/EmbeddedPlayer/album={}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/track={}/transparent=true/",
                    keys[0],
                    keys[1],
                );
            let client = state.http_client.clone();
            match client.get(&embed_url).send().await {
                Err(e) => {
                    state.log.log_err(loga::WARN, e.context("Upstream request failed"));
                    return response_503();
                },
                Ok(resp) => match resp.bytes().await {
                    Err(e) => {
                        state.log.log_err(loga::WARN, e.context("Failed to read upstream body on embed"));
                        return response_503()
                    },
                    Ok(body) => Response::builder()
                        .status(200)
                        .header("content-type", "text/html")
                        .body(body_full(body.to_vec()))
                        .unwrap(),
                },
            }
        }))).unwrap();
    }

    // /api/genrerank/
    {
        let state = state.clone();
        router.insert("/api/genrerank/", Box::new(handler!((state: Arc < State >)(args -> Body) {
            let parts: Vec<&str> = args.subpath.splitn(4, '/').collect();
            if parts.len() < 2 {
                return response_200_json(&ErrorRet { error: "Not enough key params".to_string() });
            }
            let sort = parts[0].to_string();
            let topcat = parts[1].to_string();
            let subcat: Option<String> = parts.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string());
            let page: i64 = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0i64);
            let pagesize: i64 = 100;
            let offset = page * pagesize;
            let raw_loc = args.query.split('&').find_map(|kv| kv.strip_prefix("l=")).map(|s| s.to_string());
            let loc_ids: Option<Vec<i32>> = match &raw_loc {
                None => None,
                Some(raw) => {
                    let mut ids = vec![];
                    for part in raw.split(',') {
                        match part.parse::<i32>() {
                            Ok(id) => ids.push(id),
                            Err(_) => {
                                return response_200_json(&ErrorRet { error: "Bad location values".to_string() });
                            },
                        }
                    }
                    Some(ids)
                },
            };
            let sort_url = sort.clone();
            let topcat_url = topcat.clone();
            let db = state.db.clone();
            let id_to_name = state.locations_id_to_name.clone();
            let tracks = match spawn_blocking(move || {
                let mut db = db.lock().map_err(|_| loga::err("DB mutex poisoned"))?;
                let tracks: Vec<TrackOut> = match (subcat, loc_ids) {
                    (None, None) => {
                        good_ormning::sqlite::good_query_many!(
                            r#"
                                select 
                                    "id" as "id",
                                    "art_id" as "art_id", 
                                    "featured_track_id" as "featured_track_id", 
                                    "location" as "location", 
                                    "primary_text" as "primary_text", 
                                    "secondary_text" as "secondary_text", 
                                    "track_type" as "track_type", 
                                    "url_hints_slug" as "url_hints_slug", 
                                    "url_hints_subdomain" as "url_hints_subdomain"
                                from (
                                    select 
                                        "track"."id" as "id", 
                                        "track"."art_id" as "art_id", 
                                        "track"."featured_track_id" as "featured_track_id", 
                                        "track"."location" as "location", 
                                        "track"."primary_text" as "primary_text", 
                                        "track"."secondary_text" as "secondary_text", 
                                        "track"."type" as "track_type", 
                                        "track"."url_hints_slug" as "url_hints_slug", 
                                        "track"."url_hints_subdomain" as "url_hints_subdomain", 
                                        row_number()
                                    over (
                                        order by 
                                            "genrerank"."date" desc, 
                                            "genrerank"."rank" desc
                                    ) as "rn"
                                    from "genrerank"
                                    inner join "track"
                                        on "genrerank"."track" = "track"."id"
                                    where "genrerank"."sort" = ?1 and "genrerank"."genre" = ?2
                                ) as "rows"
                                where "rn" > ?3 and "rn" <= ?4
                            "#;
                            dbm::Db1(&mut *db),
                            p1: string = & sort,
                            p2: string = & topcat,
                            p3: i64 = offset,
                            p4: i64 = offset + pagesize
                        ).context("DB query failed")?.into_iter().map(|row| {
                            row_to_track_out(
                                row.id,
                                row.art_id,
                                row.featured_track_id,
                                row.location,
                                row.primary_text,
                                row.secondary_text,
                                row.track_type,
                                row.url_hints_slug,
                                row.url_hints_subdomain,
                                &id_to_name,
                            )
                        }).collect()
                    },
                    (None, Some(locs)) => {
                        good_ormning::sqlite::good_query_many!(
                            r#"
                                select 
                                    "id" as "id", 
                                    "art_id" as "art_id", 
                                    "featured_track_id" as "featured_track_id", 
                                    "location" as "location", 
                                    "primary_text" as "primary_text", 
                                    "secondary_text" as "secondary_text", 
                                    "track_type" as "track_type", 
                                    "url_hints_slug" as "url_hints_slug", 
                                    "url_hints_subdomain" as "url_hints_subdomain" 
                                from (
                                    select 
                                        "track"."id" as "id", 
                                        "track"."art_id" as "art_id", 
                                        "track"."featured_track_id" as "featured_track_id", 
                                        "track"."location" as "location", 
                                        "track"."primary_text" as "primary_text", 
                                        "track"."secondary_text" as "secondary_text", 
                                        "track"."type" as "track_type", 
                                        "track"."url_hints_slug" as "url_hints_slug", 
                                        "track"."url_hints_subdomain" as "url_hints_subdomain", 
                                        row_number()
                                    over (
                                        order by 
                                            "genrerank"."date" desc, 
                                            "genrerank"."rank" desc
                                        ) as "rn"
                                    from "genrerank"
                                    inner join "track"
                                        on "genrerank"."track" = "track"."id"
                                    where 
                                        "genrerank"."sort" = $sort
                                        and "genrerank"."genre" = $topcat
                                        and "track"."location" in (
                                            select value from rarray($loc)
                                        )
                                ) as "rows"
                                where "rn" > $after and "rn" <= $until
                            "#;
                            dbm::Db1(&mut *db),
                            sort: string = & sort,
                            topcat: string = & topcat,
                            loc: arr i32 = locs,
                            after: i64 = offset,
                            until: i64 = offset + pagesize
                        ).context("DB query failed")?.into_iter().map(|row| {
                            row_to_track_out(
                                row.id,
                                row.art_id,
                                row.featured_track_id,
                                row.location,
                                row.primary_text,
                                row.secondary_text,
                                row.track_type,
                                row.url_hints_slug,
                                row.url_hints_subdomain,
                                &id_to_name,
                            )
                        }).collect()
                    },
                    (Some(sub), None) => {
                        good_ormning::sqlite::good_query_many!(
                            r#"
                                select 
                                    "id" as "id", 
                                    "art_id" as "art_id", 
                                    "featured_track_id" as "featured_track_id", 
                                    "location" as "location", 
                                    "primary_text" as "primary_text", 
                                    "secondary_text" as "secondary_text", 
                                    "track_type" as "track_type", 
                                    "url_hints_slug" as "url_hints_slug", 
                                    "url_hints_subdomain" as "url_hints_subdomain"
                                from (
                                    select 
                                        "track"."id" as "id", 
                                        "track"."art_id" as "art_id", 
                                        "track"."featured_track_id" as "featured_track_id", 
                                        "track"."location" as "location", 
                                        "track"."primary_text" as "primary_text", 
                                        "track"."secondary_text" as "secondary_text", 
                                        "track"."type" as "track_type", 
                                        "track"."url_hints_slug" as "url_hints_slug", 
                                        "track"."url_hints_subdomain" as "url_hints_subdomain", 
                                        row_number() over (
                                            order by 
                                                "genrerank"."date" desc, 
                                                "genrerank"."rank" desc
                                            ) as "rn" 
                                        from "genrerank" 
                                        inner join "track" 
                                            on "genrerank"."track" = "track"."id" 
                                        where 
                                            "genrerank"."sort" = $sort
                                            and "genrerank"."genre" = $topcat
                                            and "genrerank"."secondary" = $sub
                                ) as "rows" 
                                where "rn" > $page_gt and "rn" <= $page_lte"#;
                            dbm::Db1(&mut *db),
                            sort: string = & sort,
                            topcat: string = & topcat,
                            sub: string = & sub,
                            page_gt: i64 = offset,
                            page_lte: i64 = offset + pagesize
                        ).context("DB query failed")?.into_iter().map(|row| {
                            row_to_track_out(
                                row.id,
                                row.art_id,
                                row.featured_track_id,
                                row.location,
                                row.primary_text,
                                row.secondary_text,
                                row.track_type,
                                row.url_hints_slug,
                                row.url_hints_subdomain,
                                &id_to_name,
                            )
                        }).collect()
                    },
                    (Some(sub), Some(locs)) => {
                        good_ormning::sqlite::good_query_many!(
                            r#"
                                select 
                                    "id" as "id", 
                                    "art_id" as "art_id", 
                                    "featured_track_id" as "featured_track_id", 
                                    "location" as "location", 
                                    "primary_text" as "primary_text", 
                                    "secondary_text" as "secondary_text", 
                                    "track_type" as "track_type", 
                                    "url_hints_slug" as "url_hints_slug", 
                                    "url_hints_subdomain" as "url_hints_subdomain" 
                                from (
                                    select "track"."id" as "id", 
                                        "track"."art_id" as "art_id", 
                                        "track"."featured_track_id" as "featured_track_id", 
                                        "track"."location" as "location", 
                                        "track"."primary_text" as "primary_text", 
                                        "track"."secondary_text" as "secondary_text", 
                                        "track"."type" as "track_type", 
                                        "track"."url_hints_slug" as "url_hints_slug", 
                                        "track"."url_hints_subdomain" as "url_hints_subdomain", 
                                        row_number()
                                    over (
                                        order by 
                                            "genrerank"."date" desc, 
                                            "genrerank"."rank" desc
                                    ) as "rn" 
                                    from "genrerank" 
                                    inner join "track" on "genrerank"."track" = "track"."id" 
                                    where 
                                        "genrerank"."sort" = $sort and 
                                        "genrerank"."genre" = $genre and
                                        "genrerank"."secondary" = $secondary and 
                                        "track"."location" in (
                                            select value from rarray($loc)
                                        )
                                ) as "rows" 
                                where 
                                    "rn" > $page_gt and 
                                    "rn" <= $page_lte
                                "#;
                            dbm::Db1(&mut *db),
                            sort: string = & sort,
                            genre: string = & topcat,
                            secondary: string = & sub,
                            loc: arr i32 = locs,
                            page_gt: i64 = offset,
                            page_lte: i64 = offset + pagesize
                        ).context("DB query failed")?.into_iter().map(|row| {
                            row_to_track_out(
                                row.id,
                                row.art_id,
                                row.featured_track_id,
                                row.location,
                                row.primary_text,
                                row.secondary_text,
                                row.track_type,
                                row.url_hints_slug,
                                row.url_hints_subdomain,
                                &id_to_name,
                            )
                        }).collect()
                    },
                };
                return Ok(tracks) as Result<Vec<TrackOut>, loga::Error>;
            }).await {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    state.log.log_err(loga::WARN, e.context("DB error"));
                    return response_503();
                },
                Err(e) => {
                    state.log.log_err(loga::WARN, e.context("Task error"));
                    return response_503();
                },
            };
            let next_page = page + 1;
            let next = match (&parts.get(2).filter(|s| !s.is_empty()), &raw_loc) {
                (None, None) => format!("/api/genrerank/{}/{}/{}", sort_url, topcat_url, next_page),
                (None, Some(l)) => {
                    format!("/api/genrerank/{}/{}/{}?l={}", sort_url, topcat_url, next_page, l)
                },
                (Some(sub), None) => {
                    format!("/api/genrerank/{}/{}/{}/{}", sort_url, topcat_url, sub, next_page)
                },
                (Some(sub), Some(l)) => {
                    format!("/api/genrerank/{}/{}/{}/{}?l={}", sort_url, topcat_url, sub, next_page, l)
                },
            };
            response_200_json(&TracksRet {
                next: next,
                tracks: tracks
            })
        }))).unwrap();
    }
    let listen = std::env::var("LISTEN").unwrap_or_else(|_| ":8080".to_string());
    let listen_addr = if let Some(port) = listen.strip_prefix(':') {
        format!("0.0.0.0:{}", port)
    } else {
        listen.clone()
    };
    log.log_with(loga::INFO, "Starting", ea!(listen = listen));
    let listener = TcpListener::bind(&listen_addr).await.expect("Failed to bind listener");
    let router = Arc::new(router);
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                log.log_err(loga::WARN, loga::err(format!("Accept error: {}", e)));
                continue;
            },
        };
        let router = router.clone();
        let log = log.clone();
        tokio::spawn(async move {
            root_handle_http(&log, router, stream).await.ok();
        });
    }
}

fn row_to_track_out(
    id: i64,
    art_id: i64,
    featured_track_id: i64,
    location: i32,
    primary_text: String,
    secondary_text: String,
    track_type: String,
    url_hints_slug: String,
    url_hints_subdomain: String,
    id_to_name: &[Option<String>],
) -> TrackOut {
    return TrackOut {
        id: id,
        art_id: art_id.to_string(),
        featured_track_id: featured_track_id,
        location: location_name(id_to_name, location),
        primary_text: primary_text,
        secondary_text: secondary_text,
        track_type: track_type,
        url_hints_slug: url_hints_slug,
        url_hints_subdomain: url_hints_subdomain,
    };
}
