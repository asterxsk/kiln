<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search via Exa, content extraction, and video understanding for Pi agent. Zero-config Exa search with no API key needed, or bring your own Exa API key for direct API access.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

<https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f>

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). Add an Exa API key for direct API access with higher limits.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search uses Exa (direct API if keyed, MCP if not). YouTube tries Gemini Web when enabled, then API, then Exa. Blocked pages fall back to Jina Reader, Bright Data Web Unlocker, or Gemini extraction. Third-party hosted page fetchers require explicit `fetchRouting.allowRemoteHostedProviders` opt-in for remote HTTP(S) targets.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. For direct API access, add your key to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-..."
}
```

`web_search` uses Exa (direct API if keyed, MCP if not). For sandboxed networks that provide outbound proxy transport through environment variables, set `ssrf.trustEnvProxy` to `true` to skip local DNS preflight for proxied hostnames:

```json
{
  "ssrf": {
    "trustEnvProxy": true
  }
}
```

This is an opt-in DNS-preflight adjustment, not proxy transport configuration. `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` are recognized; `NO_PROXY` hosts still undergo DNS validation, and localhost or literal private IP targets remain blocked.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via Exa. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", includeContent: true })
```

| Parameter | Description |
| ----------- | ------------- |
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `includeContent` | Fetch full page content from sources in background |

### fetch_content

Fetch URL(s) as readable markdown, exact textual HTTP bodies, direct images, or page-grounded answers. Automatically detects and handles GitHub repos, GitHub PRs and issues, YouTube videos, PDFs, local video files, images, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://github.com/owner/repo/pull/123#discussion_r456" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
fetch_content({ url: "https://example.com/api", mode: "raw" })
fetch_content({ url: "https://example.com/guide", mode: "answer", prompt: "What are the installation steps?" })
fetch_content({ url: "https://example.com/account", auth: "work", mode: "raw" })
fetch_content({ url: "https://example.com/diagram.png" })
```

| Parameter | Description |
| ----------- | ------------- |
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question for video analysis, or the page-local question required by `mode: "answer"` |
| `mode` | `readable` (default), `raw` for exact textual HTTP bodies, or `answer` for a grounded answer from fetched content |
| `answerModel` | Optional `provider/model-id` override for answer mode; defaults to the current enabled Pi model |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Fetched URL content is stored in full in a private `web-search-cache` directory inside the extension folder (not the Pi config dir), rather than in the session JSONL. This includes `fetch_content` answer mode, which stores the original page content. The cache has a one-hour lifetime and fixed limits of 128 entries and 128 MiB; when either limit is reached, the oldest entries are removed first. On macOS and Linux the cache directory and files are kept at permissions `0700` and `0600`, respectively. Use `findText` to locate bounded matching passages without paging through a large page, or use `offset` and `limit` to retrieve slices intentionally.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://...", offset: 30000 })
get_search_content({ responseId: "abc123", query: "original query" })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: "installation" })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: ["timeout", "retry"], findMode: "fuzzy" })
```

`findMode` supports `exact`, `case-insensitive` (default), and `fuzzy`. Finder output is capped at 20,000 characters with match counts and nearby context. `findText` cannot be combined with `offset` or `limit`. The default `limit` and maximum permitted `limit` use `maxInlineContentChars`.

### source_check

Check a claim and return a machine-readable artifact with exact passage citations. Search results are deduplicated and capped at 20 sources; `fetchContent` fetches at most 5 pages, while stored and retrieved content remains subject to the configured `maxInlineContentChars` `offset`/`limit` bounds.

```typescript
source_check({ claim: "The API supports streaming responses" })
source_check({
  claim: "The API supports streaming responses",
  queries: ["API streaming responses documentation", "API streaming limitations"],
  fetchContent: true,
  domainFilter: ["docs.example.com", "-old.example.com"]
})
```

The artifact includes `supported`, `contradicted`, `unclear`, or `missing-evidence` claim status, source quality hints, SHA-256 content hashes, and passage IDs with exact source offsets. Search and fetch errors remain in the artifact instead of being silently discarded. Artifacts are stored with the session and retrieved through `get_search_content` using the returned `responseId`; paged artifact responses are JSON slices, so request the next `offset` when needed.

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI. Set `githubClone.enabled` to `false` to skip this GitHub-specific clone/API handling; `fetch_content` remains available, so the URL can continue through the normal HTTP extraction path.

