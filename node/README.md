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
| `searxng` | configured instances | Off unless `WEBKIT_SEARXNG_URLS` is set |

All of the first six are free, keyless and official. That is a deliberate filter:
of the 76 public SearXNG instances that answer at all, three serve JSON to a
programmatic caller and the rest refuse or rate limit, which makes the public
instance network unusable as a dependency. SearXNG stays in the registry for
the case it is good at, an instance you run yourself.

`WEBKIT_PROVIDERS=wikipedia,github` narrows the set. A provider that fails is
reported in `warnings` and the rest of the results stand.

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

`render: auto` and `render: always` cannot be honoured: there is no browser in
this build. They return a warning rather than pretending.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBKIT_API_TOKEN` | none | Bearer token. Without one the API is open. |
| `PORT` / `WEBKIT_PORT` | `3000` | Port to listen on |
| `WEBKIT_HOST` / `HOST` | `0.0.0.0` | Address to listen on |
| `WEBKIT_PROVIDERS` | all available | Comma separated provider ids |
| `WEBKIT_SEARXNG_URLS` | none | Comma separated instances |
| `WEBKIT_GITHUB_TOKEN` | none | Raises the GitHub rate limit |
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

`npm test` runs 42 tests and touches no network. Providers are stubbed, and the
fetch tests assert the refusals rather than pulling pages down, which is the
behaviour worth pinning. The one thing a hermetic suite cannot prove is that
six upstream APIs still answer; `wasmer app logs` and a live search are where
that is checked.
