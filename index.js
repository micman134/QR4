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

const MAX_TEXT_LENGTH = 2000;
const COOLDOWN_MS = 1500;
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BULK_ITEMS = 10;
const MAX_BULK_ITEM_LENGTH = 500;
const HISTORY_PAGE_SIZE = 5;
const SEARCH_LIMIT = 10;
const ACTIVITY_LIMIT = 15;
const RETENTION_DAYS = Number(process.env.HISTORY_RETENTION_DAYS) || 0; // 0 = keep forever
const DISPLAY_TZ = process.env.DISPLAY_TZ || "Africa/Lagos";

// ----- Daily limits, free trials and Pro (paid with Telegram Stars) -----
// LIMITS[feature] = [free per day, Pro per day]. Counters reset at midnight in DISPLAY_TZ.
const LIMITS = {
  qr: [Number(process.env.LIMIT_QR_FREE) || 20, Number(process.env.LIMIT_QR_PRO) || 200],
  scan: [Number(process.env.LIMIT_SCAN_FREE) || 10, Number(process.env.LIMIT_SCAN_PRO) || 100],
  print: [Number(process.env.LIMIT_PRINT_FREE) || 5, Number(process.env.LIMIT_PRINT_PRO) || 50],
  download: [Number(process.env.LIMIT_DOWNLOAD_FREE) || 10, Number(process.env.LIMIT_DOWNLOAD_PRO) || 100],
  bulk: [0, Number(process.env.LIMIT_BULK_PRO) || 20], // free users use trials instead
};
const FEATURE_LABELS = {
  qr: "QR codes",
  scan: "Scans",
  print: "Print PDFs",
  download: "Downloads",
  bulk: "Bulk runs",
};
// Lifetime free trials before Stars are requested
const TRIALS = {
  bulk: Number(process.env.TRIALS_BULK) || 3,
  logo: Number(process.env.TRIALS_LOGO) || 3,
};
const PRO_STARS = Number(process.env.PRO_PRICE_STARS) || 150;
const PRO_DAYS = Number(process.env.PRO_DAYS) || 30;

const THEMES = {
  classic: { name: "Classic", emoji: "⚫", dark: "#000000", light: "#ffffff" },
  blue: { name: "Blue", emoji: "🔵", dark: "#1d4ed8", light: "#ffffff" },
  green: { name: "Green", emoji: "🟢", dark: "#15803d", light: "#ffffff" },
  purple: { name: "Purple", emoji: "🟣", dark: "#7e22ce", light: "#ffffff" },
  red: { name: "Red", emoji: "🔴", dark: "#b91c1c", light: "#ffffff" },
};

// Colour picker swatches (hex values are checked for contrast before they are applied)
const CODE_COLORS = [
  { e: "⚫", name: "Black", hex: "#000000" },
  { e: "🔵", name: "Blue", hex: "#1d4ed8" },
  { e: "🟢", name: "Green", hex: "#15803d" },
  { e: "🟣", name: "Purple", hex: "#7e22ce" },
  { e: "🔴", name: "Red", hex: "#b91c1c" },
  { e: "🟠", name: "Orange", hex: "#c2410c" },
  { e: "🟤", name: "Brown", hex: "#78350f" },
  { e: "🔷", name: "Navy", hex: "#1e3a8a" },
];
const BG_COLORS = [
  { e: "⬜", name: "White", hex: "#ffffff" },
  { e: "🟨", name: "Cream", hex: "#fef9c3" },
  { e: "🟦", name: "Sky", hex: "#dbeafe" },
  { e: "🟩", name: "Mint", hex: "#dcfce7" },
  { e: "🟪", name: "Lilac", hex: "#f3e8ff" },
  { e: "🟥", name: "Rose", hex: "#fee2e2" },
  { e: "🟧", name: "Peach", hex: "#ffedd5" },
];
const swatchName = (list, hex) => {
  const found = list.find((c) => c.hex === hex);
  return found ? `${found.e} ${found.name}` : hex;
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

const PRINT_MODES = {
  single: { name: "Single A4 poster" },
  sheet6: { name: "Sheet of 6", cols: 2, rows: 3 },
  sheet12: { name: "Sheet of 12", cols: 3, rows: 4 },
};

// Telegram limits: description 512 characters, short description 120 characters
const BOT_DESCRIPTION =
  "QR codes for menus, payments, Wi-Fi, contacts, WhatsApp, social profiles and more. Send a link or text, or tap a button.\n\n" +
  "Brand colours, your logo, transparent PNG, SVG, print-ready PDFs and bulk export. Your history is saved.\n\n" +
  "Tap Start. No sign-up needed.";

const BOT_SHORT_DESCRIPTION =
  "QR codes for menus, payments, WhatsApp, socials and more. Logos, SVG, print PDFs.";

// Short descriptions (about 25 characters) so the list looks clean on mobile
const BOT_COMMANDS = [
  { command: "start", description: "Open the main menu" },
  { command: "help", description: "All features" },
  { command: "plan", description: "My plan and limits" },
  { command: "history", description: "My past QR codes" },
  { command: "print", description: "Print-ready PDF" },
  { command: "menu", description: "Menu link QR" },
  { command: "pay", description: "Payment QR" },
  { command: "whatsapp", description: "WhatsApp chat QR" },
  { command: "product", description: "Product QR" },
  { command: "review", description: "Review link QR" },
  { command: "social", description: "Social profile QR" },
  { command: "portfolio", description: "Portfolio QR" },
  { command: "contact", description: "Contact card QR" },
  { command: "wifi", description: "Wi-Fi QR" },
  { command: "email", description: "Email QR" },
  { command: "sms", description: "SMS QR" },
  { command: "location", description: "Location QR" },
  { command: "text", description: "Exact text QR" },
  { command: "bulk", description: "Up to 10 QR codes" },
  { command: "colors", description: "Pick brand colours" },
  { command: "logo", description: "Add your logo" },
  { command: "style", description: "Colour, size, logo" },
  { command: "activity", description: "Recent activity" },
  { command: "clearhistory", description: "Delete my history" },
  { command: "deletedata", description: "Delete my data" },
  { command: "donate", description: "Support the bot ❤️" },
  { command: "cancel", description: "Cancel current setup" },
];

// ---------------------------------------------------------------------------
// Database (PostgreSQL)
// ---------------------------------------------------------------------------
// usage_daily and user_plan intentionally have no foreign key to users, so
// /deletedata cannot be used to reset free trials or lose a paid Pro plan.
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

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id     BIGINT NOT NULL,
  day         DATE NOT NULL,
  feature     TEXT NOT NULL,
  used        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, feature)
);

