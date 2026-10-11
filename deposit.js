(() => {
  const card = document.querySelector("#card");
  const id = new URLSearchParams(location.search).get("id") || (document.body.hasAttribute("data-preview") ? "dep_7c1e4a9b2f6d8053e1a4" : "");
  const { esc, nsh, usd } = Nsh;
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    check: ico("m5 12.5 4.5 4.5L19 7.5"),
    x: ico("M6 6l12 12M18 6 6 18"),
    lock: ico("M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"),
    shield: ico("M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3z"),
    link: ico("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
    alert: ico("M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"),
    clock: ico("M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"),
    plus: ico("M12 5v14M5 12h14"),
  };
  // The Apps page renders this exact window with sample data; nothing in preview touches the API.
  const PREVIEW = document.body.hasAttribute("data-preview");
  const popup = PREVIEW || Boolean(window.opener && !window.opener.closed);
  let info = null;
  let ticker = 0;

  /* ---------- theme ---------- */

  function theme(brand) {
    const light = brand.theme === "light";
    document.body.classList.toggle("light", light);
    const color = brand.color || (light ? "#0a0a0a" : "#ffffff");
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

  function head() {
    const { app, mode } = info;
    const letter = esc(String(app.name).trim().charAt(0).toUpperCase());
    const logo = app.brand.logo
      ? `<img src="${esc(app.brand.logo)}" alt="" referrerpolicy="no-referrer">`
      : letter;
    return `
      <header class="dp-head">
        <span class="dp-logo">${logo}</span>
        <div class="dp-merchant">
          <b>${esc(app.name)}</b>
          <span>${ICONS.lock}${esc(app.domain || "Verified app")}</span>
        </div>
        ${mode === "test" ? `<span class="dp-tag">Sandbox</span>` : ""}
      </header>`;
  }

  function amount() {
    return `
      <p class="dp-ask">${esc(info.app.name)} is asking you to add</p>
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
          <a class="dp-btn go" href="/signin?next=${next}">Log in to Nuru to continue</a>
          <a class="dp-btn" href="/signup?next=${next}">Create a free wallet</a>
        </div>
        <p class="dp-small"><span>${ICONS.lock}You’ll come straight back here</span></p>
        ${canLeave() ? `<p class="dp-small"><a class="dp-switch" href="${esc(backHref("cancelled"))}" data-cancel>Cancel and return to ${esc(info.app.name)}</a></p>` : ""}
      </div>`;
  }

  function showConfirm() {
    const u = info.user;
    const low = u.balance < info.amount;
    const after = u.balance - info.amount;
    card.innerHTML = `
      ${head()}
      <div class="dp-body">
        ${amount()}
        <ul class="dp-rows">
          <li><span>From</span><b class="dp-who"><span class="dp-avatar">${esc((u.name || u.email).charAt(0).toUpperCase())}</span>${esc(u.name || u.email)}<button type="button" class="dp-switch" data-switch>Change</button></b></li>
          <li class="${low ? "low" : ""}"><span>Wallet balance</span><b>${nsh(u.balance)} NSH</b></li>
          ${low ? "" : `<li><span>After this</span><b>${nsh(after)} NSH</b></li>`}
          <li><span>Fee</span><b>Free for you</b></li>
          ${info.reference ? `<li><span>Reference</span><b>${esc(info.reference)}</b></li>` : ""}
        </ul>
        ${u.connected ? "" : `<div class="dp-note">${ICONS.link}<span>First time with ${esc(info.app.name)}. Confirming also <b>connects it to your wallet</b>, so next time you only confirm the amount. It never sees your balance. Disconnect any time from <b>Apps</b>.</span></div>`}
        ${low ? `<div class="dp-note warn">${ICONS.alert}<span>You need <b>${nsh(info.amount - u.balance)} NSH</b> more. Add money to your wallet, then come back here.</span></div>` : ""}
        <div class="dp-actions">
          <button class="dp-btn" type="button" data-decline>Decline</button>
          ${low
            ? `<a class="dp-btn go" href="/dashboard#add" target="_blank" rel="noopener" data-recheck>${ICONS.plus}Add money</a>`
            : `<button class="dp-btn go" type="button" data-confirm>Confirm ${nsh(info.amount)} NSH</button>`}
        </div>
        <p class="dp-msg" role="alert"></p>
        <p class="dp-small"><span>${ICONS.shield}Money goes straight to ${esc(info.app.name)}</span><span>${ICONS.clock}Expires in <b data-clock>${clock()}</b></span></p>
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
        <h1>Deposit complete</h1>
        <p>You added to ${esc(info.app.name)}</p>
        <p class="dp-big">${nsh(r.amount)} NSH</p>
        <ul class="dp-rows">
          <li><span>Receipt</span><b>${esc(id)}</b></li>
          <li><span>New wallet balance</span><b>${nsh(r.balance)} NSH</b></li>
          <li><span>Receipt emailed to</span><b>${esc(info.user.email)}</b></li>
        </ul>
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
    if (info.blocked) return showError("This deposit can’t continue", info.blocked);
    if (!info.user) return showSignIn();
    showConfirm();
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
      await Nsh.api("auth/logout", { body: {}, redirect: false }).catch(() => {});
      location.href = `/signin?next=${encodeURIComponent(`deposit?id=${id}`)}`;
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
        btn.textContent = `Confirm ${nsh(info.amount)} NSH`;
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
      else showConfirm();
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
