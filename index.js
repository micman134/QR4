"use strict";

require("http")
  .createServer((req, res) => res.end("ok"))
  .listen(process.env.PORT || 3000);

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const QRCode = require("qrcode");
const jsQR = require("jsqr");
const sharp = require("sharp");
const { Pool } = require("pg");
const PDFDocument = require("pdfkit");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
if (!process.env.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Add it to your .env file.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL. Add your PostgreSQL connection string to your .env file.");
  process.exit(1);
}


const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
pool.on("error", (error) => console.error("Postgres pool error:", error.message));

const MAX_TEXT_LENGTH = 2000; // QR capacity is lower than this at higher error-correction levels
const COOLDOWN_MS = 1500; // minimum gap between QR generations per user
const FLOW_TTL_MS = 10 * 60 * 1000; // guided setups expire after 10 minutes
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // max size of an image sent for scanning
const MAX_BULK_ITEMS = 10; // Telegram albums hold at most 10 files
const MAX_BULK_ITEM_LENGTH = 500;
const HISTORY_PAGE_SIZE = 5;
const SEARCH_LIMIT = 10;
const ACTIVITY_LIMIT = 15;
const RETENTION_DAYS = Number(process.env.HISTORY_RETENTION_DAYS) || 0; // 0 = keep forever
const DISPLAY_TZ = process.env.DISPLAY_TZ || "Africa/Lagos";

const THEMES = {
  classic: { name: "Classic", emoji: "⚫", dark: "#000000", light: "#ffffff" },
  blue: { name: "Blue", emoji: "🔵", dark: "#1d4ed8", light: "#ffffff" },
  green: { name: "Green", emoji: "🟢", dark: "#15803d", light: "#ffffff" },
  purple: { name: "Purple", emoji: "🟣", dark: "#7e22ce", light: "#ffffff" },
  red: { name: "Red", emoji: "🔴", dark: "#b91c1c", light: "#ffffff" },
};

const SIZES = {
  small: { name: "Small", px: 400 },
  medium: { name: "Medium", px: 800 },
  large: { name: "Large", px: 1600 },
  xl: { name: "Print XL", px: 3000 },
};

const ECLS = {
  L: "Low (simplest code)",
  M: "Medium (balanced)",
  Q: "Quartile",
  H: "High (most damage-resistant)",
};

const SOCIALS = {
  instagram: { name: "Instagram", url: (h) => `https://instagram.com/${h}` },
  tiktok: { name: "TikTok", url: (h) => `https://www.tiktok.com/@${h}` },
  x: { name: "X (Twitter)", url: (h) => `https://x.com/${h}` },
  youtube: { name: "YouTube", url: (h) => `https://youtube.com/@${h}` },
  linkedin: { name: "LinkedIn", url: (h) => `https://linkedin.com/in/${h}` },
  facebook: { name: "Facebook", url: (h) => `https://facebook.com/${h}` },
  telegram: { name: "Telegram", url: (h) => `https://t.me/${h}` },
  github: { name: "GitHub", url: (h) => `https://github.com/${h}` },
  behance: { name: "Behance", url: (h) => `https://behance.net/${h}` },
};

// Kinds of QR codes: id -> [emoji, label]. Used by history and print layouts.
const KINDS = {
  link: ["🔗", "Link"],
  email: ["✉️", "Email"],
  phone: ["📞", "Phone"],
  text: ["📝", "Text"],
  menu: ["🍽️", "Menu"],
  pay: ["💳", "Payment"],
  whatsapp: ["💬", "WhatsApp"],
  product: ["🛍️", "Product"],
  review: ["⭐", "Review"],
  social: ["📱", "Social"],
  portfolio: ["🎨", "Portfolio"],
  wifi: ["📶", "Wi-Fi"],
  contact: ["👤", "Contact"],
  sms: ["💬", "SMS"],
  location: ["📍", "Location"],
  bulk: ["📦", "Bulk"],
};
const kindEmoji = (kind) => (KINDS[kind] ? KINDS[kind][0] : "🔳");
const kindLabel = (kind) => (KINDS[kind] ? KINDS[kind][1] : "QR code");

// Print layouts
const PRINT_MODES = {
  single: { name: "Single A4 poster" },
  sheet6: { name: "Sheet of 6", cols: 2, rows: 3 },
  sheet12: { name: "Sheet of 12", cols: 3, rows: 4 },
};

// Telegram limits: description 512 characters, short description 120 characters
const BOT_DESCRIPTION =
  "QR codes for menus, payments, Wi-Fi, contacts, WhatsApp, social profiles and more. Send a link or text, or pick a command.\n\n" +
  "Built for small businesses, designers and creators: brand colours, your logo, transparent PNG, SVG, print-ready PDFs and bulk export. " +
  "Your history is saved so you can come back to it.\n\n" +
  "Tap Start to begin. No sign-up needed.";

const BOT_SHORT_DESCRIPTION =
  "QR codes for menus, payments, WhatsApp, socials and more. Logos, SVG, print-ready PDFs and history.";

const BOT_COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "See everything I can do" },
  { command: "history", description: "Browse or search your past QR codes" },
  { command: "print", description: "Print-ready PDF of your latest QR code" },
  { command: "activity", description: "See your recent activity" },
  { command: "menu", description: "QR code for your menu link" },
  { command: "pay", description: "QR code for a payment link or bank details" },
  { command: "whatsapp", description: "Click-to-chat WhatsApp QR code" },
  { command: "product", description: "QR code with product name, price and details" },
  { command: "review", description: "QR code for your Google review link" },
  { command: "social", description: "QR code for a social media profile" },
  { command: "portfolio", description: "QR code for your portfolio or website" },
  { command: "contact", description: "Create a contact card (vCard) QR code" },
  { command: "wifi", description: "Create a Wi-Fi QR code" },
  { command: "email", description: "Create a pre-filled email QR code" },
  { command: "sms", description: "Create a pre-filled SMS QR code" },
  { command: "location", description: "Turn a location into a QR code" },
  { command: "text", description: "Encode text exactly as typed" },
  { command: "bulk", description: "Make up to 10 QR codes at once" },
  { command: "colors", description: "Set brand colours, e.g. /colors #1d4ed8 #ffffff" },
  { command: "logo", description: "Add your logo to the centre of QR codes" },
  { command: "style", description: "Change colour, size, background and accuracy" },
  { command: "clearhistory", description: "Delete your saved QR history" },
  { command: "deletedata", description: "Delete everything stored about you" },
  { command: "donate", description: "Support this bot ❤️" },
  { command: "cancel", description: "Cancel the current setup" },
];

// ---------------------------------------------------------------------------
// Database (PostgreSQL)
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          BIGINT PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  logo        BYTEA,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_history (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'text',
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  has_logo    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qr_history_user_idx ON qr_history (user_id, id DESC);

CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_user_idx ON activity_log (user_id, id DESC);
`;

async function initDb() {
  await pool.query(SCHEMA);
}

async function pruneOldHistory() {
  if (!RETENTION_DAYS) return;
  try {
    const result = await pool.query(
      "DELETE FROM qr_history WHERE created_at < now() - ($1 || ' days')::interval",
      [String(RETENTION_DAYS)]
    );
    const activity = await pool.query(
      "DELETE FROM activity_log WHERE created_at < now() - ($1 || ' days')::interval",
      [String(RETENTION_DAYS)]
    );
    if (result.rowCount || activity.rowCount) {
      console.log(`Retention cleanup removed ${result.rowCount} QR entries and ${activity.rowCount} activity rows.`);
    }
  } catch (error) {
    console.error("Retention cleanup failed:", error.message);
  }
}

// Fire-and-forget: logging must never break the bot
function logActivity(userId, action, details = {}) {
  pool
    .query("INSERT INTO activity_log (user_id, action, details) VALUES ($1, $2, $3)", [userId, action, details])
    .catch((error) => console.error("Activity log failed:", error.message));
}

const withoutLogo = (settings) => {
  const { logo, ...rest } = settings; // eslint-disable-line no-unused-vars
  return rest;
};

async function addHistory(userId, { kind, title, summary, payload, settings }) {
  const { rows } = await pool.query(
    `INSERT INTO qr_history (user_id, kind, title, summary, payload, settings, has_logo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, kind, title, summary || "", payload, withoutLogo(settings), Boolean(settings.logo)]
  );
  return Number(rows[0].id);
}

async function getHistoryEntry(userId, id) {
  const { rows } = await pool.query("SELECT * FROM qr_history WHERE id = $1 AND user_id = $2", [id, userId]);
  return rows[0] || null;
}

