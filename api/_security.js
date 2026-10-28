import crypto from "node:crypto";
import QRCode from "qrcode";
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  db, send, fail, body, sha, secret, seal, unseal, clientIp, sessionCookie, mailSecurity, webhookSecret, isMode,
  APP_URL, SESSION_DAYS,
} from "./_lib.js";

const STEP_UP_MINUTES = 15;
const MAX_FAILS = 5;
const rp = () => { const u = new URL(APP_URL); return { id: u.hostname, origin: u.origin }; };

/* ---------- who has what ---------- */

export const hasMfa = (u) => Boolean(u?.totp_enabled_at || u?.has_passkey);
export const methodsOf = (u) => ({
  totp: Boolean(u?.totp_enabled_at),
  passkey: Boolean(u?.has_passkey),
  recovery: (u?.recovery_codes || []).length > 0,
});

/** Live money leaving an account: refused while the account is on hold, and needs a fresh second factor when 2FA is on. */
export function guardMoneyOut(user, mode) {
  if (mode !== "live") return;
  if (user.frozen_at) fail(423, "This account is on hold while we review it. Contact supportnorashillings@benuru.com.");
  requireStepUp(user);
}

export function requireStepUp(user) {
  if (!hasMfa(user)) return;
  const at = user.session_mfa_at ? new Date(user.session_mfa_at).getTime() : 0;
  if (Date.now() - at > STEP_UP_MINUTES * 60000) {
    fail(403, "Confirm it’s you to continue.", { code: "mfa_required", methods: methodsOf(user) });
  }
}

export function requireMfaSetup(user, what) {
  if (!hasMfa(user)) fail(403, `Turn on two-step sign-in in Account before ${what}.`, { code: "mfa_setup_required" });
}

/* ---------- log and limits ---------- */

const ua = (req) => String(req.headers["user-agent"] || "").slice(0, 200);

async function logEvent(userId, req, type, detail = null) {
  await db()`INSERT INTO security_events (user_id, type, ip, user_agent, detail)
    VALUES (${userId}, ${type}, ${clientIp(req)}, ${ua(req)}, ${detail ? JSON.stringify(detail) : null})`
    .catch((err) => console.error("[security] log", err));
}

async function checkFailures(userId) {
  const [r] = await db()`SELECT count(*)::int AS n FROM security_events
    WHERE user_id = ${userId} AND type = 'mfa_failed' AND created_at > now() - interval '15 minutes'`;
  if (r.n >= MAX_FAILS) fail(429, "Too many wrong codes. Wait 15 minutes and try again.");
}

async function alert(user, title, lead) {
  await mailSecurity(user.email, title, lead).catch((err) => console.error("[security] mail", err));
}

/* ---------- one-time challenges (login tickets, setup and passkey challenges) ---------- */

async function newChallenge(purpose, userId, { minutes = 10, challenge = null, data = {} } = {}) {
  const token = secret(32);
  await db()`INSERT INTO auth_challenges (id, user_id, purpose, challenge, data, expires_at)
    VALUES (${sha(token)}, ${userId}, ${purpose}, ${challenge}, ${JSON.stringify(data)}, now() + make_interval(mins => ${minutes}))`;
  return token;
}

async function getChallenge(token, purpose, userId) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ""))) fail(400, "This step has expired. Start again.");
  const [c] = await db()`SELECT * FROM auth_challenges WHERE id = ${sha(token)} AND purpose = ${purpose}
    AND used_at IS NULL AND expires_at > now()`;
  if (!c || (userId && c.user_id !== userId)) fail(400, "This step has expired. Start again.");
  return c;
}

async function useChallenge(c) {
  const done = await db()`UPDATE auth_challenges SET used_at = now() WHERE id = ${c.id} AND used_at IS NULL RETURNING id`;
  if (!done.length) fail(400, "This step was already used. Start again.");
}

/* ---------- authenticator app (TOTP, RFC 6238) ---------- */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}

/** Returns the matching time step, never one at or before the last accepted step (no replays). */
function totpStep(key, code, lastStep) {
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= Number(lastStep)) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