CREATE TABLE IF NOT EXISTS user_plan (
  user_id     BIGINT PRIMARY KEY,
  pro_until   TIMESTAMPTZ,
  trials      JSONB NOT NULL DEFAULT '{}'::jsonb
);
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

async function pruneUsage() {
  try {
    await pool.query("DELETE FROM usage_daily WHERE day < (now() - interval '7 days')::date");
  } catch (error) {
    console.error("Usage cleanup failed:", error.message);
  }
}

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
// Plans, daily limits and trials
// ---------------------------------------------------------------------------
const todayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ }); // YYYY-MM-DD

async function getPlan(userId) {
  try {
    const { rows } = await pool.query("SELECT pro_until, trials FROM user_plan WHERE user_id = $1", [userId]);
    const row = rows[0];
    const proUntil = row && row.pro_until ? new Date(row.pro_until) : null;
    return {
      proUntil,
      pro: Boolean(proUntil && proUntil > new Date()),
      trials: (row && row.trials) || {},
    };
  } catch (error) {
    console.error("getPlan failed:", error.message);
    return { proUntil: null, pro: false, trials: {} };
  }
}

async function getUsage(userId) {
  try {
    const { rows } = await pool.query("SELECT feature, used FROM usage_daily WHERE user_id = $1 AND day = $2::date", [
      userId,
      todayKey(),
    ]);
    return Object.fromEntries(rows.map((r) => [r.feature, r.used]));
  } catch (error) {
    console.error("getUsage failed:", error.message);
    return {};
  }
}

// Fails open: a database hiccup should not block people from using the bot
async function checkQuota(userId, feature) {
  const plan = await getPlan(userId);
  const limit = LIMITS[feature][plan.pro ? 1 : 0];
  const usage = await getUsage(userId);
  const used = usage[feature] || 0;
  return { ok: used < limit, used, limit, pro: plan.pro };
}

async function bumpUsage(userId, feature) {
  try {
    await pool.query(
      `INSERT INTO usage_daily (user_id, day, feature, used) VALUES ($1, $2::date, $3, 1)
       ON CONFLICT (user_id, day, feature) DO UPDATE SET used = usage_daily.used + 1`,
      [userId, todayKey(), feature]
    );
  } catch (error) {
    console.error("bumpUsage failed:", error.message);
  }
}

async function useTrial(userId, feature) {
  try {
    await pool.query(
      `INSERT INTO user_plan (user_id, trials) VALUES ($1, jsonb_build_object($2::text, 1))
       ON CONFLICT (user_id) DO UPDATE SET trials = jsonb_set(
         user_plan.trials, ARRAY[$2::text],
         to_jsonb(COALESCE((user_plan.trials->>$2)::int, 0) + 1))`,
      [userId, feature]
    );
  } catch (error) {
    console.error("useTrial failed:", error.message);
  }
}

async function grantPro(userId, days) {
  const { rows } = await pool.query(
    `INSERT INTO user_plan (user_id, pro_until) VALUES ($1, now() + ($2 || ' days')::interval)
     ON CONFLICT (user_id) DO UPDATE SET pro_until =
       GREATEST(COALESCE(user_plan.pro_until, now()), now()) + ($2 || ' days')::interval
     RETURNING pro_until`,
    [userId, String(days)]
  );
  return new Date(rows[0].pro_until);
}

const trialsLeft = (plan, feature) => Math.max(0, TRIALS[feature] - (plan.trials[feature] || 0));

function proKeyboard(extra = []) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`⭐ Get Pro · ${PRO_STARS} Stars`, "buy:pro")],
    [Markup.button.callback("📊 My plan", "go:plan"), ...extra],
  ]);
}

function replyLimit(ctx, feature, q) {
  const text =
    `⏳ Daily limit reached\n\n${FEATURE_LABELS[feature]}: ${q.used}/${q.limit} today.\n` +
    `Resets at midnight (${DISPLAY_TZ}).` +
    (q.pro ? "" : `\n\n⭐ Pro gives you up to ${LIMITS[feature][1]} per day.`);
  return q.pro ? ctx.reply(text, homeButton()) : ctx.reply(text, proKeyboard());
}

function trialPaywall(ctx, feature) {
  const name = feature === "bulk" ? "bulk" : "logo";
  return ctx.reply(
    `🔒 Your ${TRIALS[feature]} free ${name} trials are used up.\n\n` +
      `⭐ Pro (${PRO_STARS} Stars, ${PRO_DAYS} days) unlocks unlimited logo, bulk and higher daily limits.`,
    proKeyboard()
  );
}

// Decides whether the user may run bulk now. Replies with a paywall or limit message when not.
async function checkBulkAccess(ctx) {
  const plan = await getPlan(ctx.from.id);
  if (plan.pro) {
    const q = await checkQuota(ctx.from.id, "bulk");
    if (!q.ok) {
      await replyLimit(ctx, "bulk", q);
      return { ok: false };
    }
    return { ok: true, pro: true };
  }
  if (trialsLeft(plan, "bulk") <= 0) {
    await trialPaywall(ctx, "bulk");
    return { ok: false };
  }
  return { ok: true, pro: false, left: trialsLeft(plan, "bulk") };
}

// Applies the logo trial rules to a settings copy. Free users without trials left get no logo.
async function gateLogo(userId, settings) {
  if (!settings.logo) return { state: "none" };
  const plan = await getPlan(userId);
  if (plan.pro) return { state: "pro" };
  if (trialsLeft(plan, "logo") <= 0) {
    settings.logo = null;
    return { state: "exhausted" };
  }
  return { state: "trial", left: trialsLeft(plan, "logo") };
}

