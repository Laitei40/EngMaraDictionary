# English ⇄ Mara Dictionary

A fast, offline-capable English ⇄ Mara dictionary with a full editorial workflow, admin dashboard, and automatic GitHub archival. Built with plain HTML/CSS/JS, powered by Cloudflare Workers + D1.

**Live sites:**
- Public dictionary: served from `dictionary/`
- Admin dashboard: `https://admindic.marareih.org`

---

## Project Structure

```
EngMaraDictionary/
├── dictionary/                  ← Public frontend (static HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   ├── about.html
│   ├── contact.html
│   ├── privacy.html
│   ├── terms.html
│   └── links-disclaimer.html
│
├── worker/                      ← Cloudflare Worker (API + D1)
│   ├── src/
│   │   └── worker.js            ← All public + admin API endpoints
│   ├── schema.sql               ← Base D1 schema
│   ├── seed.sql                 ← Original seed data
│   ├── seed_updated.sql         ← Latest seed data
│   ├── dictionary-data.json     ← Full export (auto-committed by GitHub sync)
│   ├── wrangler.toml            ← Worker config + D1 binding
│   ├── package.json
│   └── migrations/
│       ├── 001_add_meanings_table.sql
│       ├── 002_add_suggestions_table.sql
│       ├── 003_performance_indexes.sql
│       ├── 004_editorial_workflow.sql
│       └── 005_seed_admin.sql
│
├── dashboard/                   ← Admin dashboard (Cloudflare Worker + static assets)
│   ├── worker.js                ← Proxy worker (Cloudflare Access + Service Binding)
│   ├── wrangler.toml
│   └── public/
│       └── index.html           ← Dashboard UI (the deployed file)
│
└── README.md
```

---

## Infrastructure

| Component | Service | Details |
|---|---|---|
| API Worker | Cloudflare Workers | `engmaradictionary` · `engmaradictionary.teiteipara.workers.dev` |
| Dashboard Worker | Cloudflare Workers | `adminmaradic` · `admindic.marareih.org` |
| Database | Cloudflare D1 | `engmaradata` · 121,000+ entries |
| Auth | Cloudflare Access | JWT-verified email; role-based access control |
| Archive | GitHub | `Laitei40/EngMaraDictionary` · branch `main` |

---

## Setup & Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

```bash
npm install -g wrangler
wrangler login
```

### 1. Create the D1 Database

```bash
cd worker
npx wrangler d1 create engmaradata
```

Copy the `database_id` into `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "engmaradata"
database_id = "paste-your-id-here"
```

### 2. Apply Schema & Migrations

```bash
# Base schema
npx wrangler d1 execute engmaradata --remote --file=schema.sql

# Migrations (run in order)
npx wrangler d1 execute engmaradata --remote --file=migrations/001_add_meanings_table.sql
npx wrangler d1 execute engmaradata --remote --file=migrations/002_add_suggestions_table.sql
npx wrangler d1 execute engmaradata --remote --file=migrations/003_performance_indexes.sql
npx wrangler d1 execute engmaradata --remote --file=migrations/004_editorial_workflow.sql
npx wrangler d1 execute engmaradata --remote --file=migrations/005_seed_admin.sql
```

### 3. Set Required Secrets

```bash
cd worker

# GitHub PAT with 'Contents: Read and write' permission on the repo
npx wrangler secret put GITHUB_TOKEN
```

Optional environment variables (set in Cloudflare Dashboard → Workers → Settings → Variables):

| Variable | Default |
|---|---|
| `GITHUB_OWNER` | `Laitei40` |
| `GITHUB_REPO` | `EngMaraDictionary` |
| `GITHUB_BRANCH` | `main` |
| `GITHUB_JSON_PATH` | `worker/dictionary-data.json` |

### 4. Deploy the API Worker

```bash
cd worker
npx wrangler deploy
```

### 5. Deploy the Dashboard Worker

```bash
cd dashboard
npx wrangler deploy
```

The dashboard uses a **Service Binding** (`env.API`) to call the API worker directly, and **Cloudflare Access** to authenticate admins via JWT.

### 6. Local Development

```bash
cd worker
npm install
npm run dev        # API at http://localhost:8787
```

Serve the public frontend separately:

```bash
cd dictionary
npx serve .        # http://localhost:3000
```

---

## Admin Dashboard

Access at `https://admindic.marareih.org` (protected by Cloudflare Access).

**Features:**
- Browse, search, and filter all dictionary entries
- **Status column** — each entry shows `pending`, `approved`, or `archived`
- **Publish button** (✓) — appears on unpublished entries; one click to approve and make visible in the public dictionary
- Add, edit, and archive entries
- Review user-submitted improvement suggestions
- Manage admin users and roles
- **GitHub Sync** — exports all approved entries as JSON to `worker/dictionary-data.json` via the Git Data API (handles files of any size, no 1 MB limit)
- Sync progress bar with animated phase labels and percentage
- Audit log of all editorial actions