/* ---------- recovery codes ---------- */

const normCode = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const s = b32(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha(`recovery:${normCode(c)}`)) };
}

/* ---------- passkeys (WebAuthn) ---------- */

async function verifyPasskey(response, expectedChallenge, userId) {
  const id = String(response?.id || "");
  const [pk] = id ? await db()`SELECT * FROM passkeys WHERE id = ${id}` : [];
  if (!pk || (userId && pk.user_id !== userId)) fail(400, "This passkey isn’t registered to this account.");
  const { origin, id: rpID } = rp();
  let v = { verified: false };
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.public_key, "base64url")), counter: Number(pk.counter), transports: pk.transports || undefined },
    });
  } catch (err) {
    console.warn("[passkey] verify", err.message);
  }
  if (!v.verified) fail(400, "The passkey check didn’t pass. Try again.");
  await db()`UPDATE passkeys SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now(),
    backed_up = ${v.authenticationInfo.credentialBackedUp} WHERE id = ${pk.id}`;
  return pk;
}

async function passkeyOptions(userId) {
  const keys = userId ? await db()`SELECT id, transports FROM passkeys WHERE user_id = ${userId}` : [];
  if (userId && !keys.length) fail(400, "There are no passkeys on this account.");
  return generateAuthenticationOptions({
    rpID: rp().id,
    userVerification: "required",
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports || undefined })),
  });
}

/* ---------- second factor check (login and step-up) ---------- */