async function planView(userId) {
  const plan = await getPlan(userId);
  const usage = await getUsage(userId);
  const features = plan.pro ? ["qr", "scan", "print", "download", "bulk"] : ["qr", "scan", "print", "download"];
  const lines = features.map((f) => `${FEATURE_LABELS[f]}: ${usage[f] || 0}/${LIMITS[f][plan.pro ? 1 : 0]}`);

  let text =
    `📊 Your plan: ${plan.pro ? `⭐ Pro until ${fmtDate(plan.proUntil)}` : "Free"}\n\n` +
    `Today (resets at midnight):\n${lines.join("\n")}`;

  if (plan.pro) {
    text += "\n\nLogo and bulk: unlimited ✅";
  } else {
    text +=
      `\n\n🎁 Free trials left:\nBulk: ${trialsLeft(plan, "bulk")}/${TRIALS.bulk}\n` +
      `Logo: ${trialsLeft(plan, "logo")}/${TRIALS.logo}`;
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`⭐ ${plan.pro ? "Extend Pro" : "Get Pro"} · ${PRO_STARS} Stars`, "buy:pro")],
    [Markup.button.callback("🏠 Home", "go:home")],
  ]);
  return { text, keyboard };
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const settingsByUser = new Map();
const flows = new Map();
const lastActionAt = new Map();
const awaitingLogo = new Map();
const awaitingHex = new Map();
const loadedUsers = new Map();

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

function takeFlag(map, userId) {
  const expires = map.get(userId);
  if (!expires) return false;
  map.delete(userId);
  return expires > Date.now();
}
const takeLogoRequest = (userId) => takeFlag(awaitingLogo, userId);
const takeHexRequest = (userId) => takeFlag(awaitingHex, userId);

function clearPending(userId) {
  const had = flows.delete(userId) | awaitingLogo.delete(userId) | awaitingHex.delete(userId);
  return Boolean(had);
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, flow] of flows) {
    if (flow.expires < now) flows.delete(userId);
  }
  for (const map of [awaitingLogo, awaitingHex]) {
    for (const [userId, expires] of map) {
      if (expires < now) map.delete(userId);
    }
  }
  for (const [userId, time] of lastActionAt) {
    if (now - time > 60 * 60 * 1000) lastActionAt.delete(userId);
  }
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

const ascii = (text) => String(text).replace(/[^\x20-\x7E]/g, "").trim();

const fmtDate = (date) =>
  new Date(date).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TZ,
  });

const homeButton = () => Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "go:home")]]);

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
  const png = await renderPng(entry.payload, { ...settings, transparent: false }, 1600);
  const label = ascii(kindLabel(entry.kind)) || "QR code";
  const today = new Date().toISOString().slice(0, 10);

  return buildPdf((doc) => {
    const W = doc.page.width;
    const H = doc.page.height;

    if (modeId === "single") {
      const size = 340;
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
      Markup.button.callback("📄 HD PNG", `dl:png:${id}`),
      Markup.button.callback("🧩 SVG", `dl:svg:${id}`),
    ],
    [Markup.button.callback("🖨️ Print", `pr:${id}`), Markup.button.callback("📜 History", "hist:0")],
    [Markup.button.callback("🎨 Style", "go:style"), Markup.button.callback("➕ New QR", "go:home")],
  ];
  if (reopened) rows.push([Markup.button.callback("🗑️ Delete from history", `h:del:${id}`)]);
  return Markup.inlineKeyboard(rows);
}

