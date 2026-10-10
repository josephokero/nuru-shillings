(() => {
  const card = document.querySelector("#card");
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const esc = Nsh.esc;
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    user: ico("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
    deposits: ico("M12 4v12M7 11l5 5 5-5M5 20h14"),
    shield: ico("M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3z"),
    check: ico("m5 12.5 4.5 4.5L19 7.5"),
    alert: ico("M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"),
  };

  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const tile = (name) => {
    const h = hue(name);
    return `<span class="cn-app" style="--h:${h}">${esc(String(name).trim().charAt(0).toUpperCase())}</span>`;
  };

  const what = (scope, app) => ({
    deposits: ["Ask you to add funds", `${app} shows you the amount and you confirm it in a Nuru window. Nothing moves without your OK.`],
  }[scope]);

  function back(params) {
    const url = new URL(q.redirect_uri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (q.state) url.searchParams.set("state", q.state);
    return url.toString();
  }

  function header(info) {
    return `
      <div class="cn-pair" aria-hidden="true">
        ${tile(info.app.name)}
        <span class="cn-link"><i></i><i></i><i></i><b>${ICONS.shield}</b><i></i><i></i><i></i></span>
        <span class="cn-nuru"><span></span></span>
      </div>
      <h1>Connect <b>${esc(info.app.name)}</b> to your Nuru wallet</h1>
      <p class="cn-sub">${info.app.domain ? `<a href="${esc(info.app.website)}" target="_blank" rel="noopener noreferrer">${esc(info.app.domain)}</a>` : "This app"} wants to work with your wallet.${info.mode === "test" ? ` <span class="cn-mode">Sandbox</span>` : ""}</p>`;
  }

  function perms(info) {
    const rows = [
      `<li>${ICONS.user}<div><b>See your name and email</b><span>So ${esc(info.app.name)} knows which wallet is yours.</span></div></li>`,
      ...info.scopes.map((s) => {
        const [title, text] = what(s, esc(info.app.name));
        return `<li>${ICONS[s]}<div><b>${title}</b><span>${text}</span></div></li>`;
      }),
    ];
    return `<p class="cn-label">${esc(info.app.name)} will be able to</p><ul class="cn-perms">${rows.join("")}</ul>`;
  }

  function showError(text) {
    card.innerHTML = `
      <div class="cn-state">
        <span class="cn-badge bad">${ICONS.alert}</span>
        <h1>This link can’t be used</h1>
        <p class="cn-sub">${esc(text)}</p>
        <a class="btn block" href="/dashboard">Go to my wallet</a>
      </div>`;
  }

  const next = () => encodeURIComponent((location.pathname + location.search).replace(/^\//, ""));

  function showSignIn(info) {
    card.innerHTML = `
      ${header(info)}
      ${perms(info)}
      <div class="cn-actions">
        <a class="btn primary block" href="/signin?next=${next()}">Log in to continue</a>
        <a class="btn block" href="/signup?next=${next()}">Create a free wallet</a>
      </div>
      <p class="cn-small">You’ll come straight back here after you log in.</p>`;
  }

  function showConsent(info) {
    const u = info.user;
    card.innerHTML = `
      ${header(info)}
      <div class="cn-who">
        <span class="cn-avatar">${esc((u.name || u.email).charAt(0).toUpperCase())}</span>
        <div><b>${esc(u.name || u.email)}</b>${u.name ? `<span>${esc(u.email)}</span>` : ""}</div>
        <button type="button" class="cn-switch" id="switch">Not you?</button>
      </div>
      ${info.existing ? `<div class="cn-note">${ICONS.check}<span>Already connected. Continue to go back to ${esc(info.app.name)}.</span></div>` : ""}
      ${perms(info)}
      <div class="cn-note">${ICONS.shield}<span>${esc(info.app.name)} can’t take money on its own or see your balance. Disconnect any time from <b>Apps</b> in your wallet.</span></div>
      <div class="cn-actions row2">
        <a class="btn" href="${esc(back({ error: "access_denied" }))}" id="cancel">Cancel</a>
        <button class="btn primary" type="button" id="approve">Connect</button>
      </div>
      <p class="msg" id="msg" role="status"></p>
      <p class="cn-small">You’ll go back to ${esc(info.redirect_domain || "the app")} after this.</p>`;

    card.querySelector("#switch").addEventListener("click", async () => {
      await Nsh.api("auth/logout", { body: {}, redirect: false }).catch(() => {});
      location.href = `/signin?next=${next()}`;
    });

    const btn = card.querySelector("#approve");
    btn.addEventListener("click", async () => {
      const msg = card.querySelector("#msg");
      msg.className = "msg";
      msg.textContent = "";
      btn.disabled = true;
      btn.classList.add("busy");
      btn.textContent = "Connecting…";
      try {
        const r = await Nsh.api("connect/approve", {
          redirect: false,
          body: { app: q.app, redirect_uri: q.redirect_uri, mode: info.mode, state: q.state },
        });
        showDone(info, r.redirect);
      } catch (err) {
        msg.className = "msg err";
        msg.textContent = err.message;
        btn.disabled = false;
        btn.classList.remove("busy");
        btn.textContent = "Connect";
      }
    });
  }

  function showDone(info, url) {
    card.innerHTML = `
      <div class="cn-state">
        <div class="cn-pair done" aria-hidden="true">
          ${tile(info.app.name)}
          <span class="cn-link"><i></i><i></i><i></i><b>${ICONS.check}</b><i></i><i></i><i></i></span>
          <span class="cn-nuru"><span></span></span>
        </div>
        <h1>${esc(info.app.name)} is connected</h1>
        <p class="cn-sub">Taking you back to ${esc(info.redirect_domain || "the app")}…</p>
        <a class="btn primary block" href="${esc(url)}">Continue</a>
      </div>`;
    setTimeout(() => location.assign(url), 1600);
  }

  (async () => {
    if (!q.app || !q.redirect_uri) return showError("The link is missing the app or its return address. Ask the app for a new connect link.");
    let info;
    try {
      info = await Nsh.api(`connect/info?${new URLSearchParams({ app: q.app, redirect_uri: q.redirect_uri, mode: q.mode || "test" })}`, { redirect: false });
    } catch (err) {
      return showError(err.message);
    }
    document.title = `Connect ${info.app.name} · Nuru Shillings`;
    if (!info.user) return showSignIn(info);
    if (info.mode === "live" && info.user.own) return showError("This is your own app. Log in with a different Nuru account to connect it.");
    showConsent(info);
  })();
})();