async function checkSecondFactor(req, u, b, passkeyChallenge) {
  await checkFailures(u.id);
  const sql = db();
  if (b.code) {
    const code = String(b.code).replace(/\s/g, "");
    if (u.totp_enabled_at && /^\d{6}$/.test(code)) {
      const step = totpStep(Buffer.from(unseal(u.totp_secret), "base64"), code, u.totp_last_step);
      if (step != null) {
        const ok = await sql`UPDATE users SET totp_last_step = ${step}
          WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
        if (ok.length) return "totp";
      }
    }
  } else if (b.recovery) {
    const hash = sha(`recovery:${normCode(b.recovery)}`);
    const [r] = await sql`UPDATE users SET recovery_codes = array_remove(recovery_codes, ${hash})
      WHERE id = ${u.id} AND ${hash} = ANY(recovery_codes) RETURNING cardinality(recovery_codes) AS left`;
    if (r) {
      await alert(u, "A recovery code was used", `A recovery code was used to sign in or confirm an action. You have ${r.left} left.`);
      return "recovery";
    }
  } else if (b.passkey && passkeyChallenge) {
    await verifyPasskey(b.passkey, passkeyChallenge, u.id);
    return "passkey";
  }
  await logEvent(u.id, req, "mfa_failed");
  fail(400, b.recovery ? "That recovery code isn’t valid or was already used." : "That code isn’t right. Check your authenticator app and try again.");
}

/* ---------- sessions ---------- */

async function startSession(req, userId, method, mfa) {
  const token = secret(32);
  await db()`INSERT INTO sessions (token_hash, user_id, expires_at, method, mfa_at, ip, user_agent)
    VALUES (${sha(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}), ${method}, ${mfa ? new Date() : null}, ${clientIp(req)}, ${ua(req)})`;
  return sessionCookie(token, SESSION_DAYS * 86400);
}

const loginUser = async (id) => (await db()`SELECT u.*, EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id) AS has_passkey
  FROM users u WHERE u.id = ${id}`)[0];

/** After an email link: either sign in, or ask for the second step. */
export async function finishLogin(req, res, userId, extra = {}) {
  const u = await loginUser(userId);
  if (hasMfa(u)) {
    const ticket = await newChallenge("mfa", u.id, { minutes: 10 });
    return send(res, 200, { ...extra, mfa: true, ticket, methods: methodsOf(u) });
  }
  const cookie = await startSession(req, u.id, "email", false);
  await logEvent(u.id, req, "login", { method: "email" });
  send(res, 200, { ...extra, ok: true }, { "Set-Cookie": cookie });
}

async function mfaPasskeyOptions(req, res) {
  const b = await body(req);
  const c = await getChallenge(b.ticket, "mfa");
  const options = await passkeyOptions(c.user_id);
  await db()`UPDATE auth_challenges SET challenge = ${options.challenge} WHERE id = ${c.id}`;
  send(res, 200, { options });
}

async function mfaVerify(req, res) {
  const b = await body(req);
  const c = await getChallenge(b.ticket, "mfa");
  if (c.attempts >= MAX_FAILS) fail(429, "Too many tries. Request a new sign-in link.");
  await db()`UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ${c.id}`;
  const u = await loginUser(c.user_id);
  const method = await checkSecondFactor(req, u, b, c.challenge);
  await useChallenge(c);
  const cookie = await startSession(req, u.id, `email+${method}`, true);
  await logEvent(u.id, req, "login", { method: `email+${method}` });
  send(res, 200, { ok: true }, { "Set-Cookie": cookie });
}

async function passkeyLoginOptions(req, res) {
  const options = await passkeyOptions(null);
  const ticket = await newChallenge("passkey-login", null, { minutes: 5, challenge: options.challenge });
  send(res, 200, { ticket, options });
}

async function passkeyLogin(req, res) {
  const b = await body(req);
  const c = await getChallenge(b.ticket, "passkey-login");
  const pk = await verifyPasskey(b.response, c.challenge, null);
  await useChallenge(c);
  const cookie = await startSession(req, pk.user_id, "passkey", true);
  await db()`UPDATE users SET last_login_at = now() WHERE id = ${pk.user_id}`;
  await logEvent(pk.user_id, req, "login", { method: "passkey" });
  send(res, 200, { ok: true }, { "Set-Cookie": cookie });
}

/* ---------- settings (signed in) ---------- */

const EVENT_LABEL = {
  login: "Signed in",
  mfa_failed: "Wrong code entered",
  step_up: "Confirmed it was you",
  totp_on: "Authenticator app turned on",
  totp_off: "Authenticator app turned off",
  passkey_added: "Passkey added",
  passkey_removed: "Passkey removed",
  recovery_new: "New recovery codes made",
  sessions_revoked: "Logged out other devices",
  admin_enroll: "Admin face lock set up",
  admin_unlock: "Opened the admin console",
  admin_face_failed: "Failed admin face scan",
  admin_action: "Admin action",
};

async function overview(req, res, { needUser }) {
  const user = await needUser(req);
  const sql = db();
  const [keys, events, [sessions]] = await Promise.all([
    sql`SELECT id, name, created_at, last_used_at, backed_up FROM passkeys WHERE user_id = ${user.id} ORDER BY created_at`,
    sql`SELECT type, ip, user_agent, detail, created_at FROM security_events WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 12`,
    sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user.id} AND expires_at > now()`,
  ]);
  send(res, 200, {
    mfa: hasMfa(user),
    totp: Boolean(user.totp_enabled_at),
    totp_since: user.totp_enabled_at,
    passkeys: keys.map((k) => ({ id: k.id, name: k.name, created: k.created_at, last_used: k.last_used_at, synced: Boolean(k.backed_up) })),
    recovery_left: (user.recovery_codes || []).length,
    sessions: sessions.n,
    frozen: Boolean(user.frozen_at),
    events: events.map((e) => ({
      type: e.type, label: EVENT_LABEL[e.type] || e.type, method: e.detail?.method || null,
      ip: e.ip, device: e.user_agent, at: e.created_at,
    })),
  });
}

async function issueRecovery(userId) {
  const { codes, hashes } = newRecoveryCodes();
  await db()`UPDATE users SET recovery_codes = ${hashes} WHERE id = ${userId}`;
  return codes;
}

async function totpSetup(req, res, { needUser }) {
  const user = await needUser(req);
  if (user.totp_enabled_at) fail(400, "The authenticator app is already on.");
  requireStepUp(user);
  const key = crypto.randomBytes(20);
  const label = encodeURIComponent(`Nora Shillings:${user.email}`);
  const uri = `otpauth://totp/${label}?secret=${b32(key)}&issuer=${encodeURIComponent("Nora Shillings")}&algorithm=SHA1&digits=6&period=30`;
  const setup = await newChallenge("totp-setup", user.id, { minutes: 15, data: { key: seal(key.toString("base64")) } });
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } });
  send(res, 200, { setup, secret: b32(key).replace(/(.{4})/g, "$1 ").trim(), uri, qr });
}

