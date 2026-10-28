const Nsh = (() => {
  const MODE_KEY = "nsh-mode";

  async function api(path, options = {}) {
    const init = { method: options.body ? "POST" : "GET", credentials: "same-origin", headers: {} };
    if (options.body) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(`/api/${path}`, init);
    } catch {
      throw new Error("You appear to be offline. Check your connection.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === "mfa_required" && !options.retried) {
      await stepUp(data.methods || {});
      return api(path, { ...options, retried: true });
    }
    if (res.status === 401 && options.redirect !== false) {
      location.href = `/signin?next=${encodeURIComponent(location.pathname.replace(/^\//, "") + location.search)}`;
      throw new Error("Log in to continue.");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  const mode = () => (localStorage.getItem(MODE_KEY) === "live" ? "live" : "test");
  const setMode = (m) => localStorage.setItem(MODE_KEY, m === "live" ? "live" : "test");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nsh = (n) => Number(n || 0).toLocaleString("en-US");
  const usd = (n) => (Number(n || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const when = (iso) => {
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const SIDE_ICONS = {
    home: ico("M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10"),
    list: ico("M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"),
    plus: ico("M12 5v14M5 12h14"),
    send: ico("M7 17 17 7M8 7h9v9"),
    bank: ico("M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z"),
    store: ico("M4 9h16l-1-5H5L4 9zM5 9v11h14V9M9 20v-6h6v6"),
    code: ico("m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"),
    help: ico("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"),
    people: ico("M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8"),
    out: ico("M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"),
    user: ico("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
    apps: ico("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 17h6M17 14v6"),
    lock: ico("M14.5 8.5a4.5 4.5 0 1 1-1.3-3.2M14.5 8.5H21M18 8.5V12M21 8.5V11M3 21l6.5-6.5"),
    hook: ico("M18 16.5a3 3 0 1 1-2.8 4M9 7.5a3 3 0 1 1 3.6 2.9L9.5 16M6 16.5h9M6 16.5a3 3 0 1 0 2.9 3.7"),
  };

  const avatar = (me) => me.avatar
    ? `<img src="${esc(me.avatar)}" alt="" loading="lazy" decoding="async">`
    : esc(String(me.name || me.email || "N").trim().charAt(0).toUpperCase());

  function sidebar(me, page = "wallet") {
    const side = document.querySelector("#side");
    const who = me.name || me.email;
    const biz = page === "business";
    const wallet = (view, icon, label) => biz
      ? `<a href="/dashboard#${view}">${icon}<span>${label}</span></a>`
      : `<a href="#${view}" data-view="${view}">${icon}<span>${label}</span></a>`;
    const business = biz
      ? `<a href="#overview" data-view="overview">${SIDE_ICONS.store}<span>Overview</span></a>
        <a href="#payments" data-view="payments">${SIDE_ICONS.list}<span>Payments</span></a>
        <a href="#apps" data-view="apps">${SIDE_ICONS.apps}<span>Apps</span></a>
        <a href="#keys" data-view="keys">${SIDE_ICONS.lock}<span>API keys</span></a>
        <a href="#webhooks" data-view="webhooks">${SIDE_ICONS.hook}<span>Webhooks</span></a>
        <a href="/docs">${SIDE_ICONS.code}<span>API docs</span></a>`
      : `<a href="/developer">${SIDE_ICONS.store}<span>Business tools</span></a>
        <a href="/docs">${SIDE_ICONS.code}<span>API docs</span></a>`;
    side.innerHTML = `
      <div class="side-head">
        <a class="brand" href="/" aria-label="Nora home">Nora</a>
        <button class="side-close" type="button" aria-label="Close menu">×</button>
      </div>
      <nav class="side-nav">
        ${biz ? `<p class="side-label">Business</p>${business}` : ""}
        <p class="side-label">Wallet</p>
        ${wallet("home", SIDE_ICONS.home, "Home")}
        ${wallet("activity", SIDE_ICONS.list, "Activity")}
        ${wallet("add", SIDE_ICONS.plus, "Add money")}
        ${wallet("send", SIDE_ICONS.send, "Send money")}
        ${wallet("withdraw", SIDE_ICONS.bank, "Withdraw")}
        ${wallet("apps", SIDE_ICONS.apps, "Apps")}
        ${wallet("account", SIDE_ICONS.user, "Account")}
        ${biz ? "" : `<p class="side-label">Business</p>${business}`}
        ${me.admin ? `<p class="side-label">Admin</p><a href="/admin">${SIDE_ICONS.lock}<span>Admin console</span></a>` : ""}
        <p class="side-label">Support</p>
        <a href="/help">${SIDE_ICONS.help}<span>Help centre</span></a>
        <a href="/community">${SIDE_ICONS.people}<span>Community</span></a>
      </nav>
      <div class="side-foot">
        <div class="side-me">
          <span class="side-avatar" data-f="avatar">${avatar(me)}</span>
          <div><b>${esc(who)}</b><span id="side-status">${me.verified ? "Verified" : "Not verified"}</span></div>
          <button type="button" id="logout" aria-label="Log out" title="Log out">${SIDE_ICONS.out}</button>
        </div>
      </div>`;

    const btn = document.querySelector("#menu-btn");
    const scrim = document.querySelector("#side-scrim");
    const setOpen = (open) => {
      document.body.classList.toggle("side-open", open);
      btn?.setAttribute("aria-expanded", String(open));
    };
    btn?.addEventListener("click", () => setOpen(!document.body.classList.contains("side-open")));
    scrim?.addEventListener("click", () => setOpen(false));
    side.querySelector(".side-close").addEventListener("click", () => setOpen(false));
    side.querySelectorAll(".side-nav a, .side-nav button").forEach((el) => el.addEventListener("click", () => setOpen(false)));
    addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    matchMedia("(min-width: 961px)").addEventListener("change", (e) => { if (e.matches) setOpen(false); });
  }

  function shell(active, me, onMode) {
    const m = mode();
    if (document.querySelector("#side")) {
      sidebar(me, active);
      bindShell(onMode);
      return;
    }
    document.querySelector("#top").innerHTML = `
      <a class="brand" href="/" aria-label="Nora home">Nora</a>
      <span class="slash">/</span>
      <span class="who">${esc(me.name || me.email)}</span>
      <span class="spacer"></span>
      <div class="modes" role="group" aria-label="Mode">
        <button type="button" data-mode="test" class="${m === "test" ? "on" : ""}">Sandbox</button>
        <button type="button" data-mode="live" class="${m === "live" ? "on" : ""}">Live</button>
      </div>
      <button class="btn sm" type="button" id="logout">Log out</button>`;
    document.querySelector("#tabs").innerHTML = active === "wallet"
      ? `<a class="on" href="/dashboard">Wallet</a><a href="/docs">Docs</a><a href="/help">Help</a><a class="biz" href="/developer">Business tools →</a>`
      : `<a href="/dashboard">← Wallet</a><a class="on" href="/developer">Business tools</a><a href="/docs">Docs</a>`;
    bindShell(onMode);
  }

  function bindShell(onMode) {
    document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
      setMode(b.dataset.mode);
      api("profile/prefs", { body: { mode: b.dataset.mode }, redirect: false }).catch(() => {});
      document.querySelectorAll(".modes button").forEach((x) => x.classList.toggle("on", x === b));
      onMode(b.dataset.mode);
    }));
    document.querySelector("#logout").addEventListener("click", async () => {
      await api("auth/logout", { body: {}, redirect: false }).catch(() => {});
      location.href = "/signin";
    });
  }

  async function submit(form, msgEl, work) {
    const btn = form.querySelector("button[type=submit]");
    const label = btn.textContent;
    msgEl.className = "msg";
    msgEl.textContent = "";
    btn.disabled = true;
    if (btn.dataset.busy) {
      btn.classList.add("busy");
      btn.textContent = btn.dataset.busy;
    }
    try {
      const text = await work();
      if (text) { msgEl.className = "msg ok"; msgEl.textContent = text; }
    } catch (err) {
      msgEl.className = "msg err";
      msgEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = label;
    }
  }

  /* ---------- passkeys (WebAuthn) ---------- */

  const toBuf = (s) => {
    const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "="));
    return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
  };
  const fromBuf = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const passkeyError = (err) => new Error(err?.name === "NotAllowedError" ? "The passkey request was cancelled or timed out."
    : err?.name === "InvalidStateError" ? "This device already has a passkey for your account."
    : "Passkeys aren’t available here. Try another device or browser.");

  const passkey = {
    supported: () => Boolean(window.PublicKeyCredential && navigator.credentials?.create),
    async create(o) {
      let cred;
      try {
        cred = await navigator.credentials.create({ publicKey: {
          ...o,
          challenge: toBuf(o.challenge),
          user: { ...o.user, id: toBuf(o.user.id) },
          excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
        } });
      } catch (err) { throw passkeyError(err); }
      const r = cred.response;
      return {
        id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: fromBuf(r.clientDataJSON),
          attestationObject: fromBuf(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : [],
        },
      };
    },
    async get(o) {
      let cred;
      try {
        cred = await navigator.credentials.get({ publicKey: {
          ...o,
          challenge: toBuf(o.challenge),
          allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
        } });
      } catch (err) { throw passkeyError(err); }
      const r = cred.response;
      return {
        id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: fromBuf(r.clientDataJSON),
          authenticatorData: fromBuf(r.authenticatorData),
          signature: fromBuf(r.signature),
          userHandle: r.userHandle ? fromBuf(r.userHandle) : undefined,
        },
      };
    },
  };

  /* ---------- second step: one dialog for sign-in and for confirming sensitive actions ---------- */

  function mfaCss() {
    if (document.querySelector("link[data-mfa-css]")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/mfa.css?v=1";
    l.dataset.mfaCss = "";
    document.head.append(l);
  }

  /** methods: {totp, passkey, recovery}. submit(payload) sends {code} | {recovery} | {passkey, ticket}. */
  function secondStep({ methods, title, lead, submit, passkeyOptions, cancelLabel = "Cancel" }) {
    mfaCss();
    return new Promise((resolve, reject) => {
      const usePk = methods.passkey && passkey.supported();
      const veil = document.createElement("div");
      veil.className = "mfa-veil";
      veil.innerHTML = `
        <form class="mfa-box" role="dialog" aria-modal="true" aria-labelledby="mfa-title" novalidate>
          <span class="mfa-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/></svg></span>
          <h2 id="mfa-title">${esc(title)}</h2>
          <p class="mfa-lead">${esc(lead)}</p>
          ${usePk ? `<button class="mfa-btn primary" type="button" data-pk>Use a passkey</button>` : ""}
          ${usePk && (methods.totp || methods.recovery) ? `<div class="mfa-or"><span>or</span></div>` : ""}
          ${methods.totp ? `<label class="mfa-field" data-totp><span>6-digit code from your authenticator app</span>
            <input class="mfa-input code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></label>` : ""}
          <label class="mfa-field" data-rec ${methods.totp ? "hidden" : ""} ${methods.recovery ? "" : "hidden"}><span>Recovery code</span>
            <input class="mfa-input" name="recovery" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="abcde-12345"></label>
          ${methods.totp || methods.recovery ? `<button class="mfa-btn ${usePk ? "" : "primary"}" type="submit">Confirm</button>` : ""}
          ${methods.totp && methods.recovery ? `<button class="mfa-link" type="button" data-swap>Use a recovery code instead</button>` : ""}
          <p class="mfa-msg" role="status"></p>
          <button class="mfa-link muted" type="button" data-cancel>${esc(cancelLabel)}</button>
        </form>`;
      document.body.append(veil);
      const form = veil.querySelector("form");
      const msg = veil.querySelector(".mfa-msg");
      const code = form.code;
      const rec = form.recovery;
      const totpBox = veil.querySelector("[data-totp]");
      const recBox = veil.querySelector("[data-rec]");
      (code || rec)?.focus();

      const close = () => { veil.remove(); removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") { close(); reject(new Error("Cancelled.")); } };
      addEventListener("keydown", onKey);

      const busy = async (btn, work) => {
        const buttons = form.querySelectorAll("button");
        buttons.forEach((b) => { b.disabled = true; });
        btn?.classList.add("busy");
        msg.className = "mfa-msg";
        msg.textContent = "";
        try {
          await work();
          close();
          resolve();
        } catch (err) {
          msg.className = "mfa-msg err";
          msg.textContent = err.message;
          buttons.forEach((b) => { b.disabled = false; });
          btn?.classList.remove("busy");
        }
      };

      veil.querySelector("[data-pk]")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        const { ticket, options } = await passkeyOptions();
        await submit({ passkey: await passkey.get(options), ticket });
      }));
      veil.querySelector("[data-swap]")?.addEventListener("click", (e) => {
        const toRec = recBox.hidden;
        recBox.hidden = !toRec;
        totpBox.hidden = toRec;
        e.currentTarget.textContent = toRec ? "Use the authenticator app instead" : "Use a recovery code instead";
        (toRec ? rec : code).focus();
      });
      veil.querySelector("[data-cancel]").addEventListener("click", () => { close(); reject(new Error("Cancelled.")); });
      code?.addEventListener("input", () => {
        const d = code.value.replace(/\D/g, "").slice(0, 6);
        code.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
        if (d.length === 6) form.requestSubmit();
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const btn = form.querySelector("button[type=submit]");
        if (recBox && !recBox.hidden) {
          const v = rec.value.trim();
          if (v.length < 8) { msg.className = "mfa-msg err"; msg.textContent = "Enter one of your recovery codes."; return; }
          return busy(btn, () => submit({ recovery: v }));
        }
        const v = (code?.value || "").replace(/\D/g, "");
        if (v.length !== 6) { msg.className = "mfa-msg err"; msg.textContent = "Enter the 6-digit code."; return; }
        busy(btn, () => submit({ code: v }));
      });
    });
  }

  let stepping = null;
  function stepUp(methods) {
    if (!stepping) {
      stepping = secondStep({
        methods,
        title: "Confirm it’s you",
        lead: "For your safety, confirm with your second step before this change or before live money leaves your wallet.",
        submit: (p) => api("security/step-up", { body: p, redirect: false, retried: true }),
        passkeyOptions: () => api("security/step-up/options", { body: {}, redirect: false, retried: true }),
      }).finally(() => { stepping = null; });
    }
    return stepping;
  }

  if (!window.__nshWarned) {
    window.__nshWarned = true;
    console.log("%cStop!", "color:#ff5a5f;font:700 42px Inter,system-ui,sans-serif");
    console.log("%cThis is a browser tool for developers. If someone told you to paste or type something here, it is a scam to take over your Nora Shillings wallet. Close this panel.", "font:15px Inter,system-ui,sans-serif;line-height:1.5");
  }

  return { api, mode, setMode, esc, nsh, usd, when, shell, submit, avatar, passkey, secondStep, stepUp };
})();