async function deliverQR(ctx, entry, { reopened = false } = {}) {
  const png = await renderPng(entry.payload, entry.settings);

  const extra = {
    caption: buildCaption(entry.title, entry.summary, entry.payload, entry.settings),
    parse_mode: "HTML",
  };
  if (entry.id) extra.reply_markup = qrKeyboard(entry.id, { reopened }).reply_markup;

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

  const uid = ctx.from.id;
  const quota = await checkQuota(uid, "qr");
  if (!quota.ok) return replyLimit(ctx, "qr", quota);

  const settings = { ...getSettings(uid) };
  const gate = await gateLogo(uid, settings); // may remove the logo when free trials are used up
  let id = null;

  try {
    await ctx.sendChatAction("upload_photo");

    id = await addHistory(uid, { kind, title, summary, payload, settings }).catch((error) => {
      console.error("Saving history failed:", error.message);
      return null;
    });

    await deliverQR(ctx, { id, kind, title, summary, payload, settings });
    await bumpUsage(uid, "qr");
    logActivity(uid, "qr_created", { kind, history_id: id });

    if (gate.state === "trial") {
      await useTrial(uid, "logo");
      const left = gate.left - 1;
      const note = `🖼 Logo trial used. ${left} of ${TRIALS.logo} left.`;
      await ctx.reply(left > 0 ? note : `${note}\nThat was your last free one.`, left > 0 ? undefined : proKeyboard());
    } else if (gate.state === "exhausted") {
      await ctx.reply("🔒 Free logo trials are used up, so this code has no logo.", proKeyboard());
    }
  } catch (error) {
    console.error("QR generation failed:", error);
    if (id) deleteHistoryEntry(uid, id).catch(() => {});
    if (/too big|capacity/i.test(String(error && error.message))) {
      await ctx.reply(
        "That's too much data for a QR code at your current accuracy setting. " +
          "Try shorter content, lower the accuracy in /style, or remove your logo.",
        Markup.inlineKeyboard([[Markup.button.callback("🎨 Open style", "go:style")]])
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

  const uid = ctx.from.id;
  const access = await checkBulkAccess(ctx);
  if (!access.ok) return;

  const settings = { ...getSettings(uid) };
  await gateLogo(uid, settings); // bulk has its own trial, so a logo is only dropped if trials are gone
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

    let trialNote = "";
    if (access.pro) {
      await bumpUsage(uid, "bulk");
    } else {
      await useTrial(uid, "bulk");
      const left = access.left - 1;
      trialNote = `\n\n🎁 Bulk trial used. ${left} of ${TRIALS.bulk} left.`;
    }

    await ctx.reply(
      `✅ ${files.length} QR code${files.length === 1 ? "" : "s"} ready, in the order you sent them.\n` +
        "Saved in /history." +
        trialNote,
      access.pro || access.left - 1 > 0
        ? Markup.inlineKeyboard([
            [Markup.button.callback("📜 History", "hist:0"), Markup.button.callback("📦 Bulk again", "go:bulk")],
            [Markup.button.callback("🏠 Home", "go:home")],
          ])
        : proKeyboard([Markup.button.callback("🏠 Home", "go:home")])
    );

    for (const item of items) {
      await addHistory(uid, {
        kind: item.kind,
        title: "Bulk QR code",
        summary: `${kindEmoji(item.kind)} ${clip(item.line, 200)}`,
        payload: item.payload,
        settings,
      }).catch((error) => console.error("Saving bulk history failed:", error.message));
    }
    logActivity(uid, "bulk", { count: files.length });
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

  const quota = await checkQuota(ctx.from.id, "scan");
  if (!quota.ok) return replyLimit(ctx, "scan", quota);

  try {
    await ctx.sendChatAction("typing");

    const buffer = await downloadFile(ctx, fileId);
    const decoded = await decodeQR(buffer);

    await bumpUsage(ctx.from.id, "scan");
    logActivity(ctx.from.id, "scan", { found: Boolean(decoded) });

    if (!decoded) {
      return ctx.reply(
        "I couldn't find a readable QR code in that image.\n\n" +
          "Try a sharper, well-lit photo with the whole code in frame. Sending it as a file often helps.",
        homeButton()
      );
    }

    let text = `🔍 Decoded content:\n\n${clip(decoded, 3500)}`;
    if (/^https?:\/\//i.test(decoded)) {
      text += "\n\n⚠️ Only open links from sources you trust.";
    }
    await ctx.reply(
      text,
      Markup.inlineKeyboard([[Markup.button.callback("🔁 Make a new QR", "go:home")]])
    );
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

    const plan = await getPlan(ctx.from.id);
    const trialLine = plan.pro
      ? ""
      : `\n\n🎁 Free logo trials left: ${trialsLeft(plan, "logo")} of ${TRIALS.logo}. One is used for each QR code with a logo.`;
    await ctx.reply(
      "✅ Logo saved. It goes in the centre of your next QR codes. Accuracy is set to High automatically." + trialLine,
      Markup.inlineKeyboard([
        [Markup.button.callback("🎨 Style", "go:style"), Markup.button.callback("🗑️ Remove logo", "style:rmlogo")],
        [Markup.button.callback("🏠 Home", "go:home")],
      ])
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

const linkFlow = (title, prompt, label) => ({
  title,
  steps: [linkStep("url", prompt)],
  build: (d) => d.url,
  summary: (d) => `${label}\n${clip(d.url, 200)}\n\nScan to open.`,
});

const buildSocial = (d) =>
  /^https?:\/\//i.test(d.handle) ? d.handle : SOCIALS[d.platform].url(d.handle);

const FLOW_DEFS = {
  menu: linkFlow(
    "Your menu QR code is ready! 🍽️",
    "🍽️ Paste your menu link (website, PDF, Drive, Instagram...):",
    "🍽️ Menu"
  ),

  pay: {
    title: "Your payment QR code is ready! 💳",
    steps: [
      {
        key: "kind",
        prompt: "💳 What should customers scan to pay?",
        buttons: [
          ["💳 Payment link", "link"],
          ["🏦 Bank transfer", "bank"],
        ],
        validate: (v) => (["link", "bank"].includes(v) ? null : "Please tap one of the buttons above."),
      },
      linkStep("link", "🔗 Paste your payment link (Paystack, Flutterwave, PayPal...):", { skip: (d) => d.kind !== "link" }),
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

  text: {
    steps: [
      {
        key: "text",
        prompt: "📝 Send the exact text to encode. Links, emails and numbers stay as typed.",
        validate: (v) =>
          !v ? "Please send some text." : v.length <= MAX_TEXT_LENGTH ? null : `Please keep it under ${MAX_TEXT_LENGTH} characters.`,
      },
    ],
    build: (d) => d.text,
    summary: (d) => `📝 Text\n${clip(d.text)}`,
  },

  bulk: {
    steps: [
      {
        key: "items",
        prompt:
          `📦 Send up to ${MAX_BULK_ITEMS} items, one per line (links, text, numbers...).\n` +
          "You'll get each one back as an HD PNG, using your /style.",
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
  clearPending(ctx.from.id);

  // Check bulk access up front so people don't type ten lines and then hit a paywall
  if (type === "bulk") {
    const access = await checkBulkAccess(ctx);
    if (!access.ok) return;
    if (!access.pro) await ctx.reply(`🎁 Free bulk trials left: ${access.left} of ${TRIALS.bulk}.`);
  }

  flows.set(ctx.from.id, { type, index: 0, data: {}, expires: Date.now() + FLOW_TTL_MS });
  return askNext(ctx);
}

async function askNext(ctx) {
  const flow = getFlow(ctx.from.id);
  if (!flow) return;
  const def = FLOW_DEFS[flow.type];

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
  const rows = step.buttons
    ? chunk(
        step.buttons.map(([label, value]) => Markup.button.callback(label, `flow:${value}`)),
        step.columns || 1
      )
    : [];

  const controls = [];
  if (step.optional) controls.push(Markup.button.callback("⏭️ Skip", "fl:skip"));
  controls.push(Markup.button.callback("✖️ Cancel", "fl:cancel"));
  rows.push(controls);

  return ctx.reply(step.prompt, Markup.inlineKeyboard(rows));
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

async function skipStep(ctx) {
  const flow = getFlow(ctx.from.id);
  if (!flow) return ctx.reply("Nothing to skip right now.", homeButton());

  const step = FLOW_DEFS[flow.type].steps[flow.index];
  if (!step.optional) return ctx.reply("This step is required. Please send a value, or tap Cancel.");

  flow.data[step.key] = "";
  flow.index++;
  flow.expires = Date.now() + FLOW_TTL_MS;
  return askNext(ctx);
}

async function removeButtons(ctx) {
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (_) {
    /* message may already be edited, ignore */
  }
}

// ---------------------------------------------------------------------------
// Home menu
// ---------------------------------------------------------------------------
const HOME_BUTTONS = [
  ["🍽️ Menu", "menu"],
  ["💳 Pay", "pay"],
  ["💬 WhatsApp", "whatsapp"],
  ["🛍️ Product", "product"],
  ["⭐ Review", "review"],
  ["📱 Social", "social"],
  ["🎨 Portfolio", "portfolio"],
  ["👤 Contact", "contact"],
  ["📶 Wi-Fi", "wifi"],
  ["✉️ Email", "email"],
  ["📩 SMS", "sms"],
  ["📍 Location", "location"],
  ["📝 Text", "text"],
  ["📦 Bulk", "bulk"],
];

function homeKeyboard() {
  const rows = chunk(
    HOME_BUTTONS.map(([label, id]) => Markup.button.callback(label, `go:${id}`)),
    3
  );
  rows.push([
    Markup.button.callback("🎨 Style", "go:style"),
    Markup.button.callback("📜 History", "go:history"),
    Markup.button.callback("🖨️ Print", "go:print"),
  ]);
  rows.push([
    Markup.button.callback("📊 My plan", "go:plan"),
    Markup.button.callback("❤️ Donate", "go:donate"),
    Markup.button.callback("❓ Help", "go:help"),
  ]);
  return Markup.inlineKeyboard(rows);
}

const HOME_TEXT =
  "👋 Quick QR Generator\n\n" +
  "Send me a link, text, email or phone number, or tap a button.\n" +
  "📷 Send a photo of a QR code to scan it.";

const sendHome = (ctx) => ctx.reply(HOME_TEXT, homeKeyboard());

const HELP_TEXT =
  "🤖 Quick QR Generator\n\n" +
  "Send a link, text, email or number to get a QR code.\n\n" +
  "🏪 Business\n" +
  "/menu /pay /whatsapp /product /review /contact\n\n" +
  "🎨 Design\n" +
  "/colors /logo /style /bulk\n\n" +
  "📱 Creators\n" +
  "/social /portfolio /whatsapp /contact\n\n" +
  "Also\n" +
  "/wifi /email /sms /location /text\n\n" +
  "📜 Your stuff\n" +
  "/history /print /activity /plan\n" +
  "/clearhistory /deletedata\n\n" +
  "📷 Send a photo to scan a QR code.\n" +
  "/donate to support the bot ❤️";

const sendHelp = (ctx) => ctx.reply(HELP_TEXT, homeKeyboard());

// ---------------------------------------------------------------------------
// Style settings and colour picker
// ---------------------------------------------------------------------------
async function styleView(userId) {
  const settings = getSettings(userId);
  const plan = await getPlan(userId);
  const mark = (active) => (active ? "✅ " : "");

  const themeButtons = Object.entries(THEMES).map(([id, t]) =>
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

  const theme = resolveTheme(settings);
  const colourLine = settings.theme === "custom" ? `${swatchName(CODE_COLORS, theme.dark)} on ${swatchName(BG_COLORS, theme.light)}` : theme.name;
  const logoLine = settings.logo
    ? plan.pro
      ? "On"
      : `On (trials left: ${trialsLeft(plan, "logo")}/${TRIALS.logo})`
    : "Off";

  const text =
    "🎨 QR style\n\n" +
    `Colour: ${colourLine}\n` +
    `Size: ${SIZES[settings.size].name} (${SIZES[settings.size].px}px)\n` +
    `Accuracy: ${settings.logo ? "H (logo)" : settings.ecl}\n` +
    `Background: ${settings.transparent ? "Transparent" : "Solid"}\n` +
    `Logo: ${logoLine}\n\n` +
    "Tap to change. Saved automatically.";

  const logoRow = settings.logo
    ? [Markup.button.callback("🖼️ Change logo", "style:logo"), Markup.button.callback("🗑️ Remove logo", "style:rmlogo")]
    : [Markup.button.callback("🖼️ Add logo", "style:logo")];

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("▼ Colour", "noop")],
    ...chunk(themeButtons, 3),
    [Markup.button.callback("🎨 Pick custom colours", "go:colors")],
    [Markup.button.callback("▼ Size", "noop")],
    sizeButtons,
    [Markup.button.callback("▼ Accuracy", "noop")],
    eclButtons,
    [Markup.button.callback(`${settings.transparent ? "✅" : "⬜"} Transparent background`, "style:transparent")],
    logoRow,
    [Markup.button.callback("👁️ Preview", "style:preview"), Markup.button.callback("🏠 Home", "go:home")],
  ]);
  return { text, keyboard };
}

async function showStyle(ctx) {
  const { text, keyboard } = await styleView(ctx.from.id);
  return ctx.reply(text, keyboard);
}

async function refreshStyle(ctx) {
  const { text, keyboard } = await styleView(ctx.from.id);
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (error) {
    if (!/not modified/i.test(String(error && error.message))) throw error;
  }
}

function colourView(settings) {
  const theme = resolveTheme(settings);
  const mark = (active) => (active ? "✅" : "");

  const codeButtons = CODE_COLORS.map((c) =>
    Markup.button.callback(`${mark(theme.dark === c.hex)}${c.e}`, `col:d:${c.hex.slice(1)}`)
  );
  const bgButtons = BG_COLORS.map((c) =>
    Markup.button.callback(`${mark(theme.light === c.hex)}${c.e}`, `col:l:${c.hex.slice(1)}`)
  );

  const text =
    "🎨 Pick your colours\n\n" +
    `Code: ${swatchName(CODE_COLORS, theme.dark)}\n` +
    `Background: ${swatchName(BG_COLORS, theme.light)}\n\n` +
    "Tap a swatch. I check the contrast so your code still scans.";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("▼ Code colour", "noop")],
    ...chunk(codeButtons, 4),
    [Markup.button.callback("▼ Background", "noop")],
    ...chunk(bgButtons, 4),
    [Markup.button.callback("⌨️ Type hex", "col:type"), Markup.button.callback("👁️ Preview", "style:preview")],
    [Markup.button.callback("◀️ Back to style", "go:style")],
  ]);
  return { text, keyboard };
}

const showColours = (ctx) => {
  const { text, keyboard } = colourView(getSettings(ctx.from.id));
  return ctx.reply(text, keyboard);
};

async function refreshColours(ctx) {
  const { text, keyboard } = colourView(getSettings(ctx.from.id));
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (error) {
    if (!/not modified/i.test(String(error && error.message))) throw error;
  }
}

// Used by /colors #hex #hex and by the "Type hex" button
async function applyColors(ctx, args) {
  const dark = normalizeHex(args[0]);
  const light = args[1] ? normalizeHex(args[1]) : "#ffffff";
  if (!dark || !light) {
    return ctx.reply("Colours must be 6-digit hex codes like #1d4ed8.");
  }

  const ratio = contrastRatio(dark, light);
  if (ratio < 3) {
    return ctx.reply(
      `Those colours are too close (contrast ${ratio.toFixed(1)}:1) and many phones won't scan the code. ` +
        "Try a darker code colour or a lighter background."
    );
  }

  const settings = getSettings(ctx.from.id);
  settings.custom = { dark, light };
  settings.theme = "custom";
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "colors_set", { dark, light });

  let reply = `✅ Colours saved: ${dark} on ${light}.`;
  if (luminance(dark) > luminance(light)) {
    reply += "\n\n⚠️ Your code is lighter than its background. Some older scanners can't read inverted codes, so test it first.";
  }
  return ctx.reply(
    reply,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎨 Colours", "go:colors"), Markup.button.callback("⚙️ Style", "go:style")],
      [Markup.button.callback("🏠 Home", "go:home")],
    ])
  );
}

async function askLogo(ctx) {
  flows.delete(ctx.from.id);
  awaitingHex.delete(ctx.from.id);
  awaitingLogo.set(ctx.from.id, Date.now() + FLOW_TTL_MS);

  const plan = await getPlan(ctx.from.id);
  const trialLine = plan.pro
    ? ""
    : `\n\n🎁 Free logo trials: ${trialsLeft(plan, "logo")} of ${TRIALS.logo} left.`;
  return ctx.reply(
    "🖼️ Send your logo as an image.\n\n" +
      "A square PNG sent as a file looks best. It sits in the centre of your QR codes." +
      trialLine,
    Markup.inlineKeyboard([[Markup.button.callback("✖️ Cancel", "fl:cancel")]])
  );
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
      text: "📜 Your history is empty.\n\nEvery QR code you create is saved here.",
      keyboard: Markup.inlineKeyboard([[Markup.button.callback("➕ Make a QR code", "go:home")]]),
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
  buttons.push([Markup.button.callback("🖨️ Print latest", "go:print"), Markup.button.callback("🏠 Home", "go:home")]);

  const text =
    `📜 History: ${total} QR code${total === 1 ? "" : "s"} (page ${page + 1}/${pages})\n\n` +
    "Tap one to reopen it.\n" +
    "Search: /history keyword";

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

async function showHistory(ctx) {
  const { text, keyboard } = await historyView(ctx.from.id, 0);
  return ctx.reply(text, keyboard);
}

function printKeyboard(id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📄 Single A4 poster", `prm:single:${id}`)],
    [Markup.button.callback("🏷️ Sheet of 6", `prm:sheet6:${id}`), Markup.button.callback("🏷️ Sheet of 12", `prm:sheet12:${id}`)],
    [Markup.button.callback("🏠 Home", "go:home")],
  ]);
}

function printPrompt() {
  return "🖨️ Choose a print layout (A4 PDF).\n\nSheet of 6: table cards, stickers.\nSheet of 12: small labels.";
}

async function showPrint(ctx) {
  const [latest] = await listHistory(ctx.from.id, 1, 0);
  if (!latest) {
    return ctx.reply(
      "You don't have any saved QR codes yet. Create one first.",
      Markup.inlineKeyboard([[Markup.button.callback("➕ Make a QR code", "go:home")]])
    );
  }
  return ctx.reply(
    `${printPrompt()}\n\nLatest QR: ${kindEmoji(latest.kind)} ${fmtDate(latest.created_at)}\n` +
      "For an older one, open it from History and tap Print.",
    printKeyboard(latest.id)
  );
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
    case "history_viewed":
      return "Viewed history";
    case "donation":
      return `Donated ${d.amount} Stars`;
    case "pro_purchased":
      return `Bought Pro (${d.days} days)`;
    default:
      return row.action;
  }
}

// ---------------------------------------------------------------------------
// Donations and Pro (Telegram Stars)
// ---------------------------------------------------------------------------
const DONATE_LINK = process.env.DONATE_LINK;
const STAR_AMOUNTS = [25, 50, 100, 250];

function showDonate(ctx) {
  const rows = [STAR_AMOUNTS.map((n) => Markup.button.callback(`⭐ ${n}`, `donate:${n}`))];
  if (DONATE_LINK) rows.push([Markup.button.url("💳 Card or bank transfer", DONATE_LINK)]);
  rows.push([Markup.button.callback("⭐ Get Pro instead", "buy:pro"), Markup.button.callback("🏠 Home", "go:home")]);

  return ctx.reply(
    "❤️ Quick QR Generator is free to use. Donations help cover running costs.\n\nPick an amount in Telegram Stars:",
    Markup.inlineKeyboard(rows)
  );
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
      console.error("User sync failed:", error.message);
    }
  }
  return next();
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.start((ctx) => sendHome(ctx));
bot.help((ctx) => sendHelp(ctx));

// Every guided flow gets a command with the same name (/wifi, /menu, /pay, ...)
for (const type of Object.keys(FLOW_DEFS)) {
  if (type === "text") continue; // /text has its own handler so it can take the text inline
  bot.command(type, (ctx) => startFlow(ctx, type));
}

bot.command("text", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/text(@\w+)?\s*/i, "").trim();
  if (!raw) return startFlow(ctx, "text");
  return sendQR(ctx, raw, { summary: `📝 Text\n${clip(raw)}`, kind: "text" });
});