async function totpEnable(req, res, { needUser }) {
  const user = await needUser(req);
  const b = await body(req);
  const c = await getChallenge(b.setup, "totp-setup", user.id);
  const code = String(b.code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) fail(400, "Enter the 6-digit code from your authenticator app.");
  const keyB64 = unseal(c.data.key);
  const step = totpStep(Buffer.from(keyB64, "base64"), code, null);
  if (step == null) fail(400, "That code isn’t right. Make sure your phone’s time is set automatically, then try the newest code.");
  await useChallenge(c);
  const sql = db();
  const [u] = await sql`UPDATE users SET totp_secret = ${seal(keyB64)}, totp_enabled_at = now(), totp_last_step = ${step}
    WHERE id = ${user.id} AND totp_enabled_at IS NULL RETURNING recovery_codes`;
  if (!u) fail(409, "The authenticator app is already on.");
  const codes = (u.recovery_codes || []).length ? null : await issueRecovery(user.id);
  await sql`UPDATE sessions SET mfa_at = now() WHERE token_hash = ${sha(user.session_token)}`;
  await logEvent(user.id, req, "totp_on");
  await alert(user, "Two-step sign-in is on", "An authenticator app was added to your account. You’ll be asked for a code when you sign in with an email link and before sending or withdrawing live money.");
  send(res, 200, { ok: true, recovery_codes: codes });
}

async function afterMethodRemoved(userId) {
  const u = await loginUser(userId);
  if (!hasMfa(u)) await db()`UPDATE users SET recovery_codes = NULL WHERE id = ${userId}`;
}

async function totpDisable(req, res, { needUser }) {
  const user = await needUser(req);
  if (!user.totp_enabled_at) fail(400, "The authenticator app is not on.");
  requireStepUp(user);
  await db()`UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ${user.id}`;
  await afterMethodRemoved(user.id);
  await logEvent(user.id, req, "totp_off");
  await alert(user, "Authenticator app removed", "The authenticator app was turned off for your account.");
  send(res, 200, { ok: true });
}

