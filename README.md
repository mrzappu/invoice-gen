# Invoice Studio + Discord Support Bot

Node.js/Express website and Discord bot. Invoice records and private product credentials are stored in SQLite (`invoice.db`). The public invoice API never returns account email/ID or password fields, and the invoice preview/PNG/PDF never renders them.

## Features
- Generic invoice templates, color themes, live preview, PNG/PDF/print exports.
- Save/search invoices using the same invoice ID.
- SQLite database with automatic schema creation and a compatibility import for legacy `invoices.json` records.
- `/invoice-search`: invoice lookup, buyer selection, product selection, Replace/Help/Bug/Refund reason, then private ticket creation.
- Ticket controls in a Discord Components V2 container: Claim, Close, Reopen, Account Details, Add user, Remove user.
- Private credentials are revealed ephemerally only to the ticket claimant or server owner.
- `/resize`: resize an attached image to 3840×2160 PNG using Contain or Cover.
- Game-price lookup in Discord channel `1529155314887163986`: members type a game name to see Steam India pricing, game details, and SteamDB/Steam links.
- `/game-price game_name:<title> our_price:<INR>` lets staff set/update the shop price. Re-run it to edit; use `0` to remove the listed price. If no shop price is set, the response shows “Our Price: Not listed”. The game result is a plain Components V2 card with only the game image, name, Steam price, our price, and Steam Game ID; it has no buttons or coloured embed.
- A normal-text sticky instruction message is automatically maintained in the configured game-price channel. When a Steam game is found, the member’s typed search message is deleted and replaced with a Components V2 result card. Set `GAME_PRICE_CHANNEL_ID` to override the default channel ID. Discord only allows “Only you can see this / Dismiss message” ephemeral responses for interactions (such as slash commands or button clicks), not for ordinary typed messages.

## Local setup
1. Install Node.js 22.22.0.
2. Run `npm install`.
3. Set environment variables (see below).
4. Run `npm start` and open `http://localhost:10000`.

## Environment variables
- `DISCORD_TOKEN` — bot token.
- `CLIENT_ID` — Discord application ID.
- `GUILD_ID` — optional test server ID; guild commands update quickly when supplied.
- `STAFF_ROLE_ID` — optional staff role given access to new ticket channels.
- `GAME_PRICE_CHANNEL_ID` — optional channel for game-name lookup; defaults to `1529155314887163986`.
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

## Game-price channel setup
1. Enable **Message Content Intent** for the bot in the Discord Developer Portal (Bot settings).
2. Ensure the bot can View Channel, Read Message History, Send Messages, Embed Links, and Manage Messages in the game-price channel. Manage Messages is needed to delete typed game searches and move the normal-text sticky note to the bottom after member messages. The bot also needs Message Content Intent enabled in the Discord Developer Portal.
3. Deploy the code, then in the target channel type a game title. Members can only trigger lookups in the configured channel.
4. Staff use `/game-price game_name:<Steam game title> our_price:<INR>` to set or edit your shop price. Use `0` to clear it.

Game details/prices are retrieved from Steam’s store endpoints, and each result includes a SteamDB details link. SteamDB says it has no public API and does not allow automated scraping, so the bot does not scrape SteamDB directly. Steam store pricing can change with sales and region settings.

## Discord permissions
Invite the bot with `bot` and `applications.commands` scopes. It needs View Channels, Send Messages, Read Message History, Manage Channels, and Manage Roles/permission-overwrite access in the support category. Configure `STAFF_ROLE_ID` if you want a staff role automatically added to new tickets. The bot must be in the target server and `CLIENT_ID` must match its application.

## Render build fix (Node.js / better-sqlite3)

This project pins Node.js **22.22.0** in `.node-version`, `package.json`, and `render.yaml`. The reported error is caused by Render building `better-sqlite3` under Node.js 26, whose V8 API is incompatible with this dependency version. Upload/commit all three updated files to the same repository branch and root directory configured in Render.

**Important:** Render Dashboard `NODE_VERSION` environment variables take precedence over files in the repository. Open **Render → your service → Environment** and change any existing `NODE_VERSION` value to `22.22.0` (or remove it so `.node-version` is used). Then open **Manual Deploy → Clear build cache & deploy**. The first lines of the new build log should say Node.js `22.22.0`, not `26.11.1`. If it still says 26, Render is using an override, a different branch/commit, or a different root directory.

Do not commit production credentials or a database containing customer/account passwords to a public repository. Render's free filesystem is ephemeral, so configure persistent storage or a managed database for production records.


## Updated Discord panel and ticket permissions
- `/invoice-panel` posts a button panel. Users press **Search Invoice / Open Ticket**, enter the invoice ID in a modal, then choose the product and ticket reason.
- `/invoice-inspect invoice_id:<ID>` is for server administrators, members with **Manage Channels**, the configured `STAFF_ROLE_ID`, and the server owner. It shows saved invoice totals and product/account details ephemerally.
- Staff can claim unclaimed tickets. The assigned claimant can unclaim their own ticket. The server owner can unclaim or take over a ticket claimed by another staff member.
- The ticket opener, assigned claimant, or server owner can close a ticket. Only the assigned claimant or server owner can reopen it.
- Set `STAFF_ROLE_ID` in Render to your staff role ID. The bot needs permission to create/manage channels and manage channel overwrites. Re-deploy after updating the source so Discord refreshes the slash commands.
