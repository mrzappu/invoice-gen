'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder
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
app.get('/health',(_req,res)=>res.status(200).json({ok:true,service:'inet-invoice-bot',database:'sqlite'}));
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
  const users=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketadd:${ticketId}`).setPlaceholder('Add user to ticket').setMinValues(1).setMaxValues(5));
  const remove=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ticketremove:${ticketId}`).setPlaceholder('Remove user from ticket').setMinValues(1).setMaxValues(5));
  return [row,users,remove];
}
function ticketById(id){return db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(id));}
function isOwner(interaction){return Boolean(interaction.guild && interaction.guild.ownerId===interaction.user.id);}
function isStaff(interaction){const roleId=process.env.STAFF_ROLE_ID;return isOwner(interaction)||Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)||interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)||(roleId&&interaction.member?.roles?.cache?.has(roleId)));}
function canSeeSecrets(interaction,ticket){return isOwner(interaction)||ticket.claimed_by===interaction.user.id;}
async function startTicket(interaction,invoiceId,productIndex,issueType) {
  const invoice=getInvoice(invoiceId); if(!invoice) return interaction.reply({content:'Invoice record no longer exists. Save the invoice again and retry.',ephemeral:true});
  const product=(invoice.products||[])[Number(productIndex)]; if(!product) return interaction.reply({content:'Product not found on this invoice.',ephemeral:true});
  const guild=interaction.guild; if(!guild)return interaction.reply({content:'Tickets can only be created inside a server.',ephemeral:true});
  const staffRoleId=process.env.STAFF_ROLE_ID;
  const overwrites=[{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:interaction.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]}];
  if(staffRoleId)overwrites.push({id:staffRoleId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages]});
  const channel=await guild.channels.create({name:`ticket-${String(invoiceId).toLowerCase().replace(/[^a-z0-9-]/g,'').slice(-16)}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,8)}`.slice(0,90),type:ChannelType.GuildText,topic:`Invoice ${invoiceId} • ${issueType} • opener ${interaction.user.id}`,permissionOverwrites:overwrites});
  const now=new Date().toISOString();
  const result=db.prepare('INSERT INTO tickets(invoice_id,guild_id,channel_id,opener_id,product_name,issue_type,status,created_at,product_index) VALUES(?,?,?,?,?,?,?,?,?)').run(invoiceId,guild.id,channel.id,interaction.user.id,product.name,issueType,'open',now,Number(productIndex));
  const ticketId=Number(result.lastInsertRowid);
  const body=`**Ticket:** #${ticketId}\n**Invoice ID:** ${invoiceId}\n**Buyer:** ${short(invoice.buyerName)}\n**Product:** ${short(product.name)}\n**Reason:** ${issueType}\n**Opened by:** <@${interaction.user.id}>\n\nAccount credentials are private. Only the ticket claimant and server owner can reveal them.`;
  await channel.send({components:[new ContainerBuilder().setAccentColor(0xf5b400).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Imposter Network Support Ticket\n${body}`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticketId,'open',null))],flags:MessageFlags.IsComponentsV2});
  return interaction.reply({content:`Ticket created: ${channel}`,ephemeral:true});
}
async function startBot(){
 if(!process.env.DISCORD_TOKEN){console.log('DISCORD_TOKEN not set; website will run without Discord bot.');return;}
 bot=new Client({intents:[GatewayIntentBits.Guilds]});
 const commands=[
  new SlashCommandBuilder().setName('resize').setDescription('Resize an image to 3840×2160 and return PNG').addAttachmentOption(o=>o.setName('image').setDescription('Image to resize').setRequired(true)).addStringOption(o=>o.setName('fit').setDescription('How to fit the image').addChoices({name:'Contain (no crop)',value:'contain'},{name:'Cover (crop edges)',value:'cover'})),
  new SlashCommandBuilder().setName('invoice-panel').setDescription('Open the invoice support panel'),
  new SlashCommandBuilder().setName('invoice-inspect').setDescription('Admin: inspect a saved invoice').addStringOption(o=>o.setName('invoice_id').setDescription('Invoice ID to inspect').setRequired(true))
 ].map(c=>c.toJSON());
 bot.once('ready',async()=>{console.log(`Discord bot logged in as ${bot.user.tag}`);try{const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);if(process.env.GUILD_ID&&process.env.CLIENT_ID){await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID),{body:commands});console.log('Guild slash commands registered.');}else if(process.env.CLIENT_ID){await rest.put(Routes.applicationCommands(process.env.CLIENT_ID),{body:commands});console.log('Global slash commands registered.');}else console.warn('CLIENT_ID missing; slash commands were not registered.');}catch(e){console.error('Command registration failed:',e);}});
 bot.on('interactionCreate',async interaction=>{
  try{
   if(interaction.isChatInputCommand()){
    if(interaction.commandName==='resize'){
     await interaction.deferReply();try{const file=interaction.options.getAttachment('image');if(!file.contentType?.startsWith('image/'))return interaction.editReply('Please attach a valid image.');if(file.size>15*1024*1024)return interaction.editReply('Image must be 15 MB or smaller.');const response=await fetch(file.url);if(!response.ok)throw new Error('Could not download image');const input=Buffer.from(await response.arrayBuffer());const fit=interaction.options.getString('fit')||'contain';const png=await sharp(input,{failOn:'none'}).rotate().resize(3840,2160,{fit:fit==='cover'?'cover':'contain',background:{r:15,g:18,b:32,alpha:1}}).png({compressionLevel:8}).toBuffer();await interaction.editReply({content:`Done — **3840 × 2160 px** PNG. Fit: **${fit}**.`,files:[new AttachmentBuilder(png,{name:'resized-3840x2160.png'})]});}catch(e){console.error('Resize failed',e);await interaction.editReply('Could not resize this image. Use JPG, PNG or WebP under 15 MB.');}
    }
    if(interaction.commandName==='invoice-panel'){
     const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('invoicepanel:open').setLabel('Search Invoice / Open Ticket').setStyle(ButtonStyle.Primary));
     return interaction.reply(v2Card('Imposter Network • Support Panel','Press the button below, enter your invoice ID, then select the product and issue type to create a private support ticket.',[row]));
    }
    if(interaction.commandName==='invoice-inspect'){
     if(!isStaff(interaction))return interaction.reply({content:'Only server administrators, staff with Manage Channels, configured staff role, or the server owner can inspect invoices.',ephemeral:true});
     const typed=interaction.options.getString('invoice_id',true).trim();const record=getInvoice(typed);
     if(!record)return interaction.reply({content:`No saved invoice found for **${typed}**. Make sure it was saved to lookup.`,ephemeral:true});
     const products=(record.products||[]).map((p,i)=>`**${i+1}. ${short(p.name,80)}** — Qty ${Number(p.qty)||0} × ₹${Number(p.price||0).toFixed(2)}${p.accountEmail?'\nEmail / ID: ||'+String(p.accountEmail).slice(0,120)+'||':''}${p.accountPassword?'\nPassword: ||'+String(p.accountPassword).slice(0,120)+'||':''}`).join('\n\n')||'No products';
     const details=`**Invoice:** ${short(record.invoiceId)}\n**Buyer:** ${short(record.buyerName)}\n**Shop:** ${short(record.sellerName||record.shopName||'Imposter Network')}\n**Type:** ${short(record.documentType||'INVOICE')}\n**Created:** ${short(record.date||record.savedAt||'—')}\n**Products:** ${(record.products||[]).length}\n**Payable:** ₹${Number(record.payable||0).toFixed(2)}\n**Paid:** ₹${Number(record.totalPaid||0).toFixed(2)}\n**Balance:** ₹${Number(record.needToPay||0).toFixed(2)}\n\n${products}`;
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
    return interaction.reply(v2Card(`Invoice ${record.invoiceId}`,`**Buyer:** ${short(record.buyerName)}\n**Shop:** ${short(record.sellerName||record.shopName||'Imposter Network')}\n**Type:** ${short(record.documentType||'INVOICE')}\n**Products:** ${(record.products||[]).length}\n**Payable:** ₹${Number(record.payable||0).toFixed(2)}\n**Paid:** ₹${Number(record.totalPaid||0).toFixed(2)}\n**Balance:** ₹${Number(record.needToPay||0).toFixed(2)}\n\nSelect the buyer, then product, then ticket reason.`,[selectInvoiceBuyer(record)]));
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
      if(!isOwner(interaction)&&ticket.opener_id!==interaction.user.id&&ticket.claimed_by!==interaction.user.id)return interaction.reply({content:'Only the ticket opener, assigned claimant, or server owner can close this ticket.',ephemeral:true});
      if(ticket.status==='closed')return interaction.reply({content:'This ticket is already closed.',ephemeral:true});
      db.prepare("UPDATE tickets SET status='closed',closed_at=? WHERE id=?").run(new Date().toISOString(),ticket.id);
      await channel.permissionOverwrites.edit(ticket.opener_id,{SendMessages:false}).catch(()=>{});
      await channel.send('🔒 Ticket closed. The assigned claimant or server owner can reopen it.');
      await interaction.message.edit({components:[new ContainerBuilder().setAccentColor(0x747f8d).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Support Ticket #${ticket.id}\n**Invoice:** ${ticket.invoice_id}\n**Product:** ${short(ticket.product_name)}\n**Status:** CLOSED\n**Claimed by:** ${ticket.claimed_by?`<@${ticket.claimed_by}>`:'Unclaimed'}`)).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(...ticketControls(ticket.id,'closed',ticket.claimed_by))]}).catch(()=>{});
      return interaction.reply({content:'Ticket closed successfully.',ephemeral:true});
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