const LOCATION_HELP =
  "📍 Tap the 📎 attachment button, choose Location, and send it. I'll turn it into a QR code that opens in maps.";

bot.command("location", (ctx) => ctx.reply(LOCATION_HELP, homeButton()));

bot.command(["colors", "colours"], async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);
  if (!args.length) return showColours(ctx);
  return applyColors(ctx, args);
});

bot.command("logo", (ctx) => askLogo(ctx));

bot.command("removelogo", async (ctx) => {
  const settings = getSettings(ctx.from.id);
  if (!settings.logo) return ctx.reply("You don't have a logo saved.", homeButton());
  settings.logo = null;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "logo_removed");
  return ctx.reply("Logo removed.", homeButton());
});

bot.command("style", (ctx) => showStyle(ctx));

bot.command(["plan", "pro"], async (ctx) => {
  const { text, keyboard } = await planView(ctx.from.id);
  return ctx.reply(text, keyboard);
});

bot.command("cancel", (ctx) => {
  if (clearPending(ctx.from.id)) return ctx.reply("Cancelled.", homeButton());
  return ctx.reply("Nothing to cancel right now.", homeButton());
});

bot.command("skip", (ctx) => skipStep(ctx));

bot.command("history", async (ctx) => {
  const term = ctx.message.text.replace(/^\/history(@\w+)?\s*/i, "").trim();

  if (term) {
    const rows = await searchHistory(ctx.from.id, term.slice(0, 50), SEARCH_LIMIT);
    if (!rows.length) {
      return ctx.reply(`No saved QR codes match "${clip(term, 50)}".`, Markup.inlineKeyboard([[Markup.button.callback("📜 All history", "hist:0")]]));
    }
    const buttons = rows.map((row) => [Markup.button.callback(historyButtonLabel(row), `h:open:${row.id}`)]);
    buttons.push([Markup.button.callback("📜 All history", "hist:0"), Markup.button.callback("🏠 Home", "go:home")]);
    return ctx.reply(
      `🔎 ${rows.length} result${rows.length === 1 ? "" : "s"} for "${clip(term, 50)}". Tap one:`,
      Markup.inlineKeyboard(buttons)
    );
  }

  return showHistory(ctx);
});

