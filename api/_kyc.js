import { db, HttpError, APP_URL } from "./_lib.js";

/* ---------- identity checks: Didit (ID document + live selfie + face match) ---------- */

const env = (k) => String(process.env[k] || "").trim();
const BASE = "https://verification.didit.me/v3";
export const kycReady = () => Boolean(env("DIDIT_API_KEY") && env("DIDIT_WORKFLOW_ID"));

async function didit(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-api-key": env("DIDIT_API_KEY"), "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("[didit]", path.split("/")[1], r.status, j.detail || j.error || "");
    throw new HttpError(502, "The identity check is not reachable right now. Try again in a minute.");
  }
  return j;
}

/* "Approved", "APPROVED", "In Review", "IN_REVIEW" → approved, in_review */
const statusOf = (s) => String(s || "").trim().toLowerCase().replace(/[\s-]+/g, "_") || "not_started";
export const KYC_DONE = new Set(["approved", "declined", "expired", "abandoned", "kyc_expired"]);

const tidy = (s) => {
  const t = String(s || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : t;
};

export async function startKyc(user) {
  if (!kycReady()) throw new HttpError(503, "Identity checks are not switched on yet. Try again later.");
  if (user.verified_at) throw new HttpError(400, "You are already verified.");
  const s = await didit("/session/", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: env("DIDIT_WORKFLOW_ID"),
      vendor_data: String(user.id),
      callback: `${APP_URL}/dashboard?kyc=1`,
      callback_method: "both",
      language: "en",
    }),
  });
  if (!s.session_id || !s.url) throw new HttpError(502, "The identity check could not start. Try again in a minute.");
  await db()`UPDATE users SET kyc_session = ${s.session_id}, kyc_status = ${statusOf(s.status)} WHERE id = ${user.id}`;
  return s.url;
}

/* Only Didit's own decision record, fetched with our key, can verify an account. */
export async function syncKyc(user) {
  if (!user.kyc_session || !kycReady()) return user;
  const d = await didit(`/session/${encodeURIComponent(user.kyc_session)}/decision/`);
  if (d.session_id !== user.kyc_session || String(d.vendor_data) !== String(user.id)) return user;
  const status = statusOf(d.status);
  const sql = db();
  if (status === "approved") {
    const docs = d.id_verifications || [];
    const doc = docs.find((v) => statusOf(v.status) === "approved") || docs[0] || {};
    const name = tidy(doc.full_name || [doc.first_name, doc.last_name].filter(Boolean).join(" ")) || null;
    const country = tidy(doc.issuing_state_name || doc.nationality || doc.issuing_state) || null;
    const [u] = await sql`UPDATE users SET kyc_status = 'approved',
        name = COALESCE(${name}, name), country = COALESCE(${country}, country), verified_at = COALESCE(verified_at, now())
      WHERE id = ${user.id} AND kyc_session = ${d.session_id} RETURNING *`;
    return u || user;
  }
  const [u] = await sql`UPDATE users SET kyc_status = ${status}
    WHERE id = ${user.id} AND kyc_session = ${d.session_id} RETURNING *`;
  return u || user;
}

export async function kycWebhook(payload) {
  const id = String(payload?.session_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  const [user] = await db()`SELECT * FROM users WHERE kyc_session = ${id}`;
  if (user && !user.verified_at) await syncKyc(user);
}
