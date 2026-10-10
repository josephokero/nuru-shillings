import { db, HttpError, APP_URL, mailReceipt } from "./_lib.js";

/* ---------- config ---------- */

const env = (k) => String(process.env[k] || "").trim();
export const paypalReady = () => Boolean(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET"));
export const payheroReady = () => Boolean((env("PAYHERO_BASIC_TOKEN") || (env("PAYHERO_USERNAME") && env("PAYHERO_PASSWORD"))) && env("PAYHERO_CHANNEL_ID"));
export const kesPerUsd = () => Number(env("MPESA_USD_KES_RATE")) || 129;
export const usdToKes = (usd) => Math.max(1, Math.ceil(usd * kesPerUsd()));
const paypalBase = () => (env("PAYPAL_MODE").toLowerCase() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const publicBase = () => (APP_URL.startsWith("https://") ? APP_URL : "https://norashillings.benuru.com");

export const METHOD_LABEL = { paypal: "PayPal", card: "Card", mpesa: "M-Pesa" };

export function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("254") && d.length === 12) return d;
  if (d.startsWith("0") && d.length === 10) return `254${d.slice(1)}`;
  if ((d.startsWith("7") || d.startsWith("1")) && d.length === 9) return `254${d}`;
  throw new HttpError(400, "Enter a Safaricom number like 0712 345 678.");
}
export const prettyPhone = (p) => (p && p.length === 12 ? `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p || "");

/* ---------- PayPal (wallet and guest card checkout) ---------- */

let ppToken = { value: "", until: 0 };
async function paypalToken() {
  if (ppToken.value && Date.now() < ppToken.until) return ppToken.value;
  const auth = Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    console.error("[paypal] auth", r.status, j.error_description || j.error);
    throw new HttpError(502, "PayPal is not reachable right now. Try again in a minute.");
  }
  ppToken = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3000) - 120) * 1000 };
  return ppToken.value;
}

async function pp(path, init = {}) {
  const r = await fetch(`${paypalBase()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await paypalToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(25000),
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}

export async function paypalCreateOrder(t) {
  const card = t.method === "card";
  const experience = {
    brand_name: "Nuru Shillings",
    landing_page: card ? "GUEST_CHECKOUT" : "LOGIN",
    user_action: "PAY_NOW",
    shipping_preference: "NO_SHIPPING",
    payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
    return_url: `${APP_URL}/api/topup/paypal/return?t=${t.id}`,
    cancel_url: `${APP_URL}/api/topup/paypal/cancel?t=${t.id}`,
  };
  const r = await pp("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": t.id, Prefer: "return=representation" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: t.id,
        custom_id: t.id,
        invoice_id: t.id,
        description: `Nuru Shillings wallet top-up (${Number(t.nsh).toLocaleString("en-US")} NSH)`,
        soft_descriptor: "NURU SHILLINGS",
        amount: { currency_code: "USD", value: Number(t.usd).toFixed(2) },
      }],
      payment_source: { paypal: { experience_context: experience } },
    }),
  });
  const url = r.json.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  if (!r.ok || !r.json.id || !url) {
    console.error("[paypal] create", r.status, JSON.stringify(r.json).slice(0, 400));
    throw new HttpError(502, "PayPal could not start the checkout. Try again.");
  }
  return { orderId: r.json.id, url };
}

function captureOf(order) {
  const unit = order?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  return {
    orderStatus: order?.status,
    captureId: cap?.id || null,
    captureStatus: cap?.status || null,
    value: cap?.amount?.value || unit?.amount?.value || null,
    currency: cap?.amount?.currency_code || unit?.amount?.currency_code || null,
    customId: cap?.custom_id || unit?.custom_id || unit?.reference_id || null,
    payer: order?.payer?.email_address || order?.payment_source?.paypal?.email_address || null,
    cardLast4: order?.payment_source?.card?.last_digits || null,
  };
}

