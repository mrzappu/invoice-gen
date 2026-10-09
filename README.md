# INET Invoice Studio + Discord Bot

A vanilla HTML/CSS/JS invoice studio served by a small Node.js/Express service. The same Node process connects a Discord bot and provides:

- Live invoice preview, Imposter Network and Gojo's Steam Lounge presets, 9 themes.
- Product rows, charges, discounts, payments, Indian-numbering amount in words, terms, watermark, received seal, signature.
- PNG and PDF exports, browser print.
- Save invoice to `/api/invoices` and search it using Discord `/invoice-search`.
- Discord `/resize` command that resizes an attached image to exactly 3840×2160 and returns a PNG. `contain` keeps the full image with padding; `cover` fills the canvas by cropping edges.
- `/health` endpoint and Render-compatible `process.env.PORT` binding.

## Run locally

Requires Node.js 20+.

```sh
npm install
# set DISCORD_TOKEN, CLIENT_ID and optionally GUILD_ID in your environment
npm start
```

Open `http://localhost:10000`. If no `DISCORD_TOKEN` is set, the website still runs without the bot.

## Deploy on Render Free

1. Upload this folder to a GitHub repository.
2. In Render, create a **Web Service** from that repository. Use Build Command `npm install` and Start Command `npm start` (or use `render.yaml`).
3. Add environment variables:
   - `DISCORD_TOKEN`: bot token from the Discord Developer Portal. Keep it secret.
   - `CLIENT_ID`: Discord application ID.
   - `GUILD_ID`: your server ID (recommended for fast guild command registration).
   - `INVOICE_API_KEY`: optional API key. If set, the browser must send it to use save/search endpoints; this simple front end does not prompt for it, so leave it unset for the included browser workflow or add an authenticated admin UI before enabling it.
4. Invite the bot to your server with `bot` and `applications.commands` scopes. It needs no privileged gateway intents for these slash commands.
5. After deploy, visit `https://YOUR-SERVICE.onrender.com/health` and then the root website.

## Important Render Free limitations

- Free web services can sleep when idle, so the bot may be offline while the service sleeps. A web service is not a reliable always-on Discord bot host. For 24/7 bot availability, use an always-on worker/paid service or host the bot separately.
- The included invoice store is a JSON file under `data/`. Render Free's filesystem is ephemeral: data may be lost on redeploy/restart. For real invoice history, attach a persistent disk where supported or use a hosted database (Postgres, etc.). Do not treat the JSON file as durable accounting storage.
- Never publish your bot token in code or commit it to GitHub. Rotate it immediately if exposed.

## Invoice lookup

Saving a document through **Save to lookup** stores its invoice ID and fields. In Discord use `/invoice-search invoice_id:IMP-...`. The lookup only works for records still present in the JSON file.

## Image resizing

Use `/resize image:<attachment> fit:Contain (no crop)` for a complete image with background padding, or `Cover (crop edges)` to fill the 16:9 canvas. The output is exactly 3840×2160 PNG. Discord upload size limits may vary; very detailed 4K PNGs can exceed the server's upload limit.

## Security note

This is a starter project. Before making it public for customers, add authentication/authorization, request rate limits, stronger validation, persistent database storage, backups, and an access policy for invoice searches. The invoice search command currently returns the invoice details ephemerally to the person requesting it.