bot.command("print", (ctx) => showPrint(ctx));

bot.command("activity", async (ctx) => {
  const { rows } = await pool.query(
    `SELECT action, details, created_at FROM activity_log
     WHERE user_id = $1 AND NOT (action = 'command' AND details->>'command' = 'activity')
     ORDER BY id DESC LIMIT $2`,
    [ctx.from.id, ACTIVITY_LIMIT]
  );
  if (!rows.length) return ctx.reply("No activity recorded yet.", homeButton());
  const lines = rows.map((row) => `${fmtDate(row.created_at)} · ${describeActivity(row)}`);
  return ctx.reply(`🕑 Your last ${rows.length} actions:\n\n${lines.join("\n")}`, homeButton());
});

bot.command("clearhistory", async (ctx) => {
  const total = await countHistory(ctx.from.id);
  if (!total) return ctx.reply("Your history is already empty.", homeButton());
  return ctx.reply(
    `Delete all ${total} saved QR code${total === 1 ? "" : "s"}? This can't be undone.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🗑️ Yes, delete", "h:clearyes"), Markup.button.callback("Keep it", "h:no")],
    ])
  );
});

bot.command("deletedata", (ctx) =>
  ctx.reply(
    "This permanently deletes your QR history, activity log, saved style and logo.\n\n" +
      "Your Pro status and daily/trial counters are kept.",
    Markup.inlineKeyboard([
      [Markup.button.callback("⚠️ Delete everything", "h:wipeyes"), Markup.button.callback("Cancel", "h:no")],
    ])
  )
);

bot.command("donate", (ctx) => showDonate(ctx));

// ---------------------------------------------------------------------------
// Button callbacks
// ---------------------------------------------------------------------------
bot.action("noop", (ctx) => ctx.answerCbQuery());

// Home menu and shortcuts
bot.action(/^go:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const target = ctx.match[1];

  if (Object.prototype.hasOwnProperty.call(FLOW_DEFS, target)) return startFlow(ctx, target);

  switch (target) {
    case "home":
      return sendHome(ctx);
    case "help":
      return sendHelp(ctx);
    case "style":
      return showStyle(ctx);
    case "colors":
      return showColours(ctx);
    case "history":
      return showHistory(ctx);
    case "print":
      return showPrint(ctx);
    case "donate":
      return showDonate(ctx);
    case "location":
      return ctx.reply(LOCATION_HELP, homeButton());
    case "plan": {
      const { text, keyboard } = await planView(ctx.from.id);
      return ctx.reply(text, keyboard);
    }
    default:
      return;
  }
});

// Flow buttons
bot.action(/^flow:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!getFlow(ctx.from.id)) {
    return ctx.reply("That setup has expired.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Start again", "go:home")]]));
  }
  await removeButtons(ctx);
  return acceptFlowValue(ctx, ctx.match[1]);
});

bot.action("fl:skip", async (ctx) => {
  await ctx.answerCbQuery();
  await removeButtons(ctx);
  return skipStep(ctx);
});

bot.action("fl:cancel", async (ctx) => {
  await ctx.answerCbQuery("Cancelled");
  await removeButtons(ctx);
  clearPending(ctx.from.id);
  return ctx.reply("Cancelled.", homeButton());
});

// Style
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
  await refreshStyle(ctx);
});

bot.action("style:transparent", async (ctx) => {
  const settings = getSettings(ctx.from.id);
  settings.transparent = !settings.transparent;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "style_changed", { setting: "transparent", value: settings.transparent });
  await ctx.answerCbQuery("Saved ✅");
  await refreshStyle(ctx);
});

bot.action("style:logo", async (ctx) => {
  await ctx.answerCbQuery();
  return askLogo(ctx);
});

bot.action("style:rmlogo", async (ctx) => {
  const settings = getSettings(ctx.from.id);
  if (!settings.logo) return ctx.answerCbQuery("No logo to remove.");
  settings.logo = null;
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "logo_removed");
  await ctx.answerCbQuery("Logo removed 🗑️");
  // Refresh the style screen if the button was pressed there
  const onStyle = ctx.callbackQuery.message && ctx.callbackQuery.message.text && ctx.callbackQuery.message.text.startsWith("🎨 QR style");
  if (onStyle) return refreshStyle(ctx);
  return removeButtons(ctx);
});

bot.action("style:preview", async (ctx) => {
  if (isRateLimited(ctx.from.id)) return ctx.answerCbQuery("Please wait a moment.");
  await ctx.answerCbQuery("Building preview…");
  try {
    const settings = { ...getSettings(ctx.from.id) };
    const png = await renderPng("https://t.me/", settings, 500);
    const extra = {
      caption: "👁️ Preview of your current style",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🎨 Colours", "go:colors"), Markup.button.callback("⚙️ Style", "go:style")],
      ]).reply_markup,
    };
    return settings.transparent
      ? await ctx.replyWithDocument({ source: png, filename: "preview.png" }, extra)
      : await ctx.replyWithPhoto({ source: png, filename: "preview.png" }, extra);
  } catch (error) {
    console.error("Preview failed:", error);
    return ctx.reply("Sorry, I couldn't build the preview.");
  }
});

// Colour picker
bot.action(/^col:(d|l):([0-9a-fA-F]{6})$/, async (ctx) => {
  const side = ctx.match[1] === "d" ? "dark" : "light";
  const hex = `#${ctx.match[2].toLowerCase()}`;
  const settings = getSettings(ctx.from.id);
  const current = resolveTheme(settings);

  const next = { dark: current.dark, light: current.light, [side]: hex };
  const ratio = contrastRatio(next.dark, next.light);
  if (ratio < 3) {
    return ctx.answerCbQuery("Too little contrast, it might not scan. Pick another.", { show_alert: true });
  }

  settings.custom = next;
  settings.theme = "custom";
  await saveSettings(ctx.from.id);
  logActivity(ctx.from.id, "colors_set", next);
  await ctx.answerCbQuery("Saved ✅");
  await refreshColours(ctx);
});

bot.action("col:type", async (ctx) => {
  await ctx.answerCbQuery();
  flows.delete(ctx.from.id);
  awaitingLogo.delete(ctx.from.id);
  awaitingHex.set(ctx.from.id, Date.now() + FLOW_TTL_MS);
  return ctx.reply(
    "⌨️ Send hex codes: code colour, then background (optional).\n\nExample: #1d4ed8 #ffffff",
    Markup.inlineKeyboard([[Markup.button.callback("✖️ Cancel", "fl:cancel")]])
  );
});

// Pro purchase (Telegram Stars)
bot.action("buy:pro", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.replyWithInvoice({
    title: "Quick QR Pro",
    description: `${PRO_DAYS} days: unlimited logo and bulk, higher daily limits.`,
    payload: `pro:${PRO_DAYS}`,
    provider_token: "", // must be empty for Telegram Stars
    currency: "XTR",
    prices: [{ label: `Pro, ${PRO_DAYS} days`, amount: PRO_STARS }],
  });
});