async function passkeyAddOptions(req, res, { needUser }) {
  const user = await needUser(req);
  requireStepUp(user);
  const keys = await db()`SELECT id, transports FROM passkeys WHERE user_id = ${user.id}`;
  if (keys.length >= 10) fail(400, "You can have up to 10 passkeys. Remove one first.");
  const options = await generateRegistrationOptions({
    rpName: "Nora Shillings",
    rpID: rp().id,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: keys.map((k) => ({ id: k.id, transports: k.transports || undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const ticket = await newChallenge("passkey-add", user.id, { minutes: 5, challenge: options.challenge });
  send(res, 200, { ticket, options });
}

async function passkeyAdd(req, res, { needUser }) {
  const user = await needUser(req);
  const b = await body(req);
  const c = await getChallenge(b.ticket, "passkey-add", user.id);
  const { origin, id: rpID } = rp();
  let v = { verified: false };
  try {
    v = await verifyRegistrationResponse({
      response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (err) {
    console.warn("[passkey] register", err.message);
  }
  if (!v.verified) fail(400, "The passkey couldn’t be added. Try again.");
  await useChallenge(c);
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const name = String(b.name || "").trim().replace(/[<>]/g, "").slice(0, 40) || "Passkey";
  const sql = db();
  const added = await sql`INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, device_type, backed_up)
    VALUES (${credential.id}, ${user.id}, ${Buffer.from(credential.publicKey).toString("base64url")}, ${credential.counter},
      ${credential.transports || null}, ${name}, ${credentialDeviceType}, ${credentialBackedUp})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (!added.length) fail(409, "That passkey is already registered.");
  const codes = (user.recovery_codes || []).length ? null : await issueRecovery(user.id);
  await sql`UPDATE sessions SET mfa_at = now() WHERE token_hash = ${sha(user.session_token)}`;
  await logEvent(user.id, req, "passkey_added", { name });
  await alert(user, "A passkey was added", `The passkey “${name}” was added to your account. You can now sign in with it, and it works as your second step.`);
  send(res, 200, { ok: true, recovery_codes: codes });
}

async function passkeyRemove(req, res, { needUser }) {
  const user = await needUser(req);
  requireStepUp(user);
  const id = String((await body(req)).id || "");
  const [pk] = await db()`DELETE FROM passkeys WHERE id = ${id} AND user_id = ${user.id} RETURNING name`;
  if (!pk) fail(404, "That passkey isn’t on this account.");
  await afterMethodRemoved(user.id);
  await logEvent(user.id, req, "passkey_removed", { name: pk.name });
  await alert(user, "A passkey was removed", `The passkey “${pk.name}” can no longer be used to sign in.`);
  send(res, 200, { ok: true });
}

async function recoveryRegenerate(req, res, { needUser }) {
  const user = await needUser(req);
  requireMfaSetup(user, "making recovery codes");
  requireStepUp(user);
  const codes = await issueRecovery(user.id);
  await logEvent(user.id, req, "recovery_new");
  await alert(user, "New recovery codes", "New recovery codes were made for your account. The old ones no longer work.");
  send(res, 200, { recovery_codes: codes });
}

async function revokeOthers(req, res, { needUser }) {
  const user = await needUser(req);
  const gone = await db()`DELETE FROM sessions WHERE user_id = ${user.id} AND token_hash <> ${sha(user.session_token)} RETURNING 1`;
  await logEvent(user.id, req, "sessions_revoked", { count: gone.length });
  send(res, 200, { ok: true, revoked: gone.length });
}

async function stepUpOptions(req, res, { needUser }) {
  const user = await needUser(req);
  const options = await passkeyOptions(user.id);
  const ticket = await newChallenge("step-up", user.id, { minutes: 5, challenge: options.challenge });
  send(res, 200, { ticket, options });
}

async function stepUp(req, res, { needUser }) {
  const user = await needUser(req);
  if (!hasMfa(user)) return send(res, 200, { ok: true });
  const b = await body(req);
  let challenge = null;
  let c = null;
  if (b.passkey) {
    c = await getChallenge(b.ticket, "step-up", user.id);
    challenge = c.challenge;
  }
  const method = await checkSecondFactor(req, user, b, challenge);
  if (c) await useChallenge(c);
  await db()`UPDATE sessions SET mfa_at = now() WHERE token_hash = ${sha(user.session_token)}`;
  await logEvent(user.id, req, "step_up", { method });
  send(res, 200, { ok: true });
}

async function webhookSigningSecret(req, res, { needUser }) {
  const user = await needUser(req);
  const mode = new URL(req.url, "http://local").searchParams.get("mode");
  if (!isMode(mode)) fail(400, "Choose Sandbox or Live.");
  if (mode === "live") requireStepUp(user);
  send(res, 200, { mode, secret: webhookSecret(user.id, mode) });
}

const ROUTES = {
  "POST auth/mfa": mfaVerify,
  "POST auth/mfa/passkey": mfaPasskeyOptions,
  "POST auth/passkey/options": passkeyLoginOptions,
  "POST auth/passkey/verify": passkeyLogin,
  "GET security": overview,
  "POST security/totp/setup": totpSetup,
  "POST security/totp/enable": totpEnable,
  "POST security/totp/disable": totpDisable,
  "POST security/passkeys/options": passkeyAddOptions,
  "POST security/passkeys/add": passkeyAdd,
  "POST security/passkeys/remove": passkeyRemove,
  "POST security/recovery": recoveryRegenerate,
  "POST security/sessions/revoke": revokeOthers,
  "POST security/step-up/options": stepUpOptions,
  "POST security/step-up": stepUp,
  "GET dev/webhook/secret": webhookSigningSecret,
};
export const securityHandler = (method, route) => ROUTES[`${method} ${route}`];
