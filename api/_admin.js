import { db, send, fail, body, mailAdmin, mailWithdrawal, APP_URL } from "./_lib.js";
import { usdToKes, failWithdrawal } from "./_pay.js";

/* Every live withdrawal needs a person: an admin sends it by hand from PayPal or M-Pesa, then marks it sent here. */

const admins = () => String(process.env.NSH_ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
export const isAdmin = (user) => Boolean(user?.email) && admins().includes(String(user.email).toLowerCase());

const view = (w) => ({
  id: w.id,
  method: w.method,
  destination: w.destination,
  amount: Number(w.amount),
  kes: usdToKes(Number(w.amount) / 100),
  status: w.status,
  failure: w.failure,
  receipt: w.receipt,
  created_at: w.created_at,
  paid_at: w.paid_at,
  refunded_at: w.refunded_at,
  user: { name: w.name, email: w.email, country: w.country, verified: Boolean(w.verified_at) },
});

export async function notifyWithdrawal(w) {
  const usd = (Number(w.amount) / 100).toFixed(2);
  const nsh = `${Number(w.amount).toLocaleString("en-US")} NSH`;
  const who = w.user ? `${w.user} asked` : "A user asked";
  const after = `then open ${APP_URL}/admin and enter the ${w.method === "M-Pesa" ? "M-Pesa code" : "PayPal transaction ID"} to mark it sent. If you can't send it, return it to their wallet from the same page.\n\nWithdrawal: ${w.id}`;
  const [subject, text] = w.method === "M-Pesa"
    ? [`Approve M-Pesa withdrawal: KES ${usdToKes(Number(w.amount) / 100).toLocaleString("en-US")} to ${w.destination}`,
      `${who} to withdraw ${nsh} ($${usd}) to M-Pesa ${w.destination}.\n\nSend KES ${usdToKes(Number(w.amount) / 100).toLocaleString("en-US")} from M-Pesa, ${after}`]
    : w.method === "PayPal"
      ? [`Approve PayPal withdrawal: $${usd} to ${w.destination}`,
        `${who} to withdraw ${nsh} ($${usd}) to PayPal ${w.destination}.\n\nIn PayPal choose Send, enter ${w.destination} and $${usd} USD, ${after}`]
      : [`Approve ${w.method} withdrawal: $${usd} to ${w.destination}`, `${who} to withdraw ${nsh} ($${usd}) to ${w.method} ${w.destination}.\n\nSend it, ${after}`];
  await mailAdmin(subject, text).catch(() => {});
}

async function withUser(sql, id) {
  const [w] = await sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ${id}`;
  return w;
}

export async function adminHandler(route, req, res, user) {
  if (!isAdmin(user)) fail(403, "This page is only for Nora admins.");
  const sql = db();

  if (route === "admin/withdrawals" && req.method === "GET") {
    const [open, recent] = await Promise.all([
      sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.mode = 'live' AND w.status IN ('pending', 'review') ORDER BY w.created_at`,
      sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.mode = 'live' AND w.status NOT IN ('pending', 'review')
        ORDER BY coalesce(w.paid_at, w.refunded_at, w.created_at) DESC LIMIT 30`,
    ]);
    return send(res, 200, { open: open.map(view), recent: recent.map(view) });
  }

  if (route === "admin/withdrawals/approve" && req.method === "POST") {
    const b = await body(req);
    const id = String(b.id || "");
    const receipt = String(b.receipt || "").replace(/\s/g, "").toUpperCase();
    const [{ method } = {}] = await sql`SELECT method FROM withdrawals WHERE id = ${id}`;
    if (!/^[A-Z0-9]{8,20}$/.test(receipt)) {
      fail(400, method === "PayPal"
        ? "Enter the PayPal transaction ID from the payment details, like 5TY05013RG002845M."
        : "Enter the M-Pesa confirmation code from the SMS, like SJK3H2ABCD.");
    }
    const [used] = await sql`SELECT id FROM withdrawals WHERE receipt = ${receipt} AND id <> ${id} LIMIT 1`;
    if (used) fail(400, "That code is already on another withdrawal. Check it and try again.");
    const [w] = await sql`UPDATE withdrawals SET status = 'paid', receipt = ${receipt}, paid_at = now()
      WHERE id = ${id} AND mode = 'live' AND status IN ('pending', 'review') RETURNING id`;
    if (!w) fail(409, "Someone already handled this withdrawal. Refresh the list.");
    const full = await withUser(sql, id);
    await mailWithdrawal(full.email, full, "paid").catch((err) => console.error("[admin] mail", err.message));
    return send(res, 200, { ok: true, withdrawal: view(full) });
  }

  if (route === "admin/withdrawals/return" && req.method === "POST") {
    const b = await body(req);
    const id = String(b.id || "");
    const why = String(b.reason || "").trim().slice(0, 200) || "We couldn’t send this withdrawal.";
    const w = await failWithdrawal(id, `${why.replace(/\.?$/, ".")} Your money is back in your wallet.`);
    if (!w) fail(409, "Someone already handled this withdrawal. Refresh the list.");
    const full = await withUser(sql, id);
    await mailWithdrawal(full.email, full, "returned").catch((err) => console.error("[admin] mail", err.message));
    return send(res, 200, { ok: true, withdrawal: view(full) });
  }

  fail(404, "Unknown admin route.");
}
