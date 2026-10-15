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


## Public game price cards (`/post`)

Staff/server owners can publish a public game card with `/post`. Provide exactly one of `game_name` or `game_id`, enter `our_price`, and optionally select `template` (`gojo`, `imposter`, or `standard`). The bot posts a titled card with green Our Price, red Steam Price, Game ID, Steam header image, Buy Game link button, and branded footer. Publishing also saves/updates the Our Price in SQLite so `/game` uses the same value. The command posts in the channel where it is invoked; use it in the desired public channel.

### `/post` game card style update
- `/post` now publishes a clean Discord Components V2 card matching the `/game` result style, without a traditional coloured embed sidebar.
- The card displays the game name, Our Price, Steam Price, game image, Buy Game button inside the card, and the selected template footer.
- `game_id` remains available as a search input, but the Game ID is not displayed in the public card.
- The Buy Game button opens the configured Discord destination channel: https://discord.com/channels/1519204760316809297/1526896976505864214


## Admin `/gen` — Steam metadata ZIP

Use `/gen app_id:<Steam App ID>` to create a private downloadable ZIP for a game listed on the Steam Store. The command is restricted to the server owner, administrators, members with Manage Channels, or the configured `STAFF_ROLE_ID`. The ZIP includes `game-metadata.json` and `README.txt` with a Gojo's Steam Lounge copyright/license notice. It contains metadata only—no game content, Steam manifests, Lua files, or ownership bypass. The command uses Steam's public Store app-details endpoint.

Install/download games through the official Steam client using an account that owns the game.

## Discord login and invoice admin audit
- `GET /auth/discord` starts Discord OAuth login; `GET /auth/discord/callback` completes it. Set `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, and `DISCORD_OAUTH_REDIRECT_URI` in Render. Register the redirect URI exactly in the Discord Developer Portal (for this service it will normally be `https://invoice-gen-1-it3l.onrender.com/auth/discord/callback`).
- `SESSION_SECRET` should be a long random secret (32+ characters). The session cookie is signed, HttpOnly, Secure, and SameSite=Lax.
- `ADMIN_DISCORD_IDS` is a comma-separated list of Discord user IDs allowed to view `/admin` and `/api/admin/invoices`.
- `INVOICE_LOG_CHANNEL_ID` is the Discord text channel ID where invoice creation/update reports and a PDF attachment are sent. `INVOICE_NOTIFICATION_CHANNEL_ID` is accepted as an alternate name. Give the bot View Channel, Send Messages, and Attach Files permissions there.
- The invoice website remains usable without logging in; invoice records made without OAuth show `Website user` rather than a verified Discord identity. To attribute invoices to a real Discord account, use Login with Discord before creating/saving them.
- `/admin` lists invoice activity with creator, buyer, date, products, totals, and the stored record. Only IDs in `ADMIN_DISCORD_IDS` can access it. Private account credentials are stored in the database payload; restrict database and admin access accordingly.

## Admin dashboard and invoice activity improvements

- `/admin` now uses a responsive dashboard with activity metrics, search, action filters, formatted JSON inspection, and CSV/JSON exports. The dashboard requires Discord OAuth and an ID listed in `ADMIN_DISCORD_IDS`.
- The main page checks `/auth/me` and switches the Discord login link to a signed-in account badge, Admin Dashboard link (admins only), and Logout link when a session exists.
- Invoice IDs use `INV-YYYYMMDD-XXXXX` (date plus a random uppercase alphanumeric code) for newly generated invoices. Existing stored invoice IDs are not rewritten.
- Invoice-created/updated Discord logs are sent as a Discord Components V2 card with a verified creator/seller mention when the creator is logged in, plus a professionally laid-out PDF attachment.
- The Discord PDF uses the bundled DejaVu Sans fonts for currency and Unicode support. PDF notifications omit private account email/password fields. Keep the admin page and its full-payload exports private because those records may contain sensitive product account information.


## Admin dashboard V3: profile, audit history and protected database transfer
- The admin dashboard has Invoice History, Login History, Database & Security, and Admin Profile tabs. Invoice records can be inspected as formatted JSON or edited through the complete payload editor; edits create an `admin edited` audit record. CSV/JSON exports are available.
- Successful Discord OAuth logins are recorded in `admin_login_history` with Discord ID, username, avatar hash, and timestamp. The dashboard displays profile details and last-login information. This history begins after this version is deployed.
- `ADMIN_SECURITY_CHANNEL_ID` is the recommended private Discord text channel for 6-digit database upload verification codes. If unset, the app falls back to `INVOICE_LOG_CHANNEL_ID` or `INVOICE_NOTIFICATION_CHANNEL_ID`. Give the bot View Channel, Send Messages, and Embed Links permissions; restrict channel access to trusted admins.
- Database upload requires an authenticated admin and a 6-digit code delivered in Discord. Codes expire after 10 minutes, have a 60-second resend cooldown, and allow up to five attempts. Uploads are SQLite-integrity-checked and merged into the live invoice database; matching invoice IDs are updated. Other tables such as tickets and bot settings are intentionally not overwritten. Download a fresh backup before importing.
- Invoice log cards mention the seller/creator and buyer when their valid Discord IDs are present in the invoice payload.

## Admin / Support / Payment QR V4 updates

- Admin invoice editing now has a visual editor for common seller, buyer, Discord ID, document, payment, totals, theme, QR, terms and product fields, plus an Advanced JSON editor for custom fields. Invoice IDs remain immutable; use the replacement workflow to issue a new ID. Admin edits create an audit record with editor identity and changed field names and notify the configured invoice log channel with an invoice image and matching PDF.
- Support ticket reasons are limited to **Replace**, **Help**, **Bug**, and **Refund**. The replacement button is disabled until a ticket is claimed. After claim, the button opens a form for the replacement product name and new account email/ID and password. The replacement gets a new `INV-...` ID, a generated invoice image and a PDF made from that same image, and is sent to the ticket channel, configured invoice log channel, and ticket opener by DM when DMs are enabled.
- The bot registers `/qr` with `payment_type` (`upi` or `ltc`), `address`, `item`, and optional `amount`. The QR card is an ephemeral Discord Components V2 response visible only to the command user, with no colored sidebar. It includes the QR image, payment details, and the instruction: “After payment, please send a screenshot of the payment receipt in your support ticket.” UPI amounts are in INR; Litecoin amounts are in LTC. QR generation does not verify or confirm that a payment was received; always verify the recipient/address and amount before paying.
- Keep `INVOICE_LOG_CHANNEL_ID` (or `INVOICE_NOTIFICATION_CHANNEL_ID`) configured and make sure the bot has View Channel, Send Messages, Attach Files, and Embed Links permissions. For support ticket claiming, configure `STAFF_ROLE_ID` or grant trusted staff Manage Channels permissions.
- Slash commands are registered on bot startup. Set `GUILD_ID` for fast guild command updates; global command changes can take longer to appear.
