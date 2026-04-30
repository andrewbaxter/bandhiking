use {
    good_ormning::sqlite::{
        generate,
        schema::field::{
            field_i32,
            field_i64,
            field_str,
        },
        Version,
    },
    std::{
        collections::HashMap,
        env,
        fs,
        io::{
            self,
            BufRead,
        },
        path::Path,
    },
};

pub fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../locations/locations.go");

    // Provide fallback STATIC_DIR for local cargo check/build (nix build sets this
    // externally)
    if std::env::var("STATIC_DIR").is_err() {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let fallback = format!("{}/static", manifest_dir);
        println!("cargo:rustc-env=STATIC_DIR={}", fallback);
    }

    // Generate DB schema
    {
        let v = Version::new();
        let track = v.table("track");
        let id = track.field("id", field_i64().build());
        let _art_id = track.field("art_id", field_i64().build());
        let _featured_track_id = track.field("featured_track_id", field_i64().build());
        let _location_text = track.field("location_text", field_str().opt().build());
        let _location = track.field("location", field_i32().build());
        let _primary_text = track.field("primary_text", field_str().build());
        let _secondary_text = track.field("secondary_text", field_str().build());
        let _track_type = track.field("type", field_str().build());
        let _url_hints_slug = track.field("url_hints_slug", field_str().build());
        let _url_hints_subdomain = track.field("url_hints_subdomain", field_str().build());
        track.primary_key("track_pk", &[&id]);
        let genrerank = v.table("genrerank");
        let genre = genrerank.field("genre", field_str().build());
        let secondary = genrerank.field("secondary", field_str().build());
        let sort = genrerank.field("sort", field_str().build());
        let _date = genrerank.field("date", field_i64().build());
        let _rank = genrerank.field("rank", field_i32().build());
        let track_ref = genrerank.field("track", field_i64().build());
        genrerank.unique_index("genrerank_unique", &[&genre, &secondary, &sort, &track_ref]);
        generate(good_ormning::SqliteGenerateArgs {
            versions: vec![(1usize, v.build())],
            ..Default::default()
        }).unwrap();
    }

    // Parse locations.go and write JSON data files for use at runtime
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let locations_path = Path::new(&manifest_dir).join("../locations/locations.go");
    let out_dir = env::var("OUT_DIR").unwrap();
    parse_locations(&locations_path, &out_dir);
}

fn parse_go_string(s: &str) -> Option<String> {
    let s = s.strip_prefix('"')?.strip_suffix('"')?;
    return Some(s.replace("\\\"", "\"").replace("\\\\", "\\"));
}

fn parse_locations(go_path: &Path, out_dir: &str) {
    let file = fs::File::open(go_path).expect("Failed to open locations/locations.go");
    let reader = io::BufReader::new(file);

    enum ParseState {
        Init,
        InRawToId,
        InIdToName,
    }

    let mut state = ParseState::Init;
    let mut raw_to_id: HashMap<String, i32> = HashMap::new();
    let mut id_to_name: Vec<(i32, String)> = Vec::new();
    for line in reader.lines() {
        let line = line.expect("Failed to read locations.go line");
        let line = line.trim();
        match state {
            ParseState::Init => {
                if line.starts_with("var RawToId") {
                    state = ParseState::InRawToId;
                } else if line.starts_with("var IdToName") {
                    state = ParseState::InIdToName;
                }
            },
            ParseState::InRawToId => {
                if line == "}" {
                    state = ParseState::Init;
                } else if line.starts_with('"') {
                    let line = line.trim_end_matches(',');
                    if let Some(colon) = line.rfind(':') {
                        let key_part = line[..colon].trim();
                        let val_part = line[colon + 1..].trim();
                        if let (Some(key), Ok(val)) = (parse_go_string(key_part), val_part.parse::<i32>()) {
                            raw_to_id.insert(key, val);
                        }
                    }
                }
            },
            ParseState::InIdToName => {
                if line == "}" {
                    break;
                } else if !line.is_empty() && line != "{" {
                    let line = line.trim_end_matches(',');
                    if let Some(colon) = line.find(':') {
                        let key_part = line[..colon].trim();
                        let val_part = line[colon + 1..].trim();
                        if let (Ok(key), Some(val)) = (key_part.parse::<i32>(), parse_go_string(val_part)) {
                            id_to_name.push((key, val));
                        }
                    }
                }
            },
        }
    }
    fs::write(format!("{}/locations_raw_to_id.json", out_dir), serde_json::to_string(&raw_to_id).unwrap()).unwrap();
    fs::write(
        format!("{}/locations_id_to_name.json", out_dir),
        serde_json::to_string(&id_to_name).unwrap(),
    ).unwrap();
}
