#[test]
fn render_blueprint_defines_one_public_combined_docker_service() {
    let manifest = include_str!("../render.yaml");
    assert!(manifest.contains("type: web"));
    assert!(manifest.contains("runtime: docker"));
    assert!(manifest.contains("dockerfilePath: ./Dockerfile"));
    assert!(manifest.contains("healthCheckPath: /healthz"));
    assert!(manifest.contains("WEBKIT_BIND_ADDR"));
    assert!(manifest.contains("0.0.0.0:10000"));
    assert!(manifest.contains("WEBKIT_SEARXNG_URL"));
    assert!(manifest.contains("http://127.0.0.1:8081"));
    assert!(manifest.contains("generateValue: true"));
    assert!(!manifest.contains("YOUR_SEARXNG_INTERNAL_HOSTNAME"));
}

#[test]
fn combined_dockerfile_uses_searxng_runtime_and_public_webkit_port() {
    let dockerfile = include_str!("../Dockerfile");
    assert!(dockerfile.contains("FROM searxng/searxng:latest AS runtime"));
    assert!(dockerfile.contains("COPY --from=builder /app/target/release/web-kit"));
    assert!(
        dockerfile.contains("COPY docker/searxng/settings-render.yml /etc/searxng/settings.yml")
    );
    assert!(dockerfile.contains("WEBKIT_SEARXNG_URL=http://127.0.0.1:8081"));
    assert!(dockerfile.contains("EXPOSE 10000"));
    assert!(dockerfile.contains("ENTRYPOINT [\"/usr/local/bin/webkit-entrypoint\"]"));
}

#[test]
fn combined_entrypoint_starts_internal_searxng_before_webkit() {
    let entrypoint = include_str!("../docker/combined-entrypoint.sh");
    let granian = entrypoint
        .find("/usr/local/searxng/.venv/bin/granian")
        .unwrap();
    let readiness = entrypoint.find("format=json").unwrap();
    let webkit = entrypoint.find("exec /usr/local/bin/web-kit").unwrap();
    assert!(entrypoint.contains("GRANIAN_HOST=127.0.0.1"));
    assert!(entrypoint.contains("GRANIAN_PORT=8081"));
    assert!(entrypoint.contains("SearXNG did not become ready"));
    assert!(granian < readiness && readiness < webkit);
}

#[test]
fn openapi_contract_lists_all_public_routes_and_auth_scheme() {
    let openapi = include_str!("../openapi.yaml");
    for path in [
        "/healthz",
        "/readyz",
        "/v1/providers",
        "/v1/search",
        "/v1/fetch",
    ] {
        assert!(openapi.contains(path), "missing {path}");
    }
    assert!(openapi.contains("bearerAuth"));
    assert!(openapi.contains("SearchRequest"));
    assert!(openapi.contains("FetchRequest"));
    assert!(openapi.contains("SearchResponse"));
    assert!(openapi.contains("FetchResponse"));
}

#[test]
fn ci_runs_format_tests_and_release_build() {
    let workflow = include_str!("../.github/workflows/ci.yml");
    assert!(workflow.contains("cargo fmt --all -- --check"));
    assert!(workflow.contains("cargo test --all-targets"));
    assert!(workflow.contains("cargo build --release"));
}
