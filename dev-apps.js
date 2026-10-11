(() => {
  const root = document.querySelector("#dev-apps");
  if (!root) return;
  const esc = Nsh.esc;
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const SWATCHES = ["#ffffff", "#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#0a0a0a"];

  let data = null;
  let editing = null;

  const inkOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#000" : "#fff";
  };
  const colorFor = (brand) => brand.color || (brand.theme === "light" ? "#0a0a0a" : "#ffffff");

  function tile(a) {
    const letter = esc(String(a.name || "A").trim().charAt(0).toUpperCase());
    if (a.brand?.logo) return `<span class="da-tile da-img"><img src="${esc(a.brand.logo)}" alt="" referrerpolicy="no-referrer"></span>`;
    if (a.brand?.color) return `<span class="da-tile" style="background:${esc(a.brand.color)};color:${inkOf(a.brand.color)}">${letter}</span>`;
    return `<span class="da-tile" style="--h:${hue(a.name)}">${letter}</span>`;
  }

  const connectLink = (a) => {
    const p = new URLSearchParams({ app: a.id, redirect_uri: a.redirect_uris[0], state: "your-random-state", mode: Nsh.mode() });
    return `${data.connect_base}?${p}`;
  };

  /* The real deposit page, loaded from its own HTML with sample data, so the preview is exactly what users get. */
  const PV_WIDTH = 440;
  let depositHtml = null;
  let pv = null;
  const previewBox = () => `
    <div class="da-pv-tabs" role="tablist" aria-label="Preview screen">
      <button type="button" class="on" data-pv="confirm">Confirm</button>
      <button type="button" data-pv="signin">Logged out</button>
      <button type="button" data-pv="done">Complete</button>
    </div>
    <div class="da-pv-frame"><iframe title="Deposit window preview" tabindex="-1"></iframe></div>
    <p class="da-pv-note">The real deposit window your users see. Amount and customer are samples.</p>`;

  addEventListener("message", (e) => {
    if (!pv || e.origin !== location.origin || e.source !== pv.frame.contentWindow) return;
    if (e.data?.type === "nuru:preview-ready") { pv.ready = true; pv.paint(); }
    if (e.data?.type === "nuru:preview-size") pv.fit(e.data.height);
  });

  function form(a) {
    const brand = a?.brand || { color: null, theme: "dark", logo: null };
    return `
      <form class="da-form" id="da-form">
        <div class="da-form-grid">
          <div>
            <div class="row">
              <label class="field"><span>App name people see</span><input class="input" name="name" required maxlength="60" placeholder="Acme Games" value="${esc(a?.name || "")}"></label>
              <label class="field"><span>Website</span><input class="input" name="website" placeholder="https://acme.games" value="${esc(a?.website || "")}"></label>
            </div>
            <label class="field"><span>Return URLs, one per line</span><textarea class="input da-uris" name="redirect_uris" rows="2" required placeholder="https://acme.games/nuru/return">${esc((a?.redirect_uris || []).join("\n"))}</textarea></label>
            <p class="da-hint">Where people land after a deposit when you use a full-page redirect instead of the popup. Use https, or http://localhost while testing.</p>

            <p class="da-sub">Deposit window</p>
            <div class="da-brand">
              <div class="field">
                <span>Theme</span>
                <div class="da-seg" role="radiogroup">
                  <label><input type="radio" name="theme" value="dark" ${brand.theme !== "light" ? "checked" : ""}><span>Dark</span></label>
                  <label><input type="radio" name="theme" value="light" ${brand.theme === "light" ? "checked" : ""}><span>Light</span></label>
                </div>
              </div>
              <div class="field">
                <span>Button colour</span>
                <div class="da-swatches">
                  ${SWATCHES.map((c) => `<button type="button" class="da-sw ${brand.color === c ? "on" : ""}" style="--c:${c}" data-sw="${c}" aria-label="${c}"></button>`).join("")}
                  <label class="da-pick" title="Pick any colour"><input type="color" value="${esc(brand.color || "#4f46e5")}" data-pick><span>+</span></label>
                  <input type="hidden" name="brand_color" value="${esc(brand.color || "")}">
                </div>
              </div>
            </div>
            <label class="field"><span>Logo link (optional)</span><input class="input" name="logo_url" placeholder="https://acme.games/logo.png" value="${esc(brand.logo || "")}"></label>
          </div>
          <div class="da-pv-wrap" id="da-pv">${previewBox()}</div>
        </div>
        <div class="da-form-foot">
          <button class="btn" type="button" data-cancel>Cancel</button>
          <button class="btn primary" type="submit">${a ? "Save changes" : "Create app"}</button>
        </div>
        <p class="msg" id="da-msg"></p>
      </form>`;
  }

  function appRow(a) {
    const color = colorFor(a.brand);
    const m = Nsh.mode();
    const users = a.users[m];
    return `
      <li class="da-app" data-id="${esc(a.id)}">
        <div class="da-top">
          ${tile(a)}
          <div class="da-name">
            <b>${esc(a.name)}</b>
            <span>${a.website ? `${esc(a.website.replace(/^https?:\/\//, ""))} · ` : ""}${users} ${m === "live" ? "live" : "Sandbox"} user${users === 1 ? "" : "s"} · ${Nsh.nsh(a.received[m])} NSH received</span>
          </div>
          <div class="da-actions">
            <button class="btn sm primary" type="button" data-test>Test the popup</button>
            <button class="btn sm" type="button" data-edit>Edit</button>
            <button class="btn sm" type="button" data-del>Delete</button>
          </div>
        </div>
        <dl class="da-kv">
          <div><dt>App ID</dt><dd><code>${esc(a.id)}</code><button type="button" class="da-copy" data-copy="${esc(a.id)}">Copy</button></dd></div>
          <div><dt>Window</dt><dd><span class="da-chip"><i style="background:${esc(color)}"></i>${a.brand.theme === "light" ? "Light" : "Dark"} · ${esc(color)}</span>${a.brand.logo ? `<span class="da-chip">Custom logo</span>` : ""}</dd></div>
          <div><dt>Return URL${a.redirect_uris.length > 1 ? "s" : ""}</dt><dd>${a.redirect_uris.map((u) => `<code>${esc(u)}</code>`).join("")}</dd></div>
          <div><dt>Connect only</dt><dd class="da-link"><code>${esc(connectLink(a))}</code>
            <span><button type="button" class="da-copy" data-copy="${esc(connectLink(a))}">Copy</button><small>Optional. Links a wallet to your user account before any deposit.</small></span></dd></div>
        </dl>
        <p class="da-test-msg" role="status"></p>
        <div class="da-confirm" hidden>
          <span>Delete <b>${esc(a.name)}</b>? Everyone connected to it is disconnected and open deposit requests are cancelled.</span>
          <button class="btn sm" type="button" data-keep>Keep</button>
          <button class="btn sm da-danger" type="button" data-sure>Delete app</button>
        </div>
      </li>`;
  }

  const SNIPPET = (sdk) => `<span class="c">// 1. Your server asks for a deposit (secret key stays on the server)</span>
POST /v1/deposits  { "app": "app_…", "amount": "500", "reference": "order_1042" }

<span class="c">// 2. Your page opens the Nuru window with the url you got back</span>
&lt;script src="${esc(sdk)}"&gt;&lt;/script&gt;
const { status } = await Nuru.deposit(deposit.url);
<span class="c">// "succeeded" · "declined" · "closed". Confirm with the deposit.succeeded webhook.</span>`;

  function render() {
    pv = null;
    root.innerHTML = `
      <div class="card-head">
        <div><h2>Apps</h2><p>Let people add funds to your app from their Nuru wallet. They confirm every amount in a Nuru window that matches your brand.</p></div>
        ${editing === null && data.apps.length ? `<button class="btn sm primary" type="button" data-new>New app</button>` : ""}
      </div>
      <div class="card-body">
        ${editing === "new" || (!data.apps.length && editing === null) ? form(null) : ""}
        ${data.apps.length ? `<ul class="da-list">${data.apps.map((a) => (editing === a.id ? `<li class="da-app">${form(a)}</li>` : appRow(a))).join("")}</ul>` : ""}
        <div class="da-flow">
          <span><b>1</b>Create a deposit with your secret key</span>
          <span><b>2</b>Open it with <code>Nuru.deposit()</code> or redirect</span>
          <span><b>3</b>The user confirms and you both get an email</span>
          <a class="link" href="/docs#apps">Full guide →</a>
        </div>
        <pre class="da-code">${SNIPPET(data.sdk)}</pre>
      </div>`;
    const f = root.querySelector("#da-form");
    if (!f) return;
    if (!data.apps.length) f.querySelector("[data-cancel]").hidden = true;
    bindForm(f);
  }

  function bindForm(f) {
    const brand = () => ({
      theme: f.querySelector("input[name=theme]:checked")?.value || "dark",
      color: f.brand_color.value || null,
      logo: /^https:\/\/\S+$/.test(f.logo_url.value.trim()) ? f.logo_url.value.trim() : null,
    });
    const wrap = f.querySelector("#da-pv");
    const box = wrap.querySelector(".da-pv-frame");
    const frame = box.querySelector("iframe");
    const sample = () => {
      const website = f.website.value.trim();
      let domain = null;
      try { domain = new URL(website).hostname.replace(/^www\./, ""); } catch { /* not a full link yet */ }
      return {
        status: "pending", mode: Nsh.mode(), amount: 500, reference: "order_1042", description: null, origins: [], return_url: null,
        app: { name: f.name.value.trim() || "Your app", website, domain, brand: brand() },
        user: { name: "Amina Otieno", email: "amina@example.com", balance: 2400, connected: false },
      };
    };
    pv = {
      frame, ready: false, view: "confirm", height: 640,
      paint() { if (this.ready) frame.contentWindow.postMessage({ type: "nuru:preview", view: this.view, info: sample() }, location.origin); },
      fit(h) {
        if (h) this.height = h;
        const s = Math.min(1, box.clientWidth / PV_WIDTH);
        frame.style.height = `${this.height}px`;
        frame.style.transform = `scale(${s})`;
        box.style.height = `${Math.ceil(this.height * s)}px`;
      },
    };
    new ResizeObserver(() => pv?.frame === frame && pv.fit()).observe(box);
    pv.fit();
    depositHtml ||= fetch("/deposit").then((r) => r.text()).then((t) => t.replace('<body class="dp"', '<body class="dp" data-preview'));
    depositHtml.then((html) => { frame.srcdoc = html; }).catch(() => { wrap.querySelector(".da-pv-note").textContent = "Preview couldn’t load. Refresh to try again."; });
    wrap.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-pv]");
      if (!tab) return;
      pv.view = tab.dataset.pv;
      wrap.querySelectorAll("[data-pv]").forEach((b) => b.classList.toggle("on", b === tab));
      pv.paint();
    });
    const paint = () => pv.paint();
    const setColor = (c) => {
      f.brand_color.value = c;
      f.querySelectorAll(".da-sw").forEach((s) => s.classList.toggle("on", s.dataset.sw === c));
      f.querySelector(".da-pick").classList.toggle("on", Boolean(c) && !SWATCHES.includes(c));
      paint();
    };
    f.addEventListener("input", (e) => {
      if (e.target.matches("[data-pick]")) setColor(e.target.value);
      else paint();
    });
    f.addEventListener("change", paint);
    f.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-sw]");
      if (sw) setColor(f.brand_color.value === sw.dataset.sw ? "" : sw.dataset.sw);
    });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      Nsh.submit(f, f.querySelector("#da-msg"), async () => {
        const b = brand();
        await Nsh.api("dev/apps", {
          body: {
            id: editing !== "new" ? editing : undefined,
            name: f.name.value,
            website: f.website.value,
            redirect_uris: f.redirect_uris.value.split(/\s+/).filter(Boolean),
            theme: b.theme,
            brand_color: f.brand_color.value,
            logo_url: f.logo_url.value.trim(),
          },
        });
        editing = null;
        await load();
      });
    });
  }

  async function load() {
    try {
      data = await Nsh.api("dev/apps");
      render();
    } catch (err) {
      root.innerHTML = `<div class="card-body"><p class="msg err">${esc(err.message)}</p></div>`;
    }
  }

  async function testDeposit(row, btn) {
    const msg = row.querySelector(".da-test-msg");
    msg.className = "da-test-msg";
    msg.textContent = "";
    btn.disabled = true;
    try {
      const d = await Nsh.api("dev/apps/test-deposit", { body: { id: row.dataset.id, amount: "500" } });
      if (!window.Nuru) { location.assign(d.url); return; }
      const r = await window.Nuru.deposit(d.url, { redirect: false });
      const text = {
        succeeded: "Test deposit succeeded. Check your email and the deposit.succeeded webhook.",
        declined: "You declined the test deposit. A deposit.declined webhook was sent.",
        blocked: "Your browser blocked the popup. Allow popups for this site and try again.",
      }[r.status] || "The window was closed before finishing.";
      msg.className = `da-test-msg ${r.status === "succeeded" ? "ok" : ""}`;
      msg.textContent = text;
      if (r.status === "succeeded") load();
    } catch (err) {
      msg.className = "da-test-msg err";
      msg.textContent = err.message;
    }
    btn.disabled = false;
  }

  root.addEventListener("error", (e) => {
    const img = e.target.closest?.(".da-img img, .da-pv-logo img");
    if (img) img.remove();
  }, true);

  root.addEventListener("click", async (e) => {
    const t = e.target;
    const row = t.closest(".da-app");
    if (t.closest("[data-new]")) { editing = "new"; render(); root.querySelector("#da-form input")?.focus(); }
    else if (t.closest("[data-cancel]")) { editing = null; render(); }
    else if (t.closest("[data-edit]")) { editing = row.dataset.id; render(); }
    else if (t.closest("[data-test]")) { testDeposit(row, t.closest("[data-test]")); }
    else if (t.closest("[data-del]")) { row.querySelector(".da-confirm").hidden = false; }
    else if (t.closest("[data-keep]")) { row.querySelector(".da-confirm").hidden = true; }
    else if (t.closest("[data-sure]")) {
      t.disabled = true;
      await Nsh.api("dev/apps/delete", { body: { id: row.dataset.id } }).catch((err) => alert(err.message));
      await load();
    } else if (t.closest("button[data-copy]")) {
      const b = t.closest("button[data-copy]");
      await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy"; }, 1600);
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".modes button") && data && editing === null) setTimeout(render, 30);
    else if (e.target.closest(".modes button") && pv) setTimeout(() => pv.paint(), 30);
  });

  load();
})();