export async function paypalGetOrder(orderId) {
  const r = await pp(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  return r.ok ? captureOf(r.json) : null;
}

const DECLINES = {
  INSTRUMENT_DECLINED: "Your card or PayPal funding source was declined. Try another card or method.",
  PAYER_ACTION_REQUIRED: "PayPal needs you to finish the payment first.",
  ORDER_NOT_APPROVED: "The payment was not approved on PayPal.",
  TRANSACTION_REFUSED: "PayPal refused this payment. Try another method.",
};

export async function paypalCapture(orderId) {
  const r = await pp(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { "PayPal-Request-Id": `cap-${orderId}`, Prefer: "return=representation" },
    body: "{}",
  });
  if (r.ok) return { ...captureOf(r.json) };
  const issue = r.json?.details?.[0]?.issue || r.json?.name || "";
  if (issue === "ORDER_ALREADY_CAPTURED") return paypalGetOrder(orderId);
  console.error("[paypal] capture", r.status, issue, JSON.stringify(r.json).slice(0, 300));
  return { failed: true, reason: DECLINES[issue] || "PayPal could not complete the payment. Try again." };
}

export async function paypalVerifyWebhook(req, event) {
  const webhookId = env("NSH_PAYPAL_WEBHOOK_ID");
  if (!webhookId) return null;
  const h = (k) => req.headers[k] || "";
  const r = await pp("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    }),
  });
  return r.ok && r.json.verification_status === "SUCCESS";
}

/* ---------- PayHero (M-Pesa STK push) ---------- */

function payheroAuth() {
  const t = env("PAYHERO_BASIC_TOKEN");
  if (t) return t.startsWith("Basic ") ? t : `Basic ${t}`;
  return `Basic ${Buffer.from(`${env("PAYHERO_USERNAME")}:${env("PAYHERO_PASSWORD")}`).toString("base64")}`;
}

