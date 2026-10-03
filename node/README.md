# Web-Kit, on Node

The API in [`../openapi.yaml`](../openapi.yaml), in a build that will actually
run somewhere.

The Rust service in this repository is the original. It is a good fit for a
Docker host and a poor one for a platform that will not run a binary: its only
provider is SearXNG, which needs Python and Redis, and its build needs a Rust
toolchain. This directory is the same HTTP contract with no dependencies at all
and no metasearch engine, for hosts that run Node and nothing else.

```sh
npm test
WEBKIT_API_TOKEN=$(openssl rand -base64 30) npm start
```

## Reaching a caller-named URL

`/v1/fetch` is the one path where the URL comes from whoever called, so it is
the one path that has to care where that URL leads.

A host is checked before anything is sent to it: the address is resolved, and
if **any** address the name maps to is private, loopback, link-local or
otherwise reserved, the request is refused. Checking every answer rather than
the first is deliberate — a name with one public and one private record must not
be fetched on the strength of the public one.

Then the same address is dialled for the request. This is the part that is easy
to leave out, and leaving it out makes the check decorative: DNS is consulted
twice otherwise, and an attacker who controls a name with a short TTL can answer
the first lookup with a public address and the second with `127.0.0.1`. That is
DNS rebinding, and it turns a check into a formality a patient caller walks
past. So `src/pinned.js` resolves once, checks once, and connects to the address
it checked.

The hostname still travels in the `Host` header and still goes to TLS as SNI, so
sites see and validate the name that was asked for, and certificates are still
checked against it. Only the address on the socket differs, and only for the
lifetime of one request.

Every redirect hop is checked the same way, and robots.txt is fetched through
the same path — otherwise reading the rules would be the way in.

## Providers

Search asks several providers at once and reconciles what they say. A result
more than one of them returned outranks a result only one found, because two
endpoints agreeing is worth more than one being first.

| Provider | Endpoint | Notes |
|---|---|---|
| `wikipedia` | `en.wikipedia.org` | Also `de es fr ja pt ru zh`, by `language` |
| `hackernews` | `hn.algolia.com` | Stories only; comments are not results |
| `arxiv` | `export.arxiv.org` | The one provider speaking Atom |
| `github` | `api.github.com` | `WEBKIT_GITHUB_TOKEN` raises the rate limit |
| `crossref` | `api.crossref.org` | Papers, with authors and venue |
| `openlibrary` | `openlibrary.org` | Books |
| `firecrawl` | `api.firecrawl.dev` | **The general web index.** Off unless `FIRECRAWL_API_KEY` is set |
| `searxng` | configured instances | Off unless `WEBKIT_SEARXNG_URLS` is set |

Six of these seven are free, keyless and official. That is a deliberate filter:
of the 76 public SearXNG instances that answer at all, three serve JSON to a
programmatic caller and the rest refuse or rate limit, which makes the public
instance network unusable as a dependency. SearXNG stays in the registry for
the case it is good at, an instance you run yourself.

The six keyless providers are all **vertical** indexes: encyclopaedia, news,
papers, code, books, scholarly metadata. They know a great deal about six kinds
of thing and nothing about a product, a company, an error message, or anything
published this morning. `firecrawl` is the general index, and it is what makes
this a search rather than a lookup.

It asks for nothing but title, url and description. Hydrating ten results into
full page text costs ten times as much and produces a wall of text nobody asked
to read; `/v1/fetch` exists to read the one or two results worth reading, and
reads them better than a search API would.

`WEBKIT_PROVIDERS=wikipedia,github` narrows the set. A provider that fails is
reported in `warnings` and the rest of the results stand.

`FIRECRAWL_API_URL` points at a self-hosted Firecrawl instead of the cloud.

## Fetching

`/v1/fetch` is the dangerous half, and the checks live here rather than in the
caller because the caller is an agent holding credentials:

- **Private addresses are refused**, including the shapes that hide one. The
  name is resolved and every returned address is tested, so `localhost`,
  `169.254.169.254` and `http://[::ffff:127.0.0.1]/` are all refused, in the
  hex spelling the URL parser actually produces.
