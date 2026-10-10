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
export const SESSION_DAYS = 30;
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

export async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64000) break;
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

export async function mailLink(to, link, isNew) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const title = isNew ? "Create your Nuru Shillings account" : "Log in to Nuru Shillings";
  const action = isNew ? "Create account" : "Log in";
  const lead = isNew
    ? "Click the button to create your account. Your wallet opens straight away."
    : "Click the button to log in to your wallet.";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      reply_to: SUPPORT,
      subject: title,
      text: `${title}\n\n${lead}\n\n${link}\n\nThe link works once and expires in 20 minutes. If you did not ask for it, ignore this email.\n\nDo not forward this email. Nuru Shillings will never ask you for this link, a secret key, an M-Pesa PIN, or a card security code.`,
      html: `<div style="background:#000;padding:40px 16px;font-family:Inter,Arial,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#0a0a0a;border:1px solid #262626;border-radius:14px;padding:36px 32px;color:#ededed">
    <div style="width:22px;height:22px;border-radius:50%;background:#fff;margin-bottom:28px"></div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:-.02em;color:#fff">${esc(title)}</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#a1a1a1">${esc(lead)}</p>
    <a href="${esc(link)}" style="display:block;text-align:center;background:#fff;color:#000;text-decoration:none;font-size:15px;font-weight:600;padding:13px 18px;border-radius:8px">${esc(action)}</a>
    <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#737373">The link works once and expires in 20 minutes. If you did not ask for it, you can ignore this email.</p>
  </div>
  <p style="max-width:440px;margin:18px auto 0;font-size:12px;line-height:1.6;color:#555;text-align:center">Nuru Shillings · 100 NSH = 1 USD<br>Do not forward this email. We never ask for this link, a secret key, an M-Pesa PIN, or a card security code.</p>
</div>`,
    }),
  });
  if (!r.ok) console.error("[auth] resend", r.status, (await r.text()).slice(0, 300));
  return r.ok;
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
