# INET Invoice Studio + Discord Support Bot

Node.js/Express website and Discord bot. Invoice records and private product credentials are stored in SQLite (`invoice.db`). The public invoice API never returns account email/ID or password fields, and the invoice preview/PNG/PDF never renders them.

## Features
- Imposter Network and Gojo's Steam Lounge invoice templates, nine themes, live preview, PNG/PDF/print exports.
- Save/search invoices using the same invoice ID.
- SQLite database with automatic schema creation and a compatibility import for legacy `invoices.json` records.
- `/invoice-search`: invoice lookup, buyer selection, product selection, Replace/Help/Bug/Refund reason, then private ticket creation.
- Ticket controls in a Discord Components V2 container: Claim, Close, Reopen, Account Details, Add user, Remove user.
- Private credentials are revealed ephemerally only to the ticket claimant or server owner.
- `/resize`: resize an attached image to 3840×2160 PNG using Contain or Cover.

## Local setup
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Set environment variables (see below).
4. Run `npm start` and open `http://localhost:10000`.

## Environment variables
- `DISCORD_TOKEN` — bot token.
- `CLIENT_ID` — Discord application ID.
- `GUILD_ID` — optional test server ID; guild commands update quickly when supplied.
- `STAFF_ROLE_ID` — optional staff role given access to new ticket channels.
- `DB_FILE` — optional explicit SQLite database path. Default: `./invoice.db`.
- `DATA_DIR` — optional data directory. If set, default database path becomes `$DATA_DIR/invoice.db`.
- `INVOICE_API_KEY` — optional API key. If configured, website fetch requests must also send `x-api-key`; configure the frontend accordingly before enabling this.

## Render deployment
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`
- Add `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and optionally `STAFF_ROLE_ID` in Render Environment.
- To preserve SQLite data, use storage that persists across deploys/restarts and set `DB_FILE` to that mounted path. Render Free Web Services have ephemeral filesystems and may sleep; do not treat the bundled `invoice.db` or the free service filesystem as permanent storage.

## Fix for `No data found`
1. On the website, click **Save to lookup** after creating the invoice. The status must confirm the invoice ID was saved.
2. Search the exact same invoice ID using `/invoice-search`.
3. On startup, this version imports any legacy `invoices.json` found beside the app, in `data/`, or in `DATA_DIR` into SQLite when that ID is not already present.
4. Check Render logs for database startup errors. Keep the same `DB_FILE` path across website and bot (they run in the same Node process).

## Account details safety
Enter optional account email/ID and password in the product row. They are stored in the SQLite invoice payload but excluded from public invoice API responses and visual exports. Ticket account details are ephemeral and available only to the claimed staff member or server owner. Use trusted staff only, rotate credentials after use, and protect backups of `invoice.db` because it contains sensitive data.

## Discord permissions
Invite the bot with `bot` and `applications.commands` scopes. It needs View Channels, Send Messages, Read Message History, Manage Channels, and Manage Roles/permission-overwrite access in the support category. Configure `STAFF_ROLE_ID` if you want a staff role automatically added to new tickets. The bot must be in the target server and `CLIENT_ID` must match its application.
