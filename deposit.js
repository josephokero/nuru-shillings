(() => {
  const card = document.querySelector("#card");
  const id = new URLSearchParams(location.search).get("id") || (document.body.hasAttribute("data-preview") ? "dep_7c1e4a9b2f6d8053e1a4" : "");
  const { esc, nsh, usd } = Nsh;
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    check: ico("m5 12.5 4.5 4.5L19 7.5"),
    x: ico("M6 6l12 12M18 6 6 18"),
    lock: ico("M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"),
    alert: ico("M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"),
    clock: ico("M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"),
    plus: ico("M12 5v14M5 12h14"),
    user: ico("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
    down: ico("M12 4v12M7 11l5 5 5-5M5 20h14"),
    eye: ico("M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.4.7-1.3 1.9-2.6 3.1M6.6 7.6C4.6 8.9 3.2 10.8 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"),
  };
  let justConnected = false;
  // The Apps page renders this exact window with sample data; nothing in preview touches the API.
  const PREVIEW = document.body.hasAttribute("data-preview");
  const popup = PREVIEW || Boolean(window.opener && !window.opener.closed);
  let info = null;
  let ticker = 0;

  /* ---------- theme ---------- */

  function theme(brand) {
    const light = brand.theme === "light";
    document.body.classList.toggle("light", light);
    const color = /^#[0-9a-f]{6}$/i.test(brand.color || "") ? brand.color : light ? "#0a0a0a" : "#ffffff";
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty("--brand", color);
    document.documentElement.style.setProperty("--brand-ink", lum > 0.45 ? "#000000" : "#ffffff");
  }

  /* ---------- talking back to the app ---------- */

  function tell(status) {
    if (PREVIEW || !popup || !info) return;
    const msg = { type: "nuru:deposit", id, status, reference: info.reference || null };
    for (const origin of info.origins) {
      try { window.opener.postMessage(msg, origin); } catch { /* opener navigated away */ }
    }
  }

  function returnUrl(status) {
    if (!info?.return_url) return null;
    const url = new URL(info.return_url);
    url.searchParams.set("status", status);
    return url.toString();
  }

  function leave(status, delay) {
    if (PREVIEW) return;
    const url = returnUrl(status);
    setTimeout(() => {
      if (popup) window.close();
      else if (url) location.assign(url);
    }, delay);
  }

  const canLeave = () => popup || Boolean(info?.return_url);
  const backLabel = () => (popup ? `Back to ${esc(info.app.name)}` : info?.return_url ? `Return to ${esc(info.app.name)}` : "Open my wallet");
  const backHref = (status) => (popup ? "#" : returnUrl(status) || "/dashboard");

  /* ---------- pieces ---------- */

  function logo() {
    const { app } = info;
    return app.brand.logo
      ? `<img src="${esc(app.brand.logo)}" alt="" referrerpolicy="no-referrer">`
      : esc(String(app.name).trim().charAt(0).toUpperCase());
  }

  function head() {
    const { app, mode } = info;
    return `
      <header class="dp-head">
        <span class="dp-logo">${logo()}</span>
        <div class="dp-merchant">
          <b>${esc(app.name)}</b>
          <span>${ICONS.lock}${esc(app.domain || "Verified app")}</span>
        </div>
        ${mode === "test" ? `<span class="dp-tag">Sandbox</span>` : ""}
      </header>`;
  }

  function amount() {
    return `
      <p class="dp-ask">${esc(info.app.name)} is requesting</p>
      <p class="dp-amount">${nsh(info.amount)}<small>NSH</small></p>
      <p class="dp-usd">${usd(info.amount)}${info.mode === "test" ? " · practice money" : ""}</p>
      ${info.description ? `<p class="dp-desc">${esc(info.description)}</p>` : ""}`;
  }

  const left = () => Math.max(0, new Date(info.expires) - Date.now());
  const clock = () => {
    const s = Math.ceil(left() / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function startClock() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      const el = card.querySelector("[data-clock]");
      if (!el) return clearInterval(ticker);
      if (left() <= 0) {
        clearInterval(ticker);
        tell("expired");
        return showEnd("expired");
      }
      el.textContent = clock();
    }, 1000);
  }

  /* ---------- states ---------- */

  function showError(title, text) {
    card.innerHTML = `
      <div class="dp-state">
        <div class="dp-ring bad"><span>${ICONS.alert}</span></div>
        <h1>${esc(title)}</h1>
        <p>${esc(text)}</p>
        <div class="dp-actions one">
          ${canLeave() ? `<a class="dp-btn" href="${esc(backHref("cancelled"))}" data-back>${backLabel()}</a>` : `<a class="dp-btn" href="/dashboard">Open my wallet</a>`}
        </div>
      </div>`;
  }

  function showSignIn() {
    const next = encodeURIComponent(`deposit?id=${id}`);
    card.innerHTML = `
      ${head()}
      <div class="dp-body">
        ${amount()}
        <div class="dp-actions one">
          <a class="dp-btn go" href="/signin?next=${next}">Log in to Nora to continue</a>
          <a class="dp-btn" href="/signup?next=${next}">Create a free wallet</a>
        </div>
        <p class="dp-small"><span>${ICONS.lock}You’ll come straight back here</span></p>
        ${canLeave() ? `<p class="dp-small"><a class="dp-switch" href="${esc(backHref("cancelled"))}" data-cancel>Cancel and return to ${esc(info.app.name)}</a></p>` : ""}
      </div>`;
  }

  /* Live deposits never come from the developer's own wallet. */
  function showOwn() {
    card.innerHTML = `
      ${head()}
      <div class="dp-body">
        ${amount()}
        <div class="dp-note warn">${ICONS.alert}<span>You’re logged in as <b>${esc(info.user.email)}</b>, the developer of ${esc(info.app.name)}. Deposits come from the customer’s own Nora wallet, never from yours.</span></div>
        <div class="dp-actions one">
          <button class="dp-btn go" type="button" data-switch="signin">Log in with another wallet</button>
          <button class="dp-btn" type="button" data-switch="signup">Create a free wallet</button>
        </div>
        ${canLeave() ? `<p class="dp-small"><a class="dp-switch" href="${esc(backHref("cancelled"))}" data-cancel>Cancel and return to ${esc(info.app.name)}</a></p>` : ""}
      </div>`;
  }

  const initial = (u) => esc((u.name || u.email).charAt(0).toUpperCase());

  function showUser() {
    if (info.user.connected) showConfirm();
    else showConnect();
  }

  /* First time only: the app asks for access to the wallet. */
  function showConnect() {
    const u = info.user;
    const name = esc(info.app.name);
    card.innerHTML = `
      <div class="dp-body dp-connect">
        <div class="dp-pair" aria-hidden="true">
          <span class="dp-logo">${logo()}</span>
          <span class="dp-dots"><i></i><i></i><i></i></span>
          <span class="dp-nuru"><i></i></span>
        </div>
        <h1 class="dp-title">Connect ${name} to your wallet</h1>
        <p class="dp-lead">${info.app.domain ? `${esc(info.app.domain)} · ` : ""}first time only${info.mode === "test" ? ` <span class="dp-tag">Sandbox</span>` : ""}</p>
        <ul class="dp-perms">
          <li>${ICONS.down}<div><b>Ask you to add money</b><span>You confirm every amount. Nothing moves without you.</span></div></li>
          <li>${ICONS.user}<div><b>See your name and email</b><span>So ${name} knows which wallet is yours.</span></div></li>
          <li class="no">${ICONS.eye}<div><b>Never sees your balance or activity</b><span>Disconnect any time from Apps in your wallet.</span></div></li>
        </ul>
        <div class="dp-from">
          <span class="dp-avatar">${initial(u)}</span>
          <span class="dp-from-who"><b>${esc(u.name || u.email)}</b>${u.name ? `<small>${esc(u.email)}</small>` : ""}</span>
          <button type="button" class="dp-switch" data-switch>Not you?</button>
        </div>
        <div class="dp-actions">
          <button class="dp-btn" type="button" data-decline>Cancel</button>
          <button class="dp-btn go" type="button" data-connect>Connect</button>
        </div>
        <p class="dp-msg" role="alert"></p>
      </div>`;
  }

  /* Every deposit after that: one amount, accept or decline. */
  function showConfirm() {
    const u = info.user;
    const low = u.balance < info.amount;
    card.innerHTML = `
      ${head()}
      <div class="dp-body">
        ${justConnected ? `<p class="dp-ok">${ICONS.check}Connected</p>` : ""}
        ${amount()}
        <div class="dp-from">
          <span class="dp-avatar">${initial(u)}</span>
          <span class="dp-from-who"><b>${esc(u.name || u.email)}</b><small class="${low ? "low" : ""}">${nsh(u.balance)} NSH available</small></span>
          <button type="button" class="dp-switch" data-switch>Change</button>
        </div>
        ${low ? `<div class="dp-note warn">${ICONS.alert}<span>You need <b>${nsh(info.amount - u.balance)} NSH</b> more. Add money, then come back here.</span></div>` : ""}
        <div class="dp-actions">
          <button class="dp-btn" type="button" data-decline>Decline</button>
          ${low
            ? `<a class="dp-btn go" href="/dashboard#add" target="_blank" rel="noopener" data-recheck>${ICONS.plus}Add money</a>`
            : `<button class="dp-btn go" type="button" data-confirm>Confirm</button>`}
        </div>
        <p class="dp-msg" role="alert"></p>
        <p class="dp-small"><span>${ICONS.clock}Expires in <b data-clock>${clock()}</b></span></p>
      </div>`;
    startClock();
  }

  function showDone(r) {
    const status = "succeeded";
    tell(status);
    const auto = canLeave();
    card.innerHTML = `
      <div class="dp-state">
        <div class="dp-ring"><span>${ICONS.check}</span></div>
        <h1>Done</h1>
        <p class="dp-big">${nsh(r.amount)} NSH</p>
        <p>added to ${esc(info.app.name)}</p>
        <p class="dp-after">Wallet balance ${nsh(r.balance)} NSH · receipt sent to your email</p>
        <div class="dp-actions one">
          <a class="dp-btn go" href="${esc(backHref(status))}" data-back>${backLabel()}</a>
        </div>
        ${auto ? `<p class="dp-count">Returning to ${esc(info.app.name)} automatically</p><div class="dp-bar"><i style="animation-duration:4s"></i></div>` : ""}
      </div>`;
    if (auto) leave(status, 4000);
  }

  function showEnd(status) {
    clearInterval(ticker);
    const copy = {
      declined: ["Deposit declined", "No money moved. You can close this window."],
      cancelled: ["Deposit cancelled", `${info.app.name} cancelled this request. No money moved.`],
      expired: ["This request expired", `Go back to ${info.app.name} and start again. No money moved.`],
      succeeded: ["Already paid", `This deposit to ${info.app.name} is already complete.`],
    }[status] || ["Nothing to do here", "This request is closed."];
    card.innerHTML = `
      <div class="dp-state">
        <div class="dp-ring ${status === "succeeded" ? "" : "plain"}"><span>${status === "succeeded" ? ICONS.check : status === "expired" ? ICONS.clock : ICONS.x}</span></div>
        <h1>${esc(copy[0])}</h1>
        <p>${esc(copy[1])}</p>
        <div class="dp-actions one">
          <a class="dp-btn" href="${esc(backHref(status))}" data-back>${backLabel()}</a>
        </div>
      </div>`;
  }

  /* ---------- actions ---------- */

  async function load() {
    try {
      info = await Nsh.api(`deposit/info?id=${encodeURIComponent(id)}`, { redirect: false });
    } catch (err) {
      return showError("This link can’t be used", err.message);
    }
    theme(info.app.brand);
    document.title = `${info.app.name} · Confirm deposit`;
    if (info.status !== "pending") return showEnd(info.status);
    const own = info.mode === "live" && info.user?.own;
    if (info.blocked && !own) return showError("This deposit can’t continue", info.blocked);
    if (!info.user) return showSignIn();
    if (own) return showOwn();
    showUser();
  }

  card.addEventListener("error", (e) => {
    if (e.target.matches?.(".dp-logo img")) e.target.replaceWith(String(info.app.name).trim().charAt(0).toUpperCase());
  }, true);

  card.addEventListener("click", async (e) => {
    if (PREVIEW) {
      if (e.target.closest("a, button")) e.preventDefault();
      return;
    }
    const t = e.target;
    if (t.closest("[data-back]") && popup) {
      e.preventDefault();
      window.close();
    } else if (t.closest("[data-cancel]")) {
      e.preventDefault();
      tell("cancelled");
      const url = returnUrl("cancelled");
      if (popup) window.close();
      else if (url) location.assign(url);
    } else if (t.closest("[data-switch]")) {
      const page = t.closest("[data-switch]").dataset.switch === "signup" ? "signup" : "signin";
      await Nsh.api("auth/logout", { body: {}, redirect: false }).catch(() => {});
      location.href = `/${page}?next=${encodeURIComponent(`deposit?id=${id}`)}`;
    } else if (t.closest("[data-recheck]")) {
      const msg = card.querySelector(".dp-msg");
      msg.style.color = "var(--muted)";
      msg.textContent = "When you’re done, this page updates by itself.";
      const again = async () => {
        if (document.hidden) return;
        removeEventListener("focus", again);
        await load();
      };
      addEventListener("focus", again);
    } else if (t.closest("[data-decline]")) {
      const btn = t.closest("[data-decline]");
      btn.disabled = true;
      btn.classList.add("busy");
      try {
        const r = await Nsh.api("deposit/decline", { body: { id }, redirect: false });
        tell(r.status);
        showEnd(r.status);
        if (canLeave()) leave(r.status, 1600);
      } catch (err) {
        btn.disabled = false;
        btn.classList.remove("busy");
        card.querySelector(".dp-msg").textContent = err.message;
      }
    } else if (t.closest("[data-connect]")) {
      const btn = t.closest("[data-connect]");
      card.querySelectorAll(".dp-actions .dp-btn").forEach((b) => { b.disabled = true; });
      btn.classList.add("busy");
      btn.textContent = "Connecting…";
      try {
        await Nsh.api("deposit/connect", { body: { id }, redirect: false });
        info.user.connected = true;
        justConnected = true;
        showConfirm();
      } catch (err) {
        card.querySelectorAll(".dp-actions .dp-btn").forEach((b) => { b.disabled = false; });
        btn.classList.remove("busy");
        btn.textContent = "Connect";
        card.querySelector(".dp-msg").textContent = err.message;
      }
    } else if (t.closest("[data-confirm]")) {
      const btn = t.closest("[data-confirm]");
      const msg = card.querySelector(".dp-msg");
      card.querySelectorAll(".dp-actions .dp-btn").forEach((b) => { b.disabled = true; });
      btn.classList.add("busy");
      btn.textContent = "Confirming…";
      msg.textContent = "";
      try {
        showDone(await Nsh.api("deposit/confirm", { body: { id }, redirect: false }));
      } catch (err) {
        card.querySelectorAll(".dp-actions .dp-btn").forEach((b) => { b.disabled = false; });
        btn.classList.remove("busy");
        btn.textContent = "Confirm";
        msg.textContent = err.message;
      }
    }
  });

  if (PREVIEW) {
    const foot = document.querySelector(".dp-powered");
    const size = () => parent.postMessage({ type: "nuru:preview-size", height: card.offsetHeight + foot.offsetHeight + 62 }, window.origin);
    addEventListener("message", (e) => {
      if (e.origin !== window.origin || e.data?.type !== "nuru:preview") return;
      info = { ...e.data.info, expires: new Date(Date.now() + 15 * 60e3).toISOString() };
      theme(info.app.brand);
      if (e.data.view === "signin") showSignIn();
      else if (e.data.view === "done") showDone({ amount: info.amount, balance: info.user.balance - info.amount });
      else {
        info.user = { ...info.user, connected: e.data.view !== "connect" };
        showUser();
      }
      requestAnimationFrame(size);
    });
    new ResizeObserver(size).observe(card);
    parent.postMessage({ type: "nuru:preview-ready" }, window.origin);
  } else if (!/^dep_[a-f0-9]{20}$/.test(id)) {
    showError("This link can’t be used", "The deposit link is incomplete. Go back to the app and try again.");
  } else {
    load();
  }
})();
