(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => el.querySelectorAll(s);
  const { esc, nsh: n } = Nsh;
  const usd = (nshAmount) => (Number(nshAmount || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const money = (nshAmount) => `${n(nshAmount)} NSH`;
  const when = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}, ${time}`;
  };
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} days ago`;
  };
  const mobile = matchMedia("(pointer: coarse)").matches && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    home: svg("M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10"),
    bank: svg("M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z"),
    people: svg("M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8"),
    plus: svg("M12 5v14M5 12h14"),
    store: svg("M4 9h16l-1-5H5L4 9zM5 9v11h14V9M9 20v-6h6v6"),
    apps: svg("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 17h6M17 14v6"),
    shield: svg("M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6l-7-3z"),
    wallet: svg("M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm0 0 2-3h10M16 13.5h.01"),
    code: svg("m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"),
    out: svg("M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"),
    in: svg("M17 7 7 17M16 17H7V8"),
    up: svg("M7 17 17 7M8 7h9v9"),
    clock: svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"),
    back: svg("M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"),
    list: svg("M4 6h16M4 12h16M4 18h10"),
    user: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
    key: svg("M14.5 8.5a4.5 4.5 0 1 1-1.3-3.2M14.5 8.5H21M18 8.5V12M21 8.5V11M3 21l6.5-6.5"),
    left: svg("M15 18l-6-6 6-6"),
  };

  const VIEWS = {
    overview: ["Overview", "Everything on Nora Shillings at a glance"],
    withdrawals: ["Withdrawals", "Send PayPal and M-Pesa withdrawals by hand, then mark them sent"],
    users: ["Users", "Every account, its money and its security"],
    user: ["User", "One account in full"],
    topups: ["Top-ups", "Money people added by PayPal, card and M-Pesa"],
    payments: ["Payments", "Payments businesses took through the API"],
    apps: ["Apps and deposits", "Developer apps and the money users moved into them"],
    security: ["Security log", "Sign-ins, failed codes, face scans and every admin action"],
  };

  let st = null;
  let lockTimer = 0;
  let userFilter = "all";
  let topupMode = "live";
  let payMode = "live";
  let secFilter = "";
  let openCount = 0;

  /* ---------- api ---------- */

  async function call(path, body, retried) {
    let res;
    try {
      res = await fetch(`/api/${path}`, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("You appear to be offline. Check your connection.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === "mfa_required" && !retried) {
      await Nsh.stepUp(data.methods || {});
      return call(path, body, true);
    }
    if (res.status === 423 && data.code === "admin_locked") {
      showGate();
      throw new Error(data.error);
    }
    if (res.status === 404 && data.error === "Not found.") {
      location.href = "/signin?next=admin";
      throw new Error("Log in to continue.");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  /* ---------- face lock ---------- */

  function setGate({ title, lead, steps, button, foot }) {
    $("#gate-title").textContent = title;
    $("#gate-lead").textContent = lead;
    $("#gate-steps").hidden = !steps;
    $("#gate-steps").innerHTML = (steps || []).map((s, i) => `<li><b>${i + 1}</b><span>${esc(s)}</span></li>`).join("");
    $("#gate-btn").hidden = !button;
    $("#gate-btn").textContent = button || "";
    $("#gate-foot").textContent = foot || "";
  }

  function showGate() {
    clearTimeout(lockTimer);
    document.body.classList.remove("side-open");
    $("#app").hidden = true;
    $("#side").hidden = true;
    $("#gate").hidden = false;
    $("#gate-msg").textContent = "";
    $("#gate-msg").className = "msg";
    document.title = "Admin console · Nora Shillings";
    if (!st) return;
    if (!st.enrolled) {
      setGate({
        title: "Set up your face lock",
        lead: "Your phone becomes the only key to this console. You do this once.",
        steps: mobile
          ? ["Tap the button below.", "Look at your phone to confirm with Face ID or face unlock.", "That’s it. You’ll do the same scan every time you open the console."]
          : ["Click the button below. A QR code appears on this screen.", "Open the camera on your phone and scan the QR code.", "Look at your phone to confirm with Face ID or face unlock. Keep Bluetooth on for both devices."],
        button: mobile ? "Set up with my face" : "Connect my phone",
        foot: "The key is saved on your phone and is permanent. It can’t be changed or replaced from the website.",
      });
    } else {
      const k = st.key || {};
      setGate({
        title: "Scan your face to open",
        lead: mobile
          ? "Confirm with Face ID or face unlock on this phone."
          : "Scan the QR code with the phone you set up, then look at it. Next time your phone may get a notification instead of a QR code.",
        button: mobile ? "Scan my face" : "Scan with my phone",
        foot: `Face lock set up ${when(k.created_at)}${k.last_used_at ? ` · last opened ${when(k.last_used_at)}` : ""}.`,
      });
    }
  }

  async function faceCheck() {
    const btn = $("#gate-btn");
    const msg = $("#gate-msg");
    btn.disabled = true;
    $("#gate").classList.add("busy");
    msg.className = "msg";
    msg.textContent = mobile ? "Look at your phone…" : "Scan the QR code with your phone, then look at it…";
    try {
      if (!Nsh.passkey.supported()) throw new Error("This browser can’t do face checks. Use Chrome, Edge or Safari.");
      if (!st.enrolled) {
        const { ticket, options } = await call("admin/face/enroll/options", {});
        if (!mobile) {
          options.hints = ["hybrid"];
          options.authenticatorSelection = { ...options.authenticatorSelection, authenticatorAttachment: "cross-platform" };
        }
        const response = await Nsh.passkey.create(options);
        await call("admin/face/enroll", { ticket, response });
      } else {
        const { ticket, options } = await call("admin/face/unlock/options", {});
        if (!mobile) options.hints = ["hybrid"];
        const response = await Nsh.passkey.get(options);
        await call("admin/face/unlock", { ticket, response });
      }
      msg.className = "msg ok";
      msg.textContent = "Face confirmed.";
      await start();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message === "The passkey request was cancelled or timed out."
        ? "The face scan was cancelled or timed out. Try again."
        : err.message;
    } finally {
      btn.disabled = false;
      $("#gate").classList.remove("busy");
    }
  }

  function showUnlocked() {
    const until = new Date(st.until);
    $("#unlocked-text").textContent = `Unlocked until ${until.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(async () => { st = await call("admin/state").catch(() => st); st.unlocked = false; showGate(); }, Math.max(0, until - Date.now()));
  }

  /* ---------- shell ---------- */

  function sidebar() {
    const link = (view, icon, label, extra = "") => `<a href="#${view}" data-view="${view}">${icon}<span>${label}</span>${extra}</a>`;
    $("#side").innerHTML = `
      <div class="side-head">
        <a class="brand" href="/" aria-label="Nora home">Nora</a>
        <button class="side-close" type="button" aria-label="Close menu">×</button>
      </div>
      <nav class="side-nav">
        <p class="side-label ac-admin">Admin console</p>
        ${link("overview", I.home, "Overview")}
        ${link("withdrawals", I.bank, "Withdrawals", `<span class="ac-count" id="side-open"></span>`)}
        ${link("users", I.people, "Users")}
        ${link("topups", I.plus, "Top-ups")}
        ${link("payments", I.store, "Payments")}
        ${link("apps", I.apps, "Apps and deposits")}
        ${link("security", I.shield, "Security log")}
        <p class="side-label">Leave</p>
        <a href="/dashboard">${I.wallet}<span>My wallet</span></a>
        <a href="/developer">${I.code}<span>Business tools</span></a>
      </nav>
      <div class="side-foot">
        <div class="side-me">
          <span class="side-avatar">${esc(String(st.name || st.email).charAt(0).toUpperCase())}</span>
          <div><b>${esc(st.name || st.email)}</b><span>Admin · face locked</span></div>
          <button type="button" id="logout" aria-label="Log out" title="Log out">${I.out}</button>
        </div>
      </div>`;
    const btn = $("#menu-btn");
    const setOpen = (open) => { document.body.classList.toggle("side-open", open); btn.setAttribute("aria-expanded", String(open)); };
    btn.onclick = () => setOpen(!document.body.classList.contains("side-open"));
    $("#side-scrim").onclick = () => setOpen(false);
    $(".side-close").onclick = () => setOpen(false);
    $$(".side-nav a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
    $("#logout").onclick = async () => {
      await call("auth/logout", {}).catch(() => {});
      location.href = "/signin";
    };
  }

  function setOpenCount(count) {
    openCount = count;
    const el = $("#side-open");
    if (el) el.textContent = count ? String(count) : "";
  }

  function route() {
    const [raw, arg] = location.hash.replace(/^#\/?/, "").split("/");
    const view = Object.hasOwn(VIEWS, raw) ? raw : "overview";
    $$(".view").forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$(".side-nav [data-view]").forEach((a) => {
      const on = a.dataset.view === view || (view === "user" && a.dataset.view === "users");
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const [title, sub] = VIEWS[view];
    $("#view-title").textContent = title;
    $("#view-sub").textContent = sub;
    document.title = `${openCount ? `(${openCount}) ` : ""}${title} · Admin · Nora Shillings`;
    scrollTo({ top: 0, behavior: "instant" });
    load(view, arg);
  }

  const LOADERS = {
    overview: loadOverview,
    withdrawals: loadWithdrawals,
    users: loadUsers,
    user: loadUser,
    topups: loadTopups,
    payments: loadPayments,
    apps: loadApps,
    security: loadSecurity,
  };

  let loading = 0;
  async function load(view, arg) {
    const ticket = ++loading;
    try {
      await LOADERS[view](arg, () => ticket === loading);
    } catch (err) {
      if (ticket !== loading || $("#app").hidden) return;
      const section = $(`.view[data-view="${view}"]`);
      const box = $(".w-list, #user-detail, .ac-open", section);
      if (box) box.innerHTML = empty("Couldn’t load this", err.message);
    }
  }
  const current = () => location.hash.replace(/^#\/?/, "").split("/");
  const reload = () => { const [v, a] = current(); load(Object.hasOwn(VIEWS, v) ? v : "overview", a); };

  /* ---------- rows ---------- */

  const empty = (title, text) => `<li class="w-empty"><span class="w-empty-ico">${I.list}</span><b>${esc(title)}</b><span>${esc(text)}</span></li>`;
  const tag = (label, tone = "") => `<span class="tag ${tone}">${esc(label)}</span>`;

  function row({ icon, tone = "", title, meta, date, status, amount, amountTone = "", sub = "", href = "", act = "" }) {
    return `<li class="w-row"${href ? ` data-href="${esc(href)}"` : ""}>
      <div class="w-tx">
        <span class="w-ico ${tone}">${icon}</span>
        <div class="w-what"><b>${title}</b><span>${meta}</span><span class="w-date-sm">${esc(date)}</span></div>
      </div>
      <span class="w-date">${esc(date)}</span>
      <span class="w-status">${status}</span>
      <div class="w-amt ${amountTone}"><b>${amount}</b>${sub ? `<span>${sub}</span>` : ""}${act}</div>
    </li>`;
  }

  const WD = { pending: ["Waiting", "warn"], review: ["PayPal review", "warn"], paid: ["Sent", "ok"], failed: ["Returned", "bad"], processing: ["Sending", "warn"], unclaimed: ["Awaiting claim", "warn"] };
  const TOP = { paid: ["Paid", "ok"], pending: ["Pending", "warn"], failed: ["Failed", "bad"], reversed: ["Reversed", "bad"], refunded: ["Refunded", ""] };
  const PAY = { paid: ["Paid", "ok"], pending: ["Pending", "warn"], refunded: ["Refunded", ""] };
  const DEP = { succeeded: ["Paid", "ok"], pending: ["Pending", "warn"], declined: ["Declined", "bad"], cancelled: ["Cancelled", ""], expired: ["Expired", ""] };
  const st2 = (map, s) => { const [l, t] = map[s] || [s || "—", ""]; return tag(l, t); };

  function wdRow(w) {
    const mp = w.method === "M-Pesa";
    return row({
      icon: I.up, tone: w.status === "paid" ? "in" : w.status === "failed" ? "bad" : "warn",
      title: `${esc(w.method)} ${esc(w.destination)}`,
      meta: esc([w.user?.name || w.user?.email, w.receipt, w.failure].filter(Boolean).join(" · ")),
      date: when(w.paid_at || w.refunded_at || w.created_at),
      status: st2(WD, w.status),
      amount: mp && w.kes ? `KES ${n(w.kes)}` : usd(w.amount),
      sub: money(w.amount),
      href: w.user?.id ? `#user/${w.user.id}` : "",
    });
  }

  function wdCard(w) {
    const mp = w.method === "M-Pesa";
    const late = Date.now() - new Date(w.created_at) > 8 * 3600e3;
    return `
      <article class="ad-card" data-id="${esc(w.id)}">
        <div class="ad-card-top">
          <div class="ad-amt"><b>${mp ? `KES ${n(w.kes)}` : usd(w.amount)}</b><span>${usd(w.amount)} · ${money(w.amount)}</span></div>
          ${tag(w.status === "review" ? "PayPal review" : late ? "Over 8 hours" : "Waiting", late ? "bad" : "warn")}
        </div>
        <dl class="ad-kv">
          <div><dt>Send</dt><dd>${mp ? `KES ${n(w.kes)} from M-Pesa` : w.method === "PayPal" ? `${usd(w.amount)} USD from PayPal (Send money)` : `${usd(w.amount)} by ${esc(w.method)}`}</dd></div>
          <div><dt>Send to</dt><dd><b class="ad-dest">${esc(w.method)} ${esc(w.destination)}</b><button type="button" class="ad-copy" data-copy="${esc(w.destination)}">Copy</button></dd></div>
          <div><dt>Account</dt><dd><a class="link" href="#user/${esc(w.user.id)}">${esc(w.user.name || w.user.email)}</a>${w.user.verified ? tag("ID verified", "ok") : tag("Not verified", "bad")}</dd></div>
          <div><dt>Email</dt><dd>${esc(w.user.email)}</dd></div>
          <div><dt>Requested</dt><dd>${when(w.created_at)} · ${ago(w.created_at)}</dd></div>
          <div><dt>Withdrawal</dt><dd><code>${esc(w.id)}</code></dd></div>
        </dl>
        <form class="ad-approve">
          <label class="field"><span>${mp ? "M-Pesa code from the SMS" : "PayPal transaction ID"}</span>
            <input class="input" name="receipt" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${mp ? "SJK3H2ABCD" : "5TY05013RG002845M"}"></label>
          <button class="btn primary" type="submit">Mark as sent</button>
        </form>
        <details class="ad-return">
          <summary>Can’t send it? Return it to their wallet</summary>
          <form class="ad-return-form">
            <label class="field"><span>Reason the user will see</span>
              <input class="input" name="reason" maxlength="200" placeholder="${mp ? "That number isn’t registered for M-Pesa." : "That email doesn’t have a PayPal account."}"></label>
            <button class="btn ad-danger" type="submit">Return ${money(w.amount)} to wallet</button>
          </form>
        </details>
        <p class="msg" role="alert"></p>
      </article>`;
  }

  const EVENT = {
    login: "Signed in", mfa_failed: "Wrong code entered", step_up: "Confirmed it was them", totp_on: "Authenticator app on",
    totp_off: "Authenticator app off", passkey_added: "Passkey added", passkey_removed: "Passkey removed", recovery_new: "New recovery codes",
    sessions_revoked: "Logged out other devices", admin_unlock: "Opened the admin console", admin_enroll: "Admin face lock set up",
    admin_face_failed: "Failed admin face scan", admin_action: "Admin action",
  };
  const ACTION = {
    withdrawal_sent: "marked a withdrawal sent", withdrawal_returned: "returned a withdrawal", user_frozen: "put an account on hold",
    user_unfrozen: "took an account off hold", user_signed_out: "signed a user out everywhere", app_removed: "removed an app",
  };
  const device = (ua) => {
    const s = String(ua || "");
    const os = /iPhone|iPad/.test(s) ? "iPhone" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : "";
    const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
    return [br, os].filter(Boolean).join(" on ") || (s ? "Unknown device" : "");
  };

  function eventItem(e, showUser = true) {
    const d = e.detail || {};
    const bad = e.type === "mfa_failed" || e.type === "admin_face_failed";
    const label = e.type === "admin_action" ? `Admin ${ACTION[d.action] || d.action || "action"}` : EVENT[e.type] || e.type;
    const extra = [d.method, d.target, d.reason, d.receipt].filter(Boolean).join(" · ");
    const who = showUser && e.email ? (e.user_id ? `<a class="link" href="#user/${esc(e.user_id)}">${esc(e.email)}</a>` : esc(e.email)) : "";
    return `<li>
      <span class="w-ico ${bad ? "bad" : e.type.startsWith("admin") ? "warn" : ""}">${bad ? I.shield : e.type.startsWith("admin") ? I.key : I.user}</span>
      <div class="w-what"><b>${esc(label)}${extra ? ` · ${esc(extra)}` : ""}</b><span>${[who, esc(e.ip || ""), esc(device(e.user_agent))].filter(Boolean).join(" · ")}</span></div>
      <span class="ac-when">${when(e.created_at)}</span>
    </li>`;
  }

  /* ---------- views ---------- */

  async function loadOverview(_, fresh) {
    const d = await call("admin/overview");
    if (!fresh()) return;
    const t = d.totals;
    setOpenCount(t.wd_open);
    $("#t-users").textContent = n(t.users);
    $("#t-users-sub").textContent = `${n(t.verified)} verified · ${n(t.new_7d)} new this week${t.frozen ? ` · ${n(t.frozen)} on hold` : ""}`;
    $("#t-held").textContent = usd(t.live_balances);
    $("#t-held-sub").textContent = `${money(t.live_balances)} people can withdraw`;
    $("#t-wd").textContent = n(t.wd_open);
    $("#t-wd-sub").textContent = t.wd_open ? `${usd(t.wd_open_amount)} to send` : `${usd(t.wd_paid)} sent so far`;
    $("#t-top").textContent = usd(t.topups_nsh);
    $("#t-top-sub").textContent = `${n(t.topups_paid)} paid · ${usd(t.topups_30d)} last 30 days`;
    $("#t-pay").textContent = usd(t.payments_volume + t.deposits_volume);
    $("#t-pay-sub").textContent = `${n(t.payments_paid)} payments · ${n(t.apps)} apps · ${n(t.connections)} connections`;
    $("#t-fees").textContent = usd(t.payment_fees + t.deposit_fees);
    $("#t-fees-sub").textContent = `${n(t.active_7d)} people active this week`;
    $("#ov-open").innerHTML = d.open.length ? d.open.map(wdRow).join("")
      : empty("Nothing to send", "New PayPal and M-Pesa withdrawals show up here, and you get an email for each one.");
    $("#ov-signups").innerHTML = d.signups.length ? d.signups.map((u) => `<li>
        <span class="w-ico">${I.user}</span>
        <div class="w-what"><b><a href="#user/${esc(u.id)}">${esc(u.name || u.email)}</a></b><span>${esc(u.email)}</span></div>
        ${u.verified_at ? tag("Verified", "ok") : tag("Not verified")}
      </li>`).join("") : empty("No users yet", "New sign-ups show up here.");
    $("#ov-events").innerHTML = d.events.length ? d.events.map((e) => eventItem(e)).join("") : empty("Nothing yet", "Sign-ins and security changes show up here.");
  }

  async function loadWithdrawals(_, fresh) {
    const d = await call("admin/withdrawals");
    if (!fresh()) return;
    setOpenCount(d.open.length);
    $("#wd-open").innerHTML = d.open.length ? d.open.map(wdCard).join("")
      : `<div class="ad-empty"><b>Nothing waiting</b><span>New PayPal and M-Pesa withdrawals show up here, and you get an email for each one.</span></div>`;
    $("#wd-recent").innerHTML = d.recent.length ? d.recent.map(wdRow).join("") : empty("Nothing handled yet", "Sent and returned withdrawals show up here.");
  }

  let searchTimer = 0;
  async function loadUsers(_, fresh) {
    const q = $("#user-q").value.trim();
    const d = await call(`admin/users?filter=${encodeURIComponent(userFilter)}&q=${encodeURIComponent(q)}`);
    if (!fresh()) return;
    $("#users").innerHTML = d.users.length ? d.users.map((u) => row({
      icon: I.user, tone: u.frozen_at ? "bad" : u.verified_at ? "in" : "",
      title: `${esc(u.name || u.email)}${u.admin ? " · admin" : ""}`,
      meta: esc([u.name ? u.email : "", u.country, u.totp || u.passkey ? "2-step on" : "", u.last_login_at ? `last in ${when(u.last_login_at)}` : ""].filter(Boolean).join(" · ")),
      date: when(u.created_at),
      status: u.frozen_at ? tag("On hold", "bad") : u.verified_at ? tag("Verified", "ok") : tag("Not verified"),
      amount: usd(u.live), sub: `${money(u.test)} sandbox`,
      href: `#user/${u.id}`,
    })).join("") : empty("No users found", q ? "Try another search." : "Nobody matches this filter.");
  }

  async function loadUser(id, fresh) {
    const box = $("#user-detail");
    if (!id) { location.hash = "#users"; return; }
    box.innerHTML = `<div class="w-card w-empty"><b>Loading…</b></div>`;
    const d = await call(`admin/user?id=${encodeURIComponent(id)}`);
    if (!fresh()) return;
    const u = d.user;
    $("#view-title").textContent = u.name || u.email;
    $("#view-sub").textContent = u.email;
    document.title = `${u.name || u.email} · Admin · Nora Shillings`;
    const lst = (items, fn, none) => items.length ? items.map(fn).join("") : empty(none, "");
    const ledgerRow = (l) => row({
      icon: l.amount > 0 ? I.in : I.up, tone: l.amount > 0 ? "in" : "",
      title: esc(l.counterparty || l.kind), meta: esc([l.mode === "test" ? "Sandbox" : "Live", l.kind, l.method, l.ref].filter(Boolean).join(" · ")),
      date: when(l.created_at), status: tag(l.status || "done", l.status === "pending" ? "warn" : ""),
      amount: `${l.amount > 0 ? "+" : ""}${money(l.amount)}`, amountTone: l.amount > 0 ? "in" : "",
    });
    box.innerHTML = `
      <a class="ac-back" href="#users">${I.left}All users</a>
      <section class="w-card">
        <div class="ac-person">
          <span class="side-avatar">${esc(String(u.name || u.email).charAt(0).toUpperCase())}</span>
          <div class="ac-person-main">
            <h2>${esc(u.name || "No name yet")}</h2>
            <p>${esc(u.email)} · <code>${esc(u.id)}</code></p>
            <div class="ac-tags">
              ${u.admin ? tag("Admin", "warn") : ""}
              ${u.verified_at ? tag("ID verified", "ok") : tag(u.kyc_status ? `ID check: ${u.kyc_status}` : "Not verified")}
              ${u.frozen_at ? tag("On hold", "bad") : ""}
              ${u.totp_enabled_at ? tag("Authenticator app", "ok") : ""}
              ${d.passkeys.length ? tag(`${d.passkeys.length} passkey${d.passkeys.length > 1 ? "s" : ""}`, "ok") : ""}
              ${!u.totp_enabled_at && !d.passkeys.length ? tag("No 2-step") : ""}
            </div>
          </div>
          <div class="ac-acts" data-user="${esc(u.id)}">
            ${u.admin ? "" : u.frozen_at
              ? `<button class="btn sm" type="button" data-unfreeze>Take off hold</button>`
              : `<button class="btn sm ad-danger" type="button" data-freeze>Put on hold</button>`}
            <button class="btn sm" type="button" data-signout>Sign out everywhere</button>
          </div>
        </div>
        ${u.frozen_at ? `<p class="ac-hold"><b>On hold since ${when(u.frozen_at)}.</b> ${u.frozen_reason ? esc(u.frozen_reason.replace(/\.?$/, ".")) : ""} They can’t send or withdraw live money.</p>` : ""}
        <p class="msg" id="user-msg" role="status" style="margin:0 24px 12px"></p>
        <dl class="ac-facts">
          <div><dt>Live balance</dt><dd>${usd(d.balances.live)} · ${money(d.balances.live)}</dd></div>
          <div><dt>Sandbox balance</dt><dd>${money(d.balances.test)}</dd></div>
          <div><dt>Joined</dt><dd>${when(u.created_at)}</dd></div>
          <div><dt>Last sign-in</dt><dd>${when(u.last_login_at)}</dd></div>
          <div><dt>Country</dt><dd>${esc(u.country || "—")}</dd></div>
          <div><dt>API keys</dt><dd>${d.keys.length ? d.keys.map((k) => `${k.mode === "live" ? "Live" : "Sandbox"} …${esc(k.last4)}`).join(", ") : "None"}</dd></div>
          <div><dt>Webhooks</dt><dd>${[u.webhook_live && "Live", u.webhook_test && "Sandbox"].filter(Boolean).join(", ") || "None"}</dd></div>
          <div><dt>Signed in on</dt><dd>${d.sessions.length} device${d.sessions.length === 1 ? "" : "s"}</dd></div>
        </dl>
      </section>
      <div class="ac-grid">
        <div class="w-card w-activity"><div class="w-card-head"><h2>Wallet activity</h2><span class="w-count">${d.ledger.length} latest</span></div>
          <ul class="w-list">${lst(d.ledger, ledgerRow, "No activity")}</ul></div>
        <div class="w-card w-activity"><div class="w-card-head"><h2>Withdrawals</h2></div>
          <ul class="w-list">${lst(d.withdrawals, (w) => wdRow({ ...w, kes: null, user: null }), "No withdrawals")}</ul></div>
        <div class="w-card w-activity"><div class="w-card-head"><h2>Top-ups</h2></div>
          <ul class="w-list">${lst(d.topups, (t) => row({
            icon: I.in, tone: t.status === "paid" ? "in" : "", title: `${esc(t.method)}${t.phone ? ` ${esc(t.phone)}` : ""}`,
            meta: esc([t.mode === "test" ? "Sandbox" : "Live", t.receipt || t.provider_ref, t.failure].filter(Boolean).join(" · ")),
            date: when(t.created_at), status: st2(TOP, t.status), amount: money(t.nsh), sub: t.kes ? `KES ${n(t.kes)}` : t.usd ? `$${Number(t.usd).toFixed(2)}` : "",
          }), "No top-ups")}</ul></div>
        <div class="w-card w-activity"><div class="w-card-head"><h2>Payments</h2></div>
          <ul class="w-list">${lst(d.payments, (p) => row({
            icon: p.role === "merchant" ? I.store : I.up, tone: p.status === "paid" ? "in" : "", title: esc(p.company),
            meta: esc([p.role === "merchant" ? "They were paid" : "They paid", p.mode === "test" ? "Sandbox" : "Live", p.id].join(" · ")),
            date: when(p.created_at), status: st2(PAY, p.status), amount: money(p.amount), sub: `fee ${n(p.fee)}`,
          }), "No payments")}</ul></div>
        <div class="w-card w-activity"><div class="w-card-head"><h2>Signed-in devices</h2></div>
          <ul class="w-list ac-mini">${d.sessions.length ? d.sessions.map((s) => `<li>
            <span class="w-ico">${I.user}</span>
            <div class="w-what"><b>${esc(device(s.user_agent) || "Unknown device")}</b><span>${esc([s.method, s.ip].filter(Boolean).join(" · "))}</span></div>
            <span class="ac-when">${when(s.last_seen_at || s.created_at)}</span></li>`).join("") : empty("Not signed in anywhere", "")}</ul></div>
        <div class="w-card w-activity"><div class="w-card-head"><h2>Security events</h2></div>
          <ul class="w-list ac-mini">${d.events.length ? d.events.map((e) => eventItem(e, false)).join("") : empty("No events", "")}</ul></div>
        ${d.apps.length ? `<div class="w-card w-activity"><div class="w-card-head"><h2>Apps</h2></div>
          <ul class="w-list">${d.apps.map(appRow).join("")}</ul></div>` : ""}
      </div>`;
  }

  async function loadTopups(_, fresh) {
    const d = await call(`admin/topups?mode=${topupMode}`);
    if (!fresh()) return;
    $("#topups").innerHTML = d.topups.length ? d.topups.map((t) => row({
      icon: I.in, tone: t.status === "paid" ? "in" : t.status === "failed" ? "bad" : "",
      title: `${esc(t.name || t.email)} · ${esc(t.method)}`,
      meta: esc([t.phone, t.receipt || t.provider_ref, t.failure, t.id].filter(Boolean).join(" · ")),
      date: when(t.created_at), status: st2(TOP, t.status), amount: money(t.nsh),
      sub: t.kes ? `KES ${n(t.kes)}` : t.usd ? `$${Number(t.usd).toFixed(2)}` : "", href: `#user/${t.user_id}`,
    })).join("") : empty("No top-ups", topupMode === "live" ? "Live top-ups show up here." : "Sandbox top-ups show up here.");
  }

  async function loadPayments(_, fresh) {
    const d = await call(`admin/payments?mode=${payMode}`);
    if (!fresh()) return;
    $("#payments").innerHTML = d.payments.length ? d.payments.map((p) => row({
      icon: I.store, tone: p.status === "paid" ? "in" : "",
      title: esc(p.company),
      meta: esc([p.merchant_email, p.payer_email ? `paid by ${p.payer_email}` : "", p.reference, p.id].filter(Boolean).join(" · ")),
      date: when(p.created_at), status: st2(PAY, p.status), amount: money(p.amount), sub: `fee ${n(p.fee)}`, href: `#user/${p.merchant_id}`,
    })).join("") : empty("No payments", "Payments businesses create show up here.");
  }

  function appRow(a) {
    return row({
      icon: I.apps, tone: a.deleted_at ? "bad" : "",
      title: esc(a.name), meta: esc([a.owner_email, a.website, `${a.users} connected`, a.id].filter(Boolean).join(" · ")),
      date: when(a.created_at), status: a.deleted_at ? tag("Removed", "bad") : tag("Active", "ok"),
      amount: a.live_volume != null ? money(a.live_volume) : `${a.users} users`,
      act: a.deleted_at ? "" : `<button class="dv-act bad" type="button" data-remove-app="${esc(a.id)}" data-name="${esc(a.name)}">Remove</button>`,
    });
  }

  async function loadApps(_, fresh) {
    const d = await call("admin/apps");
    if (!fresh()) return;
    $("#apps").innerHTML = d.apps.length ? d.apps.map(appRow).join("") : empty("No apps", "Apps developers create show up here.");
    $("#deposits").innerHTML = d.deposits.length ? d.deposits.map((x) => row({
      icon: I.in, tone: x.status === "succeeded" ? "in" : "",
      title: esc(x.app_name), meta: esc([x.mode === "test" ? "Sandbox" : "Live", x.user_email, x.reference, x.id].filter(Boolean).join(" · ")),
      date: when(x.created_at), status: st2(DEP, x.status), amount: money(x.amount), sub: `fee ${n(x.fee)}`,
    })).join("") : empty("No deposits", "Money users move into apps shows up here.");
  }

  async function loadSecurity(_, fresh) {
    const d = await call(`admin/security?type=${encodeURIComponent(secFilter)}`);
    if (!fresh()) return;
    $("#events").innerHTML = d.events.length ? d.events.map((e) => eventItem(e)).join("") : empty("Nothing here", "Matching events show up here.");
  }

  /* ---------- actions ---------- */

  async function wdAct(article, form, path, payload, busy) {
    const msg = $(".msg", article);
    const btn = $("button[type=submit]", form);
    const label = btn.textContent;
    msg.className = "msg";
    msg.textContent = "";
    $$("button, input", article).forEach((el) => { el.disabled = true; });
    btn.textContent = busy;
    try {
      await call(path, { id: article.dataset.id, ...payload });
      article.classList.add("done");
      await loadWithdrawals(null, () => true);
    } catch (err) {
      $$("button, input", article).forEach((el) => { el.disabled = false; });
      btn.textContent = label;
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  }

  document.addEventListener("submit", (e) => {
    const article = e.target.closest(".ad-card");
    if (!article) return;
    e.preventDefault();
    if (e.target.matches(".ad-approve")) wdAct(article, e.target, "admin/withdrawals/approve", { receipt: e.target.receipt.value }, "Saving…");
    else if (e.target.matches(".ad-return-form")) wdAct(article, e.target, "admin/withdrawals/return", { reason: e.target.reason.value }, "Returning…");
  });

  async function userAct(btn, path, payload, done) {
    const msg = $("#user-msg");
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "";
    try {
      const r = await call(path, payload);
      await loadUser(payload.id, () => true);
      const m = $("#user-msg");
      m.className = "msg ok";
      m.textContent = typeof done === "function" ? done(r) : done;
    } catch (err) {
      btn.disabled = false;
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  }

  document.addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      await navigator.clipboard.writeText(copy.dataset.copy).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      return;
    }
    const acts = e.target.closest(".ac-acts");
    if (acts) {
      const id = acts.dataset.user;
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-freeze")) {
        const reason = prompt("Why are you putting this account on hold? They can’t send or withdraw live money until you take it off.", "Under review by Nora.");
        if (reason !== null) userAct(b, "admin/users/freeze", { id, reason }, "Account is on hold.");
      } else if (b.hasAttribute("data-unfreeze")) {
        userAct(b, "admin/users/unfreeze", { id }, "Account is off hold.");
      } else if (b.hasAttribute("data-signout")) {
        if (confirm("Sign this person out on every device?")) userAct(b, "admin/users/signout", { id }, (r) => `Signed out of ${r.signed_out} device${r.signed_out === 1 ? "" : "s"}.`);
      }
      return;
    }
    const rm = e.target.closest("[data-remove-app]");
    if (rm) {
      if (!confirm(`Remove the app “${rm.dataset.name}”? Its connected users are disconnected and pending deposits are declined.`)) return;
      rm.disabled = true;
      try {
        await call("admin/apps/remove", { id: rm.dataset.removeApp });
        reload();
      } catch (err) {
        rm.disabled = false;
        alert(err.message);
      }
      return;
    }
    const r = e.target.closest(".w-row[data-href]");
    if (r && !e.target.closest("a, button, input")) location.hash = r.dataset.href;
  });

  $$("[data-uf]").forEach((b) => b.addEventListener("click", () => {
    userFilter = b.dataset.uf;
    $$("[data-uf]").forEach((x) => x.classList.toggle("on", x === b));
    load("users");
  }));
  $("#user-q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load("users"), 250); });
  $$("[data-tm]").forEach((b) => b.addEventListener("click", () => {
    topupMode = b.dataset.tm;
    $$("[data-tm]").forEach((x) => x.classList.toggle("on", x === b));
    load("topups");
  }));
  $$("[data-pm]").forEach((b) => b.addEventListener("click", () => {
    payMode = b.dataset.pm;
    $$("[data-pm]").forEach((x) => x.classList.toggle("on", x === b));
    load("payments");
  }));
  $$("[data-sf]").forEach((b) => b.addEventListener("click", () => {
    secFilter = b.dataset.sf;
    $$("[data-sf]").forEach((x) => x.classList.toggle("on", x === b));
    load("security");
  }));

  $("#gate-btn").addEventListener("click", faceCheck);
  $("#lock-now").addEventListener("click", async () => {
    await call("admin/lock", {}).catch(() => {});
    st.unlocked = false;
    showGate();
  });
  addEventListener("hashchange", () => { if (!$("#app").hidden) route(); });
  addEventListener("visibilitychange", () => { if (!document.hidden && !$("#app").hidden && current()[0] !== "user") reload(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") document.body.classList.remove("side-open"); });

  /* ---------- start ---------- */

  async function start() {
    st = await call("admin/state");
    if (!st.unlocked) return showGate();
    $("#gate").hidden = true;
    $("#side").hidden = false;
    $("#app").hidden = false;
    sidebar();
    showUnlocked();
    route();
  }

  start().catch((err) => {
    $("#gate").hidden = false;
    $("#gate-lead").textContent = err.message;
  });
})();
