use std::collections::BTreeSet;

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use serde_json::Value;

const OPENAPI: &str = include_str!("fixtures/polytoken-0.5.8-openapi.json");

fn generated_names() -> BTreeSet<String> {
    include_str!("../src/lib.rs")
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            match (words.next(), words.next(), words.next()) {
                (Some("pub"), Some(kind @ ("struct" | "enum" | "type")), Some(name)) => {
                    let _ = kind;
                    Some(name.trim_end_matches('{').trim_end_matches('=').to_owned())
                }
                _ => None,
            }
        })
        .collect()
}

#[test]
fn target_version_is_0_5_8() {
    assert_eq!(POLYTOKEN_DAEMON_TARGET_VERSION, "0.5.8");
}

#[test]
fn generated_schema_names_match_0_5_8_spec() {
    let spec: Value = serde_json::from_str(OPENAPI).expect("valid OpenAPI fixture");
    let schemas = spec["components"]["schemas"]
        .as_object()
        .expect("OpenAPI components.schemas object");
    let spec_names: BTreeSet<String> = schemas.keys().cloned().collect();
    let rust_names = generated_names();

    let missing: Vec<_> = spec_names.difference(&rust_names).cloned().collect();
    let extra: Vec<_> = rust_names.difference(&spec_names).cloned().collect();
    assert!(missing.is_empty(), "schemas missing from Rust: {missing:?}");
    assert!(
        extra.is_empty(),
        "Rust declarations absent from schema: {extra:?}"
    );
    assert_eq!(spec_names.len(), 178, "fixture schema count changed");
    assert!(!rust_names.contains("CodexAuthProfile"));

    println!(
        "polytoken 0.5.8 inventory: {} OpenAPI component schemas, {} generated declarations; missing={missing:?}, extra={extra:?}",
        spec_names.len(),
        rust_names.len()
    );
}