// Downloads read from the database, so they keep working after restarts
bot.action(/^dl:(png|svg):(\d+)$/, async (ctx) => {
  const format = ctx.match[1];
  const entry = await getHistoryEntry(ctx.from.id, Number(ctx.match[2]));

  if (!entry) {
    return ctx.answerCbQuery("This QR code is no longer in your history. Please generate it again.", { show_alert: true });
  }

  const quota = await checkQuota(ctx.from.id, "download");
  if (!quota.ok) {
    await ctx.answerCbQuery();
    return replyLimit(ctx, "download", quota);
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
    await bumpUsage(ctx.from.id, "download");
    logActivity(ctx.from.id, "qr_downloaded", { format, history_id: Number(entry.id) });
  } catch (error) {
    console.error("QR download failed:", error);
    await ctx.reply("Sorry, I couldn't prepare that file.");
  }
});

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

  const quota = await checkQuota(ctx.from.id, "print");
  if (!quota.ok) {
    await ctx.answerCbQuery();
    return replyLimit(ctx, "print", quota);
  }

  await ctx.answerCbQuery("Building your PDF…");
  try {
    await ctx.sendChatAction("upload_document");
    const pdf = await renderPrintPdf(entry, entrySettings(entry, ctx.from.id), modeId);
    await ctx.replyWithDocument(
      { source: pdf, filename: `qr-print-${modeId}.pdf` },
      { caption: `🖨️ ${PRINT_MODES[modeId].name}: print at 100% scale (no "fit to page") for the sharpest result.` }
    );
    await bumpUsage(ctx.from.id, "print");
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
    await removeButtons(ctx);
  }
});

