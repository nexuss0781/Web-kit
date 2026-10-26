# Web-Kit SDK

Self-hosted web access for agents: **SearXNG first, keyless Firecrawl second**,
one Firecrawl-compatible API, no key required.

A hosted deployment is the wrong shape for an agent's web access. It has a
network path that can time out, a shared address the free tier may refuse, and
a lifetime measured in hours. This package runs the same engine on the machine
the agent runs on, installs its own search index, and answers on loopback.

## Install

```cmd
npm install -g webkit-sdk
webkit doctor
```

If you would rather not install globally, every command below works as
`npx webkit-sdk ...`.

The first `webkit start` downloads SearXNG and builds a Python environment in
`~/.webkit`. It takes a few minutes once; after that it is a second. You need
Python 3.10 or newer on PATH (or `WEBKIT_PYTHON` pointing at one). Node 20+.

## Use

```cmd
webkit search "postgres 18 release notes" --limit 8
webkit search "AI regulation" --news --time week
webkit scrape https://example.com/article -o page.md
webkit start
webkit status
webkit doctor
```

In code:

```js
import { createClient } from 'webkit-sdk';

const web = await createClient();          // daemon if running, else in-process
const { data } = await web.search({ query: 'sqlite wal mode', limit: 5 });
for (const row of data.web) console.log(row.title, row.url);

const page = await web.scrape({ url: data.web[0].url });
console.log(page.data.markdown.slice(0, 400));
```

`createClient()` never requires a running daemon. It uses one when it finds one
and otherwise runs the engine in the current process, so a short-lived agent
leaves nothing behind.

## Point the Firecrawl CLI at it

```cmd
for /f "delims=" %i in ('webkit env') do @%i
firecrawl search "query" --json
firecrawl scrape https://example.com -o page.md
```

`webkit env` prints `FIRECRAWL_API_URL` (and a token if you configured one).
The CLI's existing commands, and any agent skill written against them, then
work unchanged. Implemented endpoints:

| Endpoint | Status |
| --- | --- |
| `POST /v2/search` | full: `web`, `news`, `images`, domain filters, freshness, inline markdown |
| `GET /v2/search` | same, from query parameters |
| `POST /v2/scrape` | `markdown`, `html`, `rawHtml`, `links`, `images` |
| `GET|POST /v2/search/developer` | Firecrawl when available, GitHub fallback |
| `screenshot`, `branding`, `json` formats | refused with a message, never an empty success |

## How it answers

One ladder, tried in order, stopping as soon as a tier has enough results:

1. **SearXNG** — local, free, and the richest: categories, engines, page depth,
   direct answers, infoboxes. This is the primary index.
2. **Keyless Firecrawl** — a real general web index, no credential.
3. **Verticals** — Wikipedia, arXiv, GitHub, Hacker News, Crossref, books.
4. **Firecrawl with a key** — only when the three free tiers could not answer.
   It is last because it spends money, not because it is better.

A tier that returns fewer than `min(3, limit)` results is treated as a reason to
continue, not an answer. `tiers_tried` in the response says what happened;
`warnings` says which tier was short and why.

The agent sees one brand and one shape. It is not asked to choose a provider,
and does not learn which one answered.

## Configuration

Settings live in `~/.webkit/config.json` and are overridden by the environment:

| Key | Default | Environment |
| --- | --- | --- |
| engine port | `8787` | `WEBKIT_PORT` |
| engine host | `127.0.0.1` | `WEBKIT_BIND` |
| SearXNG port | `8888` | `WEBKIT_SEARXNG_PORT` |
| run SearXNG | `true` | `WEBKIT_SEARXNG=0` |
| token | none | `WEBKIT_API_TOKEN` |
| auto-start daemon | `true` | `WEBKIT_NO_AUTOSTART=1` |
| data directory | `~/.webkit` | `WEBKIT_HOME` |
| Python | auto-detected | `WEBKIT_PYTHON` |

Engine knobs from the deployment still apply (`WEBKIT_SEARCH_TIERS`,
`WEBKIT_SEARCH_MIN_RESULTS`, `WEBKIT_KEYLESS_FIRECRAWL`,
`FIRECRAWL_API_KEY`, `WEBKIT_GITHUB_TOKEN`). A keyed Firecrawl key is used only
as the final fallback.

The engine is loopback-only, so no token is needed by default. Set one if the
machine has other users.

## Commands

| Command | Effect |
| --- | --- |
| `webkit setup` | install/upgrade SearXNG and its environment |
| `webkit start` | provision if needed, then run the daemon |
| `webkit stop` | stop the daemon and its SearXNG child |
| `webkit status` | what is running, on which ports |
| `webkit doctor [--fast]` | check every dependency and probe a real search |
| `webkit serve` | run in the foreground (useful when start fails) |
| `webkit search <query>` | search |
| `webkit scrape <url>` | read one page |
| `webkit env [--sh]` | shell variables for the Firecrawl CLI |
| `webkit skill` | path to the bundled agent skill |

## The agent skill

`skills/webkit/SKILL.md` is a single, provider-agnostic skill: search, read,
research loop, failure modes. Install it wherever your agent reads skills, or
print its path with `webkit skill`.

## What it does not do

- **No browser.** No clicking, logging in, or form submission. Pages are read,
  not driven.
- **No screenshot or structured-extraction format.** These need a headless
  browser and a schema engine; the SDK refuses them rather than faking them.
- **No site crawler.** Scrape the pages you need; whole-site crawls are a
  different product.
- **No Windows service.** The daemon is a background process with a pid file,
  not a system service. `webkit stop` is the supported shutdown.

## Platform notes

Windows is a first-class target and a slightly unusual one for SearXNG:

- SearXNG's repository contains a filename with a colon, which Windows cannot
  check out. The SDK downloads a tarball and extracts only `searx/` and the
  requirements, so git is not required at all.
- SearXNG imports Python's `pwd` module at startup. `python/pwd.py` supplies it;
  the code path that uses it is never reached without a Valkey URL.
- Windows ships no IANA time zone database; the SDK installs `tzdata`.

Linux and macOS use the same code path, with `python3` and a POSIX venv layout.

## Files it creates

```
~/.webkit/
  config.json          your settings
  daemon.json          pid and ports of the running engine
  daemon.log           engine output
  searxng/             extracted SearXNG source
  searxng-venv/        its Python environment
  searxng.yml          generated settings (use_default_settings)
  searxng.log          its output
  python-compat/pwd.py the Windows shim
  cache/               downloaded tarball
```

Delete `~/.webkit` to uninstall everything. The npm package itself contains
only code.

## License

MIT for this package. SearXNG is AGPL-3.0 and is downloaded at runtime, not
bundled or modified; it runs as its own process and is reached over HTTP.
