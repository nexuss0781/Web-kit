---
name: webkit
description: Search the web, read pages, and gather sources with Web-Kit. Use for research, current facts, documentation lookup, news, competitor checks, or any task that needs the open web instead of prior knowledge. Runs locally; no API key.
---

# Web-Kit

Web-Kit is the agent's web access layer. It searches, finds URLs, and reads
pages. Everything below is one command set and one result shape; you do not
choose between search backends and you do not need a key.

Two ways to use it. Prefer the command line for a one-off, the local endpoint
for a loop that reads several pages.

## Before the first query

```cmd
npx webkit-sdk doctor
```

This reports whether the engine is reachable and which tier answered a probe
search. If it says `not ready`, run `npx webkit-sdk start` once. That command
installs the local index on first use, which takes a few minutes; later starts
take a second.

Do not ask the user for a token. Web-Kit is loopback-only and needs none.

## Search

```cmd
npx webkit-sdk search "sqlite wal mode checkpoint" --limit 8
npx webkit-sdk search "postgres 18 release notes" --time month
npx webkit-sdk search "searxng granian" --site docs.searxng.org
npx webkit-sdk search "AI regulation" --news
npx webkit-sdk search "rust async runtime" --json
```

Options worth remembering:

| Option | Meaning |
| --- | --- |
| `--limit N` | how many results (default 10) |
| `--news` | news index only |
| `--images` | image index only |
| `--sources web,news` | more than one group in one call |
| `--site a.com,b.com` | restrict to domains |
| `--time day\|week\|month\|year` | freshness |
| `--lang en` | language hint |
| `--json` | the full envelope, for parsing |
| `--no-start` | fail fast instead of starting the daemon |

`--json` returns the Firecrawl v2 shape:

```json
{
  "success": true,
  "data": {
    "web": [
      { "url": "...", "title": "...", "description": "...", "position": 1 }
    ],
    "answers": [{ "answer": "..." }]
  },
  "tiers_tried": ["searxng"]
}
```

`data.web`, `data.news`, `data.images` are present only when requested.
`data.answers`, `data.infoboxes`, `data.suggestions` are extra context when the
index has a direct answer; use them before writing prose.

## Read a page

```cmd
npx webkit-sdk scrape https://example.com/article -o page.md
npx webkit-sdk scrape https://example.com/article --json
```

The default is clean markdown with navigation and scripts removed. Use
`--html` when structure matters (tables, embeds) and `--raw` to print the
untouched HTML.

`scrape` reads only from this machine. It respects `robots.txt` and refuses
private addresses, so a URL that points at localhost or a LAN host will fail --
that is deliberate, not a bug.

## Working with the Firecrawl CLI

If the environment has `firecrawl` installed, point it at Web-Kit instead of
learning a second surface:

```cmd
for /f "delims=" %i in ('npx webkit-sdk env') do @%i
firecrawl search "query" --json
firecrawl scrape https://example.com -o page.md
```

`webkit env` prints `FIRECRAWL_API_URL` and, when a token is configured,
`FIRECRAWL_API_KEY`. The CLI's own flags then behave as documented upstream.

## How to research well with it

1. **Search the question, not the topic.** `"sqlite busy_timeout default"`
   beats `sqlite`. Add the artifact that would contain the answer: `docs`,
   `changelog`, `issue`, `rfc`, `benchmark`.
2. **Read before asserting.** Two or three scrapes from different domains is
   the minimum for a factual claim. One source is a lead, not a fact.
3. **Use freshness deliberately.** Prices, releases, incidents, and politics
   need `--time week` or `--time day`; concepts and history do not.
4. **Trust the URL, not the snippet.** Snippets are truncated and sometimes
   stale. If the answer depends on a number or a date, scrape the page.
5. **Prefer primary sources.** Documentation, changelogs, standards, and issue
   trackers over aggregators and SEO pages.
6. **Say when it is thin.** If results are weak, refine once with a quoted
   phrase or a site restriction; if still weak, report the gap. Do not fill it
   with plausible prose.

## What Web-Kit will not do

- No screenshot, no JavaScript rendering of arbitrary pages, no
  schema-validated JSON extraction. Asking for those returns an error naming
  the formats that do exist, rather than an empty success.
- No browser interaction: no clicks, logins, or form submissions.
- No crawling of a whole site by default. Scrape the pages you need.

## When something fails

| Symptom | What it means | What to do |
| --- | --- | --- |
| `engine did not start` | port busy or startup error | `npx webkit-sdk doctor`, then `npx webkit-sdk serve` to see it |
| `no results` from every tier | query too narrow or network blocked | broaden once; check `npx webkit-sdk doctor` |
| `partial:` warning | one tier came up short and the next answered | usable results; note it if completeness matters |
| `format ... is not produced` | unsupported output requested | ask for `markdown`, `html`, `links`, or `images` |
| scrape fails with a private address | SSRF guard | it is not reachable from this tool by design |

## Notes for the agent

- The result envelope is the interface. Do not scrape the HTML of the search
  engine or parse console formatting when `--json` is available.
- Search is a tool, not a source: cite the URL you actually read.
- The same command works from any directory; state lives in `~/.webkit`.
