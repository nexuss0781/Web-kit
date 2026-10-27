# TODO

State after commit `711c53c`: the engine answers `/v2/map`, `/v2/crawl`,
`/v2/batch/scrape`, `/v2/extract` and `/v2/monitor`, and `/v2/scrape` produces
`json`, `summary`, `question`, `attributes`, `extract` and `deterministicJson`
as well as the document formats. None of it is verified end to end yet.

Order is deliberate: prove the engine, then make the SDK reach it, then publish.

## 1. Verify the new engine surface

- [ ] Start the engine on 8787 and exercise each route with a real URL:
      `POST /v2/map`, `POST /v2/crawl` + poll, `POST /v2/batch/scrape` + poll,
      `POST /v2/extract` + poll, `POST /v2/monitor` + `run` + `checks`.
- [ ] Confirm the scheduler starts with the daemon and leaves a one-shot
      process alone (`sdk/src/engine.js`, `node/src/server.js`).
- [ ] Check cancel, 404 on an unknown id, and expiry behaviour.
- [ ] Crawl a page with `formats: [{ type: 'json', schema }]`: the current
      `crawl.js` collapses formats to type strings, so the schema is lost.
      Preserve format objects in `fetchFormats`.

## 2. Known defects

- [ ] `webkit search "..." --limit 3` returns 10 results. Limit is not
      enforced end to end; trace CLI -> client -> engine.
- [ ] Monitor `readCrawlTarget` calls `v2Map` then `v2Scrape`; confirm the
      page cap holds and that a removed page is reported as `removed`.

## 3. Compatibility gaps

- [ ] Add `/v1` aliases for map, crawl, batch/scrape and extract if the
      Firecrawl CLI (1.26.22) calls them.
- [ ] `download` is map + scrape run client-side by the Firecrawl CLI. Confirm
      it works against `/v2/map`; add a native `webkit download` only if not.

## 4. Token and configuration plumbing

- [ ] `~/.webkit/config.json` gains `githubToken`.
- [ ] `webkit config set github-token` (never echo the value).
- [ ] Export it from `sdk/src/settings.js` `engineEnv`.
- [ ] `webkit doctor` reports whether the developer index has a token, without
      printing it.

## 5. SDK surface

- [ ] `sdk/src/client.js`: `map`, `crawl`, `batch`, `extract`, `monitor`.
- [ ] `sdk/src/engine.js` `loadSurface` for the in-process path.
- [ ] CLI commands mirroring the client, with `--json` output.
- [ ] Keep one brand: every message names Web-Kit, never the upstream it
      borrowed a pattern from.

## 6. Tests

- [ ] `schedule`: cron parse, phrase parse, 5-minute floor, next run in UTC.
- [ ] `discovery`: sitemap gzip, robots, path globs, scope.
- [ ] `map`, `crawl`, `batch`, `extract`, `monitor` against a local fixture
      server (no internet in tests).
- [ ] `llm`: mocked Ollama and an OpenAI-compatible endpoint, plus the
      no-model refusal path.
- [ ] Keep `node/npm test` and `sdk/npm test` green.

## 7. Documentation

- [ ] `openapi.yaml`: the five new routes and the new scrape formats.
- [ ] `node/README.md` and `sdk/README.md`.
- [ ] `sdk/skills/webkit/SKILL.md`: one provider-agnostic procedure that
      mentions map/crawl/extract/monitor and never names an upstream.
- [ ] State honestly what is not produced: screenshots, branding, browser
      actions.

## 8. Release

- [ ] `npm run bundle` so `sdk/engine` carries the new modules.
- [ ] Bump `0.1.1` in both packages.
- [ ] `npm publish --otp=<fresh code>` for `webkit-sdk`.
- [ ] `npx -y webkit-sdk@0.1.1` smoke test, then push.

## Deliberately out of scope

`browser`, `interact`, browser-driven `agent`, `parse`, `gov`, `alexandria`,
`find-tools`, `credit-usage`, `search-feedback`. No Playwright, no Docker, no
WSL. Screenshots and branding are refused with a reason, never answered empty.
