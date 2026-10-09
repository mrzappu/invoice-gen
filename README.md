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
- Private `/game game_name:<title>` command: search a Steam game and show a private Components V2 result (game image, game name, Steam India price, Our Price, and Game ID only). Discord displays “Only you can see this · Dismiss message”.
- `/game-price game_name:<title> our_price:<INR>` lets staff set/update the shop price. Re-run it to edit; use `0` to remove the listed price. If no shop price is set, the response shows “Our Price: Not listed”. The game result is a plain Components V2 card with only the game image, name, Steam price, our price, and Steam Game ID; it has no buttons or coloured embed.
- A styled normal-text sticky instruction message is automatically maintained in the configured game-price channel. Members use `/game` for private results; ordinary typed messages do not trigger public game lookups. Set `GAME_PRICE_CHANNEL_ID` to override the default channel ID.

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
2. Ensure the bot can View Channel, Read Message History, Send Messages, Embed Links, and Manage Messages in the game-price channel. Manage Messages is needed to move the normal-text sticky note to the bottom after member messages. The bot also needs Message Content Intent enabled in the Discord Developer Portal.
3. Set `CLIENT_ID` to the Discord application ID. Set `GUILD_ID` to your server ID to register slash commands quickly for that server. Restart/redeploy and check Render logs for “Guild slash commands registered”.
4. In the target channel, run `/game` and fill the `game_name` option. The reply is ephemeral/private and has the “Dismiss message” UI.
5. Staff use `/game-price game_name:<Steam game title> our_price:<INR>` to set or edit your shop price. Use `0` to clear it.

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


## Replacement invoices and ticket closure
- Staff can use `/invoice-replacement invoice_id:<original ID>` to create a new replacement invoice ID and a replacement PDF. The new record stores `replacementOf`, and the `invoice_replacements` table records the original ID, new ID, template name, staff member, and time. A direct command can DM only when the original invoice payload includes a usable `discordUserId` or `buyerDiscordId`.
- From an open ticket, use **Create Replacement Invoice**. This uses the ticket opener as the DM recipient, sends the replacement PDF where DMs are allowed, and posts the new invoice ID and original invoice ID in the ticket. Members can use the new invoice ID in `/invoice-panel` to open a separate ticket if the replacement has an issue.
- The PDF carries forward the invoice's seller name, template/theme label, color field (when saved as `themeColor` or `primaryColor`), products, and totals. The PDF generator is a clean invoice PDF; it does not reproduce arbitrary custom HTML/CSS templates or logos unless those are represented in saved invoice fields.
- The ticket **Close** button now permits the opener, assigned claimant, configured staff/admin, or server owner. It builds a text transcript before deletion, attempts to DM it to the opener, closer, and claimant, optionally posts a copy to `TICKET_LOG_CHANNEL_ID`, then deletes the ticket channel after a short delay. The bot needs Manage Channels, Read Message History, and permission to DM recipients (recipients can have DMs disabled).
- Set optional `TICKET_LOG_CHANNEL_ID` to a staff-only text channel if you want an archived transcript even when DMs fail.
- `/invoice-panel` posts a public panel; invoice lookup results and ticket creation confirmations remain private where appropriate.


## Buyer identity, replacement chain, and owner-channel delivery

- The invoice website has a **Buyer Discord User ID** field. Save the invoice after entering the ID so the bot can DM replacement PDFs to that buyer.
- New invoices save their selected preset (`Standard`, `Gojo's Steam Lounge`, or `IMPOSTER NETWORK`), theme colour, watermark, and footer branding. Replacement invoices inherit that saved template and colour scheme. The generated PDF uses the matching brand/accent colour and watermark setting.
- Each invoice ID can be replaced only once. The new replacement invoice ID can then be used for one further replacement, so replacements form a chain; the bot blocks replacing the same ID twice and reports the replacement count.
- Configure `REPLACEMENT_OWNER_CHANNEL_ID` (or `OWNER_CHANNEL_ID`) to a private staff/owner channel. Replacement records are sent there with the buyer, original/new invoice IDs, product, and spoiler-hidden account email/password. Restrict that channel to trusted staff because it can contain account credentials.
- `/invoice-replacement invoice_id:<ID>` creates a replacement from a saved invoice. Optional `account_email` and `account_password` values are accepted for the replacement account and are stored only in the private invoice/ticket database and sent as spoiler-hidden values to the configured owner channel and buyer DM where possible. Avoid running this command in a public channel because slash-command option values may be visible to channel members; use it in a private staff channel.
- Replacement DMs include the PDF, the new invoice ID, the previous ID, replacement count, template name, and spoiler-hidden credentials when available. A DM can fail if the buyer has DMs disabled.
- HTML ticket transcripts show profile avatars, display names, usernames, Discord user IDs, timestamps, message text, and attachment links.

Back up your production database before deployment. The ZIP's `invoice.db` is a snapshot and may not contain the latest production invoices.
