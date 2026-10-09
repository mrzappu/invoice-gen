'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = Number(process.env.PORT) || 10000; // Render assigns PORT; never hard-code a listening port.
const API_KEY = process.env.INVOICE_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'invoices.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function readInvoices() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function writeInvoices(items) { fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2)); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function apiAuth(req, res, next) {
  // If INVOICE_API_KEY is configured, require it for write/search API requests.
  if (API_KEY && !safeEqual(req.get('x-api-key'), API_KEY)) return res.status(401).json({ error: 'Unauthorized API key.' });
  next();
}
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'inet-invoice-bot' }));
app.get('/api/invoices/:id', apiAuth, (req, res) => {
  const needle = String(req.params.id).trim().toLowerCase();
  const found = readInvoices().find(x => String(x.invoiceId).toLowerCase() === needle);
  if (!found) return res.status(404).json({ error: 'Invoice not found.' });
  res.json(found);
});
app.post('/api/invoices', apiAuth, (req, res) => {
  const body = req.body || {};
  if (!body.invoiceId || !body.buyerName) return res.status(400).json({ error: 'invoiceId and buyerName are required.' });
  const rows = readInvoices();
  const record = { ...body, savedAt: new Date().toISOString() };
  const existing = rows.findIndex(x => String(x.invoiceId) === String(record.invoiceId));
  if (existing >= 0) rows[existing] = record; else rows.push(record);
  writeInvoices(rows);
  res.status(201).json({ ok: true, invoiceId: record.invoiceId, savedAt: record.savedAt });
});

let bot;
async function startBot() {
  if (!process.env.DISCORD_TOKEN) { console.log('DISCORD_TOKEN not set; website will run without Discord bot.'); return; }
  bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  const commands = [
    new SlashCommandBuilder().setName('resize').setDescription('Resize an image to 3840×2160 and return it as a PNG')
      .addAttachmentOption(o => o.setName('image').setDescription('Image to resize').setRequired(true))
      .addStringOption(o => o.setName('fit').setDescription('How to fit the image').addChoices({name:'Contain (no crop)',value:'contain'},{name:'Cover (crop edges)',value:'cover'})),
    new SlashCommandBuilder().setName('invoice-search').setDescription('Find a saved invoice by its invoice ID')
      .addStringOption(o => o.setName('invoice_id').setDescription('Exact invoice ID, e.g. IMP-123456').setRequired(true))
  ].map(c => c.toJSON());
  bot.once('ready', async () => {
    console.log(`Discord bot logged in as ${bot.user.tag}`);
    try {
      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
      if (process.env.GUILD_ID && process.env.CLIENT_ID) {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log('Guild slash commands registered.');
      } else if (process.env.CLIENT_ID) {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Global slash commands registered (may take time to appear).');
      } else console.warn('CLIENT_ID missing; slash commands were not registered.');
    } catch (e) { console.error('Command registration failed:', e.message); }
  });
  bot.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'resize') {
      await interaction.deferReply();
      try {
        const file = interaction.options.getAttachment('image');
        if (!file.contentType?.startsWith('image/')) return interaction.editReply('Please attach a valid image file.');
        if (file.size > 15 * 1024 * 1024) return interaction.editReply('Image must be 15 MB or smaller.');
        const response = await fetch(file.url);
        if (!response.ok) throw new Error('Could not download the attachment.');
        const input = Buffer.from(await response.arrayBuffer());
        const fit = interaction.options.getString('fit') || 'contain';
        const png = await sharp(input, { failOn: 'none' }).rotate().resize(3840, 2160, {
          fit: fit === 'cover' ? 'cover' : 'contain',
          background: { r: 15, g: 18, b: 32, alpha: 1 }
        }).png({ compressionLevel: 8 }).toBuffer();
        const attachment = new AttachmentBuilder(png, { name: 'resized-3840x2160.png' });
        await interaction.editReply({ content: `Done — **3840 × 2160 px** PNG. Fit: **${fit}**.`, files: [attachment] });
      } catch (e) { console.error('Resize failed:', e); await interaction.editReply('Could not resize this image. Try a standard JPG/PNG/WebP under 15 MB.'); }
    }
    if (interaction.commandName === 'invoice-search') {
      const id = interaction.options.getString('invoice_id', true).trim().toLowerCase();
      const record = readInvoices().find(x => String(x.invoiceId).toLowerCase() === id);
      if (!record) return interaction.reply({ content: `No saved invoice found for **${interaction.options.getString('invoice_id', true)}**.`, ephemeral: true });
      const embed = new EmbedBuilder().setColor(0xf5b400).setTitle(`Invoice ${record.invoiceId}`)
        .addFields(
          { name: 'Buyer', value: String(record.buyerName || '—').slice(0, 1024), inline: true },
          { name: 'Shop', value: String(record.sellerName || record.shopName || 'Imposter Network').slice(0, 1024), inline: true },
          { name: 'Document', value: String(record.documentType || 'INVOICE'), inline: true },
          { name: 'Payable', value: `₹${Number(record.payable || 0).toFixed(2)}`, inline: true },
          { name: 'Paid', value: `₹${Number(record.totalPaid || 0).toFixed(2)}`, inline: true },
          { name: 'Need to Pay', value: `₹${Number(record.needToPay || 0).toFixed(2)}`, inline: true },
          { name: 'Date', value: String(record.date || record.savedAt || '—').slice(0, 1024), inline: false }
        ).setFooter({ text: 'Imposter Network • Invoice Lookup' });
      if (Array.isArray(record.products) && record.products.length) embed.addFields({ name: 'Products', value: record.products.slice(0, 10).map((p,i) => `${i+1}. ${String(p.name || 'Product').slice(0,80)} × ${Number(p.qty)||0} — ₹${((Number(p.qty)||0)*(Number(p.price)||0)).toFixed(2)}`).join('\n').slice(0,1024) });
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  });
  bot.on('error', e => console.error('Discord client error:', e));
  await bot.login(process.env.DISCORD_TOKEN);
}

app.listen(PORT, '0.0.0.0', () => console.log(`Web service listening on ${PORT}`));
startBot().catch(e => console.error('Discord bot startup failed; website remains online:', e.message));
