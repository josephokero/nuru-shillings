(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const BASE = location.origin;
  let me = null;
  let overview = { payments: [], events: [], totals: null };
  let apps = null;
  let payFilter = "all";
  const freshKey = { test: "", live: "" };

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    in: svg("M17 7 7 17M16 17H7V8"),
    back: svg("M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"),
    clock: svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"),
    hook: svg("M4 12h12M12 6l6 6-6 6"),
    check: svg("m5 12 4.5 4.5L19 7"),
    list: svg("M4 6h16M4 12h16M4 18h10"),
  };

  const VIEWS = {
    overview: ["Overview", "Take Nora payments on your own platform"],
    payments: ["Payments", "Create payments and refund them"],
    apps: ["Apps", "Let people add funds to your app from their Nora wallet"],
    keys: ["API keys", "Your secret key and the API base URL"],
    webhooks: ["Webhooks", "Get told the moment money moves"],
  };

  const mode = () => Nsh.mode();
  const live = () => mode() === "live";
  const nshText = (n) => `${Nsh.nsh(n)} NSH`;
  const dateOf = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
  };
  const empty = (title, text) => `<li class="w-empty"><span class="w-empty-ico">${ICONS.list}</span><b>${title}</b><span>${text}</span></li>`;

  /* ---------- rows ---------- */

  function paymentRow(p) {
    const [tag, tone, icon] = p.status === "paid" ? ["Paid", "ok", ICONS.in]
      : p.status === "pending" ? ["Pending", "warn", ICONS.clock]
      : p.status === "refunded" ? ["Refunded", "", ICONS.back] : [p.status, "", ICONS.list];
    const action = p.status === "paid"
      ? `<button class="dv-act" type="button" data-refund="${Nsh.esc(p.id)}">Refund</button>`
      : p.status === "pending" && p.checkout_url
        ? `<a class="dv-act" href="${Nsh.esc(p.checkout_url)}" target="_blank" rel="noopener">Checkout link</a>` : "";
    const meta = [p.id, p.reference, `fee ${Nsh.nsh(p.fee)}`].filter(Boolean).join(" · ");
    return `<li class="w-row">
      <div class="w-tx">
        <span class="w-ico ${p.status === "paid" ? "in" : ""}">${icon}</span>
        <div class="w-what"><b>${Nsh.esc(p.company)}</b><span>${Nsh.esc(meta)}</span><span class="w-date-sm">${dateOf(p.created)}</span></div>
      </div>
      <span class="w-date">${dateOf(p.created)}</span>
      <span class="w-status"><span class="tag ${tone}">${tag}</span></span>
      <div class="w-amt ${p.status === "paid" ? "in" : ""}"><b>${nshText(p.amount)}</b>${action}</div>
    </li>`;
  }

  function eventRow(e) {
    const s = e.delivery_status;
    const tag = s === null ? `<span class="tag">No webhook set</span>`
      : s >= 200 && s < 300 ? `<span class="tag ok">Delivered · ${s}</span>`
      : `<span class="tag bad">${s === 0 ? "Unreachable" : `Answered ${s}`}</span>`;
    return `<li class="dv-event">
      <span class="w-ico">${ICONS.hook}</span>
      <div class="w-what"><b>${Nsh.esc(e.type)}</b><span>${Nsh.esc(e.id)}${e.payment_id ? ` · ${Nsh.esc(e.payment_id)}` : ""} · ${dateOf(e.created_at)}</span></div>
      ${tag}
    </li>`;
  }

  /* ---------- render ---------- */

  function renderSetup() {
    const m = mode();
    const t = overview.totals;
    const steps = [
      { done: Boolean(me.keys[m] || freshKey[m]), title: "Create a secret key", text: "Your server uses it to call the API.", href: "#keys", go: "Create key" },
      { done: Boolean(me.webhooks[m]), title: "Add a webhook", text: "Get payment and deposit events on your server.", href: "#webhooks", go: "Add URL" },
      { done: Boolean(apps?.apps.length), title: "Create an app", text: "Let people add funds from their wallet.", href: "#apps", go: "New app" },
      { done: Boolean(t && (t.payments.paid + t.payments.pending + t.payments.refunded + t.deposits.count)), title: live() ? "Take your first payment" : "Make a test payment", text: live() ? "Share a checkout link with a buyer." : "It is paid at once in Sandbox.", href: "#payments", go: "Create" },
    ];
    const done = steps.filter((s) => s.done).length;
    $("#setup-count").textContent = done === steps.length ? "All set" : `${done} of ${steps.length}`;
    $("#setup-bar").style.width = `${Math.round((done / steps.length) * 100)}%`;
    $("#setup").innerHTML = steps.map((s) => `<li class="${s.done ? "done" : ""}">
      <span class="dv-tick">${s.done ? ICONS.check : ""}</span>
      <div><b>${s.title}</b><span>${s.text}</span></div>
      ${s.done ? "" : `<a class="btn sm" href="${s.href}">${s.go}</a>`}
    </li>`).join("");
  }

  function renderOverview() {
    const m = mode();
    const bal = me.balances[m];
    const t = overview.totals || { payments: { paid: 0, pending: 0, net: 0, fees: 0 }, deposits: { count: 0, net: 0, fees: 0 }, webhooks: { sent: 0, ok: 0 } };
    $("#ov-mode").textContent = live() ? "Live" : "Sandbox";
    $("#ov-mode").className = `w-mode ${live() ? "live" : ""}`;
    $("#ov-bal").textContent = Nsh.nsh(bal);
    $("#ov-usd").textContent = `≈ ${Nsh.usd(bal)} USD`;
    $("#ov-pay-net").textContent = nshText(t.payments.net);
    $("#ov-dep-net").textContent = nshText(t.deposits.net);
    $("#ov-fees").textContent = nshText(t.payments.fees + t.deposits.fees);
    $("#st-paid").textContent = Nsh.nsh(t.payments.paid);
    $("#st-pending").textContent = `${Nsh.nsh(t.payments.pending)} pending`;
    const list = apps?.apps || [];
    $("#st-users").textContent = Nsh.nsh(list.reduce((s, a) => s + (a.users[m] || 0), 0));
    $("#st-apps").textContent = `${list.length} app${list.length === 1 ? "" : "s"}`;
    $("#st-hooks").textContent = `${Nsh.nsh(t.webhooks.ok)} of ${Nsh.nsh(t.webhooks.sent)}`;
    $("#ov-payments").innerHTML = overview.payments.length
      ? overview.payments.slice(0, 5).map(paymentRow).join("")
      : empty("No payments yet", live() ? "Create a payment and share its checkout link." : "Create a test payment. It is paid at once.");
    $("#ov-events").innerHTML = overview.events.length
      ? overview.events.slice(0, 6).map(eventRow).join("")
      : empty("No events yet", "Send a test event once your webhook URL is saved.");
    renderSetup();
  }

  function renderPayments() {
    const rows = overview.payments.filter((p) => payFilter === "all" || p.status === payFilter);
    $("#payments").innerHTML = rows.length ? rows.map(paymentRow).join("")
      : empty(payFilter === "all" ? "No payments yet" : `No ${payFilter} payments`, "Payments you create show up here.");
    $("#pay-note").textContent = live() ? "Live payments start as pending" : "Sandbox payments are paid at once";
    $("#pay-how").innerHTML = (live()
      ? ["Create the payment here or with POST /v1/payments.", "Send the checkout link to your buyer.", "They pay from their Nora wallet. You get payment.paid."]
      : ["Create a test payment here or with POST /v1/payments.", "It is paid at once from Sandbox money.", "Your webhook gets payment.paid. Refund it to test payment.refunded."]
    ).map((s, i) => `<li><b>${i + 1}</b><span>${s}</span></li>`).join("");
    payPreview();
  }

  function payPreview() {
    const n = Number($("#pay-form").amount.value.replace(/[,\s]/g, "")) || 0;
    $("#pay-eq").textContent = n ? `≈ ${Nsh.usd(n)} · fee ${Nsh.nsh(Math.round(n / 100))} NSH · you get ${Nsh.nsh(n - Math.round(n / 100))} NSH` : "Enter an amount";
    $$("#pay-form [data-nsh]").forEach((b) => b.classList.toggle("on", Number(b.dataset.nsh) === n));
  }

  function renderKey() {
    const m = mode();
    const k = me.keys[m];
    $("#key-mode").textContent = live() ? "Live" : "Sandbox";
    $("#key-mode").className = `tag ${live() ? "ok" : "warn"}`;
    $("#key-box").classList.toggle("fresh", Boolean(freshKey[m]));
    $("#copy-key").hidden = !freshKey[m];
    $("#key-check").hidden = !freshKey[m];
    if (freshKey[m]) {
      $("#key-text").textContent = freshKey[m];
      $("#key-note").textContent = "Copy it now. For your safety it is shown only once.";
    } else if (k) {
      $("#key-text").textContent = `nsh_${m}_••••••••••••${k.last4}`;
      $("#key-note").textContent = `Created ${Nsh.when(k.created)}. Use it from your server only.`;
    } else {
      $("#key-text").textContent = "No key yet";
      $("#key-note").textContent = "Use it from your server only.";
    }
    $("#roll-key").textContent = k || freshKey[m] ? "Replace key" : "Create key";
    $("#roll-key").disabled = false;
    $("#base-url").textContent = `${BASE}/v1`;
    const key = freshKey[m] || `nsh_${m}_your_secret_key`;
    $("#snippet").innerHTML = `curl ${BASE}/v1/payments \\
  -H "<b>Authorization: Bearer ${Nsh.esc(key)}</b>" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"1800","unit":"NSH","company":"Northwind Books","reference":"order_1042"}'`;
  }

  function renderHooks() {
    const url = me.webhooks[mode()] || "";
    $("#hook-form").url.value = url;
    $("#hook-state").textContent = url ? "Active" : "Not set";
    $("#hook-state").className = `tag ${url ? "ok" : ""}`;
    $("#hook-secret").textContent = "whsec_••••••••••••";
    $("#hook-reveal").textContent = "Reveal";
    $("#events").innerHTML = overview.events.length ? overview.events.map(eventRow).join("")
      : empty("No events yet", url ? "Send a test event to see it here." : "Save a webhook URL, then send a test event.");
  }

  function render() {
    $("#sandbox-note").hidden = live();
    $("#verify-note").hidden = true;
    $$(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode()));
    renderOverview();
    renderPayments();
    renderKey();
    renderHooks();
  }

  /* ---------- routing ---------- */

  function route() {
    let view = location.hash.replace(/^#\/?/, "") || "overview";
    if (!Object.hasOwn(VIEWS, view)) view = "overview";
    $$(".view").forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$(".side-nav [data-view]").forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const [title, sub] = VIEWS[view];
    $("#view-title").textContent = title;
    $("#view-sub").textContent = sub;
    document.title = `${title} · Business tools · Nora Shillings`;
    scrollTo({ top: 0, behavior: "instant" });
  }
  addEventListener("hashchange", route);

  /* ---------- data ---------- */

  async function loadOverview() {
    overview = await Nsh.api(`dev/overview?mode=${mode()}`);
  }

  async function load() {
    [me] = await Promise.all([Nsh.api(`me?mode=${mode()}`), loadOverview()]);
    render();
  }

  async function refresh() {
    await Promise.all([
      loadOverview(),
      Nsh.api(`me?mode=${mode()}`).then((m) => { me = m; }),
    ]);
    render();
  }

  document.addEventListener("nsh:apps", (e) => {
    const again = apps !== null;
    apps = e.detail;
    if (!me) return;
    if (again) refresh().catch(() => renderOverview());
    else renderOverview();
  });

  /* ---------- actions ---------- */

  async function sendTestEvent(msg) {
    msg.className = msg.id === "ov-msg" ? "dv-inline-msg" : "msg";
    msg.textContent = "Sending…";
    const fail = (text) => { msg.className = msg.id === "ov-msg" ? "dv-inline-msg err" : "msg err"; msg.textContent = text; };
    try {
      const r = await Nsh.api("dev/webhook/test", { body: { mode: mode() } });
      const s = r.delivery_status;
      if (s === null) fail("Save a webhook URL first.");
      else if (s >= 200 && s < 300) { msg.className = msg.id === "ov-msg" ? "dv-inline-msg ok" : "msg ok"; msg.textContent = `Delivered. Your server answered ${s}.`; }
      else fail(s === 0 ? "We could not reach that URL." : `Your server answered ${s}.`);
      await refresh();
    } catch (err) {
      fail(err.message);
    }
  }

  document.addEventListener("click", async (e) => {
    const t = e.target;
    const hookBtn = t.closest("[data-hook-test]");
    if (hookBtn) {
      hookBtn.disabled = true;
      await sendTestEvent(hookBtn.closest("#hook-form") ? $("#hook-msg") : $("#ov-msg"));
      hookBtn.disabled = false;
      return;
    }
    const go = t.closest("[data-go]");
    if (go?.dataset.go === "pay") setTimeout(() => $("#pay-form").company.focus(), 60);
    if (go?.dataset.go === "app") setTimeout(() => $("#dev-apps [data-new]")?.click(), 60);

    const pf = t.closest("[data-pf]");
    if (pf) {
      payFilter = pf.dataset.pf;
      $$("[data-pf]").forEach((b) => b.classList.toggle("on", b === pf));
      renderPayments();
    }
    const chip = t.closest("#pay-form [data-nsh]");
    if (chip) {
      $("#pay-form").amount.value = chip.dataset.nsh;
      payPreview();
    }
    const copy = t.closest("[data-copy-from]");
    if (copy) {
      await navigator.clipboard.writeText($(copy.dataset.copyFrom).textContent).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    }
    const refund = t.closest("[data-refund]");
    if (refund) {
      if (!confirm("Refund this payment? The buyer gets the full amount back and the fee is returned to you.")) return;
      refund.disabled = true;
      try {
        await Nsh.api("dev/refund", { body: { mode: mode(), payment: refund.dataset.refund } });
        await refresh();
      } catch (err) {
        alert(err.message);
        refund.disabled = false;
      }
    }
  });

  $("#roll-key").addEventListener("click", async () => {
    const m = mode();
    if (me.keys[m] && !confirm("Replace the key? The old key stops working right away.")) return;
    const msg = $("#key-msg");
    msg.className = "msg";
    msg.textContent = "";
    try {
      const { key } = await Nsh.api("dev/keys", { body: { mode: m } });
      freshKey[m] = key;
      me.keys[m] = { last4: key.slice(-4), created: new Date().toISOString() };
      render();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  });

  $("#copy-key").addEventListener("click", async () => {
    await navigator.clipboard.writeText(freshKey[mode()]).catch(() => {});
    $("#copy-key").textContent = "Copied";
    setTimeout(() => { $("#copy-key").textContent = "Copy"; }, 1500);
  });

  $("#key-check").addEventListener("click", async () => {
    const msg = $("#key-msg");
    msg.className = "msg";
    msg.textContent = "Calling the API with this key…";
    try {
      const res = await fetch(`${BASE}/v1/webhooks`, { headers: { Authorization: `Bearer ${freshKey[mode()]}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The API answered ${res.status}.`);
      msg.className = "msg ok";
      msg.textContent = `The key works. ${data.mode === "live" ? "Live" : "Sandbox"} webhook: ${data.url || "not set yet"}.`;
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  });

  const hook = $("#hook-form");
  hook.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(hook, $("#hook-msg"), async () => {
      const { url } = await Nsh.api("dev/webhook", { body: { mode: mode(), url: hook.url.value } });
      me.webhooks[mode()] = url;
      render();
      return url ? "Saved. Send a test event to check it." : "Webhook removed.";
    });
  });

  $("#hook-reveal").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = $("#hook-secret");
    if (btn.textContent === "Copy") {
      await navigator.clipboard.writeText(out.textContent).catch(() => {});
      btn.textContent = "Copied";
      return;
    }
    btn.disabled = true;
    try {
      const { secret } = await Nsh.api(`dev/webhook/secret?mode=${mode()}`);
      out.textContent = secret;
      btn.textContent = "Copy";
    } catch (err) {
      $("#hook-msg").className = "msg err";
      $("#hook-msg").textContent = err.message;
    }
    btn.disabled = false;
  });

  const pay = $("#pay-form");
  pay.amount.addEventListener("input", payPreview);
  pay.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(pay, $("#pay-msg"), async () => {
      const p = await Nsh.api("dev/payment", {
        body: { mode: mode(), amount: pay.amount.value.replace(/[,\s]/g, ""), unit: "NSH", company: pay.company.value, reference: pay.reference.value },
      });
      const out = $("#pay-out");
      out.hidden = false;
      out.innerHTML = `<dl>
          <div><dt>Payment</dt><dd><code>${Nsh.esc(p.id)}</code></dd></div>
          <div><dt>Status</dt><dd><span class="tag ${p.status === "paid" ? "ok" : "warn"}">${Nsh.esc(p.status)}</span></dd></div>
          <div><dt>You get</dt><dd>${nshText(Number(p.amount) - Number(p.fee))}</dd></div>
          ${p.checkout_url ? `<div><dt>Checkout</dt><dd><a class="link" href="${Nsh.esc(p.checkout_url)}" target="_blank" rel="noopener">${Nsh.esc(p.checkout_url)}</a></dd></div>` : ""}
        </dl>`;
      pay.reference.value = "";
      refresh().catch(() => {});
      return p.status === "pending" ? "Created. Send the checkout link to your buyer." : "Paid in Sandbox. Your webhook got payment.paid.";
    });
  });

  (async () => {
    try {
      await load();
      Nsh.shell("business", me, async () => {
        $("#pay-out").hidden = true;
        $("#pay-msg").textContent = "";
        $("#ov-msg").textContent = "";
        await load();
      });
      route();
      $("#loading").hidden = true;
      $("#page").hidden = false;
    } catch (err) {
      $("#loading").innerHTML = `<div class="w-card w-empty"><b>Couldn’t load Business tools</b><span>${Nsh.esc(err.message)}</span></div>`;
    }
  })();
})();