bot.action("h:clearyes", async (ctx) => {
  const result = await pool.query("DELETE FROM qr_history WHERE user_id = $1", [ctx.from.id]);
  logActivity(ctx.from.id, "history_cleared", { count: result.rowCount });
  await ctx.answerCbQuery("History cleared");
  try {
    await ctx.editMessageText(
      `🗑️ Deleted ${result.rowCount} QR code${result.rowCount === 1 ? "" : "s"} from your history.`,
      homeButton()
    );
  } catch (_) {
    /* ignore */
  }
});

bot.action("h:wipeyes", async (ctx) => {
  // Deleting the user row cascades to settings, history and activity.
  // user_plan and usage_daily have no foreign key, so Pro and trial counters survive.
  await pool.query("DELETE FROM users WHERE id = $1", [ctx.from.id]);
  settingsByUser.delete(ctx.from.id);
  loadedUsers.delete(ctx.from.id);
  clearPending(ctx.from.id);
  await ctx.answerCbQuery("Everything deleted");
  try {
    await ctx.editMessageText("✅ Your stored data has been deleted. You can keep using the bot, and new activity will be saved again.", homeButton());
  } catch (_) {
    /* ignore */
  }
});

bot.action("h:no", async (ctx) => {
  await ctx.answerCbQuery("Okay, nothing was deleted.");
  try {
    await ctx.editMessageText("Okay, nothing was deleted.", homeButton());
  } catch (_) {
    /* ignore */
  }
});

// Donations
bot.action(/^donate:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match[1]);
  if (!STAR_AMOUNTS.includes(amount)) return ctx.answerCbQuery("Unknown amount.");

  await ctx.answerCbQuery();
  return ctx.replyWithInvoice({
    title: "Support Quick QR Generator",
    description: `Donate ${amount} Stars to keep this bot free and running.`,
    payload: `donation:${amount}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: "Donation", amount }],
  });
});

// Telegram requires you to approve the checkout within 10 seconds
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on(message("successful_payment"), async (ctx) => {
  const payment = ctx.message.successful_payment;
  const payload = String(payment.invoice_payload || "");

  if (payload.startsWith("pro:")) {
    const days = Number(payload.split(":")[1]) || PRO_DAYS;
    try {
      const until = await grantPro(ctx.from.id, days);
      console.log(`Pro purchased: ${payment.total_amount} ${payment.currency} from user ${ctx.from.id}`);
      logActivity(ctx.from.id, "pro_purchased", { days, amount: payment.total_amount });
      return ctx.reply(
        `🎉 You're Pro until ${fmtDate(until)}!\n\nUnlimited logo and bulk, plus higher daily limits.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 My plan", "go:plan"), Markup.button.callback("🏠 Home", "go:home")],
        ])
      );
    } catch (error) {
      // Payment succeeded but saving failed: log everything needed to fix it by hand
      console.error(`PRO GRANT FAILED for user ${ctx.from.id}, charge ${payment.telegram_payment_charge_id}:`, error);
      return ctx.reply("Payment received, but I couldn't activate Pro. Please contact support and we'll fix it right away.");
    }
  }

  console.log(`Donation received: ${payment.total_amount} ${payment.currency} from user ${ctx.from.id}`);
  logActivity(ctx.from.id, "donation", { amount: payment.total_amount, currency: payment.currency });
  return ctx.reply("🙏 Thank you so much for your support! It really helps keep this bot running.", homeButton());
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
    return ctx.reply("I can only read image files. Send a photo of a QR code, or send text to create one.", homeButton());
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
    return ctx.reply("I don't know that command.", Markup.inlineKeyboard([[Markup.button.callback("❓ Help", "go:help"), Markup.button.callback("🏠 Home", "go:home")]]));
  }

  // Waiting for typed hex colours from the colour picker
  if (takeHexRequest(ctx.from.id)) {
    return applyColors(ctx, text.split(/\s+/).filter(Boolean));
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
    await ctx.reply("Something went wrong. Please try again.", homeButton());
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
    console.warn("Could not update bot profile:", error.message);
  }
}

async function main() {
  await initDb();
  const me = await bot.telegram.getMe();
  await setupBotProfile();

  pruneUsage();
  setInterval(pruneUsage, 24 * 60 * 60 * 1000).unref();

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