Pull request and issue URLs are rendered as one priority-ordered markdown document instead of scraped HTML. PR views include status, body, checks when `gh` supports them, review verdicts, linked references, files, commits, conversation comments, review thread comments, truncation markers, and escalation commands. Issue views include state, metadata, body, linked closing PRs when available, and comments. Comment anchors such as `#issuecomment-...` and `#discussion_r...` are forced inline. The full rendered document is stored for `get_search_content` offsets and `findText`.

`fetch_content` uses `gh pr view` or `gh issue view` first with prompts disabled. It retries with a smaller field set when an older `gh` does not know a requested field. Public unauthenticated REST is used as a bounded fallback under the same `fetchContent.domainPolicy` and SSRF rules; REST cannot include checks. Set `githubPrIssue.enabled` to `false` to skip PR/issue specialization and keep normal HTTP extraction.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Exa (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB for Gemini analysis. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis. Timestamp/frame extraction uses ffmpeg directly and can still operate on larger local files.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are converted to Markdown and saved under the temporary `pi-web-pdf` directory by default so the agent can `read` specific sections without loading the full document into context. Three engines are available, selected with `pdf.provider` (`"auto"` is the default):

| Provider | Engine | Trade-offs |
| --- | --- | --- |
| `datalab` | Datalab hosted conversion (Marker) | Deterministic layout-aware output — tables, multi-column reading order, headings, math; `accurate` mode handles scanned pages; may return a `parse_quality_score`; requires a Datalab key, billed per page with a free monthly credit |
| `gemini` | Gemini API (vision LLM) | Best on scanned/complex pages; LLM transcription can occasionally drift or truncate; requires a Gemini key |
| `unpdf` | Local pdf.js text extraction | Free, offline, no key; flattened text only — no layout, no tables, no OCR |

`auto` order: Datalab (when a key is configured) → Gemini (when a key is configured) → local `unpdf`. Datalab runs first for layout-aware conversion. If its request fails — including after free-tier credit is exhausted — the chain continues to Gemini, then `unpdf`, automatically. Setting `pdf.provider` to `gemini`, `datalab`, or `unpdf` pins that engine and skips the other remote tiers (an explicit engine still falls back to `unpdf` when it errors, except for credential/config errors and caller cancellation). No Datalab key means the `datalab` tier is simply skipped — behavior is unchanged for existing users.

**Why Datalab.** The hosted converter uses a dedicated extraction engine (Marker) intended to retain document structure such as tables, multi-column reading order, headings, links, and math, where local `unpdf` extraction only yields flattened text. It is deterministic rather than LLM-based. Completed responses may include a `parse_quality_score` (0–5) for optional quality gating. Pricing is per processed page: **fast / balanced** $4 / 1,000 pages; **accurate** $10 / 1,000 pages. The free tier gives a **$10 monthly credit** (personal email; $20 with a work email) at **25 requests/minute** — roughly **2,500 pages/month free in `fast` mode** or 1,000 in `accurate` mode. Processing defaults to the **US region**. EU data residency uses **1.25× usage**; opt in with `DATALAB_PROCESSING_LOCATION=eu`.

Configure Datalab via the web-search config:

```jsonc
{
  "datalabApiKey": "$DATALAB_API_KEY",
  "pdf": {
    "maxSizeMB": 20,
    "maxPages": 100,
    "provider": "auto",      // "auto" | "gemini" | "datalab" | "unpdf"
    "datalabMode": "balanced", // "fast" | "balanced" | "accurate"
    "datalabTimeoutMs": 120000
  }
}
```

Env vars: `DATALAB_API_KEY` (or `datalabApiKey` in config), `DATALAB_PROCESSING_LOCATION` (`us` default; `eu` enables EU data residency at 1.25× usage), `DATALAB_MODE` (`fast` / `balanced` / `accurate`), and `DATALAB_API_BASE` (custom gateway). `pdf.datalabMode` overrides `DATALAB_MODE`. The default `datalabTimeoutMs` is 120s and is capped at 300s.

> Privacy note: like the Gemini tier, the PDF bytes are sent to the Datalab cloud for conversion. Files are uploaded to the selected region's storage and deleted best-effort after conversion.

### Blocked pages

Raw and direct-image HTTP requests use the same SSRF validation, hostname domain policy, redirect checks, timeout, and 5MB streamed response bound as normal extraction. Raw mode returns textual bodies even for non-2xx responses and exposes the HTTP status in tool details; it does not run readability or hosted extraction fallbacks.

`fetch_content` can opt into local browser-cookie auth with `auth: "profile"`, or `auth: true` when exactly one `authFetch` profile exists. Configure profiles in `~/.pi/web-search.json`, for example `{ "authFetch": { "social": ["x.com", "instagram.com"], "work": { "hosts": ["docs.company.com"], "chromeProfile": "Profile 2", "cache": "off" } } }`. Auth fetch uses only the local direct HTTP path, requires HTTPS, allows only configured hosts and their subdomains, refuses cross-origin redirects, and never sends cookies or authenticated content to hosted extraction providers. Browser cookie extraction remains opt-in through `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`.

#### Proxy (`proxy`)

`web_search`, `source_check`, and `fetch_content` all accept an optional `proxy` string (e.g. `"http://mcr:4444"`). When provided, every outbound HTTP(S) request is routed through `curl` instead of Node's built-in fetch — this works around Node fetch ignoring `HTTP(S)_PROXY` env vars and undici `ProxyAgent` failing the TLS handshake against several common HTTP proxies (ERR_SSL_WRONG_VERSION_NUMBER).

An empty string (`""`) forces a direct connection even when a config-level proxy is set. Omitting the parameter falls back to the global `proxy` in `~/.pi/web-search.json`.

```jsonc
// ~/.pi/web-search.json — global proxy for all tools
{
  "proxy": "http://mcr:4444"
}
```

Localhost, `127.0.0.1`, `[::1]`, and any host matching the `NO_PROXY` environment variable are never proxied.

When Readability fails or returns only a cookie notice, the extension can retry Jina Reader (handles JS rendering server-side, no API key needed), Bright Data Web Unlocker, Gemini URL Context API, and Gemini Web extraction when browser cookies are enabled. Configure `fetchRouting.providers` to change the order or set of `fetch_content` providers. Supported values are `http`, `jina`, `brightdata`, and `gemini`; when absent, the default order is unchanged. For remote HTTP(S) targets, third-party hosted providers are disabled unless `fetchRouting.allowRemoteHostedProviders` is `true`, because hosted services perform their own fetch and can see a different redirect chain than the local safety gate. Bright Data Web Unlocker runs ahead of only the Gemini fallbacks, because it is billed per request against a paid account; it is skipped unless both a key and an `unblocker` zone are configured. It applies no minimum-length check, so any non-empty body it returns — including a short consent or paywall stub — is the final answer for that URL and the Gemini fallbacks are not tried. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present. HTML extraction also surfaces registered discovery relations (`service-desc`, `service-doc`, `service-meta`, `api-catalog`, `describedby`) from the HTTP `Link` header and matching `link`/`a[rel]` markup. Readable or rendered content remains primary; on an empty shell, the normal extraction fallbacks run before declared links are returned on their own.

## How It Works

```
web_search(query)
  → Exa (direct API if keyed, MCP if not)

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Exa
  → HTTP fetch → PDF? Datalab → Gemini API → local text extraction, save to temp pi-web-pdf
               → HTML? Readability (+ declared Link/rel discovery) → RSC parser → third-party hosted fallbacks only when fetchRouting.allowRemoteHostedProviders is enabled
               → Text/JSON/Markdown? Return directly
```

## Commands

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. If cookie extraction fails, it reports sanitized attempted browser/profile entries and whether the failure was missing required cookies, password-store access, decryption, SQLite, or profile lookup.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

Config defaults to `~/.pi/web-search.json`, or `web-search.json` under `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME/pi` when set. Every field is optional.

```json
{
  "exaApiKey": "exa-...",
  "exaBaseUrl": "https://gateway.example.com/exa",
  "brightdataApiKey": "$BRIGHTDATA_API_KEY",
  "brightdataUnlockerZone": "pi_unlocker",
  "geminiApiKey": "AIza...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "geminiAuth": "adc",
  "geminiProject": "my-gcp-project",
  "geminiLocation": "us-central1",
  "fetchRouting": {
    "providers": ["http", "jina", "brightdata", "gemini"],
    "allowRemoteHostedProviders": false
  },
  "webSearch": {
    "enabled": true
  },
  "tools": {
    "webSearch": { "enabled": true },
    "sourceCheck": { "enabled": true },
    "fetchContent": { "enabled": true },
    "getSearchContent": { "enabled": true }
  },
  "commands": {
    "websearch": { "enabled": true },
    "search": { "enabled": true },
    "google-account": { "enabled": true }
  },
  "image": {
    "enabled": true
  },
  "browserCookies": {
    "browser": "helium",
    "profile": "Profile 2"
  },
  "allowBrowserCookies": false,
  "maxInlineContentChars": 30000,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "githubPrIssue": {
    "enabled": true
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3.6-flash"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3.6-flash",
    "maxSizeMB": 50
  },
  "pdf": {
    "enabled": true,
    "maxSizeMB": 20,
    "provider": "auto"
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["example.com"],
      "deny": ["blocked.example.com"]
    }
  },
  "shortcuts": {
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"],
    "trustEnvProxy": false
  }
}
```


API-key fields (`exaApiKey`, `geminiApiKey`, `datalabApiKey`, `cloudflareApiKey`, and `brightdataApiKey`) accept explicit credential sources. Use `$NAME` or `${NAME}` to read one named environment variable, or prefix a trusted local shell command with `!` to resolve one value at provider request time. Escape `$$` as a literal leading `$` and `$!` as a literal leading `!`:

```json
{
  "exaApiKey": "!/absolute/path/to/secret-manager read exa",
  "geminiApiKey": "${SCOPED_GEMINI_API_KEY}",
  "datalabApiKey": "$$literal-key",
  "cloudflareApiKey": "$!literal-command"
}
```

This syntax applies to provider credentials only; other configuration fields are not interpolated. `exaApiKey`, `geminiApiKey`, `datalabApiKey`, `cloudflareApiKey`, and `brightdataApiKey` use the same credential-source rules, while `exaBaseUrl`, `geminiBaseUrl`, and `brightdataUnlockerZone` are literal config values.

A command source is not run while the extension loads or registers tools. Each selected provider request runs it again with a five-second timeout, a 16 KiB output limit, a minimized environment, and a one-line non-empty stdout requirement. Command text and stderr are omitted from errors. These commands are trusted local configuration, not a same-user process isolation boundary; use absolute executable paths and protect the config file. `OP_SESSION_*` variables are forwarded to trusted resolver commands so shell-local 1Password sessions can be reused without storing them in config. An explicit source overrides legacy provider environment variables and fails that provider locally rather than falling back with a stale credential. Direct Google Gemini API requests send the resolved key only in the `x-goog-api-key` header, never in the URL.

Set `exaBaseUrl` to route Exa through a compatible HTTPS API gateway. `EXA_BASE_URL` is the environment-variable equivalent and takes precedence over config. Exa appends `/answer` or `/search`. The default remains Exa's official API root. `exaBaseUrl` applies only to keyed direct API calls; zero-config Exa MCP search continues to use Exa's hosted MCP endpoint. Invalid overrides fail before a request is sent instead of falling back to an official endpoint, and credential headers are removed if a gateway redirects to another origin.

`authFetch` configures named local browser-cookie auth profiles for explicit `fetch_content` calls. A profile can be a host array (`"work": ["docs.company.com"]`) or an object with `hosts`, optional `chromeProfile`, `redirects: "same-origin"`, and `cache: "session" | "off"`.

`browserCookies` selects the Chromium browser preset and profile used for Gemini Web cookies, for example `{ "browserCookies": { "browser": "helium", "profile": "Profile 1" } }`. When `browser` is set, cookie discovery checks only that browser, which avoids unrelated password-store prompts. Supported preset names are `helium`, `chrome`, `brave`, `arc`, `chromium`, and `edge`, subject to platform availability. Omit `browser` to keep automatic browser discovery. `profile` must be a profile directory name. The old top-level `chromeProfile` field is rejected; move it to `browserCookies.profile`. Arbitrary profile paths and `profilePath` are intentionally not supported.

`fetchContent.domainPolicy` is an optional hostname allow/deny policy for `fetch_content` target URLs. It is off when omitted. Each bare hostname matches itself and its subdomains; `deny` wins when a hostname matches both lists. The policy is checked before HTTP(S) target handling and before each redirect followed by this extension's own fetch path. Local file paths and non-HTTP sources are not subject to this policy. It is an additional restriction: the existing SSRF guard still blocks private and internal destinations. Remote extraction services can still perform their own DNS, redirects, and egress after this extension preflights the submitted target URL, so third-party hosted HTTP(S) fallbacks stay disabled unless `fetchRouting.allowRemoteHostedProviders` is enabled for separately isolated provider deployments.




**Bright Data.** Set `brightdataApiKey` or `BRIGHTDATA_API_KEY` plus `brightdataUnlockerZone` or `BRIGHTDATA_UNLOCKER_ZONE` (a zone of type `unblocker`) to enable the Bright Data Web Unlocker `fetch_content` fallback.


Bright Data Web Unlocker is a paid `fetch_content` fallback after the direct fetch and before Gemini. It validates the target URL with the local SSRF guard before resolving credentials or sending any request to Bright Data, validates redirects from the Bright Data API endpoint, and strips authorization across cross-origin API redirects. As with any remote extraction service, Bright Data fetches the submitted target from its own infrastructure; keep `brightdataUnlockerZone` unset for URLs that must not be disclosed to a third party. Successful Unlocker responses are returned as Markdown, including short pages or consent stubs, because the request has already been billed and discarding the body would hide what Bright Data saw.







Without an explicit `$` or `!` source, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_UNLOCKER_ZONE`, `EXA_API_KEY`, `EXA_BASE_URL`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `CLOUDFLARE_API_KEY`, `DATALAB_API_KEY`, `DATALAB_PROCESSING_LOCATION`, `DATALAB_MODE`, and `DATALAB_API_BASE` env vars retain their existing precedence over literal config file values. Configured Exa API keys use Exa's own account limits directly; any legacy local `exa-usage.json` file is ignored. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for Gemini generate-content calls such as search, URL context, YouTube, and local video analysis. Set it to a bare host with no trailing slash and no version segment, for example `https://my-gateway.example.com/gemini`; `geminiBaseUrl` is the config-file equivalent. When the configured host contains `gateway.ai.cloudflare.com`, authentication uses `cf-aig-authorization: Bearer <token>` from `CLOUDFLARE_API_KEY` or `cloudflareApiKey`, and `GEMINI_API_KEY` is not required for generate-content calls. Alternatively, set `geminiAuth` to `"adc"` to authenticate Gemini generate-content calls with Google Application Default Credentials (ADC) instead of an API key; calls go to the Vertex AI endpoint (`aiplatform.googleapis.com`) with an OAuth bearer token minted from the ADC file (`GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json`, i.e. `gcloud auth application-default login`). `geminiProject`/`geminiLocation` set the Vertex project and location and fall back to the `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` (or `GCLOUD_PROJECT`) env vars; project and location are required. ADC supports `authorized_user` (OAuth refresh token) and `service_account` (JWT assertion) credential files, and tokens are cached and refreshed from expiry. ADC mode covers search, URL context, and PDF/inline-data extraction; YouTube and local video analysis still go through the Gemini Files API, so they fall back to Gemini Web unless a `GEMINI_API_KEY` is also configured. The access token is treated as a credential and is redacted from errors. Local video file upload still uses Google's Files API directly, so gateway-only video extraction falls back to Gemini Web unless a `GEMINI_API_KEY` is also configured. Set `webSearch.enabled` to `false` to unregister the configured search and source-check tools while leaving fetch/content tools available. `toolNames` can opt into alternate public tool names for environments where another extension or model reserves the defaults, without changing behavior: `webSearch`, `sourceCheck`, `fetchContent`, and `getSearchContent` default to `web_search`, `source_check`, `fetch_content`, and `get_search_content`. `browserCookies.profile` pins Gemini Web cookie lookup to a specific Chromium profile. When omitted, detected Chromium profiles are scanned in stable order and the first profile containing the required Gemini cookies is used. macOS discovery supports Helium, Chrome, Brave, and Arc; Linux discovery supports Chromium and Chrome. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid browser data access and surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. Cookie databases are copied to a temporary read-only working copy; the reader uses `node:sqlite` when available and otherwise tries the `sqlite3` CLI or Python's standard-library SQLite module. `ssrf.allowRanges` lists CIDR ranges (e.g. `"198.18.0.0/15"`, `"fd00::/8"`) exempted from the SSRF guard that otherwise blocks private/reserved IP ranges. This unblocks `fetch_content`/`web_search` on hosts whose network proxy runs in TUN + fake-IP mode (Surge, Clash, Mihomo, Stash, ...), where public domains resolve into a synthetic reserved range. It is **off by default** — the guard stays fully enabled unless you list ranges here. Use the narrowest range that covers your proxy's fake-IP pool. All-address CIDRs such as `0.0.0.0/0` and `::/0` are rejected. `ssrf.trustEnvProxy` is a separate opt-in for sandboxed environments with valid HTTP(S) proxy env vars; it skips local DNS preflight only for proxied hostnames and still blocks localhost, literal private IPs, and `NO_PROXY` matches. It does not configure proxy transport.
### Shortcuts

The shortcut is configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under `tools`, `commands`, `image`, or `pdf` to disable that feature. Tool-specific settings override the legacy `webSearch.enabled` shorthand; without an override, it still disables `web_search` and `source_check`. `image.enabled: false` blocks direct image fetches and video frame extraction, and prevents video thumbnails. `pdf.enabled: false` blocks PDF extraction. For GitHub specifically, `githubClone.enabled: false` only skips clone/API specialization, and `githubPrIssue.enabled: false` only skips PR/issue specialization; neither setting unregisters `fetch_content` or blocks generic URL extraction. Pi restart is required for tool and command registration changes.

Rate limits: Content fetches run 3 concurrent with a 30s timeout for the direct HTTP fetch of each URL. Remote extraction fallbacks carry their own budgets and are not covered by that number: Jina Reader 30s, Bright Data Web Unlocker 60s, Gemini 120s, Datalab 120s (capped at 300s, rate-limited to 25 requests/minute on the free tier). `pdf.maxSizeMB` defaults to 20 and is capped at 50. `pdf.maxPages` defaults to 100 and limits every PDF provider to the first N pages.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`; no browser data or password store is touched while it is disabled. On macOS, enabling it may trigger a Keychain dialog. On Windows, Chrome and Edge v10 cookies use the current user's DPAPI key; v20 app-bound cookies are not supported. Required cookie names are checked before password-store access, and browser encryption passwords are cached only in-process. If `node:sqlite` is unavailable, the reader falls back to the `sqlite3` CLI or Python stdlib; `/google-account` reports sanitized browser/profile attempts and classifies SQLite, profile, missing-cookie, password-store, and decryption failures.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- GitHub wiki, discussion, and other non-code pages still fall through to normal web extraction. PR review-thread resolution state is unknown in the specialized PR view, and REST fallback omits checks.

<details>
<summary>Files</summary>

| File | Purpose |
| ------ | --------- |
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `brightdata-unlocker.ts` | Bright Data Web Unlocker extraction fallback |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `content-find.ts` | Bounded exact, case-insensitive, and fuzzy passage lookup |
| `page-query.ts` | Grounded page-local answer generation with model context budgeting |
| `gemini-search.ts` | Exa search entry point (direct API if keyed, MCP if not) |
| `search-types.ts` | Shared search result/option types |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | Chromium-based cookie extraction (macOS Keychain, Linux secret-tool, Windows DPAPI + SQLite) |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `github-issue-pr.ts` | GitHub PR and issue URL parsing, gh/REST fetch, markdown rendering |
| `datalab-pdf-extract.ts` | Datalab hosted PDF-to-Markdown conversion client (upload → convert → poll) |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |

</details>