async function deleteHistoryEntry(userId, id) {
  const result = await pool.query("DELETE FROM qr_history WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

async function countHistory(userId) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM qr_history WHERE user_id = $1", [userId]);
  return rows[0].n;
}

async function listHistory(userId, limit, offset) {
  const { rows } = await pool.query(
    `SELECT id, kind, title, summary, created_at FROM qr_history
     WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function searchHistory(userId, term, limit) {
  const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await pool.query(
    `SELECT id, kind, title, summary, created_at FROM qr_history
     WHERE user_id = $1 AND (summary ILIKE $2 OR kind ILIKE $2 OR title ILIKE $2)
     ORDER BY id DESC LIMIT $3`,
    [userId, like, limit]
  );
  return rows;
}

async function saveSettings(userId) {
  const settings = getSettings(userId);
  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, settings, logo, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, logo = EXCLUDED.logo, updated_at = now()`,
      [userId, withoutLogo(settings), settings.logo]
    );
  } catch (error) {
    console.error("Saving settings failed:", error.message);
  }
}

// ---------------------------------------------------------------------------
// In-memory state (flows are short-lived; settings are cached from the database)
// ---------------------------------------------------------------------------
const settingsByUser = new Map(); // userId -> { theme, size, ecl, transparent, custom, logo }
const flows = new Map(); // userId -> { type, index, data, expires }
const lastActionAt = new Map(); // userId -> timestamp
const awaitingLogo = new Map(); // userId -> expiry timestamp
const loadedUsers = new Map(); // userId -> last time we synced this user with the database

const defaultSettings = () => ({
  theme: "classic",
  size: "medium",
  ecl: "M",
  transparent: false,
  custom: null,
  logo: null,
});

function getSettings(userId) {
  let settings = settingsByUser.get(userId);
  if (!settings) {
    settings = defaultSettings();
    settingsByUser.set(userId, settings);
  }
  return settings;
}

// Settings for re-rendering an old QR code: what it looked like then, with the user's current logo if it had one
function entrySettings(entry, userId) {
  return {
    ...defaultSettings(),
    ...entry.settings,
    logo: entry.has_logo ? getSettings(userId).logo : null,
  };
}

function isRateLimited(userId) {
  const now = Date.now();
  if (now - (lastActionAt.get(userId) || 0) < COOLDOWN_MS) return true;
  lastActionAt.set(userId, now);
  return false;
}

function takeLogoRequest(userId) {
  const expires = awaitingLogo.get(userId);
  if (!expires) return false;
  awaitingLogo.delete(userId);
  return expires > Date.now();
}

