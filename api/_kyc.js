import { db, HttpError, APP_URL, mailKyc } from "./_lib.js";

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
const KYC_OPEN = new Set(["not_started", "in_progress", "awaiting_user", "resubmitted"]);

const tidy = (s) => {
  const t = String(s || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : t;
};

function decisionStatus(d) {
  return statusOf(d?.status_override || d?.status);
}

function belongsToUser(d, user) {
  if (!d?.session_id || d.session_id !== user.kyc_session) return false;
  if (d.vendor_data == null || d.vendor_data === "") return true;
  return String(d.vendor_data) === String(user.id);
}

function personFromDecision(d) {
  const docs = Array.isArray(d.id_verifications) ? d.id_verifications : [];
  const doc = docs.find((v) => statusOf(v.status) === "approved") || docs[0] || {};
  const name = tidy(doc.full_name || [doc.first_name, doc.last_name].filter(Boolean).join(" ")) || null;
  const country = tidy(doc.issuing_state_name || doc.nationality || doc.issuing_state) || null;
  return { name, country };
}

export async function startKyc(user) {
  if (!kycReady()) throw new HttpError(503, "Identity checks are not switched on yet. Try again later.");
  if (user.verified_at) throw new HttpError(400, "You are already verified.");

  /* Reuse an unfinished Didit session so "Continue" opens the same check instead of starting over. */
  if (user.kyc_session && KYC_OPEN.has(statusOf(user.kyc_status))) {
    try {
      const d = await didit(`/session/${encodeURIComponent(user.kyc_session)}/decision/`);
      const status = decisionStatus(d);
      if (belongsToUser(d, user) && KYC_OPEN.has(status) && d.session_url) {
        await db()`UPDATE users SET kyc_status = ${status} WHERE id = ${user.id} AND kyc_session = ${d.session_id}`;
        return d.session_url;
      }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  }

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
  let d;
  try {
    d = await didit(`/session/${encodeURIComponent(user.kyc_session)}/decision/`);
  } catch (err) {
    /* Status polls must not fail the dashboard when Didit blips; keep the last known state. */
    if (err instanceof HttpError) return user;
    throw err;
  }
  if (!belongsToUser(d, user)) return user;
  const status = decisionStatus(d);
  const sql = db();
  let changed;
  if (status === "approved") {
    const { name, country } = personFromDecision(d);
    [changed] = await sql`UPDATE users SET kyc_status = 'approved',
        name = COALESCE(${name}, name), country = COALESCE(${country}, country), verified_at = now()
      WHERE id = ${user.id} AND kyc_session = ${d.session_id} AND verified_at IS NULL RETURNING *`;
  } else {
    [changed] = await sql`UPDATE users SET kyc_status = ${status}
      WHERE id = ${user.id} AND kyc_session = ${d.session_id} AND kyc_status IS DISTINCT FROM ${status} RETURNING *`;
  }
  /* The webhook and the dashboard can sync at the same moment; only the update that changed the row sends mail. */
  if (changed && (status === "approved" || status === "declined")) {
    await mailKyc(changed.email, status, changed).catch((err) => console.error("[mail] kyc", err.message));
  }
  const [fresh] = await sql`SELECT * FROM users WHERE id = ${user.id}`;
  return fresh || user;
}

export async function kycWebhook(payload) {
  const id = String(payload?.session_id || payload?.decision?.session_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  const sql = db();
  let [user] = await sql`SELECT * FROM users WHERE kyc_session = ${id}`;
  /* If the stored session was overwritten by a retry, still match on the Didit vendor_data (our user id). */
  if (!user) {
    const vendor = String(payload?.vendor_data || payload?.decision?.vendor_data || "");
    if (/^[0-9a-f-]{36}$/i.test(vendor)) {
      [user] = await sql`SELECT * FROM users WHERE id = ${vendor}::uuid AND verified_at IS NULL`;
      if (user) await sql`UPDATE users SET kyc_session = ${id} WHERE id = ${user.id} AND verified_at IS NULL`;
    }
  }
  if (user && !user.verified_at) {
    user.kyc_session = id;
    await syncKyc(user);
  }
}
