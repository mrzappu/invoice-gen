'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const multer = require('multer');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, EmbedBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder
} = require('discord.js');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const API_KEY = process.env.INVOICE_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'invoice.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
 invoice_id TEXT PRIMARY KEY COLLATE NOCASE, buyer_name TEXT NOT NULL, payload TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL COLLATE NOCASE,
 guild_id TEXT NOT NULL, channel_id TEXT, opener_id TEXT NOT NULL, claimed_by TEXT,
 product_name TEXT NOT NULL, issue_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
 created_at TEXT NOT NULL, closed_at TEXT, product_index INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(invoice_id) REFERENCES invoices(invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_tickets_invoice ON tickets(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id);
CREATE TABLE IF NOT EXISTS game_prices (app_id TEXT PRIMARY KEY, game_name TEXT NOT NULL, our_price REAL NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoice_replacements (new_invoice_id TEXT PRIMARY KEY COLLATE NOCASE, original_invoice_id TEXT NOT NULL COLLATE NOCASE, ticket_id INTEGER, created_by TEXT NOT NULL, template_name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoice_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, creator_id TEXT, creator_username TEXT, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_login_history (id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL, username TEXT NOT NULL, avatar TEXT, logged_in_at TEXT NOT NULL);
`);
try { db.exec('ALTER TABLE tickets ADD COLUMN product_index INTEGER NOT NULL DEFAULT 0'); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_replacements_one_use ON invoice_replacements(original_invoice_id COLLATE NOCASE)'); } catch (e) { console.warn('Could not add replacement one-use index (legacy duplicate replacement records may exist); runtime checks remain enabled:', e.message); }
app.use(express.json({ limit: '8mb' }));
// Serve the QR generator locally so invoice QR codes do not depend on a third-party CDN.
app.use('/vendor/qrcode', express.static(path.join(__dirname, 'node_modules', 'qrcode', 'build')));
app.get('/api/qr', async (req,res)=>{try{const text=String(req.query.text||'');const size=Math.max(72,Math.min(160,Number(req.query.size)||104));if(!text||text.length>2000)return res.status(400).json({error:'A valid QR payload is required.'});const dataUrl=await require('qrcode').toDataURL(text,{width:size,margin:1,errorCorrectionLevel:'M',color:{dark:'#111111',light:'#ffffff'}});res.set('Cache-Control','no-store');res.json({dataUrl});}catch(err){console.error('QR API error:',err);res.status(500).json({error:'QR generation failed on server.'});}});
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
function safeEqual(a, b) { const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||'')); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function apiAuth(req,res,next){ if(API_KEY && !safeEqual(req.get('x-api-key'),API_KEY)) return res.status(401).json({error:'Unauthorized API key.'}); next(); }
function normalizeInvoice(row) { if(!row) return null; try { return JSON.parse(row.payload); } catch { return null; } }
function getInvoice(id) { return normalizeInvoice(db.prepare('SELECT payload FROM invoices WHERE invoice_id = ? COLLATE NOCASE').get(String(id||'').trim())); }
function saveInvoice(body) {
  const invoiceId=String(body.invoiceId||'').trim(); const buyerName=String(body.buyerName||'').trim();
  if(!invoiceId || !buyerName) throw new Error('invoiceId and buyerName are required.');
  if(invoiceId.length>100 || buyerName.length>200) throw new Error('Invoice ID or buyer name is too long.');
  const now=new Date().toISOString();
  const products=Array.isArray(body.products)?body.products.slice(0,100).map(p=>({
    ...p, name:String(p.name||'Product').slice(0,200), qty:Math.max(0,Number(p.qty)||0), price:Math.max(0,Number(p.price)||0),
    accountEmail:String(p.accountEmail||'').slice(0,500), accountPassword:String(p.accountPassword||'').slice(0,1000)
  })):[];
  const payload={...body,invoiceId,buyerName,products,savedAt:now};
  db.prepare(`INSERT INTO invoices(invoice_id,buyer_name,payload,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(invoice_id) DO UPDATE SET buyer_name=excluded.buyer_name,payload=excluded.payload,updated_at=excluded.updated_at`)
    .run(invoiceId,buyerName,JSON.stringify(payload),now,now);
  return payload;
}
// Backfill existing saved invoices into the audit log so the admin dashboard also shows older records.
try {
 const oldInvoices=db.prepare('SELECT invoice_id,payload,created_at FROM invoices').all();
 const hasActivity=db.prepare('SELECT 1 FROM invoice_activity WHERE invoice_id=? LIMIT 1');
 const addActivity=db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)');
 for(const row of oldInvoices){if(!hasActivity.get(row.invoice_id)){let payload={};try{payload=JSON.parse(row.payload)}catch{};addActivity.run(row.invoice_id,'existing record',row.created_at||new Date().toISOString(),payload.createdBy?.id||null,payload.createdBy?.username||'Previously saved invoice',row.payload);}}
} catch(e){console.warn('Invoice activity backfill skipped:',e.message);}
// One-time compatibility migration: import records from the previous invoices.json build.
for (const legacyFile of [path.join(__dirname, 'invoices.json'), path.join(__dirname, 'data', 'invoices.json'), path.join(DATA_DIR, 'invoices.json')]) {
  try { if (fs.existsSync(legacyFile)) { const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); if (Array.isArray(legacy)) for (const item of legacy) { if (item && item.invoiceId && item.buyerName && !getInvoice(item.invoiceId)) saveInvoice(item); } console.log(`Imported legacy invoice records from ${legacyFile}`); } } catch (e) { console.warn(`Could not import ${legacyFile}: ${e.message}`); }
}

// Discord OAuth login + signed, HTTP-only session cookie.
const OAUTH_CLIENT_ID = String(process.env.DISCORD_OAUTH_CLIENT_ID || process.env.CLIENT_ID || '').trim();
const OAUTH_CLIENT_SECRET = String(process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim();
function getOAuthRedirectUri(req) {
  if (process.env.DISCORD_OAUTH_REDIRECT_URI && process.env.DISCORD_OAUTH_REDIRECT_URI.trim()) {
    return process.env.DISCORD_OAUTH_REDIRECT_URI.trim();
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, '')}/auth/discord/callback`;
  }
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) return `${proto}://${host}/auth/discord/callback`;
  }
  return '';
}
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_TOKEN || 'change-this-session-secret').trim();
const ADMIN_DISCORD_IDS = new Set(String(process.env.ADMIN_DISCORD_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
function signValue(value){const data=Buffer.from(JSON.stringify(value)).toString('base64url');const sig=crypto.createHmac('sha256',SESSION_SECRET).update(data).digest('base64url');return `${data}.${sig}`;}
function readSigned(value){try{const [data,sig]=String(value||'').split('.');if(!data||!sig)return null;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(data).digest('base64url');if(!safeEqual(sig,expected))return null;const obj=JSON.parse(Buffer.from(data,'base64url').toString());if(obj.exp && obj.exp<Date.now())return null;return obj;}catch{return null;}}
function cookieValue(req,name){const raw=String(req.headers.cookie||'');const m=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return m?decodeURIComponent(m.slice(name.length+1)):'';}
function sessionUser(req){const value=readSigned(cookieValue(req,'invoice_session'));return value?.user||null;}
function isAdminUser(user){return Boolean(user?.id && ADMIN_DISCORD_IDS.has(String(user.id)));}
function requireAdmin(req,res,next){const user=sessionUser(req);if(!user)return res.status(401).json({error:'Login with Discord first.'});if(!isAdminUser(user))return res.status(403).json({error:'Administrator access required.'});req.sessionUser=user;next();}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
app.get('/auth/discord',(req,res)=>{
 const redirectUri = getOAuthRedirectUri(req);
 const missing = [];
 if (!OAUTH_CLIENT_ID) missing.push('DISCORD_OAUTH_CLIENT_ID (or CLIENT_ID)');
 if (!OAUTH_CLIENT_SECRET) missing.push('DISCORD_OAUTH_CLIENT_SECRET');
 if (!redirectUri) missing.push('DISCORD_OAUTH_REDIRECT_URI');
 if (missing.length) {
   return res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Discord OAuth Not Configured</title><style>body{background:#0c0f17;color:#e2e8f0;font-family:system-ui;padding:40px;max-width:640px;margin:0 auto}h1{color:#f87171}code{background:#1e293b;padding:2px 6px;border-radius:4px;color:#93c5fd}ul{line-height:1.8}a{color:#60a5fa}</style></head><body><h1>OAuth Configuration Incomplete</h1><p>The following required environment variable(s) are missing in Render:</p><ul>${missing.map(m=>`<li><code>${escapeHtml(m)}</code></li>`).join('')}</ul><p>Please set them in Render &rarr; Environment, then redeploy.</p><p><a href="/">&larr; Back to Invoice Studio</a></p></body></html>`);
 }
 const state=crypto.randomBytes(24).toString('hex');
 res.setHeader('Set-Cookie',`invoice_oauth_state=${signValue({state,exp:Date.now()+10*60*1000})}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
 const url=new URL('https://discord.com/oauth2/authorize');url.searchParams.set('client_id',OAUTH_CLIENT_ID);url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('response_type','code');url.searchParams.set('scope','identify');url.searchParams.set('state',state);
 res.redirect(url.toString());
});
app.get('/auth/discord/callback',async(req,res)=>{
 const redirectUri = getOAuthRedirectUri(req);
 try{
  const saved=readSigned(cookieValue(req,'invoice_oauth_state'));res.setHeader('Set-Cookie','invoice_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  if(!saved||!req.query.state||!safeEqual(saved.state,req.query.state))return res.status(400).send('Invalid or expired Discord login state. Please try again.');
  if(req.query.error)return res.status(400).send(`Discord login was cancelled or denied: ${escapeHtml(req.query.error_description||req.query.error)}`);
  if(!req.query.code)return res.status(400).send('Discord login was cancelled.');
  const tokenResponse=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:OAUTH_CLIENT_ID,client_secret:OAUTH_CLIENT_SECRET,grant_type:'authorization_code',code:String(req.query.code),redirect_uri:redirectUri})});
  const tokenRaw=await tokenResponse.text();
  let token={};
  try{token=JSON.parse(tokenRaw);}catch{token={error:tokenRaw};}
  if(!tokenResponse.ok||!token.access_token){
    const detail=token.error_description?`${token.error}: ${token.error_description}`:(token.error||tokenRaw);
    console.error('Discord OAuth token exchange failed:',tokenResponse.status,detail);
    throw new Error(detail);
  }
  const userResponse=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});
  const user=await userResponse.json();if(!userResponse.ok||!user.id)throw new Error('Could not retrieve Discord profile.');
  const profile={id:String(user.id),username:user.global_name||user.username,discriminator:user.discriminator||'0',avatar:user.avatar||null};
  try{db.prepare('INSERT INTO admin_login_history(discord_id,username,avatar,logged_in_at) VALUES(?,?,?,?)').run(profile.id,profile.username,profile.avatar,new Date().toISOString());}catch(e){console.warn('Could not record Discord login history:',e.message);}
  const session=signValue({user:profile,exp:Date.now()+7*24*60*60*1000});
  res.setHeader('Set-Cookie',`invoice_session=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
  res.redirect('/');
 }catch(e){
  console.error('Discord OAuth failed:',e.message);
  res.status(502).type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Discord Login Failed</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0c0f17;color:#e2e8f0;padding:40px 20px;line-height:1.6;max-width:680px;margin:0 auto}
.card{background:#161b26;border:1px solid #2d3748;border-radius:12px;padding:24px;box-shadow:0 10px 25px rgba(0,0,0,.5)}
h1{color:#f87171;font-size:22px;margin-top:0}
.badge{display:inline-block;background:#ef444422;color:#f87171;border:1px solid #ef444444;border-radius:6px;padding:6px 12px;font-family:monospace;font-size:14px;margin-bottom:16px;word-break:break-all}
ol{padding-left:20px}
li{margin-bottom:12px}
code{background:#0b0d13;color:#93c5fd;padding:2px 6px;border-radius:4px;font-size:13px}
a{color:#60a5fa;text-decoration:none}
a:hover{text-decoration:underline}
.btn{display:inline-block;margin-top:16px;background:#2563eb;color:#fff;padding:8px 18px;border-radius:6px;font-weight:500}
</style>
</head>
<body>
<div class="card">
  <h1>Discord Login Failed</h1>
  <div class="badge">Discord Error: ${escapeHtml(e.message)}</div>
  <p>The server could not complete the OAuth login. Please check these settings in <b>Render</b> and the <b>Discord Developer Portal</b>:</p>
  <ol>
    <li><b>DISCORD_OAUTH_CLIENT_SECRET in Render:</b><br>
    In <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> &rarr; Your App &rarr; <b>OAuth2</b> &rarr; <b>General</b>, copy the <b>Client Secret</b> (click <i>Reset Secret</i> if needed) and paste it into Render Environment variables as <code>DISCORD_OAUTH_CLIENT_SECRET</code>.<br>
    <em>Important: Do not paste the Bot Token here. OAuth Client Secret and Bot Token are different.</em></li>
    <li><b>OAuth2 Redirect URI in Discord Developer Portal:</b><br>
    Under <b>OAuth2 &rarr; Redirects</b>, make sure this exact URL is added:<br>
    <code>${escapeHtml(redirectUri || 'https://invoice-gen-bbgn.onrender.com/auth/discord/callback')}</code></li>
    <li><b>DISCORD_OAUTH_REDIRECT_URI in Render:</b><br>
    In Render Environment, set <code>DISCORD_OAUTH_REDIRECT_URI</code> to:<br>
    <code>${escapeHtml(redirectUri || 'https://invoice-gen-bbgn.onrender.com/auth/discord/callback')}</code></li>
  </ol>
  <a class="btn" href="/">Return to Invoice Studio</a>
</div>
</body>
</html>`);
 }
});
app.get('/auth/me',(req,res)=>{const user=sessionUser(req);res.json({loggedIn:Boolean(user),user:user?{...user,isAdmin:isAdminUser(user)}:null});});
app.get('/logout',(req,res)=>{res.setHeader('Set-Cookie','invoice_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');res.redirect('/');});
app.get('/admin',(req,res)=>{
 const user=sessionUser(req);if(!user)return res.redirect('/auth/discord');
 if(!isAdminUser(user))return res.status(403).send('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#080b14;color:#eef2ff;font:16px system-ui;padding:40px"><h1>403 — Admin access required</h1><p>Your Discord account is signed in, but it is not listed in ADMIN_DISCORD_IDS.</p><p><a style="color:#9ba7ff" href="/">Back to Invoice Studio</a> · <a style="color:#9ba7ff" href="/logout">Logout</a></p></body></html>');
 try { const avatarUrl=user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith('a_')?'gif':'png'}?size=128`:`https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id)%6n)}.png`;const html=fs.readFileSync(path.join(__dirname,'public','admin.html'),'utf8').replaceAll('__USERNAME__',escapeHtml(user.username)).replaceAll('__USERID__',escapeHtml(user.id)).replaceAll('__AVATAR_URL__',escapeHtml(avatarUrl)).replaceAll('__DISCRIMINATOR__',escapeHtml(user.discriminator||'0'));res.type('html').send(html); }
 catch(e){console.error('Admin dashboard render failed:',e.message);res.status(500).send('Admin dashboard file is missing.');}
});
app.get('/api/admin/invoices',requireAdmin,(req,res)=>{
 const q=String(req.query.q||'').slice(0,150);
 const rows=q?db.prepare(`SELECT * FROM invoice_activity WHERE invoice_id LIKE ? OR creator_username LIKE ? OR creator_id LIKE ? OR payload LIKE ? ORDER BY id DESC LIMIT 1000`).all(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`):db.prepare('SELECT * FROM invoice_activity ORDER BY id DESC LIMIT 1000').all();
 res.set('Cache-Control','no-store');res.json({items:rows.map(r=>({...r,payload:(()=>{try{return JSON.parse(r.payload)}catch{return {}}})()}))});
});
app.get('/api/admin/profile',requireAdmin,(req,res)=>{
 const user=req.sessionUser;const last=db.prepare('SELECT logged_in_at FROM admin_login_history WHERE discord_id=? ORDER BY id DESC LIMIT 1').get(user.id);
 res.set('Cache-Control','no-store');res.json({profile:{id:user.id,username:user.username,discriminator:user.discriminator||'0',avatar:user.avatar||null,isAdmin:true,lastLogin:last?.logged_in_at||null},loginCount:db.prepare('SELECT COUNT(*) AS n FROM admin_login_history WHERE discord_id=?').get(user.id).n});
});
app.get('/api/admin/logins',requireAdmin,(req,res)=>{
 const rows=db.prepare('SELECT id,discord_id,username,avatar,logged_in_at FROM admin_login_history ORDER BY id DESC LIMIT 500').all();res.set('Cache-Control','no-store');res.json({items:rows});
});
app.put('/api/admin/invoices/:id',requireAdmin,(req,res)=>{
 try{const original=getInvoice(req.params.id);if(!original)return res.status(404).json({error:'Invoice not found.'});const incoming=req.body?.payload;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({error:'Send the edited invoice as a JSON object in payload.'});
  const requestedId=String(incoming.invoiceId||req.params.id).trim();if(requestedId.toLowerCase()!==String(req.params.id).trim().toLowerCase())return res.status(400).json({error:'Invoice IDs are immutable. Use the ticket replacement workflow to generate a new invoice ID.'});const payload={...incoming,invoiceId:String(req.params.id).trim(),buyerName:String(incoming.buyerName||original.buyerName||'').trim(),createdBy:{id:req.sessionUser.id,username:req.sessionUser.username}};
  const changedFields=[...new Set([...Object.keys(original),...Object.keys(payload)])].filter(k=>!['_editMeta','savedAt','createdBy'].includes(k)&&JSON.stringify(original[k])!==JSON.stringify(payload[k]));
  const record=saveInvoice(payload);const stamp=new Date().toISOString();const auditPayload={...record,_editMeta:{editedBy:{id:req.sessionUser.id,username:req.sessionUser.username},changedFields}};db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)').run(record.invoiceId,'admin edited',stamp,req.sessionUser.id,req.sessionUser.username,JSON.stringify(auditPayload));
  notifyInvoiceDiscord(auditPayload,'admin edited',req.sessionUser,null).catch(()=>{});
  res.json({ok:true,invoiceId:record.invoiceId,savedAt:record.savedAt});
 }catch(e){res.status(400).json({error:e.message||'Could not update invoice.'});}
});
// Database backup is made through SQLite's online backup API so WAL data is included safely.
app.get('/api/admin/database/download',requireAdmin,async(req,res)=>{
 const backupPath=path.join(os.tmpdir(),`invoice-backup-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.sqlite`);
 try{await db.backup(backupPath);res.setHeader('Cache-Control','no-store');res.download(backupPath,`invoice-database-${new Date().toISOString().slice(0,10)}.sqlite`,err=>{fs.promises.unlink(backupPath).catch(()=>{});if(err&&!res.headersSent)res.status(500).end('Database download failed.');});}catch(e){fs.promises.unlink(backupPath).catch(()=>{});console.error('Database backup failed:',e.message);res.status(500).json({error:'Could not create database backup.'});}
});
const uploadCodes=new Map(),uploadGrants=new Map(),uploadCooldowns=new Map();
const databaseUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:1}});
app.post('/api/admin/database/request-code',requireAdmin,async(req,res)=>{
 const user=req.sessionUser,now=Date.now(),last=uploadCooldowns.get(user.id)||0;if(now-last<60000)return res.status(429).json({error:`Please wait ${Math.ceil((60000-(now-last))/1000)} seconds before requesting another code.`});
 const channelId=process.env.ADMIN_SECURITY_CHANNEL_ID||process.env.INVOICE_LOG_CHANNEL_ID||process.env.INVOICE_NOTIFICATION_CHANNEL_ID;if(!channelId)return res.status(503).json({error:'Set ADMIN_SECURITY_CHANNEL_ID (recommended) or INVOICE_LOG_CHANNEL_ID in Render first.'});if(!bot)return res.status(503).json({error:'Discord bot is not connected yet. Try again shortly.'});
 try{const channel=await bot.channels.fetch(channelId);if(!channel?.isTextBased()||!channel.send)return res.status(400).json({error:'Configured verification channel is not a text channel the bot can send to.'});
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');uploadCodes.set(user.id,{hash:crypto.createHash('sha256').update(`${user.id}:${code}:${SESSION_SECRET}`).digest('hex'),expires:now+10*60*1000,attempts:0});uploadGrants.delete(user.id);uploadCooldowns.set(user.id,now);
  await channel.send({embeds:[new EmbedBuilder().setColor(0xf0b64b).setTitle('🔐 Database upload verification').setDescription(`Admin: <@${user.id}> (\`${user.id}\`)
A database upload verification code was requested.

**Verification code: \`${code}\`**
Expires in **10 minutes**. Do not share this code.`).setFooter({text:'Invoice Studio security • only use this code in the Admin Dashboard'}).setTimestamp()],allowedMentions:{users:[String(user.id)],parse:[]}});
  res.json({ok:true,message:'Verification code sent to the configured Discord channel. It expires in 10 minutes.'});
 }catch(e){uploadCodes.delete(user.id);console.error('Database verification code send failed:',e.message);res.status(502).json({error:'Could not send the verification code. Check bot permissions and channel ID.'});}
});
app.post('/api/admin/database/verify-code',requireAdmin,(req,res)=>{
 const user=req.sessionUser,entry=uploadCodes.get(user.id),code=String(req.body?.code||'').trim();if(!entry||entry.expires<Date.now()){uploadCodes.delete(user.id);return res.status(400).json({error:'Code expired or not requested. Request a new code.'});}
 if(!/^\d{6}$/.test(code))return res.status(400).json({error:'Enter the 6-digit code.'});
 const digest=crypto.createHash('sha256').update(`${user.id}:${code}:${SESSION_SECRET}`).digest('hex');if(!safeEqual(entry.hash,digest)){entry.attempts++;if(entry.attempts>=5)uploadCodes.delete(user.id);return res.status(400).json({error:entry.attempts>=5?'Too many incorrect attempts. Request a new code.':'Incorrect code. Please try again.'});}
 uploadCodes.delete(user.id);uploadGrants.set(user.id,Date.now()+10*60*1000);res.json({ok:true,message:'Verified. You can upload a database backup for the next 10 minutes.'});
});
app.post('/api/admin/database/upload',requireAdmin,(req,res,next)=>{const until=uploadGrants.get(req.sessionUser.id)||0;if(until<Date.now()){uploadGrants.delete(req.sessionUser.id);return res.status(403).json({error:'Verify a fresh 6-digit Discord code before uploading.'});}next();},databaseUpload.single('database'),(req,res)=>{
 const user=req.sessionUser;if(!req.file)return res.status(400).json({error:'Choose a SQLite database backup file first.'});const temp=path.join(os.tmpdir(),`invoice-import-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.sqlite`);let source;
 try{fs.writeFileSync(temp,req.file.buffer,{flag:'wx'});source=new Database(temp,{readonly:true,fileMustExist:true});const check=source.pragma('quick_check');if(!check?.length||check[0].quick_check!=='ok')throw new Error('SQLite integrity check failed.');const table=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'").get();if(!table)throw new Error('This file is not an Invoice Studio database (invoices table missing).');const cols=source.prepare('PRAGMA table_info(invoices)').all().map(x=>x.name);if(!['invoice_id','buyer_name','payload','created_at','updated_at'].every(x=>cols.includes(x)))throw new Error('Database invoices table has an incompatible schema.');
  const sourceInvoices=source.prepare('SELECT invoice_id,buyer_name,payload,created_at,updated_at FROM invoices').all();for(const row of sourceInvoices){let parsed;try{parsed=JSON.parse(row.payload)}catch{throw new Error(`Invoice ${row.invoice_id} contains invalid JSON payload.`)}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!String(row.invoice_id||'').trim()||!String(row.buyer_name||'').trim())throw new Error(`Invoice ${row.invoice_id||'(unknown)'} has invalid required fields.`);}const sourceHasActivity=Boolean(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_activity'").get());const sourceActivity=sourceHasActivity?source.prepare('SELECT invoice_id,action,created_at,creator_id,creator_username,payload FROM invoice_activity').all():[];
  const insertInvoice=db.prepare(`INSERT INTO invoices(invoice_id,buyer_name,payload,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET buyer_name=excluded.buyer_name,payload=excluded.payload,updated_at=excluded.updated_at`);const hasActivity=db.prepare('SELECT 1 FROM invoice_activity WHERE invoice_id=? AND action=? AND created_at=? AND payload=? LIMIT 1');const insertActivity=db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)');
  const merge=db.transaction(()=>{for(const row of sourceInvoices)insertInvoice.run(row.invoice_id,row.buyer_name,row.payload,row.created_at,row.updated_at);for(const row of sourceActivity){if(!hasActivity.get(row.invoice_id,row.action,row.created_at,row.payload))insertActivity.run(row.invoice_id,row.action,row.created_at,row.creator_id,row.creator_username,row.payload);}});merge();uploadGrants.delete(user.id);
  const stamp=new Date().toISOString();db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)').run('DATABASE-IMPORT','database imported',stamp,user.id,user.username,JSON.stringify({invoiceCount:sourceInvoices.length,activityCount:sourceActivity.length,importedBy:{id:user.id,username:user.username},savedAt:stamp}));
  res.json({ok:true,message:`Database merged successfully: ${sourceInvoices.length} invoice records and ${sourceActivity.length} activity records imported. Existing invoices with matching IDs were updated. Tickets and bot settings were not overwritten.`});
 }catch(e){console.warn('Database upload rejected:',e.message);res.status(400).json({error:e.message||'Could not import database.'});}finally{try{source?.close()}catch{}fs.promises.unlink(temp).catch(()=>{});}
});
function makeInvoicePdf(payload){
 return new Promise((resolve,reject)=>{try{
  const doc=new PDFDocument({size:'A4',margin:44,info:{Title:`Invoice ${payload.invoiceId||''}`,Author:String(payload.sellerName||payload.brandName||'Invoice Studio'),Subject:'Invoice document'}});const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  doc.registerFont('InvoiceSans',path.join(__dirname,'fonts','DejaVuSans.ttf'));doc.registerFont('InvoiceSansBold',path.join(__dirname,'fonts','DejaVuSans-Bold.ttf'));
  const requestedAccent=String(payload.invoiceAccentColor||payload.themeColor||payload.primaryColor||'#6478f5');const accent=/^#[0-9a-fA-F]{6}$/.test(requestedAccent)?requestedAccent:'#6478f5';
  const money=n=>'₹'+(Number(n)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const brand=String(payload.brandName||payload.sellerName||'INVOICE STUDIO');const seller=String(payload.sellerName||payload.shopName||brand);const buyer=String(payload.buyerName||'Customer');
  const date=String(payload.date||payload.dateTime||payload.savedAt||new Date().toLocaleString('en-IN'));
  const products=Array.isArray(payload.products)?payload.products:[];const subtotal=Number(payload.subtotal)||products.reduce((n,p)=>n+(Number(p.qty)||0)*(Number(p.price)||0),0);const charges=Number(payload.charges)||0;const discount=Number(payload.discount)||0;const payable=Number(payload.payable??payload.total??payload.grandTotal??payload.totalAmount)||Math.max(0,subtotal+charges-discount);
  doc.save();doc.rect(0,0,doc.page.width,12).fill(accent);doc.restore();
  doc.moveDown(1.2);doc.fillColor('#101827').font('InvoiceSansBold').fontSize(22).text(brand.toUpperCase(),{width:320});
  doc.moveDown(.25);doc.fillColor('#687386').font('InvoiceSans').fontSize(9).text(String(payload.tagline||'DIGITAL PRODUCTS · SERVICES · SUPPORT'),{width:320});
  const rightX=doc.page.width-190;doc.fillColor(accent).font('InvoiceSansBold').fontSize(22).text(String(payload.documentType||payload.docType||'INVOICE').replace(/[_]/g,' '),rightX,49,{width:145,align:'right'});
  doc.fillColor('#687386').font('InvoiceSans').fontSize(9).text('INVOICE NUMBER',rightX,79,{width:145,align:'right'});doc.fillColor('#111827').font('InvoiceSansBold').fontSize(11).text(String(payload.invoiceId||'—'),rightX,92,{width:145,align:'right'});doc.fillColor('#687386').font('InvoiceSans').fontSize(9).text(`DATE  ${date}`,rightX,112,{width:145,align:'right'});
  doc.moveTo(44,148).lineTo(doc.page.width-44,148).lineWidth(1).strokeColor('#e2e7ef').stroke();
  let y=169;doc.fillColor(accent).font('InvoiceSansBold').fontSize(9).text('SELLER / ISSUED BY',44,y);doc.fillColor('#172033').font('InvoiceSansBold').fontSize(11).text(seller,44,y+17,{width:230});if(payload.contact)doc.fillColor('#657084').font('InvoiceSans').fontSize(9).text(String(payload.contact),44,y+34,{width:230});
  doc.fillColor(accent).font('InvoiceSansBold').fontSize(9).text('BILL TO',320,y);doc.fillColor('#172033').font('InvoiceSansBold').fontSize(11).text(buyer,320,y+17,{width:220});if(payload.discordUserId||payload.buyerDiscordId)doc.fillColor('#657084').font('InvoiceSans').fontSize(9).text(`Discord ID: ${String(payload.discordUserId||payload.buyerDiscordId)}`,320,y+34,{width:220});
  y=236;const left=44,right=doc.page.width-44,tableW=right-left;doc.roundedRect(left,y,tableW,28,4).fill('#111827');doc.fillColor('#ffffff').font('InvoiceSansBold').fontSize(8.5).text('DESCRIPTION',left+12,y+9,{width:230});doc.text('QTY',left+255,y+9,{width:42,align:'right'});doc.text('UNIT PRICE',left+305,y+9,{width:75,align:'right'});doc.text('AMOUNT',right-88,y+9,{width:76,align:'right'});y+=38;
  if(!products.length){doc.fillColor('#667085').font('InvoiceSans').fontSize(10).text('No line items added.',left+12,y);y+=24;}
  products.forEach((p,i)=>{const qty=Number(p.qty)||0,price=Number(p.price)||0,line=qty*price;const name=String(p.name||'Digital product');const rowH=Math.max(30,doc.heightOfString(name,{width:220,font:'InvoiceSans',fontSize:9})+14);if(y+rowH>doc.page.height-175){doc.addPage();y=55;}if(i%2===0)doc.roundedRect(left,y-6,tableW,rowH,3).fill('#f6f8fb');doc.fillColor('#172033').font('InvoiceSans').fontSize(9).text(name,left+12,y,{width:225});doc.text(String(qty),left+255,y,{width:42,align:'right'});doc.text(money(price),left+305,y,{width:75,align:'right'});doc.font('InvoiceSansBold').text(money(line),right-88,y,{width:76,align:'right'});y+=rowH;});
  y+=13;if(y>doc.page.height-170){doc.addPage();y=55;}doc.moveTo(left,y).lineTo(right,y).lineWidth(1).strokeColor('#e2e7ef').stroke();y+=16;
  const labelX=right-220,valueX=right-100;const summaryRow=(label,value,bold=false)=>{doc.fillColor(bold?'#111827':'#667085').font(bold?'Helvetica-Bold':'Helvetica').fontSize(bold?12:10).text(label,labelX,y,{width:115});doc.fillColor('#111827').font(bold?'Helvetica-Bold':'Helvetica').fontSize(bold?12:10).text(value,valueX,y,{width:100,align:'right'});y+=bold?25:19;};summaryRow('Subtotal',money(subtotal));if(charges)summaryRow('Charges',money(charges));if(discount)summaryRow('Discount','−'+money(discount));doc.roundedRect(labelX-9,y-4,right-(labelX-9),34,4).fill(accent);doc.fillColor('#ffffff').font('InvoiceSansBold').fontSize(12).text('TOTAL DUE',labelX,y+6,{width:115});doc.text(money(payable),valueX,y+6,{width:100,align:'right'});y+=47;
  if(payload.totalPaid!==undefined&&payload.totalPaid!==null){doc.fillColor('#667085').font('InvoiceSans').fontSize(9).text(`Amount received: ${money(payload.totalPaid)}     Balance due: ${money(payload.needToPay)}`,left,y,{width:tableW});y+=20;}
  doc.fillColor('#667085').font('InvoiceSans').fontSize(9).text(`Payment method: ${String(payload.paymentMethod||'—')}`,left,y,{width:tableW});y+=24;
  if(payload.terms){doc.fillColor('#111827').font('InvoiceSansBold').fontSize(9).text('TERMS & NOTES',left,y);y+=14;doc.fillColor('#667085').font('InvoiceSans').fontSize(8.5).text(String(payload.terms).slice(0,1200),left,y,{width:tableW,lineGap:2});}
  const footerY=doc.page.height-54;doc.moveTo(left,footerY).lineTo(right,footerY).lineWidth(.7).strokeColor('#e2e7ef').stroke();doc.fillColor('#667085').font('InvoiceSans').fontSize(8).text(String(payload.footerName||seller)+' · Thank you for your business.',left,footerY+12,{width:tableW,align:'center'});doc.end();
 }catch(e){reject(e);}});
}
function decodeRenderedInvoiceImage(dataUrl){
 if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:image/png;base64,'))return null;
 try{const buffer=Buffer.from(dataUrl.slice('data:image/png;base64,'.length),'base64');if(!buffer.length||buffer.length>5*1024*1024)return null;return buffer;}catch{return null;}
}
function xmlEscape(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
async function createInvoiceImageBuffer(payload){
 const width=679,height=957;const brand=String(payload.brandName||payload.sellerName||payload.shopName||'INVOICE STUDIO').slice(0,48);const seller=String(payload.sellerName||payload.shopName||brand).slice(0,58);const buyer=String(payload.buyerName||'Customer').slice(0,52);const id=String(payload.invoiceId||'—').slice(0,55);const date=String(payload.date||payload.dateTime||payload.savedAt||new Date().toLocaleString('en-IN')).slice(0,42);const type=payload.replacementOf?'REPLACEMENT':String(payload.documentType||payload.docType||'INVOICE').replace(/[_]/g,' ').slice(0,32);
 const products=Array.isArray(payload.products)?payload.products.slice(0,8):[];const money=n=>'₹'+(Number(n)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});const underThousand=n=>{const one=['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];let out=[];if(n>=100){out.push(one[Math.floor(n/100)]+' Hundred');n%=100;}if(n>=20){out.push(tens[Math.floor(n/10)]);n%=10;}if(n>0)out.push(one[n]);return out.join(' ');};const numberWords=value=>{let n=Math.max(0,Math.floor(Number(value)||0));if(!n)return 'Zero';const groups=[[10000000,'Crore'],[100000,'Lakh'],[1000,'Thousand']];const out=[];for(const [size,label] of groups){const count=Math.floor(n/size);if(count){out.push((count<1000?underThousand(count):String(count))+' '+label);n%=size;}}if(n)out.push(underThousand(n));return out.join(' ');};const subtotal=Number(payload.subtotal)||products.reduce((n,p)=>n+(Number(p.qty)||0)*(Number(p.price)||0),0);const charges=Number(payload.charges)||0;const discount=Number(payload.discount)||0;const payable=Number(payload.payable??payload.total??payload.grandTotal??payload.totalAmount??(subtotal+charges-discount))||0;const paid=Number(payload.totalPaid)||0;const due=Number(payload.needToPay??(payable-paid))||0;
 let qr='';if(!payload.replacementOf&&payload.qrEnabled&&payload.qrUpiId&&/INVOICE|QUOTATION/i.test(type)&&!/RECEIPT/i.test(type)){try{const method=String(payload.paymentMethod||'UPI'),payee=String(payload.qrPayee||seller),address=String(payload.qrUpiId),amountDue=Math.max(0,payable-paid);let qrPayload;if(/UPI/i.test(method)){const u=new URLSearchParams({pa:address,pn:payee,am:amountDue.toFixed(2),cu:'INR',tn:`Invoice ${id}`});qrPayload=`upi://pay?${u.toString()}`;}else{qrPayload=`Payment method: ${method}\nPayee: ${payee}\nPayment ID / address: ${address}\nInvoice: ${id}\nAmount due: ${amountDue.toFixed(2)}\nPlease verify details before paying.`;}const data=await require('qrcode').toDataURL(qrPayload,{width:100,margin:1,errorCorrectionLevel:'M'});qr=data.replace(/^data:image\/png;base64,/,'');}catch{}}
 const esc=xmlEscape;const text=(x,y,value,size=11,fill='#111111',weight=400,anchor='start')=>`<text x="${x}" y="${y}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 679 957"><rect width="679" height="957" fill="#fff"/><rect width="679" height="5" fill="#111"/>${text(28,43,brand.toUpperCase(),18,'#080808',800)}${text(28,63,String(payload.tagline||'DIGITAL PRODUCTS · SERVICES · SUPPORT').slice(0,56),9,'#333',600)}${text(650,43,type,19,'#080808',800,'end')}${text(650,64,'INVOICE NUMBER',8,'#555',600,'end')}${text(650,80,id,10,'#111',700,'end')}${text(650,96,'DATE  '+date,8,'#444',500,'end')}<rect x="28" y="115" width="623" height="31" fill="#111"/>${text(339,135,String(payload.bannerText||`${type} — FOR PRODUCT DETAILS & PURCHASE`).slice(0,72).toUpperCase(),8,'#fff',800,'middle')}${text(32,174,'BILL TO',8,'#555',800)}${text(32,193,buyer,11,'#111',800)}${text(32,218,'HANDLED BY',8,'#555',800)}${text(32,237,String(payload.handledBy||payload.createdBy?.username||'—').slice(0,35),10,'#111',700)}${text(32,262,'PAYMENT METHOD',8,'#555',800)}${text(32,280,String(payload.paymentMethod||'—').slice(0,35),10,'#111',700)}<circle cx="565" cy="222" r="48" fill="#fff" stroke="#111" stroke-width="2.5"/><circle cx="565" cy="222" r="41" fill="none" stroke="#555" stroke-width="1" stroke-dasharray="3 3"/>${text(565,207,String(payload.sealTop||'YOUR').slice(0,16),8,'#111',800,'middle')}${text(565,225,String(payload.sealMid||'★ RECEIVED ★').slice(0,20),9,'#111',900,'middle')}${text(565,242,String(payload.sealBottom||brand).slice(0,16),8,'#111',800,'middle')}<rect x="28" y="302" width="623" height="27" fill="#080808"/>${text(39,320,'#',8,'#fff',800)}${text(61,320,'PRODUCT',8,'#fff',800)}${text(431,320,'QTY',8,'#fff',800,'end')}${text(526,320,'PRICE',8,'#fff',800,'end')}${text(640,320,'TOTAL',8,'#fff',800,'end')}`;
 let y=351;products.forEach((p,i)=>{const qty=Number(p.qty)||0,price=Number(p.price)||0;const name=String(p.name||`Product ${i+1}`).slice(0,52);if(i%2===0)svg+=`<rect x="28" y="${y-17}" width="623" height="30" fill="#f4f4f4"/>`;svg+=text(39,y,String(i+1),9,'#222',500)+text(61,y,name,9,'#171717',500)+text(431,y,String(qty),9,'#171717',500,'end')+text(526,y,money(price),9,'#171717',500,'end')+text(640,y,money(qty*price),9,'#111',700,'end');y+=30;});if((payload.products||[]).length>products.length){svg+=text(39,y,`+ ${(payload.products||[]).length-products.length} additional item(s) omitted from preview`,8,'#555',500);y+=22;}
 y=Math.max(y+14,products.length?y+14:370);const row=(label,value,bold=false)=>{svg+=text(412,y,label,9,bold?'#111':'#555',bold?800:500)+text(640,y,value,bold?11:9,'#111',bold?800:500,'end');y+=18;};row('Subtotal',money(subtotal));if(charges)row('Seal / Charges',money(charges));if(discount)row('Discount','−'+money(discount));svg+=`<rect x="386" y="${y-12}" width="265" height="29" fill="#111"/>`;svg+=text(398,y+7,'AMOUNT PAYABLE',9,'#fff',800)+text(640,y+7,money(payable),11,'#fff',800,'end');y+=37;row('Total Paid',money(paid));row('Need To Pay',money(due),true);
 svg+=`<rect x="28" y="${Math.min(y+5,690)}" width="623" height="36" fill="#f4f4f4"/><rect x="28" y="${Math.min(y+5,690)}" width="4" height="36" fill="#111"/>`+text(42,Math.min(y+19,704),'AMOUNT IN WORDS',7,'#555',800)+text(42,Math.min(y+32,717),`${numberWords(Math.floor(payable))} Rupees${Math.round((payable-Math.floor(payable))*100)?' and '+numberWords(Math.round((payable-Math.floor(payable))*100))+' Paise':''} Only`.slice(0,92),9,'#111',700);
 let termsY=Math.min(y+57,744);if(qr){const qy=Math.min(y+54,735);svg+=`<rect x="28" y="${qy}" width="623" height="106" fill="#fff" stroke="#d2d2d2"/><image x="42" y="${qy+5}" width="94" height="94" href="data:image/png;base64,${qr}"/>`;svg+=text(151,qy+27,'PAYMENT',8,'#333',800)+text(151,qy+48,money(payable),15,'#111',900)+text(151,qy+66,String(payload.qrUpiId).slice(0,48),8,'#444',500)+text(151,qy+83,String(payload.qrFooter||'After payment, share your receipt in the support ticket.').slice(0,72),7,'#444',400);termsY=qy+112;}
 if(payload.terms){svg+=text(28,termsY,'TERMS & CONDITIONS',8,'#111',800);const lines=String(payload.terms).split(/\r?\n/).filter(Boolean).slice(0,2);lines.forEach((line,i)=>{svg+=text(34,termsY+15+i*12,`${i+1}. ${String(line).slice(0,96)}`,7,'#444',400);});}
 const footerY=895;svg+=`<line x1="28" y1="${footerY-23}" x2="651" y2="${footerY-23}" stroke="#bdbdbd"/>`+text(28,footerY-7,'ENQUIRY & SUPPORT',8,'#111',800)+text(28,footerY+8,String(payload.contact||'Contact With Discord Staff Team').slice(0,58),8,'#444',400)+text(28,footerY+23,String(payload.footerName||seller).slice(0,48),9,'#111',800)+(payload.showSignature===false?'':text(651,footerY-8,String(payload.signerName||payload.handledBy||'—').slice(0,24),14,'#111',600,'end')+`<line x1="535" y1="${footerY+1}" x2="651" y2="${footerY+1}" stroke="#111"/>`+text(651,footerY+15,'AUTHORISED SIGNATURE',7,'#555',500,'end'))+`<line x1="28" y1="934" x2="651" y2="934" stroke="#bbb" stroke-dasharray="3 3"/>`+text(339,950,`Thank you for shopping with ${String(payload.footerName||seller).slice(0,44)}!`,8,'#444',600,'middle')+`<text x="339" y="500" font-family="DejaVu Sans,Arial,sans-serif" font-size="42" font-weight="800" fill="#111" fill-opacity="0.045" text-anchor="middle" transform="rotate(-30 339 500)">${esc(String(payload.watermark||brand).slice(0,36))}</text></svg>`;
 return sharp(Buffer.from(svg)).png({compressionLevel:8}).toBuffer();
}
function makePdfFromRenderedImage(imageBuffer, payload){
 return new Promise((resolve,reject)=>{try{
  const doc=new PDFDocument({size:'A4',margin:0,info:{Title:`Invoice ${payload.invoiceId||''}`,Author:String(payload.sellerName||payload.brandName||'Invoice Studio'),Subject:'Invoice Studio rendered invoice'}});
  const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  // Embed the exact generator preview image so the PDF matches the website output.
  doc.image(imageBuffer,0,0,{fit:[doc.page.width,doc.page.height],align:'center',valign:'center'});doc.end();
 }catch(e){reject(e);}});
}
async function notifyInvoiceDiscord(payload, action, user, renderedImageDataUrl){
 const channelId=process.env.INVOICE_LOG_CHANNEL_ID||process.env.INVOICE_NOTIFICATION_CHANNEL_ID;if(!channelId||!bot)return;
 try{
  const channel=await bot.channels.fetch(channelId);if(!channel?.isTextBased()||!channel.send)return;
  const renderedImage=decodeRenderedInvoiceImage(renderedImageDataUrl)||await createInvoiceImageBuffer(payload);
  const pdf=await makePdfFromRenderedImage(renderedImage,payload);const seller=String(payload.sellerName||payload.shopName||payload.brandName||'Seller not provided');
  const sellerId=String(payload.sellerDiscordId||payload.creatorDiscordId||user?.id||'').trim();const buyerId=String(payload.discordUserId||payload.buyerDiscordId||'').trim();
  const sellerMention=/^\d{17,20}$/.test(sellerId)?`<@${sellerId}>`:String(user?.username||'Website user (not logged in)');const buyerMention=/^\d{17,20}$/.test(buyerId)?`<@${buyerId}>`:short(payload.buyerName||'—',150);
  const products=(payload.products||[]).map(p=>`• **${short(p.name||'Item',100)}** × ${Number(p.qty)||1} — ₹${((Number(p.qty)||0)*(Number(p.price)||0)).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`).join('\n')||'• No line items';
  const total=payload.payable??payload.total??payload.grandTotal??payload.totalAmount??'—';
  const totalText=(typeof total==='number'||(String(total).trim()!==''&&!Number.isNaN(Number(total))))?'₹'+Number(total).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):short(total,60);
  const actionTitle=action==='admin edited'?'Edited':action==='updated'?'Updated':'Created';
  const card=new ContainerBuilder().setAccentColor(actionTitle==='Created'?0x6d7cff:0xf0b64b);
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🧾 Invoice ${actionTitle}
**Invoice ID**  \`${short(payload.invoiceId,90)}\`
**Seller / Creator:** ${sellerMention}${sellerId&&/^\d{17,20}$/.test(sellerId)?` (ID: \`${sellerId}\`)`:''}
${action==='admin edited'?`**Edited by:** <@${user?.id||'0'}> (${short(user?.username||'Admin',80)} · ID: \`${user?.id||'unknown'}\`)\n**Changed fields:** ${short((payload._editMeta?.changedFields||[]).join(', ')||'No field diff available',500)}\n`:''}**Shop:** ${short(seller,150)}
**Buyer:** ${buyerMention}${buyerId&&/^\d{17,20}$/.test(buyerId)?` (ID: \`${buyerId}\`)`:''}
**Date:** ${short(payload.date||payload.dateTime||payload.savedAt||new Date().toISOString(),100)}`));
  card.addSeparatorComponents(new SeparatorBuilder());
  card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Items
${short(products,1800)}

### Total Due
# ${totalText}
**Document:** ${short(payload.documentType||payload.docType||'INVOICE',80)}
**Subtotal:** ₹${Number(payload.subtotal||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})} · **Charges:** ₹${Number(payload.charges||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}
**Discount:** ₹${Number(payload.discount||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})} · **Paid:** ₹${Number(payload.totalPaid||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}
**Balance:** ₹${Number(payload.needToPay||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}
**Payment:** ${short(payload.paymentMethod||'—',80)} · **Status:** ${short(payload.purchaseStatus||payload.orderStatus||payload.status||'—',80)}
${payload.terms||payload.notes?`**Terms / Notes:** ${short(payload.terms||payload.notes,500)}\n`:''}
🖼️ Full invoice preview and matching PDF are attached below.`));
  const files=[];
  const safeInvoiceName=String(payload.invoiceId||'invoice').replace(/[^a-z0-9_-]/gi,'_');
  const components=[card];
  files.push(new AttachmentBuilder(renderedImage,{name:'invoice-preview.png',description:`Invoice preview for ${payload.invoiceId||''}`}));
  card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://invoice-preview.png').setDescription(`Invoice ${payload.invoiceId||''} — invoice design`)));
  files.push(new AttachmentBuilder(pdf,{name:`${safeInvoiceName}.pdf`,description:`PDF invoice ${payload.invoiceId||''} matching the attached invoice image`}));
  const mentionUsers=[sellerId,buyerId,user?.id].filter(id=>/^\d{17,20}$/.test(String(id||''))).map(String);await channel.send({flags:MessageFlags.IsComponentsV2,components,files,allowedMentions:{parse:[],users:[...new Set(mentionUsers)]}});
 }catch(e){console.warn('Invoice Discord notification failed:',e.message);}
}

// Compare meaningful invoice fields without volatile timestamps or the client-rendered preview.
function canonicalInvoice(value) {
  const ignored = new Set(['savedAt','date','dateTime','createdAt','updatedAt','renderedInvoiceImage','createdBy','_editMeta']);
  if (Array.isArray(value)) return value.map(canonicalInvoice);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (!ignored.has(key)) out[key] = canonicalInvoice(value[key]);
    return out;
  }
  return value;
}
function sameMeaningfulInvoice(a,b) { return JSON.stringify(canonicalInvoice(a)) === JSON.stringify(canonicalInvoice(b)); }
const invoiceSaveWindows = new Map();
function allowInvoiceSave(key) {
  const now=Date.now(), windowMs=60_000, max=12;
  const recent=(invoiceSaveWindows.get(key)||[]).filter(t=>now-t<windowMs);
  if(recent.length>=max){invoiceSaveWindows.set(key,recent);return false;}
  recent.push(now);invoiceSaveWindows.set(key,recent);
  if(invoiceSaveWindows.size>5000) for(const [k,times] of invoiceSaveWindows) if(!times.length||now-times[times.length-1]>windowMs) invoiceSaveWindows.delete(k);
  return true;
}
app.get('/health',(_req,res)=>res.status(200).json({ok:true,service:'invoice-bot',database:'sqlite'}));
app.get('/api/invoices/:id',apiAuth,(req,res)=>{const found=getInvoice(req.params.id);if(!found)return res.status(404).json({error:'Invoice not found.'});const safe={...found,products:(found.products||[]).map(({accountEmail,accountPassword,...p})=>p)};res.json(safe);});
app.post('/api/invoices',apiAuth,async(req,res)=>{try{
 const body=req.body||{};const renderedImageDataUrl=body.renderedInvoiceImage;const {renderedInvoiceImage:_discardedImage,...invoiceBody}=body;const user=sessionUser(req);const prior=getInvoice(invoiceBody.invoiceId);
 // Repeated lookup/save clicks with no actual invoice edits are idempotent: no audit row and no Discord message.
 if(prior && sameMeaningfulInvoice(prior,invoiceBody)) return res.status(200).json({ok:true,unchanged:true,invoiceId:prior.invoiceId,savedAt:prior.savedAt,action:'unchanged',message:'Invoice is already saved; no duplicate Discord log was sent.'});
 const saveKey=String(user?.id||req.ip||req.socket?.remoteAddress||'anonymous');
 if(!allowInvoiceSave(saveKey)) return res.status(429).json({error:'Invoice save limit reached. Please wait a minute before saving more invoices.'});
 const record=saveInvoice({...invoiceBody,createdBy:user?{id:user.id,username:user.username}:undefined});
 const action=prior?'updated':'created';const stamp=new Date().toISOString();
 db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)').run(record.invoiceId,action,stamp,user?.id||record.createdBy?.id||null,user?.username||record.createdBy?.username||'Website user',JSON.stringify(record));
 notifyInvoiceDiscord(record,action,user,renderedImageDataUrl).catch(()=>{});
 res.status(201).json({ok:true,invoiceId:record.invoiceId,savedAt:record.savedAt,action});
 }catch(e){res.status(400).json({error:e.message||'Could not save invoice.'});}});
// Sensitive product credentials are not returned by the public invoice API and are never rendered into invoice exports.

let bot;
const issueTypes=['Replace','Help','Bug','Refund'];
const short=(s,n=90)=>String(s||'—').slice(0,n);
function v2Card(title,body,components=[]) {
  const container=new ContainerBuilder().setAccentColor(0xf5b400);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));
  if(components.length){container.addSeparatorComponents(new SeparatorBuilder());for(const c of components)container.addActionRowComponents(c);}
  return {flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[container]};
}
function selectInvoiceBuyer(invoice) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticketbuyer:${invoice.invoiceId}`)
    .setPlaceholder('Select buyer').addOptions({label:short(invoice.buyerName,100),value:'buyer',description:`Invoice ${short(invoice.invoiceId,80)}`}));
}
function selectProduct(invoice) {
  const products=(invoice.products||[]).slice(0,25);
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticketproduct:${invoice.invoiceId}`)
    .setPlaceholder('Select product').addOptions((products.length?products:[{name:'No product listed'}]).map((p,i)=>({label:short(p.name||`Product ${i+1}`,100),value:String(i),description:`Qty ${Number(p.qty)||1} • ₹${(Number(p.price)||0).toFixed(2)}`}))));
}
function issueSelect(invoiceId,productIndex,product) {const hasAccountDetails=Boolean(String(product?.accountEmail||'').trim()&&String(product?.accountPassword||'').trim());const available=hasAccountDetails?issueTypes:issueTypes.filter(x=>x!=='Replace');return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticketissue:${invoiceId}:${productIndex}`).setPlaceholder('Choose ticket reason').addOptions(available.map(x=>({label:x,value:x.toLowerCase(),description:x==='Replace'?'Open a replacement ticket (account details required)':`Open a ${x.toLowerCase()} support ticket`}))));}
function ticketControls(ticketId,status='open',claimedBy=null) {
  const row=new ActionRowBuilder();
  row.addComponents(new ButtonBuilder().setCustomId(`ticketclaim:${ticketId}`).setLabel(claimedBy?'Claimed / Take Over':'Claim').setStyle(ButtonStyle.Primary).setDisabled(status!=='open'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketunclaim:${ticketId}`).setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(!claimedBy||status==='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketclose:${ticketId}`).setLabel('Close').setStyle(ButtonStyle.Danger).setDisabled(status==='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketreopen:${ticketId}`).setLabel('Reopen').setStyle(ButtonStyle.Success).setDisabled(status!=='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketdetails:${ticketId}`).setLabel('Account Details').setStyle(ButtonStyle.Secondary));
  const replacement=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticketreplace:${ticketId}`).setLabel('Create Replacement Invoice').setStyle(ButtonStyle.Primary).setDisabled(status==='closed'||!claimedBy));
  const users=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketadd:${ticketId}`).setPlaceholder('Add user to ticket').setMinValues(1).setMaxValues(5));
  const remove=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketremove:${ticketId}`).setPlaceholder('Remove user from ticket').setMinValues(1).setMaxValues(5));
  return [row,replacement,users,remove];
}
function replacementInvoiceModal(ticketId){
 const modal=new ModalBuilder().setCustomId(`ticketreplace-submit:${ticketId}`).setTitle('Create Replacement Invoice');
 const productName=new TextInputBuilder().setCustomId('replacement_product').setLabel('Replacement product name (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Leave blank to keep the original name');
 const email=new TextInputBuilder().setCustomId('replacement_email').setLabel('New account email / ID (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(250).setPlaceholder('New replacement account');
 const password=new TextInputBuilder().setCustomId('replacement_password').setLabel('New account password (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(250).setPlaceholder('Only used for this replacement');
 const note=new TextInputBuilder().setCustomId('replacement_note').setLabel('Private replacement note (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setPlaceholder('Internal support note');
 modal.addComponents(new ActionRowBuilder().addComponents(productName),new ActionRowBuilder().addComponents(email),new ActionRowBuilder().addComponents(password),new ActionRowBuilder().addComponents(note));return modal;
}
function ticketById(id){return db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(id));}
function isOwner(interaction){return Boolean(interaction.guild && interaction.guild.ownerId===interaction.user.id);}
function isStaff(interaction){const roleId=process.env.STAFF_ROLE_ID;return isOwner(interaction)||Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)||interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)||(roleId&&interaction.member?.roles?.cache?.has(roleId)));}
function canSeeSecrets(interaction,ticket){return isOwner(interaction)||ticket.claimed_by===interaction.user.id;}
async function respondInteraction(interaction,payload){ if(interaction.deferred) return interaction.editReply(payload); if(interaction.replied) return interaction.followUp(payload); return interaction.reply(payload); }
function replacementRoot(invoiceId) {
  let current=String(invoiceId||''); const seen=new Set();
  while(current&&!seen.has(current)){seen.add(current);const row=db.prepare('SELECT original_invoice_id FROM invoice_replacements WHERE new_invoice_id=? COLLATE NOCASE').get(current);if(!row)break;current=row.original_invoice_id;}
  return current||String(invoiceId||'');
}
function replacementCount(invoiceId) {
  const root=replacementRoot(invoiceId);
  return Number(db.prepare(`WITH RECURSIVE chain(id) AS (SELECT new_invoice_id FROM invoice_replacements WHERE original_invoice_id=? COLLATE NOCASE UNION ALL SELECT r.new_invoice_id FROM invoice_replacements r JOIN chain c ON r.original_invoice_id=c.id) SELECT COUNT(*) AS n FROM chain`).get(root)?.n||0);
}
function getTemplate(invoice) {
  const raw=String(invoice.templateName||invoice.template||invoice.invoiceTemplate||invoice.themeName||invoice.preset||'').toLowerCase();
  const brand=String(invoice.brandName||invoice.sellerName||invoice.shopName||'').toLowerCase();
  if(/gojo/.test(raw+' '+brand))return {name:"Gojo's Steam Lounge",brand:"GOJO'S STEAM LOUNGE",accent:'#1688ff',watermark:"GOJO'S STEAM LOUNGE",theme:'blue'};
  if(/imposter|inet/.test(raw+' '+brand))return {name:'IMPOSTER NETWORK',brand:'IMPOSTER NETWORK',accent:'#7c3aed',watermark:'IMPOSTER NETWORK',theme:'purple'};
  return {name:String(invoice.templateName||invoice.template||invoice.invoiceTemplate||invoice.themeName||'Standard'),brand:String(invoice.brandName||invoice.sellerName||invoice.shopName||'Your Shop'),accent:String(invoice.themeColor||invoice.primaryColor||'#2563eb'),watermark:String(invoice.watermark||invoice.brandName||invoice.sellerName||'YOUR SHOP'),theme:String(invoice.theme||'standard')};
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function makeInvoiceId(prefix='REPL') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function createInvoicePdfBuffer(invoice, metadata={}) {
  return new Promise((resolve,reject)=>{
    try {
      const tpl=getTemplate(invoice); const accent=tpl.accent;
      const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`Invoice ${invoice.invoiceId}`,Author:tpl.brand}});
      const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
      // Light watermark, consistent with the selected website brand template.
      if(invoice.showWatermark!==false){doc.save();doc.rotate(-32,{origin:[300,420]}).fontSize(42).fillColor(accent,0.09).text(String(invoice.watermark||tpl.watermark||tpl.brand).slice(0,60),65,390,{width:470,align:'center'});doc.restore();}
      doc.roundedRect(35,32,525,78,12).fill(accent);
      doc.fontSize(20).fillColor('#ffffff').text(tpl.brand.slice(0,70),52,48,{width:490});
      doc.fontSize(9).fillColor('#ffffff').text(String(invoice.tagline||'Digital Products • Games • Services').slice(0,100),52,80,{width:490});
      doc.moveDown(3.5).fontSize(18).fillColor(accent).text(metadata.isReplacement?'REPLACEMENT':String(invoice.documentType||'INVOICE').toUpperCase());
      doc.moveDown(.5).fontSize(10).fillColor('#333333');
      doc.text(`Invoice ID: ${invoice.invoiceId}`);doc.text(`Buyer: ${invoice.buyerName||'—'}`);if(invoice.discordUserId||invoice.buyerDiscordId)doc.text(`Buyer Discord ID: ${invoice.discordUserId||invoice.buyerDiscordId}`);doc.text(`Date: ${invoice.date||invoice.createdAt||new Date().toLocaleString('en-IN')}`);
      if(metadata.originalInvoiceId){doc.text(`Replaces invoice: ${metadata.originalInvoiceId}`);doc.text(`Replacement count for this invoice chain: ${metadata.replacementCount??replacementCount(metadata.originalInvoiceId)}`);}
      doc.text(`Template: ${tpl.name}`);
      doc.moveDown().fontSize(12).fillColor(accent).text('PRODUCTS');doc.moveDown(.3).fillColor('#111827').fontSize(10);
      doc.moveTo(48,doc.y).lineTo(547,doc.y).strokeColor(accent).stroke();doc.moveDown(.5);
      for(const p of (invoice.products||[])){doc.text(`${String(p.name||'Product').slice(0,100)}  |  Qty: ${Number(p.qty)||0}  |  Unit price: INR ${Number(p.price||0).toFixed(2)}  |  Total: INR ${((Number(p.qty)||0)*(Number(p.price)||0)).toFixed(2)}`);}
      doc.moveDown().fontSize(10).fillColor('#111827');doc.text(`Subtotal: INR ${Number(invoice.subtotal||0).toFixed(2)}`);doc.text(`Payable: INR ${Number(invoice.payable||invoice.total||0).toFixed(2)}`);doc.text(`Paid: INR ${Number(invoice.totalPaid||0).toFixed(2)}`);doc.text(`Balance: INR ${Number(invoice.needToPay||0).toFixed(2)}`);
      if(metadata.isReplacement){doc.moveDown().fontSize(9).fillColor(accent).text('REPLACEMENT COPY — retain the new invoice ID for future support requests.');}
      doc.moveDown(2).fontSize(9).fillColor(accent).text(`${tpl.brand} • ${String(invoice.footerName||tpl.brand).slice(0,80)}`,{align:'center'});
      doc.end();
    } catch(e){reject(e);}
  });
}
async function getTranscript(channel, ticket) {
  const lines=[]; const header=`<header><h1>Support Ticket Transcript #${ticket.id}</h1><p><b>Invoice:</b> ${escapeHtml(ticket.invoice_id)} &nbsp; <b>Product:</b> ${escapeHtml(ticket.product_name)}</p><p><b>Issue:</b> ${escapeHtml(ticket.issue_type)} &nbsp; <b>Opened by:</b> ${escapeHtml(ticket.opener_id)}</p><p><b>Created:</b> ${escapeHtml(ticket.created_at)} &nbsp; <b>Closed:</b> ${escapeHtml(new Date().toISOString())}</p></header>`;
  let before, fetchedCount=0;
  try {
    while(fetchedCount<500){
      const batch=await channel.messages.fetch({limit:100,...(before?{before}:{})});if(!batch.size)break;
      const ordered=[...batch.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
      for(const m of ordered){const at=new Date(m.createdTimestamp).toLocaleString('en-IN');const authorName=m.member?.displayName||m.author?.globalName||m.author?.username||'Unknown';const avatar=m.author?.displayAvatarURL?.({extension:'png',size:64})||'';const attachments=[...m.attachments.values()].map(a=>`<p class="attachment">📎 <a href="${escapeHtml(a.url)}">${escapeHtml(a.name||'Attachment')}</a> <small>${Math.round((a.size||0)/1024)} KB</small></p>`).join('');const content=escapeHtml(m.content||'[No text content]').replace(/\n/g,'<br>');lines.push(`<article><div class="message-head">${avatar?`<img class="avatar" src="${escapeHtml(avatar)}" alt="avatar">`:''}<div><b>${escapeHtml(authorName)}</b><div class="meta">@${escapeHtml(m.author?.username||'unknown')} · ID ${escapeHtml(m.author?.id||'?')} · ${escapeHtml(at)}${m.author?.bot?' · BOT':''}</div></div></div><div class="content">${content}</div>${attachments}</article>`);}
      fetchedCount+=batch.size;before=batch.last()?.id;if(batch.size<100)break;
    }
  } catch(e){lines.push(`<article>Transcript fetch warning: ${escapeHtml(e.message)}</article>`);}
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket #${ticket.id} transcript</title><style>body{font:15px/1.55 Arial,sans-serif;background:#f2f4f8;color:#172033;margin:0;padding:28px}main{max-width:900px;margin:auto;background:white;border-radius:18px;padding:28px;box-shadow:0 8px 30px #17203318}header{background:linear-gradient(135deg,#222b4a,#6b4eff);color:white;padding:24px;border-radius:14px;margin-bottom:22px}article{padding:16px;border:1px solid #e1e6ef;border-radius:12px;margin:12px 0;overflow-wrap:anywhere;background:#fff}.message-head{display:flex;align-items:center;gap:11px;margin-bottom:10px}.avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#e2e8f0}.meta{font-size:12px;color:#64748b;margin-top:3px;margin-bottom:4px}.content{white-space:normal;line-height:1.6}.attachment{padding:8px 10px;background:#f4f6fa;border-radius:8px}a{color:#365bcb}footer{margin-top:24px;color:#64748b;font-size:12px}</style></head><body><main>${header}<h2>Conversation</h2>${lines.join('')}<footer>Generated by the support ticket system.</footer></main></body></html>`;
  return Buffer.from(html.slice(0,900000),'utf8');
}
async function sendTranscriptToUsers(guild, ticket, transcript, closerId) {
  const recipients=new Set([ticket.opener_id,closerId].filter(Boolean));
  if(ticket.claimed_by)recipients.add(ticket.claimed_by);
  const attachment=new AttachmentBuilder(transcript,{name:`ticket-${ticket.id}-transcript.html`});
  for(const userId of recipients){try{const user=await bot.users.fetch(userId);await user.send({content:`Transcript for closed ticket #${ticket.id} (Invoice ${ticket.invoice_id}).`,files:[attachment]});}catch(e){console.warn(`Could not DM transcript to ${userId}: ${e.message}`);}}
  const logId=process.env.TICKET_LOG_CHANNEL_ID;
  if(logId){try{const log=await guild.channels.fetch(logId);if(log?.isTextBased())await log.send({content:`Ticket #${ticket.id} closed by <@${closerId}>. Invoice: ${ticket.invoice_id}.`,files:[new AttachmentBuilder(transcript,{name:`ticket-${ticket.id}-transcript.html`})]});}catch(e){console.warn('Could not post ticket transcript to log channel:',e.message);}}
}
async function startTicket(interaction,invoiceId,productIndex,issueType) {
  const invoice=getInvoice(invoiceId); if(!invoice) return respondInteraction(interaction,{content:'Invoice record no longer exists. Save the invoice again and retry.',ephemeral:true});
  const product=(invoice.products||[])[Number(productIndex)]; if(!product) return respondInteraction(interaction,{content:'Product not found on this invoice.',ephemeral:true});
  if(String(issueType).toUpperCase()==='REPLACE'&&(!String(product.accountEmail||'').trim()||!String(product.accountPassword||'').trim()))return respondInteraction(interaction,{content:'A replacement ticket requires both account email / ID and password to be saved on this invoice product. Help, Refund and Bug tickets can still be opened without account details.',ephemeral:true});
  const guild=interaction.guild; if(!guild)return respondInteraction(interaction,{content:'Tickets can only be created inside a server.',ephemeral:true});
  const staffRoleId=process.env.STAFF_ROLE_ID;
  const overwrites=[{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:interaction.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]}];
  if(staffRoleId)overwrites.push({id:staffRoleId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages]});
  const channel=await guild.channels.create({name:`ticket-${String(invoiceId).toLowerCase().replace(/[^a-z0-9-]/g,'').slice(-16)}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,8)}`.slice(0,90),type:ChannelType.GuildText,topic:`Invoice ${invoiceId} • ${issueType} • opener ${interaction.user.id}`,permissionOverwrites:overwrites});
  const now=new Date().toISOString();
  const result=db.prepare('INSERT INTO tickets(invoice_id,guild_id,channel_id,opener_id,product_name,issue_type,status,created_at,product_index) VALUES(?,?,?,?,?,?,?,?,?)').run(invoiceId,guild.id,channel.id,interaction.user.id,product.name,issueType,'open',now,Number(productIndex));
  const ticketId=Number(result.lastInsertRowid);
  const body=`**Ticket:** #${ticketId}\n**Invoice ID:** ${invoiceId}\n**Buyer:** ${short(invoice.buyerName)}\n**Product:** ${short(product.name)}\n**Reason:** ${issueType}\n**Opened by:** <@${interaction.user.id}>\n\nAccount credentials are private. Only the ticket claimant and server owner can reveal them.`;
  await channel.send({components:[new ContainerBuilder().setAccentColor(0xf5b400).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Support Ticket\n${body}`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticketId,'open',null))],flags:MessageFlags.IsComponentsV2});
  const openTicket=new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open Ticket Channel').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guild.id}/${channel.id}`));return respondInteraction(interaction,{content:`Ticket created: ${channel}. Use the button below to jump to the channel.`,components:[openTicket],ephemeral:true});
}
async function startBot(){
 if(!process.env.DISCORD_TOKEN){console.log('DISCORD_TOKEN not set; website will run without Discord bot.');return;}
 bot=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
 const commands=[
  new SlashCommandBuilder().setName('resize').setDescription('Resize an image to 3840×2160 and return PNG').addAttachmentOption(o=>o.setName('image').setDescription('Image to resize').setRequired(true)).addStringOption(o=>o.setName('fit').setDescription('How to fit the image').addChoices({name:'Contain (no crop)',value:'contain'},{name:'Cover (crop edges)',value:'cover'})),
  new SlashCommandBuilder().setName('invoice-panel').setDescription('Open the invoice support panel'),
  new SlashCommandBuilder().setName('invoice-inspect').setDescription('Admin: inspect a saved invoice').addStringOption(o=>o.setName('invoice_id').setDescription('Invoice ID to inspect').setRequired(true)),
  new SlashCommandBuilder().setName('invoice-replacement').setDescription('Staff: create a replacement invoice image and matching PDF').addStringOption(o=>o.setName('invoice_id').setDescription('Invoice ID to replace').setRequired(true)),
  new SlashCommandBuilder().setName('qr').setDescription('Admin only: post a payment QR publicly').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o=>o.setName('payment_type').setDescription('Payment network').setRequired(true).addChoices({name:'UPI',value:'upi'},{name:'Litecoin (LTC)',value:'ltc'})).addStringOption(o=>o.setName('address').setDescription('UPI ID or Litecoin wallet address').setRequired(true).setMaxLength(200)).addStringOption(o=>o.setName('item').setDescription('Item / order description').setRequired(true).setMaxLength(100)).addNumberOption(o=>o.setName('amount').setDescription('Payment amount (INR for UPI, LTC for Litecoin)').setRequired(false).setMinValue(0.00000001).setMaxValue(1000000000)),
 ].map(c=>c.toJSON());
 bot.once('ready',async()=>{console.log(`Discord bot logged in as ${bot.user.tag}`);try{const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);if(process.env.GUILD_ID&&process.env.CLIENT_ID){await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID),{body:commands});console.log(`Guild slash commands registered for guild ${process.env.GUILD_ID}.`);}else if(process.env.CLIENT_ID){await rest.put(Routes.applicationCommands(process.env.CLIENT_ID),{body:commands});console.log('Global slash commands registered. Global command updates may take time to appear; set GUILD_ID for fast testing.');}else console.error('CLIENT_ID is missing: slash commands cannot be registered. Add CLIENT_ID in Render Environment, then restart/redeploy.');}catch(e){console.error('Command registration failed. Check CLIENT_ID, DISCORD_TOKEN, and GUILD_ID:',e?.stack||e);}});
 bot.on('interactionCreate',async interaction=>{
  try{
   if(interaction.isChatInputCommand()){
    if(interaction.commandName==='resize'){
     await interaction.deferReply();try{const file=interaction.options.getAttachment('image');if(!file.contentType?.startsWith('image/'))return interaction.editReply('Please attach a valid image.');if(file.size>15*1024*1024)return interaction.editReply('Image must be 15 MB or smaller.');const response=await fetch(file.url);if(!response.ok)throw new Error('Could not download image');const input=Buffer.from(await response.arrayBuffer());const fit=interaction.options.getString('fit')||'contain';const png=await sharp(input,{failOn:'none'}).rotate().resize(3840,2160,{fit:fit==='cover'?'cover':'contain',background:{r:15,g:18,b:32,alpha:1}}).png({compressionLevel:8}).toBuffer();await interaction.editReply({content:`Done — **3840 × 2160 px** PNG. Fit: **${fit}**.`,files:[new AttachmentBuilder(png,{name:'resized-3840x2160.png'})]});}catch(e){console.error('Resize failed',e);await interaction.editReply('Could not resize this image. Use JPG, PNG or WebP under 15 MB.');}
    }
    if(interaction.commandName==='qr'){
     // Only configured admins, the guild owner, or Discord administrators may run this command.
     // Reply publicly with a Components V2 card. Do not defer with IsComponentsV2:
     // Discord can reject the deferred response flags, leaving the command stuck on "thinking".
     const configuredAdmin=ADMIN_DISCORD_IDS.has(String(interaction.user.id));
     const guildOwner=Boolean(interaction.guild && interaction.guild.ownerId===interaction.user.id);
     const discordAdministrator=Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
     if(!configuredAdmin&&!guildOwner&&!discordAdministrator){
      return interaction.reply({content:'Administrator access is required to use /qr.',flags:MessageFlags.Ephemeral});
     }
     try{
      const type=interaction.options.getString('payment_type',true);
      const address=interaction.options.getString('address',true).trim();
      const item=interaction.options.getString('item',true).trim();
      const amount=interaction.options.getNumber('amount');
      let payload;
      if(type==='upi'){
       if(!/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,60}$/.test(address)){
        return interaction.reply({content:'Invalid UPI ID. Enter a valid UPI ID, for example `name@bank`.',flags:MessageFlags.Ephemeral});
       }
       if(amount!==null&&amount<0.01){
        return interaction.reply({content:'UPI amounts must be at least ₹0.01.',flags:MessageFlags.Ephemeral});
       }
       const params=new URLSearchParams({pa:address,pn:'Invoice Studio',tn:item,cu:'INR'});
       if(amount!==null)params.set('am',Number(amount).toFixed(2));
       payload='upi://pay?'+params.toString();
      }else{
       if(!/^(?:[LM3][a-km-zA-HJ-NP-Z1-9]{25,60}|ltc1[a-z0-9]{20,70})$/i.test(address)){
        return interaction.reply({content:'Invalid Litecoin address. Check the LTC address and try again.',flags:MessageFlags.Ephemeral});
       }
       const params=new URLSearchParams({message:item});
       if(amount!==null)params.set('amount',String(amount));
       payload='litecoin:'+address+(params.size?'?'+params.toString():'');
      }
      // QR generation is local and fast, so build the payload first and send one initial response.
      // This avoids a deferred interaction failing on the Components V2 flag.
      const png=await require('qrcode').toBuffer(payload,{type:'png',width:900,margin:2,errorCorrectionLevel:'H'});
      const amountText=amount===null?'Not specified':(type==='upi'?'₹':'Ł')+Number(amount).toLocaleString('en-US',{maximumFractionDigits:8});
      const card=new ContainerBuilder();
      card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Payment QR\nScan the QR below using a compatible payment app.\n\n**Item / Order**\n${short(item,100)}\n\n**Payment network**\n${type==='upi'?'UPI · INR':'Litecoin · LTC'}\n\n**Address / ID**\n\`${short(address,180)}\`\n\n**Amount**\n${amountText}`));
      card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://payment-qr.png').setDescription(`Payment QR for ${item}`)));
      card.addSeparatorComponents(new SeparatorBuilder());
      card.addTextDisplayComponents(new TextDisplayBuilder().setContent('**After payment, please send a screenshot of the payment receipt in your support ticket.**'));
      return await interaction.reply({flags:MessageFlags.IsComponentsV2,components:[card],files:[new AttachmentBuilder(png,{name:'payment-qr.png',description:`Payment QR for ${item}`})],allowedMentions:{parse:[]}});
     }catch(e){
      console.error('QR command failed:',e?.stack||e);
      const errorPayload={content:'Could not generate the QR. Please verify the payment ID/address and try again.',flags:MessageFlags.Ephemeral};
      if(interaction.deferred||interaction.replied)return interaction.followUp(errorPayload).catch(()=>{});
      return interaction.reply(errorPayload).catch(()=>{});
     }
    }
    if(interaction.commandName==='invoice-panel'){
     const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('invoicepanel:open').setLabel('Search Invoice / Open Ticket').setStyle(ButtonStyle.Primary));
     return interaction.reply({flags:MessageFlags.IsComponentsV2,components:[new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('## Invoice Support Panel\nPress the button below, enter your invoice ID, then select the product and issue type to create a private support ticket.')).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(row)]});
    }
    if(interaction.commandName==='invoice-replacement'){
     if(!isStaff(interaction))return interaction.reply({content:'Only staff or the server owner can create replacement invoices.',ephemeral:true});
     await interaction.deferReply({flags:MessageFlags.Ephemeral});
     const originalId=interaction.options.getString('invoice_id',true).trim();const original=getInvoice(originalId);
     if(!original)return interaction.editReply(`No saved invoice found for ${originalId}.`);
     if(db.prepare('SELECT 1 FROM invoice_replacements WHERE original_invoice_id=? COLLATE NOCASE').get(original.invoiceId))return interaction.editReply(`Invoice ${original.invoiceId} has already been replaced once. Use its newest replacement invoice ID for another replacement.`);
     const accountEmail='';const accountPassword='';
     const newId=makeInvoiceId('INV');const tpl=getTemplate(original);const templateName=tpl.name;const count=replacementCount(original.invoiceId)+1;const now=new Date().toISOString();
     const products=(original.products||[]).map((p,i)=>i===0?{...p,accountEmail:accountEmail||p.accountEmail||'',accountPassword:accountPassword||p.accountPassword||''}:p);
     const replacement={...original,products,invoiceId:newId,documentType:original.documentType||'INVOICE',replacementOf:original.invoiceId,replacementLabel:'REPLACEMENT',qrEnabled:false,qrUpiId:'',templateName,preset:original.preset||(/gojo/i.test(templateName)?'gojo':/imposter/i.test(templateName)?'imposter':'standard'),brandName:tpl.brand,sellerName:tpl.brand,shopName:tpl.brand,theme:tpl.theme,themeColor:tpl.accent,primaryColor:tpl.accent,watermark:tpl.watermark,showWatermark:original.showWatermark!==false,createdAt:now,savedAt:now,replacementCount:count};
     saveInvoice(replacement);
     db.prepare('INSERT INTO invoice_replacements(new_invoice_id,original_invoice_id,ticket_id,created_by,template_name,created_at) VALUES(?,?,?,?,?,?)').run(newId,original.invoiceId,null,interaction.user.id,templateName,now);
     const image=await createInvoiceImageBuffer(replacement);const pdf=await makePdfFromRenderedImage(image,replacement);
     db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)').run(newId,'replacement created',now,interaction.user.id,interaction.user.username,JSON.stringify(replacement));
     let dmSent=false;const buyerId=String(original.discordUserId||original.buyerDiscordId||'').trim();try{if(buyerId){const buyer=await bot.users.fetch(buyerId);await buyer.send({content:`## REPLACEMENT\n\nThank you for waiting! Your replacement invoice is ready.\n\n**New invoice ID:** \`${newId}\`\n**Previous invoice ID:** \`${original.invoiceId}\`\n**Replacement number:** ${count}\n**Template:** ${templateName}\n\nKeep the new invoice ID for future support. If you have any issue, open a ticket using the new invoice ID through \`/invoice-panel\`.\n${accountEmail||products[0]?.accountEmail?`\n**New account email / ID:** ||${accountEmail||products[0]?.accountEmail}||\n`:''}${accountPassword||products[0]?.accountPassword?`**New account password:** ||${accountPassword||products[0]?.accountPassword}||`:''}`,files:[new AttachmentBuilder(image,{name:`${newId}.png`,description:'Replacement invoice image'}),new AttachmentBuilder(pdf,{name:`${newId}.pdf`,description:'PDF matching replacement invoice image'})]});dmSent=true;}}catch(e){console.warn('Replacement invoice DM failed:',e.message);}
     const invoiceLogId=process.env.INVOICE_LOG_CHANNEL_ID||process.env.INVOICE_NOTIFICATION_CHANNEL_ID;if(invoiceLogId){try{const log=await bot.channels.fetch(invoiceLogId);if(log?.isTextBased()){const card=new ContainerBuilder().setAccentColor(0x16a085);card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ♻️ Replacement Invoice Created\n**New Invoice ID:** \`${newId}\`\n**Original Invoice:** \`${original.invoiceId}\`\n**Seller / Creator:** <@${String(replacement.sellerDiscordId||replacement.creatorDiscordId||interaction.user.id)}>\n**Buyer:** ${buyerId&&/^\d{17,20}$/.test(buyerId)?`<@${buyerId}>`:short(original.buyerName)}\n**Created by:** <@${interaction.user.id}>\n**Item count:** ${(replacement.products||[]).length}\n**DM:** ${dmSent?'Sent':'Could not DM buyer'}`));card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://replacement-invoice.png').setDescription(`Replacement invoice ${newId}`)));await log.send({flags:MessageFlags.IsComponentsV2,components:[card],files:[new AttachmentBuilder(image,{name:'replacement-invoice.png'}),new AttachmentBuilder(pdf,{name:`${newId}.pdf`})],allowedMentions:{parse:[],users:[interaction.user.id,...(buyerId&&/^\d{17,20}$/.test(buyerId)?[buyerId]:[])]}});}}catch(e){console.warn('Replacement invoice log failed:',e.message);}}
     const ownerChannelId=process.env.REPLACEMENT_OWNER_CHANNEL_ID||process.env.OWNER_CHANNEL_ID;let ownerLogged=false;
     if(ownerChannelId){try{const ownerChannel=await interaction.guild.channels.fetch(ownerChannelId);if(ownerChannel?.isTextBased()){await ownerChannel.send({content:`**replacement account record**\noriginal invoice: \`${original.invoiceId}\`\nnew invoice: \`${newId}\`\nbuyer: ${short(original.buyerName)}\nbuyer discord: ${original.discordUserId||original.buyerDiscordId||'not saved'}\nproduct: ${short(products[0]?.name)}\nemail / id: ||${accountEmail||products[0]?.accountEmail||'not provided'}||\npassword: ||${accountPassword||products[0]?.accountPassword||'not provided'}||\ncreated by: <@${interaction.user.id}>`,allowedMentions:{parse:[]}});ownerLogged=true;}}catch(e){console.warn('Replacement owner channel log failed:',e.message);}}
     return interaction.editReply(`Replacement invoice created.\nNew invoice ID: ${newId}\nOriginal invoice: ${original.invoiceId}\nTemplate: ${templateName}\nReplacement number in chain: ${count}\nPDF DM: ${dmSent?'sent':'not sent (save the buyer Discord ID or use the ticket replacement button)'}\nOwner channel log: ${ownerLogged?'sent':ownerChannelId?'failed':'not configured'}`);
    }
    if(interaction.commandName==='invoice-inspect'){
     if(!isStaff(interaction))return interaction.reply({content:'Only server administrators, staff with Manage Channels, configured staff role, or the server owner can inspect invoices.',ephemeral:true});
     const typed=interaction.options.getString('invoice_id',true).trim();const record=getInvoice(typed);
     if(!record)return interaction.reply({content:`No saved invoice found for **${typed}**. Make sure it was saved to lookup.`,ephemeral:true});
     const products=(record.products||[]).map((p,i)=>`**${i+1}. ${short(p.name,80)}** — Qty ${Number(p.qty)||0} × ₹${Number(p.price||0).toFixed(2)}${p.accountEmail?'\nEmail / ID: ||'+String(p.accountEmail).slice(0,120)+'||':''}${p.accountPassword?'\nPassword: ||'+String(p.accountPassword).slice(0,120)+'||':''}`).join('\n\n')||'No products';
     const details=`**Invoice:** ${short(record.invoiceId)}\n**Buyer:** ${short(record.buyerName)}\n**Shop:** ${short(record.sellerName||record.shopName||'Not specified')}\n**Type:** ${short(record.documentType||'INVOICE')}\n**Created:** ${short(record.date||record.savedAt||'—')}\n**Products:** ${(record.products||[]).length}\n**Payable:** ₹${Number(record.payable||0).toFixed(2)}\n**Paid:** ₹${Number(record.totalPaid||0).toFixed(2)}\n**Balance:** ₹${Number(record.needToPay||0).toFixed(2)}\n\n${products}`;
     return interaction.reply(v2Card(`Admin Invoice Inspect • ${short(record.invoiceId,80)}`,details));
    }
   }
   if(interaction.isButton() && interaction.customId==='invoicepanel:open'){
    const modal=new ModalBuilder().setCustomId('invoicepanel:submit').setTitle('Find Your Invoice');
    const input=new TextInputBuilder().setCustomId('invoice_id').setLabel('Invoice ID').setPlaceholder('Enter the exact invoice ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
   }
   if(interaction.isModalSubmit() && interaction.customId==='invoicepanel:submit'){
    const typed=interaction.fields.getTextInputValue('invoice_id').trim();const record=getInvoice(typed);
    if(!record)return interaction.reply({content:`No saved invoice found for **${typed}**. Check the ID and make sure the invoice was saved to lookup.`,ephemeral:true});
    return interaction.reply(v2Card(`Invoice ${record.invoiceId}`,`**Buyer:** ${short(record.buyerName)}\n**Shop:** ${short(record.sellerName||record.shopName||'Not specified')}\n**Type:** ${short(record.documentType||'INVOICE')}\n**Products:** ${(record.products||[]).length}\n**Payable:** ₹${Number(record.payable||0).toFixed(2)}\n**Paid:** ₹${Number(record.totalPaid||0).toFixed(2)}\n**Balance:** ₹${Number(record.needToPay||0).toFixed(2)}\n\nSelect the buyer, then product, then ticket reason.`,[selectInvoiceBuyer(record)]));
   }
   if(interaction.isStringSelectMenu()){
    const [kind,...parts]=interaction.customId.split(':');
    if(kind==='ticketbuyer'){const id=parts.join(':');const inv=getInvoice(id);if(!inv)return interaction.reply({content:'Invoice not found. Save it again on the website.',ephemeral:true});return interaction.reply(v2Card(`Invoice ${inv.invoiceId}`,`**Buyer selected:** ${short(inv.buyerName)}\nChoose the product to get support for.`,[selectProduct(inv)]));}
    if(kind==='ticketproduct'){const id=parts[0],index=Number(interaction.values[0]);const inv=getInvoice(id);if(!inv)return interaction.reply({content:'Invoice not found.',ephemeral:true});const product=(inv.products||[])[index];if(!product)return interaction.reply({content:'Product not found.',ephemeral:true});return interaction.reply(v2Card(`Product: ${short(product.name)}`,`**Invoice:** ${id}\n**Buyer:** ${short(inv.buyerName)}\n${String(product.accountEmail||'').trim()&&String(product.accountPassword||'').trim()?'Replacement tickets are available because account details are saved.':'Replacement tickets are disabled until both account email / ID and password are saved. Help, Refund and Bug tickets remain available.'}\nChoose the reason for your ticket.`,[issueSelect(id,index,product)]));}
    if(kind==='ticketissue'){const id=parts[0],index=Number(parts[1]),reason=interaction.values[0];return startTicket(interaction,id,index,reason.toUpperCase());}
   }
   if(interaction.isModalSubmit()&&interaction.customId.startsWith('ticketreplace-submit:')){
    const ticketId=Number(interaction.customId.split(':')[1]);const ticket=ticketById(ticketId);if(!ticket)return interaction.reply({content:'Ticket record not found.',ephemeral:true});
    if(ticket.status==='closed'||!ticket.claimed_by)return interaction.reply({content:'The ticket must be open and claimed before creating a replacement.',ephemeral:true});
    if(!isStaff(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only staff, the assigned claimant, or server owner can create a replacement invoice.',ephemeral:true});
    const original=getInvoice(ticket.invoice_id);if(!original)return interaction.reply({content:'Original invoice was not found in the database.',ephemeral:true});
    if(db.prepare('SELECT 1 FROM invoice_replacements WHERE original_invoice_id=? COLLATE NOCASE').get(original.invoiceId))return interaction.reply({content:`Invoice ${original.invoiceId} has already been replaced once. Use its newest replacement invoice ID for another replacement.`,ephemeral:true});
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try{
     const productIndex=Number(ticket.product_index)||0;const originalProducts=Array.isArray(original.products)?original.products:[];const oldProduct=originalProducts[productIndex]||originalProducts[0]||{name:ticket.product_name,qty:1,price:0};
     const newProductName=interaction.fields.getTextInputValue('replacement_product').trim();const accountEmail=interaction.fields.getTextInputValue('replacement_email').trim();const accountPassword=interaction.fields.getTextInputValue('replacement_password').trim();const replacementNote=interaction.fields.getTextInputValue('replacement_note').trim();
     const newId=makeInvoiceId('INV');const tpl=getTemplate(original);const templateName=tpl.name;const count=replacementCount(original.invoiceId)+1;const now=new Date().toISOString();
     const products=originalProducts.map((p,i)=>i===productIndex?{...p,name:newProductName||p.name||ticket.product_name,accountEmail:accountEmail||p.accountEmail||'',accountPassword:accountPassword||p.accountPassword||''}:p);
     const replacement={...original,products,invoiceId:newId,documentType:original.documentType||'INVOICE',replacementOf:original.invoiceId,replacementLabel:'REPLACEMENT',qrEnabled:false,qrUpiId:'',replacementNote:replacementNote||undefined,createdBy:{id:interaction.user.id,username:interaction.user.username},templateName,preset:original.preset||(/gojo/i.test(templateName)?'gojo':/imposter/i.test(templateName)?'imposter':'standard'),brandName:original.brandName||tpl.brand,sellerName:original.sellerName||tpl.brand,shopName:original.shopName||tpl.brand,theme:original.theme||tpl.theme,themeColor:original.themeColor||tpl.accent,primaryColor:original.primaryColor||tpl.accent,watermark:original.watermark||tpl.watermark,showWatermark:original.showWatermark!==false,createdAt:now,savedAt:now,date:now,replacementCount:count};
     saveInvoice(replacement);db.prepare('INSERT INTO invoice_replacements(new_invoice_id,original_invoice_id,ticket_id,created_by,template_name,created_at) VALUES(?,?,?,?,?,?)').run(newId,original.invoiceId,ticket.id,interaction.user.id,templateName,now);
     const image=await createInvoiceImageBuffer(replacement);const pdf=await makePdfFromRenderedImage(image,replacement);const safeId=newId.replace(/[^a-z0-9_-]/gi,'_');
     const buyerId=String(original.discordUserId||original.buyerDiscordId||ticket.opener_id||'');let dmSent=false;try{const buyer=await bot.users.fetch(ticket.opener_id);const credentialText=`${accountEmail?`\n**New account email / ID:** ||${accountEmail}||`:''}${accountPassword?`\n**New account password:** ||${accountPassword}||`:''}`;await buyer.send({content:`## REPLACEMENT\n\nThank you for waiting! Your replacement invoice is ready.\n**New invoice ID:** \`${newId}\`\n**Original invoice ID:** \`${original.invoiceId}\`\n**Item:** ${short(products[productIndex]?.name||ticket.product_name)}\n**Prepared by:** <@${interaction.user.id}>\n\nKeep the new invoice ID for future support. If you have any issue, open a ticket using the new invoice ID through \`/invoice-panel\`.${credentialText}`,files:[new AttachmentBuilder(image,{name:`${safeId}.png`,description:'Replacement invoice image'}),new AttachmentBuilder(pdf,{name:`${safeId}.pdf`,description:'PDF matching the replacement invoice image'})],allowedMentions:{parse:[],users:[interaction.user.id]}});dmSent=true;}catch(e){console.warn('Replacement invoice DM failed:',e.message);}
     const logId=process.env.INVOICE_LOG_CHANNEL_ID||process.env.INVOICE_NOTIFICATION_CHANNEL_ID;if(logId){try{const log=await bot.channels.fetch(logId);if(log?.isTextBased()){const card=new ContainerBuilder().setAccentColor(0x16a085);card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ♻️ Replacement Invoice Created\n**New Invoice ID:** \`${newId}\`\n**Original Invoice:** \`${original.invoiceId}\`\n**Seller / Creator:** <@${String(replacement.sellerDiscordId||replacement.creatorDiscordId||interaction.user.id)}>\n**Buyer:** <@${/^\d{17,20}$/.test(buyerId)?buyerId:ticket.opener_id}>\n**Product:** ${short(products[productIndex]?.name||ticket.product_name)}\n**Reason:** ${ticket.issue_type}\n**Created by:** <@${interaction.user.id}>\n**Replacement number:** ${count}\n**DM:** ${dmSent?'Sent':'Could not DM buyer'}`));card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://replacement-invoice.png').setDescription(`Replacement invoice ${newId}`)));await log.send({flags:MessageFlags.IsComponentsV2,components:[card],files:[new AttachmentBuilder(image,{name:'replacement-invoice.png'}),new AttachmentBuilder(pdf,{name:`${safeId}.pdf`})],allowedMentions:{parse:[],users:[interaction.user.id,...(/^\d{17,20}$/.test(buyerId)?[buyerId]:[]),...(/^\d{17,20}$/.test(String(replacement.sellerDiscordId||replacement.creatorDiscordId||''))?[String(replacement.sellerDiscordId||replacement.creatorDiscordId)]:[])]}});}}catch(e){console.warn('Replacement invoice log failed:',e.message);}}
     const audit=JSON.stringify({...replacement,accountCredentialsUpdated:Boolean(accountEmail||accountPassword)});db.prepare('INSERT INTO invoice_activity(invoice_id,action,created_at,creator_id,creator_username,payload) VALUES(?,?,?,?,?,?)').run(newId,'replacement created',now,interaction.user.id,interaction.user.username,audit);
     const card=new ContainerBuilder().setAccentColor(0x16a085);card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Replacement Created\n**New ID:** \`${newId}\`\n**Original:** \`${original.invoiceId}\`\n**Image and PDF:** Generated\n**Buyer DM:** ${dmSent?'Sent':'Failed — check buyer DMs'}`));card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://replacement.png').setDescription(`Replacement invoice ${newId}`)));await channel.send({flags:MessageFlags.IsComponentsV2,components:[card],files:[new AttachmentBuilder(image,{name:'replacement.png'}),new AttachmentBuilder(pdf,{name:`${safeId}.pdf`})],allowedMentions:{parse:[]}});
     return interaction.editReply(`Replacement invoice created: ${newId}\nImage and matching PDF sent to the ticket channel and invoice log. Buyer DM: ${dmSent?'sent':'not sent'}.`);
    }catch(e){console.error('Ticket replacement failed:',e);return interaction.editReply('Replacement creation failed. Check the bot logs and try again.');}
   }
   if(interaction.isButton()){
    const [action,idText]=interaction.customId.split(':');const ticket=ticketById(idText);if(!ticket)return interaction.reply({content:'Ticket record not found.',ephemeral:true});
    const channel=interaction.guild?.channels.cache.get(ticket.channel_id);if(!channel)return interaction.reply({content:'Ticket channel not found.',ephemeral:true});
    if(action==='ticketreplace'){
      if(!isStaff(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only staff, the assigned claimant, or server owner can create a replacement invoice.',ephemeral:true});
      if(!ticket.claimed_by)return interaction.reply({content:'Claim this ticket first. The replacement option unlocks after a ticket is claimed.',ephemeral:true});
      if(ticket.status==='closed')return interaction.reply({content:'This ticket is closed. Reopen it before creating a replacement.',ephemeral:true});
      const original=getInvoice(ticket.invoice_id);if(!original)return interaction.reply({content:'Original invoice was not found in the database.',ephemeral:true});
      if(db.prepare('SELECT 1 FROM invoice_replacements WHERE original_invoice_id=? COLLATE NOCASE').get(original.invoiceId))return interaction.reply({content:`Invoice ${original.invoiceId} has already been replaced once. Use its newest replacement invoice ID for another replacement.`,ephemeral:true});
      return interaction.showModal(replacementInvoiceModal(ticket.id));
    }
    if(action==='ticketdetails'){
      if(!canSeeSecrets(interaction,ticket))return interaction.reply({content:'For account safety, only the claimed ticket staff member and server owner can view account details.',ephemeral:true});
      const inv=getInvoice(ticket.invoice_id);const p=(inv?.products||[])[Number(ticket.product_index)]||{};
      const email=p.accountEmail||'Not provided';const password=p.accountPassword||'Not provided';
      return interaction.reply({content:`🔐 **Private account details — ${ticket.invoice_id}**\n**Product:** ${short(ticket.product_name)}\n**Email / ID:** ||${String(email).slice(0,900)}||\n**Password:** ||${String(password).slice(0,900)}||\n\nDo not share these details outside this ticket.`,ephemeral:true});
    }
    if(action==='ticketclaim'){
      if(!isStaff(interaction))return interaction.reply({content:'Only staff members or the server owner can claim tickets.',ephemeral:true});
      if(ticket.status!=='open')return interaction.reply({content:'Closed tickets cannot be claimed. Reopen the ticket first.',ephemeral:true});
      if(ticket.claimed_by && ticket.claimed_by!==interaction.user.id && !isOwner(interaction))return interaction.reply({content:`Already claimed by <@${ticket.claimed_by}>. Only the server owner can take over or unclaim another staff member's ticket.`,ephemeral:true});
      if(ticket.claimed_by===interaction.user.id)return interaction.reply({content:'You already claimed this ticket.',ephemeral:true});
      db.prepare('UPDATE tickets SET claimed_by=? WHERE id=?').run(interaction.user.id,ticket.id);
      await channel.send(ticket.claimed_by && ticket.claimed_by!==interaction.user.id ? `👑 Server owner <@${interaction.user.id}> took over this ticket from <@${ticket.claimed_by}>.` : `🛡️ Ticket claimed by <@${interaction.user.id}>.`);
      await interaction.message.edit({components:[new ContainerBuilder().setAccentColor(0xf5b400).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Support Ticket #${ticket.id}\n**Invoice:** ${ticket.invoice_id}\n**Product:** ${short(ticket.product_name)}\n**Status:** OPEN\n**Claimed by:** <@${interaction.user.id}>`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticket.id,'open',interaction.user.id))]}).catch(()=>{});
      return interaction.reply({content:'Ticket claimed. You and the server owner can view account details.',ephemeral:true});
    }
    if(action==='ticketunclaim'){
      if(!ticket.claimed_by)return interaction.reply({content:'This ticket is not currently claimed.',ephemeral:true});
      if(!isOwner(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only the assigned claimant or server owner can unclaim this ticket.',ephemeral:true});
      db.prepare('UPDATE tickets SET claimed_by=NULL WHERE id=?').run(ticket.id);
      await channel.send(`↩️ Ticket unclaimed by <@${interaction.user.id}>. It is available for staff to claim.`);
      await interaction.message.edit({components:[new ContainerBuilder().setAccentColor(0xf5b400).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Support Ticket #${ticket.id}\n**Invoice:** ${ticket.invoice_id}\n**Product:** ${short(ticket.product_name)}\n**Status:** ${ticket.status.toUpperCase()}\n**Claimed by:** Unclaimed`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticket.id,ticket.status,null))]}).catch(()=>{});
      return interaction.reply({content:'Ticket unclaimed and available to staff.',ephemeral:true});
    }
    if(action==='ticketclose'){
      if(!isStaff(interaction)&&ticket.opener_id!==interaction.user.id&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only the ticket opener, assigned claimant, staff, or server owner can close this ticket.',ephemeral:true});
      if(ticket.status==='closed')return interaction.reply({content:'This ticket is already closed.',ephemeral:true});
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      // Fetch and deliver transcript before removing the channel.
      const transcript=await getTranscript(channel,ticket);
      db.prepare("UPDATE tickets SET status='closed',closed_at=? WHERE id=?").run(new Date().toISOString(),ticket.id);
      await sendTranscriptToUsers(interaction.guild,ticket,transcript,interaction.user.id);
      if(process.env.TICKET_LOG_CHANNEL_ID){/* transcript is also posted to the configured log channel by sendTranscriptToUsers */}
      await channel.send('🔒 Ticket closed. Transcript delivery was attempted by DM. This channel will be deleted shortly.').catch(()=>{});
      await interaction.editReply('Ticket closed. Transcript was sent by DM where possible; the ticket channel will now be deleted.');
      setTimeout(async()=>{try{await channel.delete(`Ticket #${ticket.id} closed by ${interaction.user.tag}; transcript sent/attempted`);db.prepare('UPDATE tickets SET channel_id=NULL WHERE id=?').run(ticket.id);}catch(e){console.error(`Could not delete closed ticket channel ${channel.id}:`,e.message);}},5000);
      return;
    }
    if(action==='ticketreopen'){
      if(!isOwner(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only the assigned claimant or server owner can reopen this ticket.',ephemeral:true});
      if(ticket.status!=='closed')return interaction.reply({content:'This ticket is already open.',ephemeral:true});
      db.prepare("UPDATE tickets SET status='open',closed_at=NULL WHERE id=?").run(ticket.id);
      await channel.permissionOverwrites.edit(ticket.opener_id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>{});
      await channel.send('🔓 Ticket reopened.');
      await interaction.message.edit({components:[new ContainerBuilder().setAccentColor(0xf5b400).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Support Ticket #${ticket.id}\n**Invoice:** ${ticket.invoice_id}\n**Product:** ${short(ticket.product_name)}\n**Status:** OPEN\n**Claimed by:** ${ticket.claimed_by?`<@${ticket.claimed_by}>`:'Unclaimed'}`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticket.id,'open',ticket.claimed_by))]}).catch(()=>{});
      return interaction.reply({content:'Ticket reopened successfully.',ephemeral:true});
    }
   }
   if(interaction.isUserSelectMenu()){
    const [action,idText]=interaction.customId.split(':');const ticket=ticketById(idText);if(!ticket)return interaction.reply({content:'Ticket record not found.',ephemeral:true});
    if(!isOwner(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only the ticket claimant or server owner can manage ticket access.',ephemeral:true});
    const channel=interaction.guild?.channels.cache.get(ticket.channel_id);if(!channel)return interaction.reply({content:'Ticket channel not found.',ephemeral:true});
    for(const userId of interaction.values){if(action==='ticketadd')await channel.permissionOverwrites.edit(userId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,AttachFiles:true});else if(action==='ticketremove'&&userId!==ticket.opener_id)await channel.permissionOverwrites.delete(userId).catch(()=>{});}
    return interaction.reply({content:action==='ticketadd'?'Selected users added to ticket.':'Selected users removed from ticket where allowed.',ephemeral:true});
   }
  }catch(e){console.error('Interaction failed:',e);const msg='Something went wrong processing this action. Check the server logs.';if(interaction.deferred||interaction.replied)await interaction.followUp({content:msg,ephemeral:true}).catch(()=>{});else await interaction.reply({content:msg,ephemeral:true}).catch(()=>{});}
 });
 bot.on('error',e=>console.error('Discord client error:',e));await bot.login(process.env.DISCORD_TOKEN);
}
app.listen(PORT,'0.0.0.0',()=>console.log(`Web service listening on ${PORT}; SQLite DB: ${DB_FILE}`));
startBot().catch(e=>console.error('Discord bot startup failed; website remains online:',e));
