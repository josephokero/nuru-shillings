(() => {
  const root = document.querySelector("#apps-root");
  if (!root) return;
  const esc = Nsh.esc;
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    deposits: ico("M12 4v12M7 11l5 5 5-5M5 20h14"),
    ext: ico("M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"),
    link: ico("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
    shield: ico("M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3z"),
  };
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const tile = (name, cls = "") => `<span class="ap-tile ${cls}" style="--h:${hue(name)}">${esc(String(name).trim().charAt(0).toUpperCase())}</span>`;
  const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  let all = null;
  let data = null;
  let mode = "live";
  let loading = false;

  const active = () => (location.hash.replace(/^#\/?/, "") || "home") === "apps";

  function empty() {
    return `
      <div class="w-card ap-empty">
        <div class="ap-stack" aria-hidden="true">
          ${tile("Games", "a")}${tile("Shop", "b")}${tile("Bet", "c")}
          <span class="ap-hub"><span></span></span>
        </div>
        <h2>No apps connected yet</h2>
        <p>When a website or app lets you add funds with Nora, it opens a secure Nora window. You see the exact amount and decide. Apps you’ve used show up here.</p>
        <ol class="ap-how">
          <li><b>1</b><span><strong>The app asks</strong>You tap “Add funds with Nora” inside the app.</span></li>
          <li><b>2</b><span><strong>You confirm</strong>Check the amount, then Confirm or Decline.</span></li>
          <li><b>3</b><span><strong>Done</strong>Money moves instantly and you both get an email receipt.</span></li>
        </ol>
        <a class="w-more" href="/docs#apps">Building an app? Read the guide <i aria-hidden="true"></i></a>
      </div>`;
  }

  function logo(a) {
    if (a.brand?.logo) return `<span class="ap-tile ap-img"><img src="${esc(a.brand.logo)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>`;
    if (a.brand?.color) return `<span class="ap-tile" style="background:${esc(a.brand.color)}">${esc(String(a.name).trim().charAt(0).toUpperCase())}</span>`;
    return tile(a.name);
  }

  function card(a) {
    return `
      <article class="w-card ap-card" data-id="${esc(a.id)}">
        <header class="ap-head">
          ${logo(a)}
          <div class="ap-title">
            <h3>${esc(a.name)}</h3>
            <p>${a.domain ? `<a href="${esc(a.website)}" target="_blank" rel="noopener noreferrer">${esc(a.domain)}${ICONS.ext}</a><span>·</span>` : ""}Connected ${day(a.connected)}</p>
          </div>
          <span class="ap-live"><i></i>Connected</span>
        </header>

        <dl class="ap-totals">
          <div><dt>Total added</dt><dd>${Nsh.nsh(a.totals.added)} <small>NSH</small></dd></div>
          <div><dt>Deposits</dt><dd>${Nsh.nsh(a.totals.deposits)}</dd></div>
          <div><dt>Last used</dt><dd class="ap-when">${a.last_used ? Nsh.when(a.last_used) : "Not yet"}</dd></div>
        </dl>

        <p class="ap-rule">${ICONS.deposits}<span>Can ask you to add funds. <b>You confirm every amount</b> in a Nora window first.</span></p>

        ${a.recent.length ? `
        <details class="ap-recent">
          <summary>Recent deposits <span>${a.recent.length}</span></summary>
          <ul>
            ${a.recent.map((m) => `<li><span class="ap-dot">${ICONS.deposits}</span>
                <div><b>${esc(m.description || "Added to app")}</b><small>${esc(m.reference ? `${m.reference} · ${Nsh.when(m.created)}` : Nsh.when(m.created))}</small></div>
                <strong>−${Nsh.nsh(m.amount)} NSH</strong></li>`).join("")}
          </ul>
        </details>` : `<p class="ap-quiet">No deposits yet. It’s connected and ready.</p>`}

        <footer class="ap-foot">
          <span class="ap-msg" role="status"></span>
          <button class="btn sm ap-off" type="button" data-off>Disconnect</button>
        </footer>
        <div class="ap-confirm" hidden>
          <p><b>Disconnect ${esc(a.name)}?</b> It won’t be able to ask you for deposits anymore. Requests that are still open are cancelled. Your past deposits stay in your activity.</p>
          <div>
            <button class="btn sm" type="button" data-keep>Keep connected</button>
            <button class="btn sm ap-danger" type="button" data-confirm>Disconnect</button>
          </div>
        </div>
      </article>`;
  }

  function render() {
    if (!all) return;
    data = all[mode];
    const n = data.apps.length;
    const tests = all.test.apps.length;
    const tabs = tests || mode === "test" ? `
      <div class="ap-tabs" role="tablist" aria-label="Connections">
        <button type="button" role="tab" data-tab="live" aria-selected="${mode === "live"}">Live</button>
        <button type="button" role="tab" data-tab="test" aria-selected="${mode === "test"}">Sandbox${tests ? ` <i>${tests}</i>` : ""}</button>
      </div>` : "";
    root.innerHTML = `
      <div class="ap-intro">
        <div>
          <h2>${n ? `${n} connected app${n === 1 ? "" : "s"}` : "Connected apps"}</h2>
          <p>${mode === "test" ? "Test connections made with Sandbox keys. No real money moves." : "Apps that can use your wallet."}</p>
        </div>
        <span class="ap-safe">${ICONS.shield}Apps never see your balance or other activity</span>
      </div>${tabs}
      ${n ? `<div class="ap-grid">${data.apps.map(card).join("")}</div>` : empty()}`;
  }

  async function load() {
    if (loading) return;
    loading = true;
    if (!all) root.innerHTML = `<div class="ap-skel"><div class="w-card"></div><div class="w-card"></div></div>`;
    try {
      const [live, test] = await Promise.all(["live", "test"].map((m) => Nsh.api(`apps/connected?mode=${m}`)));
      all = { live, test };
      if (mode === "test" && !test.apps.length) mode = "live";
      render();
    } catch (err) {
      root.innerHTML = `<div class="w-card w-empty"><b>Couldn’t load your apps</b><span>${esc(err.message)}</span></div>`;
    } finally {
      loading = false;
    }
  }

  root.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      mode = tab.dataset.tab;
      render();
      return;
    }
    const cardEl = e.target.closest(".ap-card");
    if (!cardEl) return;
    const confirm = cardEl.querySelector(".ap-confirm");
    if (e.target.closest("[data-off]")) {
      confirm.hidden = false;
      confirm.querySelector("[data-keep]").focus();
    } else if (e.target.closest("[data-keep]")) {
      confirm.hidden = true;
    } else if (e.target.closest("[data-confirm]")) {
      const btn = e.target.closest("[data-confirm]");
      btn.disabled = true;
      btn.classList.add("busy");
      btn.textContent = "Disconnecting…";
      try {
        await Nsh.api("apps/disconnect", { body: { id: cardEl.dataset.id } });
        cardEl.classList.add("gone");
        setTimeout(() => {
          data.apps = data.apps.filter((a) => a.id !== cardEl.dataset.id);
          render();
        }, 280);
      } catch (err) {
        btn.disabled = false;
        btn.classList.remove("busy");
        btn.textContent = "Disconnect";
        cardEl.querySelector(".ap-msg").textContent = err.message;
      }
    }
  });

  root.addEventListener("error", (e) => {
    const img = e.target.closest?.(".ap-img img");
    if (img) img.replaceWith(img.closest(".ap-card")?.querySelector("h3")?.textContent.trim().charAt(0).toUpperCase() || "");
  }, true);

  const refresh = () => { if (active()) load(); };
  addEventListener("hashchange", refresh);
  refresh();
})();