- **Redirects are followed one hop at a time**, with each new target checked
  again. A public URL that redirects into `127.0.0.1` gets as far as the check
  and no further. This applies to `robots.txt` as well.
- **Only web ports.** `22`, `3306` and `6379` are not fetched.
- **`robots.txt` is read and obeyed** by default.
- **Responses are bounded** by size and by time, and the size is enforced while
  reading rather than after.

`render` decides whether the page is read as the server sent it or as a browser
would see it:

- `never` (default) — read it here. Free, and right for most pages.
- `auto` — read it here first, and re-read it in a browser **only** if the
  result looks like an empty shell: a lot of markup, almost no text. That is
  what a React or Vue page looks like before its scripts run. A page that is
  merely short is never mistaken for one.
- `always` — skip the local read and go straight to the browser.

The last two need `FIRECRAWL_API_KEY`. Without it they return a warning and the
page as it arrived, rather than pretending.

The renderer is only asked about a URL the local path has already agreed to
fetch: the address is checked and `robots.txt` is obeyed first, so a renderer
never becomes a way to reach a host this service would have refused.

### Remote rendering and who resolves the name

Every other request here resolves a name once, checks the address, and dials
exactly that address. `render` cannot: the request is made by Firecrawl, from
their network, resolving the name themselves. The address check proves the name
was public when *we* asked, not when *they* ask.

This does not put this deployment at risk. Nothing here dials the rebound
address, so our own private space stays private. What is exposed is Firecrawl's
network, which they filter themselves.

`WEBKIT_ALLOW_REMOTE_RENDER=0` refuses to hand a caller-named URL to the
renderer. `render: always` then returns the page as the server sent it with a
warning naming the switch, and `render: auto` simply does not escalate. Unset
means on, because rendering is the reason the key is there.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBKIT_API_TOKEN` | none | Bearer token. Without one the API is open. |
| `PORT` / `WEBKIT_PORT` | `3000` | Port to listen on |
| `WEBKIT_HOST` / `HOST` | `0.0.0.0` | Address to listen on |
| `WEBKIT_PROVIDERS` | all available | Comma separated provider ids |
| `WEBKIT_SEARXNG_URLS` | none | Comma separated instances |
| `WEBKIT_GITHUB_TOKEN` | none | Raises the GitHub rate limit |
| `FIRECRAWL_API_KEY` | none | Enables the general web index and JavaScript rendering |
| `FIRECRAWL_API_URL` | `https://api.firecrawl.dev` | A self-hosted Firecrawl |
| `FIRECRAWL_MAX_AGE_MS` | `172800000` | How old a reused rendered copy may be. `0` forces a fresh read |
| `WEBKIT_REQUEST_TIMEOUT_MS` | `12000` | Ceiling on one page fetch |
| `WEBKIT_SEARCH_TIMEOUT_MS` | `10000` | Ceiling on one provider |
| `WEBKIT_MAX_BODY_BYTES` | `5242880` | Ceiling on one response |

`/healthz` and `/readyz` are open so a platform can probe without the token;
everything under `/v1` needs it.

## Deploying

`app.yaml` is in this directory, and it points at the `tadihhuh` account.

The token is deliberately absent from it. Pass it as a Wasmer app secret, which
is how it stays out of the repository and out of the shell history:

```sh
wasmer app secret create WEBKIT_API_TOKEN "$WEBKIT_API_TOKEN"
wasmer deploy --non-interactive --build-remote
```

`--build-remote` is needed because `app.yaml` names a local package.

## Tests

`npm test` runs 75 tests. Providers are stubbed against a local server, and the
fetch tests assert refusals rather than pulling pages down, which is the
behaviour worth pinning.

One test is not hermetic: `pinned.test.js` resolves `example.com` to prove
`resolvePublic` hands back an address rather than a name. A DNS lookup happens
there and in the Firecrawl render tests that use real URLs as their subject. It
is a lookup, not a fetch, and it needs a network only if DNS is unavailable --
so this suite is not fully offline, and saying otherwise would be wrong.

The one thing no suite can prove is that seven upstream APIs still answer;
`wasmer app logs` and a live search are where that is checked.
