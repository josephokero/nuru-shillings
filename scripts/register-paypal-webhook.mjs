import fs from "node:fs";

const envText = fs.readFileSync(".env", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const base = String(process.env.PAYPAL_MODE).toLowerCase() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const url = process.argv[2] || "https://norashillings.benuru.com/api/webhooks/paypal";
const events = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
];

const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
const t = await fetch(`${base}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
}).then((r) => r.json());
if (!t.access_token) throw new Error("PayPal sign-in failed. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
const headers = { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" };

const list = await fetch(`${base}/v1/notifications/webhooks`, { headers }).then((r) => r.json());
let hook = list.webhooks?.find((w) => w.url === url);
if (hook) {
  console.log("Webhook already registered for", url);
} else {
  const r = await fetch(`${base}/v1/notifications/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, event_types: events.map((name) => ({ name })) }),
  });
  hook = await r.json();
  if (!r.ok) throw new Error(`PayPal refused the webhook: ${hook.name || r.status} ${hook.details?.[0]?.description || hook.message || ""}`);
  console.log("Webhook registered for", url);
}
console.log("Events:", hook.event_types?.map((e) => e.name).join(", "));

const line = `NSH_PAYPAL_WEBHOOK_ID=${hook.id}`;
const next = /^NSH_PAYPAL_WEBHOOK_ID=.*$/m.test(envText)
  ? envText.replace(/^NSH_PAYPAL_WEBHOOK_ID=.*$/m, line)
  : `${envText.replace(/\s*$/, "")}\n${line}\n`;
fs.writeFileSync(".env", next);
console.log("Saved NSH_PAYPAL_WEBHOOK_ID to .env. Add the same value in Vercel:", hook.id);
