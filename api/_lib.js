import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

let client;
export function db() {
  if (!client) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

export const APP_URL = (process.env.APP_URL || "https://norashillings.benuru.com").replace(/\/$/, "");
export const SUPPORT = process.env.NURU_SUPPORT_TO || "supportnorashillings@benuru.com";
export const FROM = process.env.NURU_MAIL_FROM || `Nuru Shillings <${SUPPORT}>`;
export const SESSION_COOKIE = "nsh_session";
export const SESSION_DAYS = 365;
export const SANDBOX_START = 10000;

export const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
export const secret = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
export const fee = (amount) => Math.round(amount / 100);

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export async function body(req, limit = 64000) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) break;
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function cookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/* ---------- Bunny storage (profile pictures) ---------- */

function bunnyEnv() {
  return {
    zone: String(process.env.BUNNY_STORAGE_ZONE || "").trim(),
    key: String(process.env.BUNNY_STORAGE_PASSWORD || "").trim(),
    region: String(process.env.BUNNY_STORAGE_REGION || "de").trim().toLowerCase(),
  };
}
function bunnyHosts(region) {
  if (!region || region === "de" || region === "frankfurt") return ["storage.bunnycdn.com", "de.storage.bunnycdn.com"];
  return [`${region}.storage.bunnycdn.com`, "storage.bunnycdn.com"];
}
export const bunnyReady = () => { const { zone, key } = bunnyEnv(); return Boolean(zone && key); };

async function bunnyFetch(objectKey, init = {}) {
  const { zone, key, region } = bunnyEnv();
  if (!zone || !key) throw new HttpError(503, "Picture storage is not set up yet.");
  let last = null;
  for (const host of bunnyHosts(region)) {
    last = await fetch(`https://${host}/${zone}/${objectKey}`, {
      ...init,
      headers: { AccessKey: key, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (last?.ok) return last;
    if (last && ![404, 502, 503].includes(last.status)) break;
  }
  return last;
}

export async function bunnyPut(objectKey, bytes, type) {
  const r = await bunnyFetch(objectKey, { method: "PUT", headers: { "Content-Type": type }, body: bytes });
  if (!r?.ok) {
    console.error("[bunny] put", r?.status, r ? (await r.text().catch(() => "")).slice(0, 200) : "offline");
    throw new HttpError(502, "We could not save the picture. Try again.");
  }
}
export async function bunnyGet(objectKey) {
  const r = await bunnyFetch(objectKey);
  if (!r?.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}
export async function bunnyDelete(objectKey) {
  await bunnyFetch(objectKey, { method: "DELETE" }).catch(() => null);
}

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64);
}

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 200;
export const isMode = (v) => v === "test" || v === "live";

export function amountOf(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,9}$/.test(s)) return 0;
  const n = Number(s);
  return n > 0 && n <= 100000000 ? n : 0;
}

export function safeWebhook(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || url.length > 500) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  return true;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = "Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

