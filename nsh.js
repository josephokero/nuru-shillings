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
  };

  const avatar = (me) => me.avatar
    ? `<img src="${esc(me.avatar)}" alt="" loading="lazy" decoding="async">`
    : esc(String(me.name || me.email || "N").trim().charAt(0).toUpperCase());

  function sidebar(me) {
    const side = document.querySelector("#side");
    const who = me.name || me.email;
    side.innerHTML = `
      <div class="side-head">
        <a class="brand" href="/" aria-label="Nora home">Nora</a>
        <button class="side-close" type="button" aria-label="Close menu">×</button>
      </div>
      <nav class="side-nav">
        <p class="side-label">Wallet</p>
        <a href="#home" data-view="home">${SIDE_ICONS.home}<span>Home</span></a>
        <a href="#activity" data-view="activity">${SIDE_ICONS.list}<span>Activity</span></a>
        <a href="#add" data-view="add">${SIDE_ICONS.plus}<span>Add money</span></a>
        <a href="#send" data-view="send">${SIDE_ICONS.send}<span>Send money</span></a>
        <a href="#withdraw" data-view="withdraw">${SIDE_ICONS.bank}<span>Withdraw</span></a>
        <a href="#apps" data-view="apps">${SIDE_ICONS.apps}<span>Apps</span></a>
        <a href="#account" data-view="account">${SIDE_ICONS.user}<span>Account</span></a>
        <p class="side-label">Business</p>
        <a href="/developer">${SIDE_ICONS.store}<span>Business tools</span></a>
        <a href="/docs">${SIDE_ICONS.code}<span>API docs</span></a>
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
      sidebar(me);
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

  return { api, mode, setMode, esc, nsh, usd, when, shell, submit, avatar };
})();