export async function payheroStk(t) {
  const payload = {
    amount: t.kes,
    phone_number: t.phone,
    channel_id: Number(env("PAYHERO_CHANNEL_ID")) || env("PAYHERO_CHANNEL_ID"),
    provider: "m-pesa",
    external_reference: t.id,
    customer_name: "Nuru Shillings",
    callback_url: env("NSH_PAYHERO_CALLBACK_URL") || `${publicBase()}/api/webhooks/payhero`,
  };
  const r = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
    method: "POST",
    headers: { Authorization: payheroAuth(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    console.error("[payhero] stk", r.status, JSON.stringify(j).slice(0, 300));
    throw new HttpError(502, j.error_message || j.message || "M-Pesa could not send the prompt. Check the number and try again.");
  }
  return { reference: j.reference ? String(j.reference) : null, checkoutRequestId: j.CheckoutRequestID || null };
}

const MPESA_CODES = {
  1: "Your M-Pesa balance is too low for this payment.",
  1032: "You cancelled the M-Pesa prompt.",
  1037: "The prompt timed out before a PIN was entered.",
  2001: "The M-Pesa PIN was wrong.",
  1025: "M-Pesa could not send the prompt. Try again.",
  9999: "M-Pesa could not send the prompt. Try again.",
  1019: "The prompt expired before it was completed.",
};
export const mpesaReason = (code, desc) => MPESA_CODES[Number(code)] || (desc ? String(desc) : "The M-Pesa payment was not completed.");

export async function payheroStatus(reference) {
  if (!reference) return { done: false };
  const r = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`, {
    headers: { Authorization: payheroAuth() },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!r?.ok) return { done: false };
  const j = await r.json().catch(() => ({}));
  const status = String(j.status || "").toUpperCase();
  if (status === "SUCCESS" || status === "COMPLETED") {
    return { done: true, success: true, receipt: String(j.provider_reference || j.third_party_reference || j.mpesa_receipt_number || "").trim() || null, raw: j };
  }
  if (["FAILED", "CANCELLED", "CANCELED", "REVERSED"].includes(status)) {
    return { done: true, success: false, reason: mpesaReason(j.result_code ?? j.ResultCode, j.result_desc || j.ResultDesc || j.message), raw: j };
  }
  return { done: false };
}

/* ---------- top-up lifecycle ---------- */

export function publicTopup(t) {
  return {
    id: t.id,
    method: t.method,
    method_label: METHOD_LABEL[t.method],
    mode: t.mode,
    usd: Number(t.usd),
    nsh: Number(t.nsh),
    kes: t.kes ? Number(t.kes) : null,
    phone: t.phone ? prettyPhone(t.phone) : null,
    status: t.status,
    failure: t.failure,
    receipt: t.receipt,
    payer: t.meta?.payer || null,
    card_last4: t.meta?.card_last4 || null,
    created: t.created_at,
    paid: t.paid_at,
  };
}

/** Credit exactly once: only the call that flips the row to paid moves money and sends the receipt. */
export async function completeTopup(id, { receipt, meta = {} }) {
  const sql = db();
  const [t] = await sql`WITH t AS (
      UPDATE topups SET status = 'paid', paid_at = now(), receipt = ${receipt || null}, failure = NULL,
        meta = meta || ${JSON.stringify(meta)}::jsonb
      WHERE id = ${id} AND status IN ('pending', 'failed') RETURNING *
    ), b AS (
      INSERT INTO balances (user_id, mode, amount) SELECT user_id, mode, nsh FROM t
      ON CONFLICT (user_id, mode) DO UPDATE SET amount = balances.amount + EXCLUDED.amount
    ), l AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, method, ref)
      SELECT user_id, mode, 'add', nsh,
        CASE method WHEN 'mpesa' THEN 'M-Pesa top-up' WHEN 'card' THEN 'Card top-up' ELSE 'PayPal top-up' END,
        CASE method WHEN 'mpesa' THEN 'M-Pesa' WHEN 'card' THEN 'Card' ELSE 'PayPal' END, id FROM t
    ) SELECT * FROM t`;
  if (!t) return null;
  await sendReceipt(t.id).catch((err) => console.error("[topup] receipt", err));
  return t;
}

async function sendReceipt(id) {
  const sql = db();
  const [row] = await sql`UPDATE topups SET emailed_at = now() WHERE id = ${id} AND emailed_at IS NULL
    RETURNING *, (SELECT email FROM users WHERE users.id = topups.user_id) AS email,
      (SELECT amount FROM balances WHERE balances.user_id = topups.user_id AND balances.mode = topups.mode) AS balance`;
  if (row?.email) await mailReceipt(row.email, { ...publicTopup(row), balance: Number(row.balance) });
}

export async function failTopup(id, reason, status = "failed") {
  const [t] = await db()`UPDATE topups SET status = ${status}, failure = ${reason}
    WHERE id = ${id} AND status = 'pending' RETURNING *`;
  return t || null;
}

/** Settle a PayPal order from PayPal's own records: capture if approved, credit if completed. */
export async function settlePaypal(t) {
  if (t.status === "paid") return t;
  let cap = await paypalGetOrder(t.provider_ref);
  if (!cap) return t;
  if (cap.orderStatus === "APPROVED") cap = await paypalCapture(t.provider_ref);
  if (cap?.failed) return (await failTopup(t.id, cap.reason)) || t;
  if (cap?.captureStatus === "COMPLETED") {
    const amountOk = cap.currency === "USD" && Number(cap.value) === Number(t.usd) && (!cap.customId || cap.customId === t.id);
    if (!amountOk) {
      console.error("[paypal] amount mismatch", t.id, cap.value, cap.currency, cap.customId);
      return (await failTopup(t.id, "The PayPal amount did not match. Contact support with this receipt number.")) || t;
    }
    return (await completeTopup(t.id, { receipt: cap.captureId, meta: { payer: cap.payer, card_last4: cap.cardLast4, order_status: cap.orderStatus } })) || t;
  }
  if (cap?.captureStatus === "DECLINED" || cap?.captureStatus === "FAILED") {
    return (await failTopup(t.id, "The payment was declined. Try another card or method.")) || t;
  }
  return t;
}

/** Settle an M-Pesa STK from PayHero's own records. */
export async function settleMpesa(t) {
  if (t.status === "paid") return t;
  const s = await payheroStatus(t.meta?.payhero_reference || t.provider_ref);
  if (!s.done) return t;
  if (s.success) {
    const amount = Number(s.raw?.amount ?? s.raw?.Amount ?? t.kes);
    if (amount && amount < Number(t.kes)) {
      return (await failTopup(t.id, "The M-Pesa amount did not match. Contact support with this receipt number.")) || t;
    }
    return (await completeTopup(t.id, { receipt: s.receipt, meta: { settled_by: "status" } })) || t;
  }
  return (await failTopup(t.id, s.reason)) || t;
}
