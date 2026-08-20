# Redis Agent Memory Inspector

A Chrome extension for inspecting and managing your Agent Memory on Redis.

![Redis Agent Memory Inspector - Overview screen](./screenshots/redis-agent-memory-inspector-overview.png)

![Redis Agent Memory Inspector - Long-term memory screen](./screenshots/redis-agent-memory-inspector-long-term-memory.png)


## Who it's for

- **DevRel & solutions engineers** - drop it onto any demo to show what's happening in memory live; no need to build a custom viewer or memory panel for every new demo or talk you create.
- **Teams building agent apps** - makes debugging memory issues during development easier than digging through raw Redis keys.
- **Workshops & tutorials** - give learners a clear window into how extraction, search, and retention actually behave.

## Backends

Works with either:

- **[Redis Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)** - the hosted service on Redis Cloud (Iris / Context Engine)
- **[Self-managed Redis Agent Memory](https://redis.io/docs/latest/operate/iris/agent-memory/self-managed/)** - the Iris Data Plane you deploy and run yourself (Kubernetes / Helm)

Both speak the same store-scoped Data Plane API. Pick the backend from the connect panel; the rest of the UI is identical.

## What it shows

Two tabs: **Overview** and **Long-term memory**.

**Overview** — the live session for the selected `user_id` / `namespace` / `session_id`. :

| Pane | What it shows |
| --- | --- |
| **Working memory** (left) | Session Summary, Message log, role tags, the session's created time and TTL |
| **Long-term memory** (right) | The latest extracted memories for the selected session |

**Long-term memory** — dedicated power-user surface for searching, filtering, inspecting, and operating on the long-term memory store more broadly.

| Pane | What it shows |
| --- | --- |
| **Memory records** | Every extracted memory with type badge (`semantic` / `episodic` / `message`), topic chips, key name, and originating `session_id`. Search, server-side filters (user/owner, namespace, sessions, type, topics), per-record delete, and a detail pane (click a record) showing every field the API returns. |

## Repository layout

```
chrome-extension/   the unpacked extension Chrome loads
proxy/              optional transparent proxy for Cloud (see "Known issues")
```

## Installation

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. **Load unpacked** and pick the `chrome-extension/` folder.
4. Pin the extension to the toolbar.

## Usage

Click the toolbar icon to open the connect panel:

- **Backend** - pick **Redis Cloud** (hosted Redis Agent Memory) or **Self-managed** (your own Iris Data Plane)
- **Endpoint** - the Cloud endpoint (e.g. `https://gcp-us-east4.memory.redis.io`) or your self-managed Data Plane URL (e.g. `http://localhost:9000`)
- **Store ID** - the store identifier
- **API Key** - Cloud only; the bearer token from the Redis Cloud console
- **Authentication** - Self-managed only; **None** (auth-disabled store), **Agent key (Bearer)**, or **X-Api-Key**
- **Proxy URL** - Cloud only, optional; override the built-in default

![Configure Redis Agent Memory Inspector](./screenshots/redis-agent-memory-inspector-configuration.png)

Click **Connect**.

## Note for Cloud users

Direct fetches to `*.memory.redis.io` are blocked by Cloudflare bot detection. Route through the included [`proxy/`](./proxy/) - `cd proxy && npm start` runs it locally on `:8787`, or deploy it to any Web-fetch runtime - and put its URL in the **Proxy URL** field of the connect panel.

## License

MIT.
