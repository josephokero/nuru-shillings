import { SUPPORT_EMAIL } from "./_knowledge.js";

const TOPICS = {
  help: "Help centre",
  community: "Community question",
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function resend(key, payload) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("[contact] resend", r.status, (await r.text()).slice(0, 400));
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });

  const key = process.env.RESEND_API_KEY;
  if (!key) return send(res, 503, { error: `Email is not configured. Write to ${SUPPORT_EMAIL}.` });

  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });

  const kind = TOPICS[b.kind] ? b.kind : "help";
  const name = String(b.name || "").trim().slice(0, 120);
  const email = String(b.email || "").trim().slice(0, 200);
  const subject = String(b.subject || "").trim().slice(0, 160);
  const message = String(b.message || "").trim().slice(0, 6000);
  const paymentId = String(b.paymentId || "").trim().slice(0, 80);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "Enter a valid email address." });
  if (message.length < 10) return send(res, 400, { error: "Write a little more so we can help." });
  if (/\bnsh_(live|test)_[A-Za-z0-9_-]{8,}/.test(message)) {
    return send(res, 400, { error: "Remove the secret key from your message. We never need it." });
  }

  const from = process.env.NURU_MAIL_FROM || `Nora Shillings <${SUPPORT_EMAIL}>`;
  const to = process.env.NURU_SUPPORT_TO || SUPPORT_EMAIL;
  const label = TOPICS[kind];
  const title = subject || label;

  const lines = [`${label} from ${name || "a visitor"} <${email}>`];
  if (paymentId) lines.push(`Payment id: ${paymentId}`);
  lines.push("", message);

  const okTeam = await resend(key, {
    from,
    to: [to],
    reply_to: email,
    subject: `[${label}] ${title}`,
    text: lines.join("\n"),
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
      <p><b>${esc(label)}</b> from ${esc(name || "a visitor")} &lt;${esc(email)}&gt;</p>
      ${paymentId ? `<p>Payment id: <code>${esc(paymentId)}</code></p>` : ""}
      <p style="white-space:pre-wrap">${esc(message)}</p></div>`,
  });
  if (!okTeam) return send(res, 502, { error: `We could not send that. Write to ${SUPPORT_EMAIL}.` });

  await resend(key, {
    from,
    to: [email],
    reply_to: to,
    subject: `We received your message: ${title}`,
    text: `Hi ${name || "there"},\n\nWe received your message and will reply to this address.\n\nYour message:\n${message}\n\nNora Shillings will never ask you for a sign-in link, a secret key, an M-Pesa PIN, or a card security code.\n\nNora Shillings · ${SUPPORT_EMAIL}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
      <p>Hi ${esc(name || "there")},</p>
      <p>We received your message and will reply to this address.</p>
      <p style="color:#555">Your message:</p>
      <blockquote style="margin:0;padding:12px 16px;border-left:3px solid #ddd;color:#333;white-space:pre-wrap">${esc(message)}</blockquote>
      <p style="color:#777;font-size:13px">Nora Shillings will never ask you for a sign-in link, a secret key, an M-Pesa PIN, or a card security code.</p>
      <p style="color:#777;font-size:13px">Nora Shillings · ${SUPPORT_EMAIL}</p></div>`,
  });

  return send(res, 200, { ok: true });
}