function emailLayout({ preheader, title, lead, body = "", action, link, note = "", to, reason }) {
  const button = action ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="#ffffff" style="border-radius:8px;background:#fff">
            <a href="${esc(link)}" style="display:block;padding:13px 18px;font-family:${FONT};font-size:15px;font-weight:600;color:#000;text-decoration:none;border-radius:8px">${esc(action)}</a>
          </td>
        </tr></table>` : "";
  return `<!DOCTYPE html><html><head><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:#000">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background:#000">
  <tr><td align="center" style="padding:48px 16px 40px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px">
      <tr><td style="padding:0 4px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="20" height="20" bgcolor="#ffffff" style="width:20px;height:20px;border-radius:50%;background:#fff;font-size:0;line-height:0">&nbsp;</td>
          <td style="padding-left:10px;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-.02em;color:#fff">Nuru Shillings</td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:36px 32px">
        <h1 style="margin:0 0 10px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-.02em;color:#fff">${esc(title)}</h1>
        <p style="margin:0 0 28px;font-family:${FONT};font-size:15px;line-height:1.6;color:#a1a1a1">${esc(lead)}</p>${body}${button}
        ${note ? `<p style="margin:24px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:#6e6e6e">${esc(note)}</p>` : ""}
      </td></tr>
      <tr><td style="padding:28px 4px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:#6e6e6e">
        Sent to ${esc(to)}. ${esc(reason)}<br>
        <a href="${APP_URL}/help" style="color:#a1a1a1;text-decoration:none">Help</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${APP_URL}/privacy" style="color:#a1a1a1;text-decoration:none">Privacy</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${APP_URL}/terms" style="color:#a1a1a1;text-decoration:none">Terms</a>
        <div style="margin-top:14px;color:#4d4d4d">© 2026 Nuru Shillings</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function resendMail(payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, reply_to: SUPPORT, ...payload }),
  });
  if (!r.ok) console.error("[mail] resend", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

export async function mailLink(to, link, isNew) {
  const title = isNew ? "Create your Nuru Shillings account" : "Log in to Nuru Shillings";
  const action = isNew ? "Create account" : "Log in";
  const lead = isNew
    ? "Click below to create your account. Your wallet opens straight away."
    : "Click below to log in to your wallet.";
  const note = "This link expires in 20 minutes and can only be used once.";
  const reason = "If you didn't request this, you can ignore it.";
  return resendMail({
    to: [to],
    subject: title,
    text: `${title}\n\n${lead}\n\n${action}: ${link}\n\n${note}\n\n—\nSent to ${to}. ${reason}\nNuru Shillings · ${APP_URL}`,
    html: emailLayout({ preheader: "This link expires in 20 minutes.", title, lead, action, link, note, to, reason }),
  });
}

export async function mailWelcome(to) {
  const title = "Your account is ready";
  const lead = "Welcome to Nuru Shillings. Your wallet is open. Here is how to get started.";
  const steps = [
    ["Add money", "Use PayPal, a card, or M-Pesa. 100 NSH is always 1 USD, and you can send and pay right away."],
    ["Verify once to withdraw", "Before your first withdrawal, take a photo of your ID and a quick selfie. It is free and done once."],
    ["Take payments", "Running a business? Open Business tools for API keys, webhooks, and payments."],
  ];
  const body = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">${steps.map(([h, p], i) => `
          <tr>
            <td width="28" valign="top" style="padding:${i ? "16px" : "0"} 0 0;font-family:${FONT};font-size:13px;font-weight:600;color:#6e6e6e">0${i + 1}</td>
            <td valign="top" style="padding:${i ? "16px" : "0"} 0 0;font-family:${FONT}">
              <div style="font-size:15px;font-weight:600;color:#fff">${esc(h)}</div>
              <div style="margin-top:3px;font-size:14px;line-height:1.55;color:#a1a1a1">${esc(p)}</div>
            </td>
          </tr>`).join("")}
        </table>`;
  const link = `${APP_URL}/dashboard`;
  const reason = "You're receiving this because you created a Nuru Shillings account.";
  return resendMail({
    to: [to],
    subject: "Welcome to Nuru Shillings",
    text: `${title}\n\n${lead}\n\n${steps.map(([h, p], i) => `${i + 1}. ${h}: ${p}`).join("\n")}\n\nOpen your wallet: ${link}\n\n—\nSent to ${to}. ${reason}\nNuru Shillings · ${APP_URL}`,
    html: emailLayout({ preheader: "Your wallet is open. Here is how to get started.", title, lead, body, action: "Open my wallet", link, to, reason }),
  });
}

export async function mailReceipt(to, t) {
  const when = new Date(t.paid || Date.now()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" });
  const usd = `$${Number(t.usd).toFixed(2)}`;
  const nsh = `${Number(t.nsh).toLocaleString("en-US")} NSH`;
  const paidWith = t.method === "mpesa" ? `M-Pesa ${t.phone || ""}`.trim()
    : t.method === "card" ? `Card${t.card_last4 ? ` ending ${t.card_last4}` : ""}`
    : `PayPal${t.payer ? ` (${t.payer})` : ""}`;
  const rows = [
    ["Receipt number", t.id],
    ["Date", `${when} EAT`],
    ["Paid with", paidWith],
    ["Amount paid", t.method === "mpesa" && t.kes ? `KES ${Number(t.kes).toLocaleString("en-US")} (${usd})` : usd],
    [t.method === "mpesa" ? "M-Pesa receipt" : "PayPal transaction", t.receipt || "—"],
    ["Added to wallet", nsh],
    ["Wallet balance", `${Number(t.balance || 0).toLocaleString("en-US")} NSH`],
  ];
  const body = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-top:1px solid #262626">${rows.map(([k, v]) => `
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#6e6e6e">${esc(k)}</td>
            <td align="right" style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#fff;font-weight:500">${esc(v)}</td>
          </tr>`).join("")}
        </table>`;
  const title = `${nsh} added to your wallet`;
  const lead = `Your payment of ${t.method === "mpesa" && t.kes ? `KES ${Number(t.kes).toLocaleString("en-US")}` : usd} was successful. Here is your receipt.`;
  const reason = "You're receiving this because you added money to your Nuru Shillings wallet.";
  return resendMail({
    to: [to],
    subject: `Receipt ${t.id} · ${nsh} added`,
    text: `${title}\n\n${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nOpen your wallet: ${APP_URL}/dashboard\n\n—\nSent to ${to}. ${reason}\nNuru Shillings · ${APP_URL}`,
    html: emailLayout({ preheader: `Payment received. ${nsh} added.`, title, lead, body, action: "Open my wallet", link: `${APP_URL}/dashboard#activity`, to, reason }),
  });
}

export async function mailDeposit(to, d, role) {
  const when = new Date(d.completed || Date.now()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" });
  const nsh = (n) => `${Number(n).toLocaleString("en-US")} NSH`;
  const usd = (n) => `$${(Number(n) / 100).toFixed(2)}`;
  const sandbox = d.mode === "test" ? " (Sandbox)" : "";
  const payer = role === "payer";
  const rows = payer ? [
    ["Receipt number", d.id],
    ["Date", `${when} EAT`],
    ["Added to", d.app],
    ["Amount", `${nsh(d.amount)} · ${usd(d.amount)}`],
    ["Fee", "Free for you"],
    ...(d.reference ? [["Reference", d.reference]] : []),
    ["Wallet balance", nsh(d.balance)],
  ] : [
    ["Deposit", d.id],
    ["Date", `${when} EAT`],
    ["App", d.app],
    ["From", d.user],
    ["Amount", nsh(d.amount)],
    ["Fee (1%)", `−${nsh(d.fee)}`],
    ["You received", nsh(d.amount - d.fee)],
    ...(d.reference ? [["Reference", d.reference]] : []),
  ];
  const body = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-top:1px solid #262626">${rows.map(([k, v]) => `
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#6e6e6e">${esc(k)}</td>
            <td align="right" style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#fff;font-weight:500">${esc(v)}</td>
          </tr>`).join("")}
        </table>`;
  const title = payer ? `You added ${nsh(d.amount)} to ${d.app}` : `${nsh(d.amount - d.fee)} received from ${d.user}`;
  const lead = payer
    ? `You confirmed this deposit${sandbox}. The money moved from your Nuru wallet to ${d.app}.`
    : `${d.user} confirmed a deposit to ${d.app}${sandbox}. It is already in your Nuru balance.`;
  const reason = payer
    ? "You're receiving this because you confirmed a deposit from your Nuru Shillings wallet."
    : "You're receiving this because your app received a deposit through Nuru Shillings.";
  const link = payer ? `${APP_URL}/dashboard#activity` : `${APP_URL}/developer`;
  const action = payer ? "View in my wallet" : "Open Business tools";
  return resendMail({
    to: [to],
    subject: payer ? `Receipt ${d.id} · ${nsh(d.amount)} to ${d.app}` : `Deposit ${d.id} · ${nsh(d.amount)} from ${d.user}`,
    text: `${title}\n\n${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${action}: ${link}\n\n—\nSent to ${to}. ${reason}\nNuru Shillings · ${APP_URL}`,
    html: emailLayout({ preheader: lead, title, lead, body, action, link, to, reason }),
  });
}

export async function mailKyc(to, outcome, u) {
  const approved = outcome === "approved";
  const when = new Date(u.verified_at || Date.now()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" });
  const rows = approved ? [["Name", u.name || "—"], ["Country", u.country || "—"], ["Verified", `${when} EAT`], ["Withdrawals", "Unlocked"]] : [];
  const body = rows.length ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;border-top:1px solid #262626">${rows.map(([k, v]) => `
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#6e6e6e">${esc(k)}</td>
            <td align="right" style="padding:12px 0;border-bottom:1px solid #1c1c1c;font-family:${FONT};font-size:13px;color:#fff;font-weight:500">${esc(v)}</td>
          </tr>`).join("")}
        </table>` : "";
  const title = approved ? "You’re verified" : "We couldn’t verify you";
  const lead = approved
    ? "Your identity check is approved. Withdrawals are now unlocked on your Nuru Shillings wallet."
    : "Your identity check wasn’t approved this time. You can try again from your wallet whenever you’re ready.";
  const note = approved
    ? "Your name and country now come from your ID. If anything looks wrong, reply to this email."
    : "Use a valid ID that hasn’t expired, take the photos in good light, and keep your face fully visible.";
  const action = approved ? "Open my wallet" : "Try again";
  const link = `${APP_URL}/dashboard#account`;
  const reason = "You're receiving this because you started an identity check on Nuru Shillings.";
  return resendMail({
    to: [to],
    subject: approved ? "You’re verified · withdrawals unlocked" : "Your identity check wasn’t approved",
    text: `${title}\n\n${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}${rows.length ? "\n\n" : ""}${note}\n\n${action}: ${link}\n\n—\nSent to ${to}. ${reason}\nNuru Shillings · ${APP_URL}`,
    html: emailLayout({ preheader: lead, title, lead, body, action, link, note, to, reason }),
  });
}

export async function deliver(userId, mode, type, payment) {
  const sql = db();
  const event = {
    id: newId("evt"),
    type,
    created: new Date().toISOString(),
    data: payment ? {
      id: payment.id,
      status: payment.status,
      amount: String(payment.amount),
      unit: "NSH",
      company: payment.company,
      chain: "private",
      reference: payment.reference,
    } : { test: true },
  };
  const [user] = await sql`SELECT webhook_test, webhook_live FROM users WHERE id = ${userId}`;
  const url = mode === "live" ? user?.webhook_live : user?.webhook_test;
  let status = null;
  if (url && safeWebhook(url)) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "NuruShillings-Webhooks/1", "Nuru-Event-Id": event.id },
        body: JSON.stringify(event),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      status = r.status;
    } catch {
      status = 0;
    }
  }
  await sql`INSERT INTO events (id, user_id, mode, type, payment_id, payload, delivery_status)
    VALUES (${event.id}, ${userId}, ${mode}, ${type}, ${payment?.id || null}, ${JSON.stringify(event)}, ${status})`;
  return { ...event, delivery_status: status, delivered_to: url || null };
}

export function publicPayment(p) {
  const out = {
    id: p.id,
    status: p.status,
    amount: String(p.amount),
    unit: "NSH",
    fee: String(p.fee),
    company: p.company,
    chain: "private",
    reference: p.reference,
    mode: p.mode,
    created: p.created_at,
  };
  if (p.status === "pending") out.checkout_url = `${APP_URL}/pay?id=${p.id}`;
  return out;
}
