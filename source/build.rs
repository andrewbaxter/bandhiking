use good_ormning::sqlite::{
    generate,
    schema::field::{
        field_i32,
        field_i64,
        field_str,
    },
    Version,
};

pub fn main() {
    println!("cargo:rerun-if-changed=build.rs");

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
}
