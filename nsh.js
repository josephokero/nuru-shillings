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

  function shell(active, me, onMode) {
    const m = mode();
    document.querySelector("#top").innerHTML = `
      <a class="brand" href="/" aria-label="Nuru home">Nuru</a>
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
    document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => {
      setMode(b.dataset.mode);
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
    msgEl.className = "msg";
    msgEl.textContent = "";
    btn.disabled = true;
    try {
      const text = await work();
      if (text) { msgEl.className = "msg ok"; msgEl.textContent = text; }
    } catch (err) {
      msgEl.className = "msg err";
      msgEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  return { api, mode, setMode, esc, nsh, usd, when, shell, submit };
})();
