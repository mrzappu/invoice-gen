'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
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
`);
try { db.exec('ALTER TABLE tickets ADD COLUMN product_index INTEGER NOT NULL DEFAULT 0'); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; }
app.use(express.json({ limit: '2mb' }));
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
    name:String(p.name||'Product').slice(0,200), qty:Math.max(0,Number(p.qty)||0), price:Math.max(0,Number(p.price)||0),
    accountEmail:String(p.accountEmail||'').slice(0,500), accountPassword:String(p.accountPassword||'').slice(0,1000)
  })):[];
  const payload={...body,invoiceId,buyerName,products,savedAt:now};
  db.prepare(`INSERT INTO invoices(invoice_id,buyer_name,payload,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(invoice_id) DO UPDATE SET buyer_name=excluded.buyer_name,payload=excluded.payload,updated_at=excluded.updated_at`)
    .run(invoiceId,buyerName,JSON.stringify(payload),now,now);
  return payload;
}
// One-time compatibility migration: import records from the previous invoices.json build.
for (const legacyFile of [path.join(__dirname, 'invoices.json'), path.join(__dirname, 'data', 'invoices.json'), path.join(DATA_DIR, 'invoices.json')]) {
  try { if (fs.existsSync(legacyFile)) { const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); if (Array.isArray(legacy)) for (const item of legacy) { if (item && item.invoiceId && item.buyerName && !getInvoice(item.invoiceId)) saveInvoice(item); } console.log(`Imported legacy invoice records from ${legacyFile}`); } } catch (e) { console.warn(`Could not import ${legacyFile}: ${e.message}`); }
}
app.get('/health',(_req,res)=>res.status(200).json({ok:true,service:'invoice-bot',database:'sqlite'}));
app.get('/api/invoices/:id',apiAuth,(req,res)=>{const found=getInvoice(req.params.id);if(!found)return res.status(404).json({error:'Invoice not found.'});const safe={...found,products:(found.products||[]).map(({accountEmail,accountPassword,...p})=>p)};res.json(safe);});
app.post('/api/invoices',apiAuth,(req,res)=>{try{const record=saveInvoice(req.body||{});res.status(201).json({ok:true,invoiceId:record.invoiceId,savedAt:record.savedAt});}catch(e){res.status(400).json({error:e.message||'Could not save invoice.'});}});
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
function issueSelect(invoiceId,productIndex) {return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticketissue:${invoiceId}:${productIndex}`).setPlaceholder('Choose ticket reason').addOptions(issueTypes.map(x=>({label:x,value:x.toLowerCase(),description:`Open a ${x.toLowerCase()} support ticket`}))));}
function ticketControls(ticketId,status='open',claimedBy=null) {
  const row=new ActionRowBuilder();
  row.addComponents(new ButtonBuilder().setCustomId(`ticketclaim:${ticketId}`).setLabel(claimedBy?'Claimed / Take Over':'Claim').setStyle(ButtonStyle.Primary).setDisabled(status!=='open'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketunclaim:${ticketId}`).setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setDisabled(!claimedBy||status==='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketclose:${ticketId}`).setLabel('Close').setStyle(ButtonStyle.Danger).setDisabled(status==='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketreopen:${ticketId}`).setLabel('Reopen').setStyle(ButtonStyle.Success).setDisabled(status!=='closed'));
  row.addComponents(new ButtonBuilder().setCustomId(`ticketdetails:${ticketId}`).setLabel('Account Details').setStyle(ButtonStyle.Secondary));
  const replacement=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticketreplace:${ticketId}`).setLabel('Create Replacement Invoice').setStyle(ButtonStyle.Primary).setDisabled(status==='closed'));
  const users=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketadd:${ticketId}`).setPlaceholder('Add user to ticket').setMinValues(1).setMaxValues(5));
  const remove=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketremove:${ticketId}`).setPlaceholder('Remove user from ticket').setMinValues(1).setMaxValues(5));
  return [row,replacement,users,remove];
}
function ticketById(id){return db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(id));}
function isOwner(interaction){return Boolean(interaction.guild && interaction.guild.ownerId===interaction.user.id);}
function isStaff(interaction){const roleId=process.env.STAFF_ROLE_ID;return isOwner(interaction)||Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)||interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)||(roleId&&interaction.member?.roles?.cache?.has(roleId)));}
function canSeeSecrets(interaction,ticket){return isOwner(interaction)||ticket.claimed_by===interaction.user.id;}
async function respondInteraction(interaction,payload){ if(interaction.deferred) return interaction.editReply(payload); if(interaction.replied) return interaction.followUp(payload); return interaction.reply(payload); }
function makeInvoiceId(prefix='REPL') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function createInvoicePdfBuffer(invoice, metadata={}) {
  return new Promise((resolve,reject)=>{
    try {
      const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`Invoice ${invoice.invoiceId}`,Author:invoice.sellerName||invoice.shopName||'Shop'}});
      const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
      const accent=String(invoice.themeColor||invoice.primaryColor||'#2563eb');
      doc.fontSize(22).fillColor(accent).text(String(invoice.sellerName||invoice.shopName||'INVOICE').slice(0,90));
      doc.moveDown(.3).fontSize(18).fillColor('#111827').text(metadata.isReplacement?'REPLACEMENT INVOICE':'INVOICE');
      doc.moveDown(.4).fontSize(10).fillColor('#333333');
      doc.text(`Invoice ID: ${invoice.invoiceId}`);doc.text(`Buyer: ${invoice.buyerName||'—'}`);doc.text(`Date: ${new Date().toLocaleString('en-IN')}`);
      if(metadata.originalInvoiceId)doc.text(`Replaces invoice: ${metadata.originalInvoiceId}`);
      if(metadata.templateName)doc.text(`Template: ${metadata.templateName}`);
      doc.moveDown().fontSize(12).fillColor(accent).text('PRODUCTS');doc.moveDown(.3).fillColor('#111827').fontSize(10);
      for(const p of (invoice.products||[])){
        doc.text(`${String(p.name||'Product').slice(0,100)}  |  Qty: ${Number(p.qty)||0}  |  Unit price: INR ${Number(p.price||0).toFixed(2)}  |  Total: INR ${((Number(p.qty)||0)*(Number(p.price)||0)).toFixed(2)}`);
      }
      doc.moveDown().fontSize(10);doc.text(`Payable: INR ${Number(invoice.payable||0).toFixed(2)}`);doc.text(`Paid: INR ${Number(invoice.totalPaid||0).toFixed(2)}`);doc.text(`Balance: INR ${Number(invoice.needToPay||0).toFixed(2)}`);
      if(metadata.isReplacement){doc.moveDown().fillColor('#b45309').text('This document was issued as a replacement for the original invoice shown above.');}
      doc.end();
    } catch(e){reject(e);}
  });
}
async function getTranscript(channel, ticket) {
  const lines=[`Ticket Transcript #${ticket.id}`,`Invoice ID: ${ticket.invoice_id}`,`Product: ${ticket.product_name}`,`Issue: ${ticket.issue_type}`,`Opened by: ${ticket.opener_id}`,`Created: ${ticket.created_at}`,`Closed: ${new Date().toISOString()}`,'','Messages:'];
  let before, fetchedCount=0;
  try {
    while(fetchedCount<500){
      const batch=await channel.messages.fetch({limit:100,...(before?{before}:{})});if(!batch.size)break;
      const ordered=[...batch.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
      for(const m of ordered){lines.push(`[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.tag||m.author?.username||'Unknown'} (${m.author?.id||'?' }): ${m.content||'[no text]'}`);for(const a of m.attachments.values())lines.push(`  Attachment: ${a.url}`);}
      fetchedCount+=batch.size;before=batch.last()?.id;if(batch.size<100)break;
    }
  } catch(e){lines.push(`Transcript fetch warning: ${e.message}`);}
  return Buffer.from(lines.join('\n').slice(0,180000),'utf8');
}
async function sendTranscriptToUsers(guild, ticket, transcript, closerId) {
  const recipients=new Set([ticket.opener_id,closerId].filter(Boolean));
  if(ticket.claimed_by)recipients.add(ticket.claimed_by);
  const attachment=new AttachmentBuilder(transcript,{name:`ticket-${ticket.id}-transcript.txt`});
  for(const userId of recipients){try{const user=await bot.users.fetch(userId);await user.send({content:`Transcript for closed ticket #${ticket.id} (Invoice ${ticket.invoice_id}).`,files:[attachment]});}catch(e){console.warn(`Could not DM transcript to ${userId}: ${e.message}`);}}
  const logId=process.env.TICKET_LOG_CHANNEL_ID;
  if(logId){try{const log=await guild.channels.fetch(logId);if(log?.isTextBased())await log.send({content:`Ticket #${ticket.id} closed by <@${closerId}>. Invoice: ${ticket.invoice_id}.`,files:[new AttachmentBuilder(transcript,{name:`ticket-${ticket.id}-transcript.txt`})]});}catch(e){console.warn('Could not post ticket transcript to log channel:',e.message);}}
}
async function startTicket(interaction,invoiceId,productIndex,issueType) {
  const invoice=getInvoice(invoiceId); if(!invoice) return respondInteraction(interaction,{content:'Invoice record no longer exists. Save the invoice again and retry.',ephemeral:true});
  const product=(invoice.products||[])[Number(productIndex)]; if(!product) return respondInteraction(interaction,{content:'Product not found on this invoice.',ephemeral:true});
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
  return respondInteraction(interaction,{content:`Ticket created: ${channel}`,ephemeral:true});
}
const GAME_PRICE_CHANNEL_ID = process.env.GAME_PRICE_CHANNEL_ID || '1529155314887163986';
const GAME_STICKY_KEY = `game_price_sticky_message_${GAME_PRICE_CHANNEL_ID}`;
const GAME_IGNORE = new Set(['hi','hello','hey','help','price','prices','steam','game','games','test','ok','okay','thanks','thank you','yo','gm','gn','good morning','good night']);
function rupees(value) { return `₹${Number(value||0).toLocaleString('en-IN',{maximumFractionDigits:2})}`; }
async function steamSearch(query) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=in`;
  const response = await fetch(url, {headers:{'User-Agent':'Steam-Price-Lookup-Bot/1.0'}});
  if(!response.ok) throw new Error(`Steam search HTTP ${response.status}`);
  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if(!items.length) return null;
  const norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const wanted=norm(query);
  const item=items.find(x=>norm(x.name)===wanted) || items.find(x=>norm(x.name).includes(wanted)||wanted.includes(norm(x.name))) || items[0];
  const appId=String(item.id);
  let detail=null;
  try {
    const detailResponse=await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&cc=in&l=english`,{headers:{'User-Agent':'Steam-Price-Lookup-Bot/1.0'}});
    if(detailResponse.ok){const d=await detailResponse.json();if(d[appId]?.success)detail=d[appId].data;}
  } catch(e) { console.warn('Steam app details lookup failed:',e.message); }
  let steamPrice='Not available';
  if(detail?.is_free) steamPrice='Free to Play';
  else if(detail?.price_overview?.final_formatted) steamPrice=detail.price_overview.final_formatted;
  else if(item.price?.final_formatted) steamPrice=item.price.final_formatted;
  else if(item.price?.final!=null) steamPrice=`₹${(Number(item.price.final)/100).toFixed(2)}`;
  return {appId,name:detail?.name||item.name||query,steamPrice,description:String(detail?.short_description||'').replace(/<[^>]*>/g,'').slice(0,350),header:detail?.header_image||item.tiny_image||null,storeUrl:`https://store.steampowered.com/app/${appId}/`,steamDbUrl:`https://steamdb.info/app/${appId}/`};
}
function gameResultComponents(game, priceRow) {
  // Components V2 card: image + only the four requested details; no buttons or coloured embed.
  const container = new ContainerBuilder();
  if (game.header) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(game.header).setDescription(game.name)
      )
    );
  }
  const ourPrice = priceRow ? rupees(priceRow.our_price) : 'Not listed';
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ${game.name}\n**Steam Price:** ${game.steamPrice}\n**Our Price:** ${ourPrice}\n**Game ID:** ${game.appId}`
  ));
  return container;
}
function gameResultEmbed(game, priceRow) {
  // Kept as a compatibility helper; game lookup sends the V2 container above.
  return gameResultComponents(game, priceRow);
}
function gameStickyMessage() {
  return [
    '╭・🎮 **GAME PRICE CHECKER**',
    '│',
    '│  Want to check a game price?',
    '│  Run **`/game`** and enter the game name.',
    '│',
    '│  🖼️ Game image  ・  🎮 Name',
    '│  💰 Steam price  ・  🏷️ Our price',
    '│  🆔 Game ID',
    '│',
    '╰・🔒 Results are private — only you can see them.'
  ].join('\n');
}
async function bumpGameSticky(channel){
  try {
    const row=db.prepare('SELECT setting_value FROM bot_settings WHERE setting_key=?').get(GAME_STICKY_KEY);
    if(row?.setting_value){const old=await channel.messages.fetch(row.setting_value).catch(()=>null);if(old)await old.delete().catch(()=>{});}
    const msg=await channel.send({content:gameStickyMessage(),allowedMentions:{parse:[]}});
    db.prepare('INSERT INTO bot_settings(setting_key,setting_value) VALUES(?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value').run(GAME_STICKY_KEY,msg.id);
  } catch(e){console.error('Could not refresh game-price sticky message:',e.message);}
}
async function ensureGameSticky(){
  try {const channel=await bot.channels.fetch(GAME_PRICE_CHANNEL_ID);if(!channel?.isTextBased())return;const row=db.prepare('SELECT setting_value FROM bot_settings WHERE setting_key=?').get(GAME_STICKY_KEY);const existing=row?.setting_value?await channel.messages.fetch(row.setting_value).catch(()=>null):null;if(!existing)await bumpGameSticky(channel);else if(existing.embeds?.length){await existing.delete().catch(()=>{});await bumpGameSticky(channel);}} catch(e){console.error('Could not initialize game-price channel sticky:',e.message);}
}
async function createGameInquiryTicket(interaction, appId){
  const game=await steamSearchById(appId);
  if(!game)return interaction.reply({content:'I could not find this game on Steam. Please type the game name again.',ephemeral:true});
  const price=db.prepare('SELECT our_price FROM game_prices WHERE app_id=?').get(String(appId));
  const fakeId=`GAME-${appId}-${Date.now().toString().slice(-6)}`;
  const invoice={invoiceId:fakeId,buyerName:interaction.user.username,sellerName:'Shop',documentType:'GAME PRICE REQUEST',products:[{name:game.name,qty:1,price:price?.our_price||0,accountEmail:'',accountPassword:''}],payable:price?.our_price||0,totalPaid:0,needToPay:price?.our_price||0,savedAt:new Date().toISOString()};
  saveInvoice(invoice);
  return startTicket(interaction,fakeId,0,'GAME PRICE REQUEST');
}
async function steamSearchById(appId){
  try {const r=await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&cc=in&l=english`,{headers:{'User-Agent':'Steam-Price-Lookup-Bot/1.0'}});if(!r.ok)return null;const d=await r.json();const item=d[String(appId)];if(!item?.success)return null;const x=item.data;return {appId:String(appId),name:x.name||`Steam App ${appId}`,steamPrice:x.is_free?'Free to Play':(x.price_overview?.final_formatted||'Not available'),description:x.short_description||'',header:x.header_image||null,storeUrl:`https://store.steampowered.com/app/${appId}/`,steamDbUrl:`https://steamdb.info/app/${appId}/`};}catch(e){console.error('Steam app lookup failed:',e.message);return null;}
}