// Periodic cleanup so the maps don't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [userId, flow] of flows) {
    if (flow.expires < now) flows.delete(userId);
  }
  for (const [userId, expires] of awaitingLogo) {
    if (expires < now) awaitingLogo.delete(userId);
  }
  for (const [userId, time] of lastActionAt) {
    if (now - time > 60 * 60 * 1000) lastActionAt.delete(userId);
  }
  // Idle users are evicted from the cache; their settings reload from PostgreSQL on the next message
  for (const [userId, time] of loadedUsers) {
    if (now - time > 60 * 60 * 1000) {
      loadedUsers.delete(userId);
      settingsByUser.delete(userId);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clip = (text, max = 500) => (text.length > max ? text.slice(0, max) + "…" : text);

const chunk = (items, size) => {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
};

const slug = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "code";

const ascii = (text) => String(text).replace(/[^\x20-\x7E]/g, "").trim(); // PDF built-in fonts only cover basic characters

const fmtDate = (date) =>
  new Date(date).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TZ,
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_LOOSE_RE = /^\+?[\d\s\-().]{5,20}$/;
const PHONE_AUTO_RE = /^(\+|0)[\d\s\-().]{6,19}$/;
const LINK_LOOSE_RE = /^(https?:\/\/)?[^\s/]+\.[^\s]+$/i;

const toUrl = (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`);

function detectContent(text) {
  if (/^https?:\/\/\S+$/i.test(text)) {
    return { payload: text, label: "🔗 Link", kind: "link" };
  }
  if (/^www\.\S+\.\S+$/i.test(text)) {
    return { payload: `https://${text}`, label: "🔗 Link", kind: "link" };
  }
  if (EMAIL_RE.test(text)) {
    return { payload: `mailto:${text}`, label: "✉️ Email address", kind: "email" };
  }
  if (PHONE_AUTO_RE.test(text) && text.replace(/\D/g, "").length >= 7) {
    return { payload: `tel:${text.replace(/[^\d+]/g, "")}`, label: "📞 Phone number", kind: "phone" };
  }
  return { payload: text, label: "📝 Text", kind: "text" };
}

// Colour helpers (brand colours + contrast check so codes stay scannable)
function normalizeHex(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(value || "");
  return m ? `#${m[1].toLowerCase()}` : null;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function resolveTheme(settings) {
  if (settings.theme === "custom" && settings.custom) {
    return { name: "Custom", emoji: "🎨", ...settings.custom };
  }
  return THEMES[settings.theme] || THEMES.classic;
}

// Fancy captions (Telegram HTML, 1024 character limit)
const CAPTION_LIMIT = 1024;
const DIVIDER = "━━━━━━━━━━━━━━";

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function scanHint(payload) {
  if (/^WIFI:/i.test(payload)) return "Open your camera and tap the banner to join the network";
  if (/^https?:\/\/wa\.me\//i.test(payload)) return "Scan to open a WhatsApp chat instantly";
  if (/^https?:\/\//i.test(payload)) return "Point your camera at the code and tap the link that appears";
  if (/^BEGIN:VCARD/i.test(payload)) return "Scan and tap to save the contact to your phone";
  if (/^mailto:/i.test(payload)) return "Scan to start a pre-filled email";
  if (/^(sms|smsto):/i.test(payload)) return "Scan to start a pre-filled text message";
  if (/^tel:/i.test(payload)) return "Scan to call this number";
  return "Point your phone camera at the code to read it";
}

function buildCaption(title, summary, payload, settings) {
  const theme = resolveTheme(settings);
  const ecl = settings.logo ? "H" : settings.ecl;
  const specs =
    `${theme.emoji} ${theme.name} · ${SIZES[settings.size].px}px · Accuracy ${ecl}` +
    (settings.logo ? " · Logo" : "") +
    (settings.transparent ? " · Transparent" : "");

  for (const max of [600, 300, 100, 0]) {
    const body = summary && max ? `<blockquote>${escapeHtml(clip(summary, max))}</blockquote>\n` : "";
    const caption =
      `✨ <b>${escapeHtml(title)}</b> ✨\n${DIVIDER}\n` +
      body +
      `📲 <i>${escapeHtml(scanHint(payload))}</i>\n${DIVIDER}\n` +
      `<i>${escapeHtml(specs)}</i>\n` +
      "💡 Tap a button below for HD PNG, SVG or print";
    if (caption.length <= CAPTION_LIMIT) return caption;
  }
  return escapeHtml(title);
}

// ---------------------------------------------------------------------------
// QR rendering
// ---------------------------------------------------------------------------
function qrOptions(settings, width) {
  const theme = resolveTheme(settings);
  return {
    width: width || SIZES[settings.size].px,
    margin: 2,
    // A logo covers the centre, so force the highest error correction
    errorCorrectionLevel: settings.logo ? "H" : settings.ecl,
    color: { dark: theme.dark, light: settings.transparent ? "#00000000" : theme.light },
  };
}

async function renderPng(payload, settings, width) {
  const options = qrOptions(settings, width);
  const base = await QRCode.toBuffer(payload, { ...options, type: "png" });
  if (!settings.logo) return base;

  const { width: actual } = await sharp(base).metadata();
  const logoSize = Math.round(actual * 0.2);
  const pad = Math.round(logoSize * 0.12);
  const box = logoSize + pad * 2;
  const backing = settings.transparent ? "#ffffff" : resolveTheme(settings).light;

  const logo = await sharp(settings.logo)
    .resize(logoSize, logoSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const badge = await sharp({ create: { width: box, height: box, channels: 4, background: backing } })
    .composite([{ input: logo, gravity: "centre" }])
    .png()
    .toBuffer();

  return sharp(base).composite([{ input: badge, gravity: "centre" }]).png().toBuffer();
}

async function renderSvg(payload, settings) {
  const svg = await QRCode.toString(payload, { ...qrOptions(settings), type: "svg" });
  if (!settings.logo) return svg;

  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb) return svg;

  const n = Number(vb[1]);
  const logoSize = n * 0.2;
  const pad = logoSize * 0.12;
  const box = logoSize + pad * 2;
  const x = (n - box) / 2;
  const y = (n - box) / 2;
  const backing = settings.transparent ? "#ffffff" : resolveTheme(settings).light;
  const href = `data:image/png;base64,${settings.logo.toString("base64")}`;

  const overlay =
    `<rect x="${x}" y="${y}" width="${box}" height="${box}" fill="${backing}"/>` +
    `<image x="${x + pad}" y="${y + pad}" width="${logoSize}" height="${logoSize}" href="${href}" preserveAspectRatio="xMidYMid meet"/>`;

  return svg.replace("</svg>", `${overlay}</svg>`);
}

// ---------------------------------------------------------------------------
// Print-ready PDF (A4)
// ---------------------------------------------------------------------------
function buildPdf(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: "QR code", Creator: "Quick QR Generator" } });
    const parts = [];
    doc.on("data", (c) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    try {
      draw(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function renderPrintPdf(entry, settings, modeId) {
  const mode = PRINT_MODES[modeId];
  // Print always uses a solid background so the paper colour never shows through the code
  const png = await renderPng(entry.payload, { ...settings, transparent: false }, 1600);
  const label = ascii(kindLabel(entry.kind)) || "QR code";
  const today = new Date().toISOString().slice(0, 10);

  return buildPdf((doc) => {
    const W = doc.page.width;
    const H = doc.page.height;

    if (modeId === "single") {
      const size = 340; // about 12 cm
      doc.font("Helvetica-Bold").fontSize(30).fillColor("#111111").text(label, 0, 110, { width: W, align: "center" });
      doc.image(png, (W - size) / 2, 180, { width: size });
      doc
        .font("Helvetica")
        .fontSize(14)
        .fillColor("#444444")
        .text(scanHint(entry.payload), 60, 180 + size + 24, { width: W - 120, align: "center" });
      doc
        .fontSize(9)
        .fillColor("#999999")
        .text(`Created with Quick QR Generator - ${today}`, 0, H - 50, { width: W, align: "center" });
      return;
    }

    // Sheet layout: a grid of identical codes with dashed cut lines
    const margin = 28;
    const cellW = (W - margin * 2) / mode.cols;
    const cellH = (H - margin * 2) / mode.rows;
    const labelH = 22;
    const size = Math.min(cellW, cellH - labelH) - 20;

    for (let r = 0; r < mode.rows; r++) {
      for (let c = 0; c < mode.cols; c++) {
        const left = margin + c * cellW;
        const top = margin + r * cellH;

        doc.save();
        doc.rect(left, top, cellW, cellH).dash(3, { space: 3 }).lineWidth(0.5).strokeColor("#bbbbbb").stroke();
        doc.restore();

        doc.image(png, left + (cellW - size) / 2, top + 10, { width: size });
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor("#222222")
          .text(`${label} - Scan me`, left, top + 10 + size + 4, { width: cellW, align: "center" });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sending QR codes
// ---------------------------------------------------------------------------
function qrKeyboard(id, { reopened = false } = {}) {
  const rows = [
    [
      Markup.button.callback("📄 HD PNG file", `dl:png:${id}`),
      Markup.button.callback("🧩 SVG (vector)", `dl:svg:${id}`),
    ],
    [Markup.button.callback("🖨️ Print", `pr:${id}`), Markup.button.callback("📜 History", "hist:0")],
  ];
  if (reopened) rows.push([Markup.button.callback("🗑️ Delete from history", `h:del:${id}`)]);
  return Markup.inlineKeyboard(rows);
}

// Renders and sends one QR code message. `entry.id` may be null if the database was unavailable.
async function deliverQR(ctx, entry, { reopened = false } = {}) {
  const png = await renderPng(entry.payload, entry.settings);

  const extra = {
    caption: buildCaption(entry.title, entry.summary, entry.payload, entry.settings),
    parse_mode: "HTML",
  };
  if (entry.id) extra.reply_markup = qrKeyboard(entry.id, { reopened }).reply_markup;

  // Telegram flattens transparent photos, so send those as a file instead
  return entry.settings.transparent
    ? ctx.replyWithDocument({ source: png, filename: "qr-code.png" }, extra)
    : ctx.replyWithPhoto({ source: png, filename: "qr-code.png" }, extra);
}

async function sendQR(ctx, payload, { title = "Your QR code is ready! 📱", summary = "", kind = "text" } = {}) {
  if (payload.length > MAX_TEXT_LENGTH) {
    return ctx.reply(`Please send content shorter than ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
  }
  if (isRateLimited(ctx.from.id)) {
    return ctx.reply("⏳ Please wait a moment before sending another request.");
  }

  const settings = { ...getSettings(ctx.from.id) };
  let id = null;

  try {
    await ctx.sendChatAction("upload_photo");

    // Save to history first so the buttons can point at the saved entry
    id = await addHistory(ctx.from.id, { kind, title, summary, payload, settings }).catch((error) => {
      console.error("Saving history failed:", error.message);
      return null;
    });

    await deliverQR(ctx, { id, kind, title, summary, payload, settings });
    logActivity(ctx.from.id, "qr_created", { kind, history_id: id });
  } catch (error) {
    console.error("QR generation failed:", error);
    if (id) deleteHistoryEntry(ctx.from.id, id).catch(() => {}); // don't keep entries that were never delivered
    if (/too big|capacity/i.test(String(error && error.message))) {
      await ctx.reply(
        "That's too much data for a QR code at your current accuracy setting. " +
          "Try shorter content, lower the error correction level with /style, or remove your logo with /logo."
      );
    } else {
      await ctx.reply("Sorry, I couldn't generate that QR code.");
    }
  }
}

async function sendBulk(ctx, raw) {
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (isRateLimited(ctx.from.id)) {
    return ctx.reply("⏳ Please wait a moment before sending another request.");
  }

  const settings = { ...getSettings(ctx.from.id) };
  const width = Math.max(SIZES.large.px, SIZES[settings.size].px);

  try {
    await ctx.sendChatAction("upload_document");

    const files = [];
    const items = [];
    for (const [i, line] of lines.entries()) {
      const { payload, kind } = detectContent(line);
      const png = await renderPng(payload, settings, width);
      files.push({ source: png, filename: `qr-${String(i + 1).padStart(2, "0")}-${slug(line)}.png` });
      items.push({ payload, kind, line });
    }

    if (files.length === 1) {
      await ctx.replyWithDocument(files[0]);
    } else {
      await ctx.replyWithMediaGroup(files.map((f) => ({ type: "document", media: f })));
    }
    await ctx.reply(
      `✅ ${files.length} QR code${files.length === 1 ? "" : "s"} ready, in the order you sent them.\n` +
        "They're saved in /history so you can reopen or print them later."
    );

    // Save each one to history after it was delivered
    for (const item of items) {
      await addHistory(ctx.from.id, {
        kind: item.kind,
        title: "Bulk QR code",
        summary: `${KINDS[item.kind] ? KINDS[item.kind][0] : "🔳"} ${clip(item.line, 200)}`,
        payload: item.payload,
        settings,
      }).catch((error) => console.error("Saving bulk history failed:", error.message));
    }
    logActivity(ctx.from.id, "bulk", { count: files.length });
  } catch (error) {
    console.error("Bulk generation failed:", error);
    if (/too big|capacity/i.test(String(error && error.message))) {
      await ctx.reply("One of those lines is too long for a QR code at your current settings. Shorten it and try again.");
    } else {
      await ctx.reply("Sorry, I couldn't generate those QR codes.");
    }
  }
}

// ---------------------------------------------------------------------------
// Images: scanning and logo upload
// ---------------------------------------------------------------------------
async function downloadFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.href);
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function decodeQR(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const result = jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height
  );
  return result ? result.data : null;
}

async function scanImage(ctx, fileId) {
  if (isRateLimited(ctx.from.id)) {
    return ctx.reply("⏳ Please wait a moment before sending another request.");
  }

  try {
    await ctx.sendChatAction("typing");

    const buffer = await downloadFile(ctx, fileId);
    const decoded = await decodeQR(buffer);

    // Only the fact that a scan happened is logged, never what was in the code
    logActivity(ctx.from.id, "scan", { found: Boolean(decoded) });

    if (!decoded) {
      return ctx.reply(
        "I couldn't find a readable QR code in that image. " +
          "Try a sharper, well-lit photo with the whole code in frame. " +
          "Sending it as a file (not a compressed photo) often helps."
      );
    }

    let text = `🔍 Decoded content:\n\n${clip(decoded, 3500)}`;
    if (/^https?:\/\//i.test(decoded)) {
      text += "\n\n⚠️ Only open links from sources you trust.";
    }
    await ctx.reply(text);
  } catch (error) {
    console.error("QR scan failed:", error);
    await ctx.reply("Sorry, I couldn't read that image.");
  }
}

async function saveLogo(ctx, fileId) {
  try {
    await ctx.sendChatAction("typing");
    const buffer = await downloadFile(ctx, fileId);
    const logo = await sharp(buffer)
      .rotate()
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    getSettings(ctx.from.id).logo = logo;
    await saveSettings(ctx.from.id);
    logActivity(ctx.from.id, "logo_set");
    await ctx.reply(
      "✅ Logo saved. It will appear in the centre of your next QR codes.\n\n" +
        "Error correction is set to High automatically so the code still scans. " +
        "Send /removelogo to remove it."
    );
  } catch (error) {
    console.error("Logo upload failed:", error);
    await ctx.reply("Sorry, I couldn't use that image. Try a PNG or JPG file.");
  }
}

// ---------------------------------------------------------------------------
// Guided flows
// ---------------------------------------------------------------------------
const wifiEscape = (s) => s.replace(/([\\;,:"])/g, "\\$1");
const vcardEscape = (s) =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");

const validators = {
  required: (label) => (v) => (v ? null : `${label} can't be empty.`),
  phone: (v) =>
    PHONE_LOOSE_RE.test(v) ? null : "Please enter a valid phone number, e.g. +2348012345678.",
  email: (v) => (EMAIL_RE.test(v) ? null : "Please enter a valid email address."),
  link: (v) => (LINK_LOOSE_RE.test(v) ? null : "Please enter a valid link, e.g. https://example.com"),
  max: (n) => (v) => (v.length <= n ? null : `Please keep it under ${n} characters.`),
};

const linkStep = (key, prompt, extra = {}) => ({
  key,
  prompt,
  validate: validators.link,
  transform: toUrl,
  ...extra,
});

// Simple "paste a link" flow used by /menu, /portfolio and /review
const linkFlow = (title, prompt, label) => ({
  title,
  steps: [linkStep("url", prompt)],
  build: (d) => d.url,
  summary: (d) => `${label}\n${clip(d.url, 200)}\n\nScan to open.`,
});

const buildSocial = (d) =>
  /^https?:\/\//i.test(d.handle) ? d.handle : SOCIALS[d.platform].url(d.handle);

const FLOW_DEFS = {
  // ----- Small businesses -----
  menu: linkFlow(
    "Your menu QR code is ready! 🍽️",
    "🍽️ Paste the link to your menu (website, PDF, Google Drive, Instagram, etc.):",
    "🍽️ Menu"
  ),

  pay: {
    title: "Your payment QR code is ready! 💳",
    steps: [
      {
        key: "kind",
        prompt: "💳 What should customers scan to pay?",
        buttons: [
          ["💳 Payment link (Paystack, Flutterwave, PayPal...)", "link"],
          ["🏦 Bank transfer details", "bank"],
        ],
        validate: (v) => (["link", "bank"].includes(v) ? null : "Please tap one of the buttons above."),
      },
      linkStep("link", "🔗 Paste your payment link:", { skip: (d) => d.kind !== "link" }),
      {
        key: "accname",
        prompt: "👤 Account name?",
        skip: (d) => d.kind !== "bank",
        validate: (v) => (v && v.length <= 100 ? null : "Please enter the account name (up to 100 characters)."),
      },
      {
        key: "bank",
        prompt: "🏦 Bank name?",
        skip: (d) => d.kind !== "bank",
        validate: (v) => (v && v.length <= 100 ? null : "Please enter the bank name (up to 100 characters)."),
      },
      {
        key: "account",
        prompt: "🔢 Account number?",
        skip: (d) => d.kind !== "bank",
        validate: (v) => (/^\d{6,20}$/.test(v) ? null : "Please enter the account number using digits only."),
      },
    ],
    build: (d) =>
      d.kind === "link"
        ? d.link
        : `Pay to: ${d.accname}\nBank: ${d.bank}\nAccount number: ${d.account}`,
    summary: (d) =>
      d.kind === "link"
        ? `💳 Payment link\n${clip(d.link, 200)}`
        : `Account name: ${d.accname}\nBank: ${d.bank}\nAccount: ${d.account}`,
  },

  whatsapp: {
    title: "Your WhatsApp QR code is ready! 💬",
    steps: [
      {
        key: "number",
        prompt: "💬 WhatsApp number with country code, e.g. +2348012345678:",
        validate: (v) =>
          /^\+\d{7,15}$/.test(v.replace(/[\s\-().]/g, ""))
            ? null
            : "Please include the + and country code, e.g. +2348012345678.",
      },
      {
        key: "message",
        prompt: "✍️ Pre-filled message? (e.g. \"Hi, I'd like to place an order\")",
        optional: true,
        validate: validators.max(500),
      },
    ],
    build: (d) => {
      const digits = d.number.replace(/\D/g, "");
      return `https://wa.me/${digits}${d.message ? `?text=${encodeURIComponent(d.message)}` : ""}`;
    },
    summary: (d) =>
      [`WhatsApp: ${d.number}`, d.message && `Message: ${clip(d.message, 200)}`].filter(Boolean).join("\n") +
      "\n\nScan to start a chat.",
  },

  product: {
    title: "Your product QR code is ready! 🛍️",
    steps: [
      { key: "name", prompt: "🛍️ Product name?", validate: (v) => (v && v.length <= 100 ? null : "Please enter a name (up to 100 characters).") },
      { key: "price", prompt: "💰 Price? (e.g. ₦15,000)", optional: true, validate: validators.max(30) },
      { key: "description", prompt: "📝 Short description?", optional: true, validate: validators.max(300) },
      linkStep("link", "🔗 Link to the product page or order form?", { optional: true }),
    ],
    build: (d) => [d.name, d.price && `Price: ${d.price}`, d.description, d.link].filter(Boolean).join("\n"),
    summary: (d) => [`Product: ${d.name}`, d.price && `Price: ${d.price}`].filter(Boolean).join("\n"),
  },

  review: linkFlow(
    "Your review QR code is ready! ⭐",
    "⭐ Paste your Google review link (or any review page):",
    "⭐ Review page"
  ),

  // ----- Creators and freelancers -----
  social: {
    title: "Your social QR code is ready! 📱",
    steps: [
      {
        key: "platform",
        prompt: "📱 Which platform?",
        columns: 2,
        buttons: Object.entries(SOCIALS).map(([id, s]) => [s.name, id]),
        validate: (v) => (Object.prototype.hasOwnProperty.call(SOCIALS, v) ? null : "Please tap one of the buttons above."),
      },
      {
        key: "handle",
        prompt: "👤 Send the username (like @yourname) or the full profile link:",
        validate: (v) =>
          /^https?:\/\/\S+$/i.test(v) || /^@?[\w.\-]{1,60}$/.test(v)
            ? null
            : "Send a username like @yourname, or a full profile link.",
        transform: (v) => (/^https?:\/\//i.test(v) ? v : v.replace(/^@/, "")),
      },
    ],
    build: buildSocial,
    summary: (d) => `${SOCIALS[d.platform].name}\n${clip(buildSocial(d), 200)}\n\nScan to open the profile.`,
  },

  portfolio: linkFlow(
    "Your portfolio QR code is ready! 🎨",
    "🎨 Paste your portfolio or website link (Behance, Notion, Dribbble, your own site...):",
    "🎨 Portfolio"
  ),

  // ----- Everyone -----
  wifi: {
    title: "Your Wi-Fi QR code is ready! 📶",
    steps: [
      {
        key: "ssid",
        prompt: "📶 What's the Wi-Fi network name (SSID)?",
        validate: (v) => (v && v.length <= 32 ? null : "The network name must be 1 to 32 characters."),
      },
      {
        key: "security",
        prompt: "🔐 Choose the security type:",
        buttons: [
          ["WPA / WPA2 / WPA3", "WPA"],
          ["WEP", "WEP"],
          ["Open (no password)", "nopass"],
        ],
        validate: (v) => (["WPA", "WEP", "nopass"].includes(v) ? null : "Please tap one of the buttons above."),
      },
      {
        key: "password",
        prompt: "🔑 Enter the Wi-Fi password:",
        skip: (d) => d.security === "nopass",
        validate: validators.required("The password"),
      },
    ],
    build: (d) =>
      d.security === "nopass"
        ? `WIFI:T:nopass;S:${wifiEscape(d.ssid)};;`
        : `WIFI:T:${d.security};S:${wifiEscape(d.ssid)};P:${wifiEscape(d.password)};;`,
    // The password is deliberately not echoed back in the caption (or saved in the history summary)
    summary: (d) => `Network: ${d.ssid}\nSecurity: ${d.security === "nopass" ? "Open" : d.security}\n\nScan to join the network.`,
  },

  contact: {
    title: "Your contact QR code is ready! 👤",
    steps: [
      { key: "name", prompt: "👤 What's the contact's full name?", validate: (v) => (v && v.length <= 100 ? null : "Please enter a name (up to 100 characters).") },
      { key: "phone", prompt: "📞 Phone number?", optional: true, validate: validators.phone },
      { key: "email", prompt: "✉️ Email address?", optional: true, validate: validators.email },
      { key: "org", prompt: "🏢 Company or organization?", optional: true, validate: validators.max(100) },
      linkStep("url", "🌐 Website?", { optional: true }),
    ],
    build: (d) =>
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `N:${vcardEscape(d.name)};;;;`,
        `FN:${vcardEscape(d.name)}`,
        d.org && `ORG:${vcardEscape(d.org)}`,
        d.phone && `TEL:${vcardEscape(d.phone)}`,
        d.email && `EMAIL:${vcardEscape(d.email)}`,
        d.url && `URL:${d.url}`,
        "END:VCARD",
      ]
        .filter(Boolean)
        .join("\n"),
    summary: (d) =>
      [`Name: ${d.name}`, d.phone && `Phone: ${d.phone}`, d.email && `Email: ${d.email}`, d.org && `Company: ${d.org}`, d.url && `Website: ${d.url}`]
        .filter(Boolean)
        .join("\n"),
  },

  email: {
    title: "Your email QR code is ready! ✉️",
    steps: [
      { key: "to", prompt: "✉️ Who should the email be sent to?", validate: validators.email },
      { key: "subject", prompt: "📝 Subject line?", optional: true, validate: () => null },
      { key: "body", prompt: "💬 Message body?", optional: true, validate: () => null },
    ],
    build: (d) => {
      const params = [];
      if (d.subject) params.push(`subject=${encodeURIComponent(d.subject)}`);
      if (d.body) params.push(`body=${encodeURIComponent(d.body)}`);
      return `mailto:${d.to}${params.length ? "?" + params.join("&") : ""}`;
    },
    summary: (d) =>
      [`To: ${d.to}`, d.subject && `Subject: ${clip(d.subject, 100)}`].filter(Boolean).join("\n"),
  },

  sms: {
    title: "Your SMS QR code is ready! 💬",
    steps: [
      { key: "number", prompt: "📞 Which phone number should the text go to?", validate: validators.phone },
      { key: "message", prompt: "💬 Message text?", optional: true, validate: () => null },
    ],
    build: (d) => {
      const number = d.number.replace(/[^\d+]/g, "");
      return d.message ? `SMSTO:${number}:${d.message}` : `sms:${number}`;
    },
    summary: (d) =>
      [`To: ${d.number}`, d.message && `Message: ${clip(d.message, 200)}`].filter(Boolean).join("\n"),
  },

  // ----- Designers and marketers -----
  bulk: {
    steps: [
      {
        key: "items",
        prompt:
          `📦 Send up to ${MAX_BULK_ITEMS} items, one per line (links, text, phone numbers...). ` +
          "I'll send each one back as an HD PNG file, using your /style settings.",
        validate: (v) => {
          const lines = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (!lines.length) return "Please send at least one line.";
          if (lines.length > MAX_BULK_ITEMS) return `Please send at most ${MAX_BULK_ITEMS} lines at a time.`;
          if (lines.some((l) => l.length > MAX_BULK_ITEM_LENGTH)) {
            return `Each line must be under ${MAX_BULK_ITEM_LENGTH} characters.`;
          }
          return null;
        },
      },
    ],
    finish: (ctx, d) => sendBulk(ctx, d.items),
  },
};

function getFlow(userId) {
  const flow = flows.get(userId);
  if (!flow) return null;
  if (flow.expires < Date.now()) {
    flows.delete(userId);
    return null;
  }
  return flow;
}

async function startFlow(ctx, type) {
  awaitingLogo.delete(ctx.from.id);
  flows.set(ctx.from.id, { type, index: 0, data: {}, expires: Date.now() + FLOW_TTL_MS });
  return askNext(ctx);
}

async function askNext(ctx) {
  const flow = getFlow(ctx.from.id);
  if (!flow) return;
  const def = FLOW_DEFS[flow.type];

  // Skip steps that don't apply (e.g. no password for an open network)
  while (flow.index < def.steps.length && def.steps[flow.index].skip && def.steps[flow.index].skip(flow.data)) {
    flow.data[def.steps[flow.index].key] = "";
    flow.index++;
  }

  if (flow.index >= def.steps.length) {
    flows.delete(ctx.from.id);
    if (def.finish) return def.finish(ctx, flow.data);
    return sendQR(ctx, def.build(flow.data), {
      title: def.title,
      summary: def.summary(flow.data),
      kind: flow.type,
    });
  }

  const step = def.steps[flow.index];
  let text = step.prompt;
  if (step.optional) text += "\n\nOptional: send /skip to leave this blank.";
  text += "\nSend /cancel to stop.";

  const keyboard = step.buttons
    ? Markup.inlineKeyboard(
        chunk(
          step.buttons.map(([label, value]) => Markup.button.callback(label, `flow:${value}`)),
          step.columns || 1
        )
      )
    : undefined;

  return ctx.reply(text, keyboard);
}

async function acceptFlowValue(ctx, rawValue) {
  const flow = getFlow(ctx.from.id);
  if (!flow) return false;

  const step = FLOW_DEFS[flow.type].steps[flow.index];
  const value = rawValue.trim();
  const error = step.validate ? step.validate(value) : null;
  if (error) {
    await ctx.reply(error);
    return true;
  }

  flow.data[step.key] = step.transform ? step.transform(value) : value;
  flow.index++;
  flow.expires = Date.now() + FLOW_TTL_MS;
  await askNext(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Style settings
// ---------------------------------------------------------------------------
function styleView(settings) {
  const mark = (active) => (active ? "✅ " : "");

  const themeEntries = Object.entries(THEMES);
  const themeButtons = themeEntries.map(([id, t]) =>
    Markup.button.callback(`${mark(settings.theme === id)}${t.emoji} ${t.name}`, `style:theme:${id}`)
  );
  if (settings.custom) {
    themeButtons.push(Markup.button.callback(`${mark(settings.theme === "custom")}🎨 Custom`, "style:theme:custom"));
  }
  const sizeButtons = Object.entries(SIZES).map(([id, s]) =>
    Markup.button.callback(`${mark(settings.size === id)}${s.name}`, `style:size:${id}`)
  );
  const eclButtons = Object.keys(ECLS).map((id) =>
    Markup.button.callback(`${mark(settings.ecl === id)}${id}`, `style:ecl:${id}`)
  );
  const toggleButton = Markup.button.callback(
    `${settings.transparent ? "✅" : "⬜"} Transparent background`,
    "style:transparent"
  );

  const theme = resolveTheme(settings);
  const colourLine = settings.theme === "custom" ? `Custom (${theme.dark} on ${theme.light})` : theme.name;

  const text =
    "🎨 QR style\n\n" +
    `Colour: ${colourLine}\n` +
    `Size: ${SIZES[settings.size].name} (${SIZES[settings.size].px}px)\n` +
    `Error correction: ${settings.logo ? "H, forced by your logo" : `${settings.ecl}, ${ECLS[settings.ecl]}`}\n` +
    `Background: ${settings.transparent ? "Transparent" : "Solid"}\n` +
    `Logo: ${settings.logo ? "Added (/removelogo to remove)" : "None (/logo to add)"}\n\n` +
    "Tap to change. Applies to your next QR codes. Your style is saved.\n" +
    "Brand colours: /colors #hex #hex\n" +
    "Tip: transparent PNGs arrive as files so the background stays clear for flyers and posters.";

  const keyboard = Markup.inlineKeyboard([...chunk(themeButtons, 3), sizeButtons, eclButtons, [toggleButton]]);
  return { text, keyboard };
}

async function refreshStyle(ctx, settings) {
  const { text, keyboard } = styleView(settings);
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (error) {
    if (!/not modified/i.test(String(error && error.message))) throw error;
  }
}

// ---------------------------------------------------------------------------
// History views
// ---------------------------------------------------------------------------
const historyButtonLabel = (row) =>
  clip(`${kindEmoji(row.kind)} ${fmtDate(row.created_at)} · ${clip(row.summary.replace(/\s+/g, " ").trim(), 28)}`, 60);

async function historyView(userId, requestedPage) {
  const total = await countHistory(userId);
  if (!total) {
    return {
      text: "📜 Your history is empty.\n\nEvery QR code you create is saved here so you can reopen, download or print it later.",
      keyboard: undefined,
    };
  }

  const pages = Math.ceil(total / HISTORY_PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const rows = await listHistory(userId, HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);

  const buttons = rows.map((row) => [Markup.button.callback(historyButtonLabel(row), `h:open:${row.id}`)]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️ Newer", `hist:${page - 1}`));
  if (page < pages - 1) nav.push(Markup.button.callback("Older ▶️", `hist:${page + 1}`));
  if (nav.length) buttons.push(nav);

  const text =
    `📜 Your history: ${total} QR code${total === 1 ? "" : "s"} (page ${page + 1} of ${pages})\n\n` +
    "Tap one to open it again with download and print buttons.\n" +
    "Search with /history keyword, e.g. /history menu";

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

function printKeyboard(id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📄 Single A4 poster", `prm:single:${id}`)],
    [Markup.button.callback("🏷️ Sheet of 6 (table cards, stickers)", `prm:sheet6:${id}`)],
    [Markup.button.callback("🏷️ Sheet of 12 (small labels)", `prm:sheet12:${id}`)],
  ]);
}

function printPrompt() {
  return "🖨️ Choose a print layout. You'll get an A4 PDF at print quality.";
}

function describeActivity(row) {
  const d = row.details || {};
  switch (row.action) {
    case "command":
      return `Used /${d.command}`;
    case "qr_created":
      return `Created a ${kindLabel(d.kind)} QR code`;
    case "qr_reopened":
      return "Reopened a QR code from history";
    case "qr_downloaded":
      return `Downloaded ${String(d.format || "").toUpperCase()} file`;
    case "qr_printed":
      return `Printed (${PRINT_MODES[d.mode] ? PRINT_MODES[d.mode].name : d.mode})`;
    case "qr_deleted":
      return "Deleted a QR code from history";
    case "bulk":
      return `Bulk: ${d.count} QR codes`;
    case "scan":
      return d.found ? "Scanned a QR code" : "Scan attempted (nothing found)";
    case "logo_set":
      return "Added a logo";
    case "logo_removed":
      return "Removed the logo";
    case "style_changed":
      return `Changed style (${d.setting})`;
    case "colors_set":
      return "Saved brand colours";
    case "history_cleared":
      return "Cleared history";
    case "donation":
      return `Donated ${d.amount} Stars`;
    default:
      return row.action;
  }
}

// ---------------------------------------------------------------------------
// Middleware: keep the user record in sync, load saved settings, log commands
// ---------------------------------------------------------------------------
bot.use(async (ctx, next) => {
  const user = ctx.from;
  if (user && !user.is_bot) {
    try {
      const now = Date.now();
      const last = loadedUsers.get(user.id);
      if (!last || now - last > 10 * 60 * 1000) {
        await pool.query(
          `INSERT INTO users (id, username, first_name) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_seen = now()`,
          [user.id, user.username || null, user.first_name || null]
        );
        if (!last) {
          const { rows } = await pool.query("SELECT settings, logo FROM user_settings WHERE user_id = $1", [user.id]);
          if (rows[0]) {
            settingsByUser.set(user.id, { ...defaultSettings(), ...rows[0].settings, logo: rows[0].logo || null });
          }
        }
        loadedUsers.set(user.id, now);
      }

      const text = ctx.message && ctx.message.text;
      const command = text && /^\/(\w+)/.exec(text);
      if (command) logActivity(user.id, "command", { command: command[1].toLowerCase() });
    } catch (error) {
      // A database problem should degrade features, not stop the bot
      console.error("User sync failed:", error.message);
    }
  }
  return next();
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const HELP_TEXT =
  "🤖 Quick QR Generator\n\n" +
  "Send me text, a link, an email address or a phone number and I'll turn it into a QR code.\n\n" +
  "🏪 For businesses:\n" +
  "/menu - Link to your menu\n" +
  "/pay - Payment link or bank details\n" +
  "/whatsapp - Click-to-chat with a pre-filled message\n" +
  "/product - Product name, price and details\n" +
  "/review - Google review link\n" +
  "/contact - Contact card (vCard)\n\n" +
  "🎨 For designers and marketers:\n" +
  "/colors - Brand colours, e.g. /colors #1d4ed8 #ffffff\n" +
  "/logo - Put your logo in the centre\n" +
  "/style - Colour, size (up to 3000px), transparent background\n" +
  "/bulk - Up to 10 QR codes in one go\n\n" +
  "📱 For creators and freelancers:\n" +
  "/social - Instagram, TikTok, X, YouTube, LinkedIn and more\n" +
  "/portfolio - Portfolio or website link\n" +
  "/whatsapp - Let clients message you instantly\n" +
  "/contact - Share your details in one scan\n\n" +
  "📜 History and printing:\n" +
  "/history - Browse your past QR codes (or /history keyword to search)\n" +
  "/print - Print-ready A4 PDF of your latest QR code\n" +
  "/activity - Your recent activity\n" +
  "/clearhistory - Delete your saved QR history\n" +
  "/deletedata - Delete everything stored about you\n\n" +
  "Also:\n" +
  "/wifi - Wi-Fi network (scan to join)\n" +
  "/email - Pre-filled email\n" +
  "/sms - Pre-filled text message\n" +
  "/location - Share a location as a QR code\n" +
  "/text - Encode text exactly as typed\n" +
  "📷 Send me a photo of a QR code and I'll read it.\n" +
  "/cancel - Stop the current setup\n" +
  "/donate - Support this bot ❤️\n\n" +
  "Every QR code comes with buttons to download an HD PNG or SVG, or print it.";

bot.start((ctx) =>
  ctx.reply(
    "Welcome to Quick QR Generator! 👋\n\n" +
      "Send me any text, URL, email address or phone number and I'll generate a QR code for you.\n\n" +
      "Running a business? Try /menu, /pay or /whatsapp.\n" +
      "Designer or marketer? Try /colors, /logo or /bulk.\n" +
      "Creator or freelancer? Try /social or /portfolio.\n\n" +
      "Your QR codes are saved in /history so you can reopen or print them anytime.\n" +
      "You can also send me a photo of a QR code to scan it. Send /help to see everything I can do."
  )
);

bot.help((ctx) => ctx.reply(HELP_TEXT));

// Every guided flow gets a command with the same name (/wifi, /menu, /pay, ...)
for (const type of Object.keys(FLOW_DEFS)) {
  bot.command(type, (ctx) => startFlow(ctx, type));
}

bot.command("location", (ctx) =>
  ctx.reply("📍 Tap the 📎 attachment button, choose Location, and send me a location. I'll turn it into a QR code that opens in maps.")
);

bot.command("text", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/text(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return ctx.reply("Send it like this:\n/text your exact text here\n\nI'll encode it without turning links, emails or numbers into special formats.");
  }
  return sendQR(ctx, raw, { summary: `📝 Text\n${clip(raw)}`, kind: "text" });
});

bot.command(["colors", "colours"], async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);
  if (!args.length) {
    return ctx.reply(
      "🎨 Set your brand colours with hex codes:\n\n" +
        "/colors #1d4ed8 #ffffff\n\n" +
        "The first is the code colour, the second is the background (optional, defaults to white). " +
        "Dark on light scans best."
    );
  }

  const dark = normalizeHex(args[0]);
  const light = args[1] ? normalizeHex(args[1]) : "#ffffff";
  if (!dark || !light) {
    return ctx.reply("Colours must be 6-digit hex codes like #1d4ed8.");
  }

  const ratio = contrastRatio(dark, light);
  if (ratio < 3) {
    return ctx.reply(
      `Those colours are too close together (contrast ${ratio.toFixed(1)}:1) and many phones won't scan the code. ` +
        "Try a darker code colour or a lighter background."
    );
  }

  const settings = getSettings(ctx.from.id);
  settings.custom = { dark, light };
  settings.theme = "custom";
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "colors_set", { dark, light });

  let reply = `✅ Brand colours saved: ${dark} on ${light}. They apply to your next QR codes.`;
  if (luminance(dark) > luminance(light)) {
    reply += "\n\n⚠️ Your code is lighter than its background. Some older scanners can't read inverted codes, so test it first.";
  }
  return ctx.reply(reply);
});

bot.command("logo", (ctx) => {
  flows.delete(ctx.from.id);
  awaitingLogo.set(ctx.from.id, Date.now() + FLOW_TTL_MS);
  return ctx.reply(
    "🖼️ Send me your logo as an image. A square PNG sent as a file (not a compressed photo) looks best.\n\n" +
      "It will sit in the centre of your QR codes, and error correction switches to High automatically.\n" +
      "Send /cancel to stop."
  );
});

bot.command("removelogo", async (ctx) => {
  const settings = getSettings(ctx.from.id);
  if (!settings.logo) return ctx.reply("You don't have a logo saved.");
  settings.logo = null;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "logo_removed");
  return ctx.reply("Logo removed.");
});

bot.command("style", (ctx) => {
  const { text, keyboard } = styleView(getSettings(ctx.from.id));
  return ctx.reply(text, keyboard);
});

bot.command("cancel", (ctx) => {
  const hadFlow = flows.delete(ctx.from.id);
  const hadLogo = awaitingLogo.delete(ctx.from.id);
  if (hadFlow || hadLogo) return ctx.reply("Cancelled. Send me anything to make a QR code.");
  return ctx.reply("Nothing to cancel right now.");
});

bot.command("skip", async (ctx) => {
  const flow = getFlow(ctx.from.id);
  if (!flow) return ctx.reply("Nothing to skip right now.");

  const step = FLOW_DEFS[flow.type].steps[flow.index];
  if (!step.optional) return ctx.reply("This step is required. Please send a value, or /cancel to stop.");

  flow.data[step.key] = "";
  flow.index++;
  flow.expires = Date.now() + FLOW_TTL_MS;
  return askNext(ctx);
});

// ----- History, print, activity, privacy -----
bot.command("history", async (ctx) => {
  const term = ctx.message.text.replace(/^\/history(@\w+)?\s*/i, "").trim();

  if (term) {
    const rows = await searchHistory(ctx.from.id, term.slice(0, 50), SEARCH_LIMIT);
    if (!rows.length) return ctx.reply(`No saved QR codes match "${clip(term, 50)}".`);
    const buttons = rows.map((row) => [Markup.button.callback(historyButtonLabel(row), `h:open:${row.id}`)]);
    return ctx.reply(
      `🔎 ${rows.length} result${rows.length === 1 ? "" : "s"} for "${clip(term, 50)}". Tap one to open it:`,
      Markup.inlineKeyboard(buttons)
    );
  }

  const { text, keyboard } = await historyView(ctx.from.id, 0);
  return ctx.reply(text, keyboard);
});

bot.command("print", async (ctx) => {
  const [latest] = await listHistory(ctx.from.id, 1, 0);
  if (!latest) return ctx.reply("You don't have any saved QR codes yet. Create one first, then use /print.");
  return ctx.reply(
    `${printPrompt()}\n\nLatest QR code: ${kindEmoji(latest.kind)} ${fmtDate(latest.created_at)}\n` +
      "To print an older one, open it from /history and tap Print.",
    printKeyboard(latest.id)
  );
});

bot.command("activity", async (ctx) => {
  const { rows } = await pool.query(
    `SELECT action, details, created_at FROM activity_log
     WHERE user_id = $1 AND NOT (action = 'command' AND details->>'command' = 'activity')
     ORDER BY id DESC LIMIT $2`,
    [ctx.from.id, ACTIVITY_LIMIT]
  );
  if (!rows.length) return ctx.reply("No activity recorded yet.");
  const lines = rows.map((row) => `${fmtDate(row.created_at)} · ${describeActivity(row)}`);
  return ctx.reply(`🕑 Your last ${rows.length} actions:\n\n${lines.join("\n")}`);
});

bot.command("clearhistory", async (ctx) => {
  const total = await countHistory(ctx.from.id);
  if (!total) return ctx.reply("Your history is already empty.");
  return ctx.reply(
    `Delete all ${total} saved QR code${total === 1 ? "" : "s"} from your history? This can't be undone.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🗑️ Yes, delete history", "h:clearyes"), Markup.button.callback("Keep it", "h:no")],
    ])
  );
});

bot.command("deletedata", (ctx) =>
  ctx.reply(
    "This permanently deletes everything stored about you: your QR history, activity log, saved style and logo. This can't be undone.",
    Markup.inlineKeyboard([
      [Markup.button.callback("⚠️ Delete everything", "h:wipeyes"), Markup.button.callback("Cancel", "h:no")],
    ])
  )
);

// ---------------------------------------------------------------------------
// Button callbacks
// ---------------------------------------------------------------------------
bot.action(/^flow:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!getFlow(ctx.from.id)) {
    return ctx.reply("That setup has expired. Please start again.");
  }
  try {
    await ctx.editMessageReplyMarkup(undefined); // remove the buttons once used
  } catch (_) {
    /* message may already be edited, ignore */
  }
  return acceptFlowValue(ctx, ctx.match[1]);
});

bot.action(/^style:(theme|size|ecl):(\w+)$/, async (ctx) => {
  const [, kind, value] = ctx.match;
  const settings = getSettings(ctx.from.id);
  const options = { theme: THEMES, size: SIZES, ecl: ECLS }[kind];

  const valid =
    kind === "theme" && value === "custom"
      ? Boolean(settings.custom)
      : Object.prototype.hasOwnProperty.call(options, value);
  if (!valid) return ctx.answerCbQuery("Unknown option.");

  settings[kind] = value;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "style_changed", { setting: kind, value });
  await ctx.answerCbQuery("Saved ✅");
  await refreshStyle(ctx, settings);
});

bot.action("style:transparent", async (ctx) => {
  const settings = getSettings(ctx.from.id);
  settings.transparent = !settings.transparent;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "style_changed", { setting: "transparent", value: settings.transparent });
  await ctx.answerCbQuery("Saved ✅");
  await refreshStyle(ctx, settings);
});

// Downloads read from the database, so they keep working after restarts
bot.action(/^dl:(png|svg):(\d+)$/, async (ctx) => {
  const format = ctx.match[1];
  const entry = await getHistoryEntry(ctx.from.id, Number(ctx.match[2]));

  if (!entry) {
    return ctx.answerCbQuery("This QR code is no longer in your history. Please generate it again.", { show_alert: true });
  }

  await ctx.answerCbQuery("Preparing your file…");
  const settings = entrySettings(entry, ctx.from.id);

  try {
    if (format === "png") {
      const width = Math.max(SIZES.large.px, SIZES[settings.size].px);
      const png = await renderPng(entry.payload, settings, width);
      await ctx.replyWithDocument({ source: png, filename: "qr-code-hd.png" });
    } else {
      const svg = await renderSvg(entry.payload, settings);
      await ctx.replyWithDocument({ source: Buffer.from(svg, "utf8"), filename: "qr-code.svg" });
    }
    logActivity(ctx.from.id, "qr_downloaded", { format, history_id: Number(entry.id) });
  } catch (error) {
    console.error("QR download failed:", error);
    await ctx.reply("Sorry, I couldn't prepare that file.");
  }
});

// Buttons on messages created before history existed
bot.action(/^dl:(png|svg)$/, (ctx) =>
  ctx.answerCbQuery("This is an old button. Please generate the QR code again.", { show_alert: true })
);

bot.action(/^pr:(\d+)$/, async (ctx) => {
  const entry = await getHistoryEntry(ctx.from.id, Number(ctx.match[1]));
  if (!entry) {
    return ctx.answerCbQuery("This QR code is no longer in your history.", { show_alert: true });
  }
  await ctx.answerCbQuery();
  return ctx.reply(printPrompt(), printKeyboard(entry.id));
});

bot.action(/^prm:(single|sheet6|sheet12):(\d+)$/, async (ctx) => {
  const modeId = ctx.match[1];
  const entry = await getHistoryEntry(ctx.from.id, Number(ctx.match[2]));
  if (!entry) {
    return ctx.answerCbQuery("This QR code is no longer in your history.", { show_alert: true });
  }

  await ctx.answerCbQuery("Building your PDF…");
  try {
    await ctx.sendChatAction("upload_document");
    const pdf = await renderPrintPdf(entry, entrySettings(entry, ctx.from.id), modeId);
    await ctx.replyWithDocument(
      { source: pdf, filename: `qr-print-${modeId}.pdf` },
      { caption: `🖨️ ${PRINT_MODES[modeId].name}: print at 100% scale (no "fit to page") for the sharpest result.` }
    );
    logActivity(ctx.from.id, "qr_printed", { mode: modeId, history_id: Number(entry.id) });
  } catch (error) {
    console.error("Print PDF failed:", error);
    await ctx.reply("Sorry, I couldn't build that PDF.");
  }
});

bot.action(/^hist:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const { text, keyboard } = await historyView(ctx.from.id, Number(ctx.match[1]));
  logActivity(ctx.from.id, "history_viewed", { page: Number(ctx.match[1]) });

  // Tapping "History" under a QR code sends a new message; paging inside the list edits it in place
  const isListMessage = ctx.callbackQuery.message && ctx.callbackQuery.message.text && ctx.callbackQuery.message.text.startsWith("📜");
  if (isListMessage) {
    try {
      return await ctx.editMessageText(text, keyboard);
    } catch (error) {
      if (/not modified/i.test(String(error && error.message))) return;
      throw error;
    }
  }
  return ctx.reply(text, keyboard);
});

bot.action(/^h:open:(\d+)$/, async (ctx) => {
  const entry = await getHistoryEntry(ctx.from.id, Number(ctx.match[1]));
  if (!entry) {
    return ctx.answerCbQuery("That QR code was deleted.", { show_alert: true });
  }

  await ctx.answerCbQuery();
  try {
    await ctx.sendChatAction("upload_photo");
    await deliverQR(
      ctx,
      {
        id: Number(entry.id),
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        payload: entry.payload,
        settings: entrySettings(entry, ctx.from.id),
      },
      { reopened: true }
    );
    logActivity(ctx.from.id, "qr_reopened", { history_id: Number(entry.id) });
  } catch (error) {
    console.error("Reopening QR failed:", error);
    await ctx.reply("Sorry, I couldn't reopen that QR code.");
  }
});

bot.action(/^h:del:(\d+)$/, async (ctx) => {
  const deleted = await deleteHistoryEntry(ctx.from.id, Number(ctx.match[1]));
  await ctx.answerCbQuery(deleted ? "Deleted from history 🗑️" : "Already deleted.");
  if (deleted) {
    logActivity(ctx.from.id, "qr_deleted", { history_id: Number(ctx.match[1]) });
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (_) {
      /* ignore */
    }
  }
});

bot.action("h:clearyes", async (ctx) => {
  const result = await pool.query("DELETE FROM qr_history WHERE user_id = $1", [ctx.from.id]);
  logActivity(ctx.from.id, "history_cleared", { count: result.rowCount });
  await ctx.answerCbQuery("History cleared");
  try {
    await ctx.editMessageText(`🗑️ Deleted ${result.rowCount} QR code${result.rowCount === 1 ? "" : "s"} from your history.`);
  } catch (_) {
    /* ignore */
  }
});

bot.action("h:wipeyes", async (ctx) => {
  // Deleting the user row cascades to settings, history and activity
  await pool.query("DELETE FROM users WHERE id = $1", [ctx.from.id]);
  settingsByUser.delete(ctx.from.id);
  loadedUsers.delete(ctx.from.id);
  flows.delete(ctx.from.id);
  awaitingLogo.delete(ctx.from.id);
  await ctx.answerCbQuery("Everything deleted");
  try {
    await ctx.editMessageText("✅ All your stored data has been deleted. You can keep using the bot, and new activity will be saved again.");
  } catch (_) {
    /* ignore */
  }
});

bot.action("h:no", async (ctx) => {
  await ctx.answerCbQuery("Okay, nothing was deleted.");
  try {
    await ctx.editMessageText("Okay, nothing was deleted.");
  } catch (_) {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Donations
// ---------------------------------------------------------------------------
// Option 1: Telegram Stars (built in, no payment provider needed)
// Option 2: an external link (Paystack, Flutterwave, Buy Me a Coffee, etc.)
//           set DONATE_LINK in your .env to show it as a button
const DONATE_LINK = process.env.DONATE_LINK;
const STAR_AMOUNTS = [25, 50, 100, 250];

bot.command("donate", (ctx) => {
  const rows = [STAR_AMOUNTS.map((n) => Markup.button.callback(`⭐ ${n}`, `donate:${n}`))];

  if (DONATE_LINK) {
    rows.push([Markup.button.url("💳 Donate by card or bank transfer", DONATE_LINK)]);
  }

  return ctx.reply(
    "❤️ Quick QR Generator is free to use. If it's useful to you, you can support its running costs and future features.\n\n" +
      "Pick an amount in Telegram Stars below" +
      (DONATE_LINK ? ", or use the card/bank option." : "."),
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/^donate:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match[1]);
  if (!STAR_AMOUNTS.includes(amount)) return ctx.answerCbQuery("Unknown amount.");

  await ctx.answerCbQuery();
  return ctx.replyWithInvoice({
    title: "Support Quick QR Generator",
    description: `Donate ${amount} Stars to keep this bot free and running.`,
    payload: `donation:${amount}`,
    provider_token: "", // must be empty for Telegram Stars
    currency: "XTR", // XTR = Telegram Stars
    prices: [{ label: "Donation", amount }], // Stars invoices take exactly one price item
  });
});

// Telegram requires you to approve the checkout within 10 seconds
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on(message("successful_payment"), (ctx) => {
  const payment = ctx.message.successful_payment;
  console.log(`Donation received: ${payment.total_amount} ${payment.currency} from user ${ctx.from.id}`);
  logActivity(ctx.from.id, "donation", { amount: payment.total_amount, currency: payment.currency });
  return ctx.reply("🙏 Thank you so much for your support! It really helps keep this bot running.");
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
bot.on("location", (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  return sendQR(ctx, `https://maps.google.com/?q=${latitude},${longitude}`, {
    title: "Your location QR code is ready! 📍",
    summary: `Latitude: ${latitude}\nLongitude: ${longitude}\n\nScan to open in maps.`,
    kind: "location",
  });
});

bot.on("photo", (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  if (takeLogoRequest(ctx.from.id)) return saveLogo(ctx, fileId);
  return scanImage(ctx, fileId);
});

bot.on("document", (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.startsWith("image/")) {
    return ctx.reply("I can only read image files. Send a photo or image of a QR code, or send text to create one.");
  }
  if (doc.file_size && doc.file_size > MAX_IMAGE_BYTES) {
    return ctx.reply("That image is too large. Please send one under 10 MB.");
  }
  if (takeLogoRequest(ctx.from.id)) return saveLogo(ctx, doc.file_id);
  return scanImage(ctx, doc.file_id);
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    return ctx.reply("I don't know that command. Send /help to see what I can do.");
  }

  // If the user is in the middle of a guided setup, treat this as their answer
  if (await acceptFlowValue(ctx, text)) return;

  if (!text) {
    return ctx.reply("Please send some text or a URL.");
  }

  const { payload, label, kind } = detectContent(text);
  return sendQR(ctx, payload, { summary: `${label}\n${clip(payload)}`, kind });
});

// ---------------------------------------------------------------------------
// Errors, startup and shutdown
// ---------------------------------------------------------------------------
bot.catch(async (error, ctx) => {
  console.error(`Update ${ctx.update.update_id} failed:`, error);
  try {
    await ctx.reply("Something went wrong. Please try again.");
  } catch (_) {
    /* nothing more we can do */
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function setupBotProfile() {
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    await bot.telegram.setMyDescription(BOT_DESCRIPTION);
    await bot.telegram.setMyShortDescription(BOT_SHORT_DESCRIPTION);
  } catch (error) {
    // Non-fatal: the bot works fine without this, you can also set these via @BotFather
    console.warn("Could not update bot profile:", error.message);
  }
}

async function main() {
  await initDb(); // creates the tables on first run
  const me = await bot.telegram.getMe(); // also validates the token
  await setupBotProfile();

  if (RETENTION_DAYS) {
    pruneOldHistory();
    setInterval(pruneOldHistory, 24 * 60 * 60 * 1000).unref();
  }

  bot.launch().catch((error) => {
    console.error("Bot stopped unexpectedly:", error);
    process.exit(1);
  });

  console.log(`QR bot @${me.username} is running!`);
}

main().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});

async function shutdown(signal) {
  try {
    bot.stop(signal);
  } finally {
    await pool.end().catch(() => {});
  }
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));