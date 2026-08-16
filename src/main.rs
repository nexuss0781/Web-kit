use tracing::info;
use tracing_subscriber::EnvFilter;
use web_kit::{build_app, config::Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("web_kit=info,tower_http=info")),
        )
        .init();

    let config = Config::from_env();
    let bind_addr = config.bind_addr;
    let app = build_app(config);
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    info!(address = %bind_addr, "Web-Kit listening");
    axum::serve(listener, app).await?;
    Ok(())
}