async function startBot(){
 if(!process.env.DISCORD_TOKEN){console.log('DISCORD_TOKEN not set; website will run without Discord bot.');return;}
 bot=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
 const commands=[
  new SlashCommandBuilder().setName('resize').setDescription('Resize an image to 3840×2160 and return PNG').addAttachmentOption(o=>o.setName('image').setDescription('Image to resize').setRequired(true)).addStringOption(o=>o.setName('fit').setDescription('How to fit the image').addChoices({name:'Contain (no crop)',value:'contain'},{name:'Cover (crop edges)',value:'cover'})),
  new SlashCommandBuilder().setName('invoice-panel').setDescription('Open the invoice support panel'),
  new SlashCommandBuilder().setName('invoice-inspect').setDescription('Admin: inspect a saved invoice').addStringOption(o=>o.setName('invoice_id').setDescription('Invoice ID to inspect').setRequired(true)),
  new SlashCommandBuilder().setName('invoice-replacement').setDescription('Staff: create a replacement invoice and DM the PDF').addStringOption(o=>o.setName('invoice_id').setDescription('Original invoice ID').setRequired(true)),
  new SlashCommandBuilder().setName('game').setDescription('Privately check a Steam game price').addStringOption(o=>o.setName('game_name').setDescription('Game name to search on Steam').setRequired(true).setMaxLength(90)),
  new SlashCommandBuilder().setName('game-price').setDescription('Admin: set or update the listed price for a Steam game').addStringOption(o=>o.setName('game_name').setDescription('Exact game name').setRequired(true)).addNumberOption(o=>o.setName('our_price').setDescription('Your price in INR (0 removes the listed price)').setRequired(true).setMinValue(0).setMaxValue(1000000))
 ].map(c=>c.toJSON());
 bot.once('ready',async()=>{console.log(`Discord bot logged in as ${bot.user.tag}`);await ensureGameSticky();try{const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);if(process.env.GUILD_ID&&process.env.CLIENT_ID){await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID),{body:commands});console.log(`Guild slash commands registered for guild ${process.env.GUILD_ID}: /game, /game-price and other commands.`);}else if(process.env.CLIENT_ID){await rest.put(Routes.applicationCommands(process.env.CLIENT_ID),{body:commands});console.log('Global slash commands registered. Global command updates may take time to appear; set GUILD_ID for fast testing.');}else console.error('CLIENT_ID is missing: slash commands cannot be registered. Add CLIENT_ID in Render Environment, then restart/redeploy.');}catch(e){console.error('Command registration failed. Check CLIENT_ID, DISCORD_TOKEN, and GUILD_ID:',e?.stack||e);}});
 bot.on('interactionCreate',async interaction=>{
  try{
   if(interaction.isChatInputCommand()){
    if(interaction.commandName==='resize'){
     await interaction.deferReply();try{const file=interaction.options.getAttachment('image');if(!file.contentType?.startsWith('image/'))return interaction.editReply('Please attach a valid image.');if(file.size>15*1024*1024)return interaction.editReply('Image must be 15 MB or smaller.');const response=await fetch(file.url);if(!response.ok)throw new Error('Could not download image');const input=Buffer.from(await response.arrayBuffer());const fit=interaction.options.getString('fit')||'contain';const png=await sharp(input,{failOn:'none'}).rotate().resize(3840,2160,{fit:fit==='cover'?'cover':'contain',background:{r:15,g:18,b:32,alpha:1}}).png({compressionLevel:8}).toBuffer();await interaction.editReply({content:`Done — **3840 × 2160 px** PNG. Fit: **${fit}**.`,files:[new AttachmentBuilder(png,{name:'resized-3840x2160.png'})]});}catch(e){console.error('Resize failed',e);await interaction.editReply('Could not resize this image. Use JPG, PNG or WebP under 15 MB.');}
    }
    if(interaction.commandName==='game'){
     await interaction.deferReply({flags:MessageFlags.Ephemeral});
     const name=interaction.options.getString('game_name',true).trim();
     try {
       const game=await steamSearch(name);
       if(!game)return interaction.editReply({content:`No Steam game found for \"${name}\". Check the title and try again.`});
       const price=db.prepare('SELECT our_price FROM game_prices WHERE app_id=?').get(game.appId);
       const container=new ContainerBuilder();
       if(game.header){container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(game.header).setDescription(game.name)));}
       container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${game.name}\n**Steam Price:** ${game.steamPrice}\n**Our Price:** ${price?rupees(price.our_price):'Not listed'}\n**Game ID:** ${game.appId}`));
       return interaction.editReply({flags:MessageFlags.IsComponentsV2,components:[container]});
     } catch(e){console.error('Private /game lookup failed:',e?.stack||e);return interaction.editReply({content:'Could not fetch Steam details right now. Please try again shortly.'});}
    }
    if(interaction.commandName==='game-price'){
     if(!isStaff(interaction))return interaction.reply({content:'Only server staff or the server owner can edit game prices.',ephemeral:true});
     await interaction.deferReply({flags:MessageFlags.Ephemeral});
     const name=interaction.options.getString('game_name',true).trim();const price=interaction.options.getNumber('our_price',true);
     try {const game=await steamSearch(name);if(!game)return interaction.editReply(`No Steam game found for **${name}**. Check the title and try again.`);
       if(price===0){db.prepare('DELETE FROM game_prices WHERE app_id=?').run(game.appId);return interaction.editReply(`Removed the listed price for **${game.name}**. The /game command will show **Our Price: Not listed**.`);}
       db.prepare('INSERT INTO game_prices(app_id,game_name,our_price,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET game_name=excluded.game_name,our_price=excluded.our_price,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(game.appId,game.name,price,interaction.user.id,new Date().toISOString());
       return interaction.editReply(`Updated price for **${game.name}**.\nSteam Price (India): **${game.steamPrice}**\nOur Price: **${rupees(price)}**\nGame ID: ${game.appId}`);
     }catch(e){console.error('Game price update failed:',e);return interaction.editReply('Could not fetch Steam details right now. Try again in a minute.');}
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
     const newId=makeInvoiceId();
     const templateName=String(original.templateName||original.template||original.invoiceTemplate||original.themeName||'Default template');
     const replacement={...original,invoiceId:newId,documentType:'REPLACEMENT INVOICE',replacementOf:original.invoiceId,templateName,createdAt:new Date().toISOString(),savedAt:new Date().toISOString()};
     saveInvoice(replacement);
     db.prepare('INSERT INTO invoice_replacements(new_invoice_id,original_invoice_id,ticket_id,created_by,template_name,created_at) VALUES(?,?,?,?,?,?)').run(newId,original.invoiceId,null,interaction.user.id,templateName,new Date().toISOString());
     const pdf=await createInvoicePdfBuffer(replacement,{isReplacement:true,originalInvoiceId:original.invoiceId,templateName});
     let dmSent=false;try{const buyer=await bot.users.fetch(String(original.discordUserId||original.buyerDiscordId||''));if(buyer?.id){await buyer.send({content:`Your replacement invoice has been created.\n**New Invoice ID:** ${newId}\n**Replaces Invoice:** ${original.invoiceId}\n**Template:** ${templateName}`,files:[new AttachmentBuilder(pdf,{name:`replacement-${newId}.pdf`})]});dmSent=true;}}catch(e){console.warn('Could not DM replacement invoice using invoice Discord user ID:',e.message);}
     return interaction.editReply(`Replacement invoice created.\n**New Invoice ID:** ${newId}\n**Original Invoice:** ${original.invoiceId}\n**Template:** ${templateName}\n**PDF:** ${dmSent?'DM sent.':'Generated, but buyer DM was not sent because no usable Discord user ID is saved on this invoice. Use the ticket replacement button to DM the ticket opener.'}`);
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
    if(kind==='ticketproduct'){const id=parts[0],index=Number(interaction.values[0]);const inv=getInvoice(id);if(!inv)return interaction.reply({content:'Invoice not found.',ephemeral:true});const product=(inv.products||[])[index];if(!product)return interaction.reply({content:'Product not found.',ephemeral:true});return interaction.reply(v2Card(`Product: ${short(product.name)}`,`**Invoice:** ${id}\n**Buyer:** ${short(inv.buyerName)}\nChoose the reason for your ticket.`,[issueSelect(id,index)]));}
    if(kind==='ticketissue'){const id=parts[0],index=Number(parts[1]),reason=interaction.values[0];return startTicket(interaction,id,index,reason.toUpperCase());}
   }
   if(interaction.isButton()){
    const [action,idText]=interaction.customId.split(':');const ticket=ticketById(idText);if(!ticket)return interaction.reply({content:'Ticket record not found.',ephemeral:true});
    const channel=interaction.guild?.channels.cache.get(ticket.channel_id);if(!channel)return interaction.reply({content:'Ticket channel not found.',ephemeral:true});
    if(action==='ticketreplace'){
      if(!isStaff(interaction)&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only staff, the assigned claimant, or server owner can create a replacement invoice.',ephemeral:true});
      if(ticket.status==='closed')return interaction.reply({content:'This ticket is closed. Reopen it before creating a replacement.',ephemeral:true});
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const original=getInvoice(ticket.invoice_id);if(!original)return interaction.editReply('Original invoice was not found in the database.');
      const newId=makeInvoiceId();const templateName=String(original.templateName||original.template||original.invoiceTemplate||original.themeName||'Default template');
      const replacement={...original,invoiceId:newId,documentType:'REPLACEMENT INVOICE',replacementOf:original.invoiceId,templateName,createdAt:new Date().toISOString(),savedAt:new Date().toISOString()};
      saveInvoice(replacement);
      db.prepare('INSERT INTO invoice_replacements(new_invoice_id,original_invoice_id,ticket_id,created_by,template_name,created_at) VALUES(?,?,?,?,?,?)').run(newId,original.invoiceId,ticket.id,interaction.user.id,templateName,new Date().toISOString());
      const pdf=await createInvoicePdfBuffer(replacement,{isReplacement:true,originalInvoiceId:original.invoiceId,templateName});
      let dmSent=false;try{const buyer=await bot.users.fetch(ticket.opener_id);await buyer.send({content:`Your replacement is ready.\n**New Invoice ID:** ${newId}\n**Replaces Invoice:** ${original.invoiceId}\n**Template:** ${templateName}\nIf you have another issue, use this new invoice ID in the Invoice Support Panel.`,files:[new AttachmentBuilder(pdf,{name:`replacement-${newId}.pdf`})]});dmSent=true;}catch(e){console.warn('Replacement invoice DM failed:',e.message);}
      await channel.send({content:`♻️ Replacement invoice created.\n**New Invoice ID:** \`${newId}\`\n**Original Invoice:** \`${original.invoiceId}\`\n**Template:** ${templateName}\n**PDF DM:** ${dmSent?'Sent to ticket opener.':'Could not DM member; check their privacy settings.'}`,allowedMentions:{parse:[]}});
      return interaction.editReply(`Replacement invoice: ${newId}\nOriginal invoice: ${original.invoiceId}\nTemplate: ${templateName}\nPDF DM: ${dmSent?'Sent':'Failed — the member may have DMs disabled'}.`);
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
 bot.on('messageCreate',async message=>{
  if(!message.guild||message.author.bot||message.channelId!==GAME_PRICE_CHANNEL_ID)return;
  // Keep the instruction post at the bottom. Game lookups are private through /game.
  await bumpGameSticky(message.channel);
 });
 bot.on('error',e=>console.error('Discord client error:',e));await bot.login(process.env.DISCORD_TOKEN);
}
app.listen(PORT,'0.0.0.0',()=>console.log(`Web service listening on ${PORT}; SQLite DB: ${DB_FILE}`));
startBot().catch(e=>console.error('Discord bot startup failed; website remains online:',e));
