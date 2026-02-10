# English ⇄ Mara Dictionary

A fast, lightweight, offline-capable English ⇄ Mara dictionary website built with plain HTML/CSS/JS and powered by Cloudflare Workers + D1.

## Project Structure

```
EngMaraDictionary/
├── dictionary/              ← Frontend (static files)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── worker/                  ← Backend (Cloudflare Worker + D1)
│   ├── src/
│   │   └── worker.js        ← Worker API handler
│   ├── schema.sql           ← D1 table schema
│   ├── seed.sql             ← Sample dictionary data
│   ├── wrangler.toml        ← Cloudflare config
│   └── package.json         ← Worker dependencies & scripts
└── README.md
```

---

## Setup & Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Set Up the D1 Database

```bash
cd worker

# Create the D1 database
npx wrangler d1 create mara-dictionary
```

Copy the `database_id` from the output and paste it into `worker/wrangler.toml`:

```toml
database_id = "paste-your-id-here"
```

### 3. Initialize the Database

```bash
# Create the table (local dev)
npm run db:schema

# Seed with sample data (local dev)
npm run db:seed

# For production (remote):
npm run db:schema:remote
npm run db:seed:remote
```

### 4. Run the Worker Locally

```bash
npm install
npm run dev
```

The API will be available at `http://localhost:8787`.

### 5. Update the Frontend API URL

In `dictionary/script.js`, update the `API_BASE` in the `Config` object:

```js
// For local development:
API_BASE: 'http://localhost:8787',

// For production (after deploying):
API_BASE: 'https://mara-dictionary-api.YOUR_SUBDOMAIN.workers.dev',
```

### 6. Serve the Frontend

For local development, serve the `dictionary/` folder with any static server:

```bash
# Using Python
cd dictionary
python -m http.server 8080

# Using Node.js (npx)
npx serve dictionary
```

Open `http://localhost:8080` in your browser.

### 7. Deploy to Production

```bash
# Deploy the Worker
cd worker
npm run deploy
```

For the frontend, deploy the `dictionary/` folder to:
- **Cloudflare Pages** (recommended)
- Any static hosting (Netlify, Vercel, GitHub Pages, etc.)

---

## API Reference

### `GET /api/search`

Search the dictionary.

| Parameter | Type   | Required | Description                              |
|-----------|--------|----------|------------------------------------------|
| `q`       | string | Yes      | Search query (1–100 characters)          |
| `lang`    | string | No       | `en` (English→Mara) or `mrh` (Mara→English). Default: `en` |

**Response:**

```json
{
  "query": "water",
  "lang": "en",
  "count": 1,
  "results": [
    {
      "id": 1,
      "english_word": "water",
      "mara_word": "tui",
      "part_of_speech": "noun",
      "definition": "A clear liquid essential for life.",
      "example_sentence": "I need water to drink."
    }
  ]
}
```

### `GET /api/health`

Health check endpoint.

```json
{ "status": "ok", "timestamp": "2026-02-10T12:00:00.000Z" }
```

---

## Offline Support

The frontend uses an **offline-first** caching strategy:

1. **IndexedDB** stores search results locally (7-day TTL)
2. **Cookies** track which queries have cached data
3. When offline, cached results are shown with a subtle "Offline mode" badge
4. When reconnected, results refresh silently from the API

No data is lost and the UI never blocks on network errors.

---

## Adding Dictionary Data

Insert new entries directly into D1:

```sql
INSERT INTO dictionary (english_word, mara_word, part_of_speech, definition, example_sentence)
VALUES ('hello', 'pangpar', 'interjection', 'A greeting.', 'Hello, how are you?');
```

Or create a new SQL file and execute it:

```bash
npx wrangler d1 execute mara-dictionary --remote --file=./new-words.sql
```

---

## License

This project is open source. Use it to preserve and share the Mara language.