**Admin Roles:**

| Role | Capabilities |
|---|---|
| `viewer` | Read-only access |
| `editor` | Create and edit entries |
| `senior_reviewer` | Approve revisions, archive entries |
| `super_admin` | All of the above + manage users, publish live |

---

## GitHub Sync

The sync pipeline exports all approved dictionary entries and commits them to GitHub using the **Git Data API**:

1. Query D1 → compact JSON (~10 MB for 121k entries)
2. `POST /git/blobs` — upload file content (no file size limit)
3. `GET /git/ref/heads/main` + `GET /git/commits/:sha` — get current HEAD
4. `POST /git/trees` — create new tree referencing the blob
5. `POST /git/commits` — create the commit
6. `PATCH /git/refs/heads/main` — advance the branch pointer

Sync runs inside `ctx.waitUntil()` so the API responds `200` immediately, avoiding the 30-second wall-clock timeout. The committed file is `worker/dictionary-data.json`.

**Required PAT scope:** fine-grained token with **Contents: Read and write** on the repo, or a classic token with `repo` scope.

---

## API Reference

### Public Endpoints

All public endpoints return only `status = 'approved'` entries.

#### `GET /api/search`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query (1–100 chars) |
| `lang` | string | No | `en` (English→Mara) or `mrh` (Mara→English). Default: `en` |

#### `GET /api/suggest`

Autocomplete prefix search. Same parameters as `/api/search`.

#### `GET /api/word`

Exact word lookup. Parameters: `q`, `lang`.

#### `GET /api/browse`

Alphabetical browse. Parameters: `letter` (A–Z), `lang`, `page`.

#### `GET /api/stats`

Returns total approved entries, unique English words, unique Mara words.

#### `GET /api/updates`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `since` | ISO 8601 | Yes | Returns entries updated after this timestamp |

#### `POST /api/suggestions`

Submit a user improvement suggestion.

```json
{
  "source_word": "hello",
  "source_lang": "en",
  "suggested_definition": "A common greeting",
  "notes": "Optional notes",
  "submitter_name": "Jane",
  "submitter_email": "jane@example.com"
}
```

#### `GET /api/health`

```json
{ "status": "ok", "timestamp": "2026-02-22T12:00:00.000Z" }
```

### Admin Endpoints

All admin endpoints require a valid Cloudflare Access JWT. The dashboard proxy injects `CF-Access-Authenticated-User-Email`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/entries` | List entries (`?page`, `?q`, `?lang`, `?status`) |
| `POST` | `/api/admin/entries` | Create entry |
| `PUT` | `/api/admin/entries/:id` | Update entry |
| `POST` | `/api/admin/entries/:id/approve` | Publish (set status → approved) |
| `POST` | `/api/admin/entries/:id/archive` | Soft-delete |
| `POST` | `/api/admin/entries/:id/restore` | Restore archived entry |
| `GET` | `/api/admin/entries/:id/meanings` | Get meanings for an entry |
| `GET` | `/api/admin/revisions` | List revisions (`?status=pending`) |
| `GET` | `/api/admin/revisions/:id` | Get single revision |
| `POST` | `/api/admin/revisions/:id/approve` | Approve a revision |
| `POST` | `/api/admin/revisions/:id/reject` | Reject a revision |
| `GET` | `/api/admin/suggestions` | List user suggestions |
| `PATCH` | `/api/admin/suggestions/:id` | Update suggestion status |
| `DELETE` | `/api/admin/suggestions/:id` | Delete suggestion |
| `GET` | `/api/admin/users` | List admin users |
| `POST` | `/api/admin/users` | Add admin user |
| `PUT` | `/api/admin/users/:id` | Update user role |
| `DELETE` | `/api/admin/users/:id` | Remove admin user |
| `GET` | `/api/admin/audit-logs` | View audit history |
| `GET` | `/api/admin/me` | Current user info |
| `GET` | `/api/admin/stats` | Entry counts by status |
| `GET` | `/api/admin/github/status` | Last commit info from GitHub |
| `POST` | `/api/admin/github/sync` | Trigger background sync to GitHub |

---

## Offline Support

The frontend uses an offline-first caching strategy:

1. **IndexedDB** stores search results locally (7-day TTL)
2. **Cookies** track which queries have cached data
3. When offline, cached results are shown with an "Offline mode" badge
4. When reconnected, results refresh silently from the API

---

## License

This project is open source. Use it to preserve and share the Mara language.
