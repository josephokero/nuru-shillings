(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  let me = null;
  let filter = "all";
  let query = "";

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    plus: svg("M12 5v14M5 12h14"),
    out: svg("M7 17 17 7M8 7h9v9"),
    in: svg("M17 7 7 17M16 17H7V8"),
    bank: svg("M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z"),
    bag: svg("M6 7h12l1 14H5L6 7zM9 7a3 3 0 0 1 6 0"),
    back: svg("M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"),
    list: svg("M4 6h16M4 12h16M4 18h10"),
  };
  const LABELS = {
    add: [ICONS.plus, "Added"],
    send: [ICONS.out, "Sent to"],
    receive: [ICONS.in, "Received from"],
    withdraw: [ICONS.bank, "Withdrawn to"],
    withdraw_refund: [ICONS.back, "Withdrawal returned"],
    pay: [ICONS.bag, "Paid"],
    payment: [ICONS.in, "Payment from checkout"],
    refund: [ICONS.back, "Refund"],
    app_pay: [ICONS.bag, "Paid in app"],
    app_deposit: [ICONS.out, "Added to app"],
    app_withdraw: [ICONS.in, "Withdrawn from app"],
    app_payment: [ICONS.in, "App payment"],
    app_deposit_in: [ICONS.in, "App funds added"],
    app_payout: [ICONS.out, "App withdrawal"],
  };

  const VIEWS = {
    home: ["Home", null],
    activity: ["Activity", "Every payment in and out of your wallet"],
    add: ["Add money", "Top up your balance at 100 NSH = $1"],
    send: ["Send money", "Free and instant to any Nuru account"],
    withdraw: ["Withdraw", "Cash out to PayPal, M-Pesa, or card"],
    account: ["Account", "Your profile and verification"],
    apps: ["Apps", "Apps connected to your wallet"],
  };
  // The wallet is always real money. Sandbox lives only in Business tools for developers.
  const MODE = "live";

  const amountOf = (v) => String(v || "").replace(/[,\s]/g, "");
  const dateOf = (iso) => {
    const d = new Date(iso);
    const today = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return `${d.toLocaleDateString("en-US", opts)}, ${time}`;
  };
  const greet = () => {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return me?.name ? `${part}, ${me.name.split(" ")[0]}` : part;
  };
  const setAll = (key, fn) => $$(`[data-f="${key}"]`).forEach(fn);

  function describe(a) {
    const [icon, label] = LABELS[a.kind] || [ICONS.list, a.kind];
    const sub = a.kind === "add" ? [a.method, a.counterparty].filter(Boolean).join(" · ")
      : a.kind === "withdraw" ? a.counterparty || ""
      : a.kind === "send" || a.kind === "receive" ? (a.method || "Nuru transfer") : a.counterparty || "";
    const title = ["send", "receive", "withdraw"].includes(a.kind) ? `${label} ${a.kind === "withdraw" ? a.method : a.counterparty}` : label;
    return { icon, title, meta: [sub, a.ref].filter(Boolean).join(" · ") };
  }

  function row(a) {
    const { icon, title, meta } = describe(a);
    const income = a.amount > 0;
    const pending = a.status === "pending";
    const [tag, tone] = pending ? ["Pending", "warn"] : a.status === "failed" ? ["Returned", "bad"] : ["Completed", "ok"];
    return `<li class="w-row">
      <div class="w-tx">
        <span class="w-ico ${income ? "in" : ""}">${icon}</span>
        <div class="w-what"><b>${Nsh.esc(title)}</b><span>${Nsh.esc(meta) || "&nbsp;"}</span><span class="w-date-sm">${dateOf(a.created_at)}</span></div>
      </div>
      <span class="w-date">${dateOf(a.created_at)}</span>
      <span class="w-status"><span class="tag ${tone}">${tag}</span></span>
      <div class="w-amt ${income ? "in" : ""}"><b>${income ? "+" : "−"}${Nsh.nsh(Math.abs(a.amount))} NSH</b><span>${Nsh.usd(Math.abs(a.amount))}</span></div>
    </li>`;
  }

  const empty = (title, text) => `<li class="w-empty">
    <span class="w-empty-ico">${ICONS.list}</span>
    <b>${title}</b><span>${text}</span>
  </li>`;

  function render() {
    const bal = me.balances[MODE];
    const acts = me.activity || [];

    $("#bal").textContent = Nsh.nsh(bal);
    $("#bal-usd").textContent = `≈ ${Nsh.usd(bal)} USD`;
    $("#verify-note").hidden = me.verified || current !== "withdraw";

    const pending = acts.filter((a) => a.status === "pending").reduce((s, a) => s + Math.abs(a.amount), 0);
    setAll("avail", (el) => { el.textContent = `${Nsh.nsh(bal)} NSH`; });
    setAll("pending", (el) => { el.textContent = `${Nsh.nsh(pending)} NSH`; });
    setAll("balance", (el) => { el.textContent = `${Nsh.nsh(bal)} NSH`; });
    setAll("balance-usd", (el) => { el.textContent = `≈ ${Nsh.usd(bal)} USD`; });

    const since = Date.now() - 30 * 864e5;
    const recent30 = acts.filter((a) => new Date(a.created_at).getTime() >= since);
    const inflow = recent30.filter((a) => a.amount > 0).reduce((s, a) => s + a.amount, 0);
    const outflow = recent30.filter((a) => a.amount < 0).reduce((s, a) => s - a.amount, 0);
    $("#st-in").textContent = `${Nsh.nsh(inflow)} NSH`;
    $("#st-in-usd").textContent = `${Nsh.usd(inflow)} · last 30 days`;
    $("#st-out").textContent = `${Nsh.nsh(outflow)} NSH`;
    $("#st-out-usd").textContent = `${Nsh.usd(outflow)} · last 30 days`;
    $("#st-count").textContent = Nsh.nsh(recent30.length);

    setAll("email", (el) => { el.textContent = me.email; });
    setAll("avatar", (el) => { el.innerHTML = Nsh.avatar(me); });
    $("#av-remove").hidden = !me.avatar;
    $("#av-change").textContent = me.avatar ? "Change photo" : "Upload photo";
    $("#acc-since").textContent = me.member_since
      ? new Date(me.member_since).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "—";
    setAll("tag", (el) => { el.textContent = me.verified ? "Verified" : "Not verified"; el.className = `tag ${me.verified ? "ok" : "warn"}`; });
    setAll("step", (el) => el.classList.toggle("done", !!me.verified));
    $("#acc-name").textContent = me.name || "—";
    $("#acc-country").textContent = me.country || "—";
    $("#panel-verify").hidden = !!me.verified;
    renderKyc();
    const sideStatus = $("#side-status");
    if (sideStatus) sideStatus.textContent = me.verified ? "Verified" : "Not verified";

    $("#recent").innerHTML = acts.length
      ? acts.slice(0, 5).map(row).join("")
      : empty("No activity yet", "Add money, send, or withdraw. Every payment shows up here.");

    const people = [...new Set(acts.filter((a) => (a.kind === "send" || a.kind === "receive") && a.counterparty).map((a) => a.counterparty))].slice(0, 6);
    $("#people").innerHTML = people.map((p) => `<button type="button" data-to="${Nsh.esc(p)}"><span class="w-avatar sm">${Nsh.esc(p.charAt(0).toUpperCase())}</span><span>${Nsh.esc(p)}</span></button>`).join("");
    refreshCheckout();

    renderWithdrawals();
    renderActivity();
    if (current === "home") $("#view-sub").textContent = greet();
  }

  const WD_STATUS = {
    processing: ["Sending", "warn"],
    pending: ["Pending", "warn"],
    unclaimed: ["Awaiting claim", "warn"],
    review: ["In review", "warn"],
    paid: ["Completed", "ok"],
    failed: ["Returned", "bad"],
  };
  const wdDone = (w) => w.status === "paid" || w.status === "failed";
  let wdFilter = "all";
  let wdTimer;

  function wdNote(w) {
    if (w.status === "failed") return w.failure || "Returned to your wallet";
    if (w.status === "unclaimed") return "PayPal emailed this address. Claim it within 30 days or it comes back to your wallet";
    if (w.status === "review") return "We’re checking this payout. No action needed";
    if (w.status === "processing") return "Sending to PayPal";
    if (w.status === "pending") return w.method === "M-Pesa" ? "Arrives in 1–8 hours, depending on traffic" : "Waiting for payout review";
    if (w.receipt) return `PayPal receipt ${w.receipt}`;
    return w.paid_at ? `Paid ${dateOf(w.paid_at)}` : "Paid";
  }

  function wdRow(w) {
    const [tag, tone] = WD_STATUS[w.status] || WD_STATUS.pending;
    const icon = w.status === "failed" ? ICONS.back : ICONS.bank;
    return `<li class="w-row">
      <div class="w-tx">
        <span class="w-ico">${icon}</span>
        <div class="w-what"><b>${Nsh.esc(`${w.method} · ${w.destination}`)}</b><span>${Nsh.esc(wdNote(w))}</span><span class="w-date-sm">${dateOf(w.created_at)}</span></div>
      </div>
      <span class="w-date">${dateOf(w.created_at)}</span>
      <span class="w-status"><span class="tag ${tone}">${tag}</span></span>
      <div class="w-amt${w.status === "failed" ? " wd-returned" : ""}"><b>−${Nsh.nsh(w.amount)} NSH</b><span>${Nsh.usd(w.amount)}</span></div>
    </li>`;
  }

  function renderWithdrawals() {
    const all = me.withdrawals || [];
    const list = all.filter((w) => wdFilter === "all" || (wdFilter === "pending" ? !wdDone(w) : w.status === wdFilter));
    $("#wd-history").innerHTML = list.length
      ? list.map(wdRow).join("")
      : empty(all.length ? "Nothing here" : "No withdrawals yet", all.length ? "No withdrawals match this filter." : "Every withdrawal shows up here with its status.");
    const open = all.filter((w) => !wdDone(w)).length;
    $("#wd-foot").textContent = all.length ? `${all.length} ${all.length === 1 ? "withdrawal" : "withdrawals"}${open ? ` · ${open} in progress` : ""}` : "";
    clearTimeout(wdTimer);
    if (all.some((w) => w.status === "processing")) {
      wdTimer = setTimeout(() => { if (current === "withdraw" && !document.hidden) load().catch(() => {}); }, 15000);
    }
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    return (me.activity || []).filter((a) => {
      if (filter === "in" && !(a.amount > 0)) return false;
      if (filter === "out" && !(a.amount < 0)) return false;
      if (filter === "pending" && a.status !== "pending") return false;
      if (!q) return true;
      const { title, meta } = describe(a);
      return `${title} ${meta} ${a.amount}`.toLowerCase().includes(q);
    });
  }

  function renderActivity() {
    const list = filtered();
    $("#activity").innerHTML = list.length
      ? list.map(row).join("")
      : empty(query ? "No matches" : "Nothing here yet", query ? "Try a different search." : "Payments that match this filter will show up here.");
    const total = (me.activity || []).length;
    $("#act-foot").textContent = total ? `Showing ${list.length} of ${total} ${total === 1 ? "transaction" : "transactions"}` : "";
  }

  function exportCsv() {
    const lines = [["Date", "Type", "Description", "Status", "Amount NSH", "Amount USD"]];
    for (const a of filtered()) {
      const { title, meta } = describe(a);
      lines.push([new Date(a.created_at).toISOString(), a.kind, `${title}${meta ? ` (${meta})` : ""}`, a.status || "completed", a.amount, (a.amount / 100).toFixed(2)]);
    }
    const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "nuru-activity.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  let current = "home";
  function route() {
    let view = location.hash.replace(/^#\/?/, "") || "home";
    if (view === "verify") view = "account";
    if (!VIEWS[view]) view = "home";
    current = view;
    if (me) $("#verify-note").hidden = me.verified || view !== "withdraw";
    $$(".view").forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$("[data-view]").forEach((a) => {
      if (a.classList.contains("view")) return;
      const on = a.dataset.view === view;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const [title, sub] = VIEWS[view];
    $("#view-title").textContent = title;
    $("#view-sub").textContent = sub || greet();
    $("#top-actions").hidden = view !== "home";
    stopPoll();
    $$(".co-done").forEach((d) => { d.hidden = true; d.previousElementSibling.hidden = false; });
    document.title = `${title} · Nuru Shillings`;
    scrollTo({ top: 0, behavior: "instant" });
    const field = $(`.view[data-view="${view}"] form .input`);
    if (field && matchMedia("(min-width: 721px)").matches) field.focus({ preventScroll: true });
  }
  addEventListener("hashchange", route);
  addEventListener("scroll", () => document.body.classList.toggle("is-scrolled", scrollY > 4), { passive: true });

  document.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      $$("[data-filter]").forEach((b) => b.classList.toggle("on", b === f));
      renderActivity();
    }
    const wf = e.target.closest("[data-wdf]");
    if (wf) {
      wdFilter = wf.dataset.wdf;
      $$("[data-wdf]").forEach((b) => b.classList.toggle("on", b === wf));
      renderWithdrawals();
    }
    const to = e.target.closest("[data-to]");
    if (to) {
      sendForm.to.value = to.dataset.to;
      refreshCheckout();
      sendForm.amount.focus();
    }
    const nsh = e.target.closest("[data-nsh]");
    if (nsh) {
      sendForm.amount.value = Nsh.nsh(nsh.dataset.nsh);
      refreshCheckout();
    }
    const recheck = e.target.closest("[data-recheck]");
    if (recheck) confirmReturn(recheck.dataset.recheck);
    if (e.target.closest("[data-again]")) {
      stopPoll();
      const done = e.target.closest(".co-done");
      done.hidden = true;
      done.previousElementSibling.hidden = false;
      done.closest("form").querySelector(".co-amount input")?.focus();
    }
    if (e.target.closest("[data-logout]")) {
      await Nsh.api("auth/logout", { body: {}, redirect: false }).catch(() => {});
      location.href = "/signin";
    }
  });
  $("#act-search").addEventListener("input", (e) => { query = e.target.value; renderActivity(); });
  $("#act-csv").addEventListener("click", exportCsv);

  let restored = false;
  async function load() {
    me = await Nsh.api(`me?mode=${MODE}`);
    if (!restored) {
      restored = true;
      restorePrefs();
    }
    render();
  }

  const pickMethod = (form, value) => {
    const radio = [...form.querySelectorAll('input[name="method"]')].find((r) => r.value === value);
    if (radio) radio.checked = true;
  };
  function restorePrefs() {
    const p = me.prefs || {};
    if (p.add_method) pickMethod(addForm, p.add_method);
    if (p.mpesa_phone && !addForm.phone.value) addForm.phone.value = p.mpesa_phone;
    if (p.withdraw_method) pickMethod(wForm, p.withdraw_method);
    if (p.withdraw_destination && !wForm.destination.value) wForm.destination.value = p.withdraw_destination;
  }
  const savePrefs = (prefs) => Nsh.api("profile/prefs", { body: prefs, redirect: false })
    .then((r) => { me.prefs = r.prefs; })
    .catch(() => {});

  /* profile picture: crop to a square and shrink in the browser, then store on Bunny */
  const avFile = $("#av-file");
  const avMsg = $("#msg-av");
  $("#av-pick").addEventListener("click", () => avFile.click());
  $("#av-change").addEventListener("click", () => avFile.click());
  async function squareJpeg(file, size = 320) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.86);
  }
  avFile.addEventListener("change", async () => {
    const file = avFile.files[0];
    avFile.value = "";
    if (!file) return;
    avMsg.className = "msg";
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { avMsg.className = "msg err"; avMsg.textContent = "Choose a JPG, PNG, or WebP picture."; return; }
    if (file.size > 15 * 1024 * 1024) { avMsg.className = "msg err"; avMsg.textContent = "That picture is too large. Use one under 15 MB."; return; }
    $("#av-pick").classList.add("busy");
    avMsg.textContent = "Uploading…";
    try {
      const image = await squareJpeg(file);
      const r = await Nsh.api("profile/avatar", { body: { image } });
      me.avatar = r.avatar;
      render();
      avMsg.className = "msg ok";
      avMsg.textContent = "Profile picture saved.";
    } catch (err) {
      avMsg.className = "msg err";
      avMsg.textContent = err.message || "We could not read that picture.";
    } finally {
      $("#av-pick").classList.remove("busy");
    }
  });
  $("#av-remove").addEventListener("click", async () => {
    avMsg.className = "msg";
    avMsg.textContent = "Removing…";
    try {
      await Nsh.api("profile/avatar/remove", { body: {} });
      me.avatar = null;
      render();
      avMsg.className = "msg ok";
      avMsg.textContent = "Profile picture removed.";
    } catch (err) {
      avMsg.className = "msg err";
      avMsg.textContent = err.message;
    }
  });

  const conv = $("#convert");
  const convUsd = () => Math.max(0, parseFloat(String(conv.usd.value).replace(/[,\s$]/g, "")) || 0);
  const convPreview = () => { $("#conv-out").textContent = Nsh.nsh(Math.round(convUsd() * 100)); };
  conv.usd.addEventListener("input", convPreview);
  conv.addEventListener("submit", (e) => {
    e.preventDefault();
    addForm.usd.value = Math.max(1, Math.round(convUsd()));
    refreshCheckout();
    location.hash = "add";
  });

  const addForm = $("#panel-add");
  const sendForm = $("#panel-send");
  const wForm = $("#panel-withdraw");
  const CHECK = svg("M5 12.5 10 17l9-10");
  const CROSS = svg("M7 7l10 10M17 7 7 17");
  const CLOCK = svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2");
  const PHONE = svg("M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2");
  const LOCK = svg("M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3");
  const METHOD_KEY = { PayPal: "paypal", Card: "card", "M-Pesa": "mpesa" };

  const fit = (input) => {
    const len = (input.value || input.placeholder || "0").length;
    input.style.width = `${Math.max(1, len) + 0.4}ch`;
  };
  const balance = () => (me ? me.balances[MODE] : 0);
  const after = (delta) => `${Nsh.nsh(balance() + delta)} NSH`;

  function finish(form, { title, text, again }) {
    const body = form.querySelector(".co-body");
    const done = form.querySelector(".co-done");
    done.innerHTML = `
      <span class="co-check">${CHECK}</span>
      <h3>${Nsh.esc(title)}</h3>
      <p>${Nsh.esc(text)}</p>
      <div class="co-done-actions">
        <a class="btn" href="#activity">View activity</a>
        <button class="btn primary" type="button" data-again>${Nsh.esc(again)}</button>
      </div>`;
    body.hidden = true;
    done.hidden = false;
  }

  function refreshCheckout() {
    const usd = parseInt(amountOf(addForm.usd.value), 10) || 0;
    const addM = addForm.method.value;
    const mpesa = addM === "M-Pesa";
    const kes = Math.ceil(usd * (me?.payments?.kes_per_usd || 129));
    const cents = Nsh.usd(usd * 100);
    $("#add-preview").textContent = `${Nsh.nsh(usd * 100)} NSH`;
    $("#add-s-usd").textContent = cents;
    $("#add-s-method").textContent = addM;
    $("#add-s-total").textContent = `${Nsh.nsh(usd * 100)} NSH`;
    $("#add-s-after").textContent = after(usd * 100);
    $("#add-s-kes-row").hidden = !mpesa;
    $("#add-s-kes").textContent = `KES ${Nsh.nsh(kes)}`;
    $("#mpesa-field").hidden = !mpesa;
    addForm.phone.required = mpesa;
    const caps = me?.payments || {};
    addForm.querySelectorAll('input[name="method"]').forEach((r) => {
      const off = me ? !caps[METHOD_KEY[r.value]] : false;
      r.disabled = off;
      r.closest(".co-method").classList.toggle("off", off);
    });
    const btn = $("#add-btn");
    btn.textContent = !usd ? "Enter an amount"
      : addM === "PayPal" ? `Continue to PayPal · ${cents}`
      : addM === "Card" ? `Pay ${cents} by card`
      : `Send M-Pesa prompt · KES ${Nsh.nsh(kes)}`;
    btn.dataset.busy = addM === "M-Pesa" ? "Sending prompt…" : "Opening secure checkout…";
    btn.disabled = !usd;
    $("#add-note").textContent = addM === "PayPal" ? "You’ll log in to PayPal to pay, then come straight back here."
      : addM === "Card" ? "You’ll enter your card on PayPal’s secure page. No PayPal account needed."
      : "We’ll send a payment prompt to your phone. Enter your M-Pesa PIN to pay.";
    $("#add-trust").hidden = false;
    $("#add-trust").innerHTML = addM === "M-Pesa"
      ? `${LOCK}M-Pesa payments run through PayHero. You approve with your own PIN.`
      : `${LOCK}Secured by PayPal. Nuru never sees your card number or PayPal password.`;
    addForm.querySelectorAll("#chips button").forEach((c) => c.classList.toggle("on", Number(c.dataset.usd) === usd));
    fit(addForm.usd);

    const sAmt = Number(amountOf(sendForm.amount.value)) || 0;
    const to = sendForm.to.value.trim();
    const sOver = sAmt > balance();
    $("#send-eq").textContent = `≈ ${Nsh.usd(sAmt)}`;
    $("#send-s-to").textContent = to || "—";
    $("#send-s-amount").textContent = `${Nsh.nsh(sAmt)} NSH`;
    $("#send-preview").textContent = `${Nsh.nsh(sAmt)} NSH`;
    $("#send-s-after").textContent = sOver ? "—" : after(-sAmt);
    $("#send-warn").hidden = !sOver;
    $("#send-btn").textContent = sAmt ? `Send ${Nsh.nsh(sAmt)} NSH` : "Enter an amount";
    $("#send-btn").disabled = !sAmt || sOver;
    $("#to-avatar").textContent = to ? to.charAt(0).toUpperCase() : "@";
    sendForm.querySelectorAll("[data-nsh]").forEach((c) => c.classList.toggle("on", Number(c.dataset.nsh) === sAmt));
    fit(sendForm.amount);

    const wAmt = Number(amountOf(wForm.amount.value)) || 0;
    const wOver = wAmt > balance();
    const m = wForm.method.value;
    const dest = wForm.destination.value.trim();
    $("#wd-preview").textContent = Nsh.usd(wAmt);
    $("#wd-s-amount").textContent = `${Nsh.nsh(wAmt)} NSH`;
    $("#wd-s-to").textContent = dest ? `${m} · ${dest}` : m;
    $("#wd-s-eta").textContent = m === "PayPal" ? "Instantly" : m === "M-Pesa" ? "In 1–8 hours" : "After payout review";
    $("#wd-s-total").textContent = Nsh.usd(wAmt);
    $("#wd-s-after").textContent = wOver ? "—" : after(-wAmt);
    $("#wd-warn").hidden = !wOver;
    const unverified = me && !me.verified;
    $("#wd-btn").textContent = unverified ? "Verify to withdraw" : wAmt ? `Withdraw ${Nsh.usd(wAmt)}` : "Enter an amount";
    $("#wd-btn").disabled = unverified || !wAmt || wOver;
    $("#dest-label").textContent = m === "PayPal" ? "PayPal email" : m === "M-Pesa" ? "M-Pesa phone number" : "Card’s last 4 digits";
    wForm.destination.placeholder = m === "PayPal" ? "you@example.com" : m === "M-Pesa" ? "+254 7XX XXX XXX" : "4242";
    fit(wForm.amount);
  }

  const money = (input) => input.addEventListener("input", () => {
    const raw = amountOf(input.value).replace(/\D/g, "");
    input.value = raw ? Nsh.nsh(raw) : "";
    refreshCheckout();
  });
  money(sendForm.amount);
  money(wForm.amount);
  addForm.usd.addEventListener("input", () => {
    addForm.usd.value = addForm.usd.value.replace(/\D/g, "").slice(0, 6);
    refreshCheckout();
  });
  [addForm, sendForm, wForm].forEach((f) => {
    f.addEventListener("change", refreshCheckout);
    f.addEventListener("input", (e) => { if (!e.target.closest(".co-amount")) refreshCheckout(); });
  });
  addForm.querySelectorAll("#chips button").forEach((c) => c.addEventListener("click", () => { addForm.usd.value = c.dataset.usd; refreshCheckout(); }));
  $("#wd-max").addEventListener("click", () => { wForm.amount.value = Nsh.nsh(balance()); refreshCheckout(); });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const usd = parseInt(amountOf(addForm.usd.value), 10);
    const method = addForm.method.value;
    const phone = addForm.phone.value.trim();
    Nsh.submit(addForm, $("#msg-add"), async () => {
      const r = await Nsh.api("topup/start", { body: { mode: "live", method: METHOD_KEY[method], usd, phone } });
      savePrefs({ add_method: method, ...(method === "M-Pesa" ? { mpesa_phone: phone } : {}) });
      if (r.redirect) {
        location.href = r.redirect;
        await new Promise(() => {});
      }
      startMpesa({ ...r, usd });
    }).then(refreshCheckout);
  });

  /* ---------- live payment screens: M-Pesa steps, receipt, failure ---------- */

  let poll = null;
  let countdown = null;
  let run = 0;
  function stopPoll() {
    run++;
    clearTimeout(poll);
    clearInterval(countdown);
    poll = null;
    countdown = null;
  }
  function showDone(html) {
    const done = addForm.querySelector(".co-done");
    done.innerHTML = html;
    addForm.querySelector(".co-body").hidden = true;
    done.hidden = false;
  }
  const checkStatus = (id) => Nsh.api(`topup/status?id=${encodeURIComponent(id)}`).catch(() => null);

  function receiptRows(t) {
    const when = new Date(t.paid || Date.now()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const paidWith = t.method === "mpesa" ? `M-Pesa ${t.phone || ""}`
      : t.method === "card" ? `Card${t.card_last4 ? ` •••• ${t.card_last4}` : ""}`
      : `PayPal${t.payer ? ` · ${t.payer}` : ""}`;
    return [
      ["Receipt number", t.id],
      ["Date", when],
      ["Paid with", paidWith],
      ["Amount paid", t.kes ? `KES ${Nsh.nsh(t.kes)} (${Nsh.usd(t.usd * 100)})` : Nsh.usd(t.usd * 100)],
      [t.method === "mpesa" ? "M-Pesa receipt" : "PayPal transaction", t.receipt || "—"],
      ["Added to wallet", `${Nsh.nsh(t.nsh)} NSH`],
      ["New balance", `${Nsh.nsh(t.balance ?? balance())} NSH`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${Nsh.esc(v)}</dd></div>`).join("");
  }

  function showReceipt(t) {
    stopPoll();
    showDone(`
      <span class="co-check">${CHECK}</span>
      <h3>Payment successful</h3>
      <p>${Nsh.nsh(t.nsh)} NSH is in your wallet. We emailed the receipt to ${Nsh.esc(me.email)}.</p>
      <dl class="co-receipt">${receiptRows(t)}</dl>
      <div class="co-done-actions">
        <a class="btn" href="#activity">View activity</a>
        <button class="btn primary" type="button" data-again>Add more</button>
      </div>`);
  }

  function showFailure(t) {
    stopPoll();
    const cancelled = t.status === "cancelled";
    showDone(`
      <span class="co-check bad">${CROSS}</span>
      <h3>${cancelled ? "Payment cancelled" : t.method === "mpesa" ? "M-Pesa payment declined" : "Payment not completed"}</h3>
      <p>${Nsh.esc(t.failure || "The payment did not go through. No money was taken.")}</p>
      <dl class="co-receipt small"><div><dt>Reference</dt><dd>${Nsh.esc(t.id)}</dd></div><div><dt>Amount</dt><dd>${t.kes ? `KES ${Nsh.nsh(t.kes)}` : Nsh.usd(t.usd * 100)}</dd></div></dl>
      <div class="co-done-actions">
        <a class="btn" href="/help">Get help</a>
        <button class="btn primary" type="button" data-again>Try again</button>
      </div>`);
  }

  function showWaiting(t, text) {
    stopPoll();
    showDone(`
      <span class="co-check wait">${CLOCK}</span>
      <h3>Still confirming</h3>
      <p>${Nsh.esc(text)}</p>
      <dl class="co-receipt small"><div><dt>Reference</dt><dd>${Nsh.esc(t.id)}</dd></div></dl>
      <div class="co-done-actions">
        <button class="btn" type="button" data-again>Start over</button>
        <button class="btn primary" type="button" data-recheck="${Nsh.esc(t.id)}">Check again</button>
      </div>`);
  }

  async function settle(t) {
    if (t?.status === "paid") { await load(); showReceipt({ ...t, balance: t.balance ?? balance() }); return true; }
    if (t && (t.status === "failed" || t.status === "cancelled")) { showFailure(t); return true; }
    return false;
  }

  function startMpesa(r) {
    stopPoll();
    const started = Date.now();
    const LIMIT = 150;
    showDone(`
      <div class="mp">
        <span class="mp-ico">${PHONE}</span>
        <h3>Check your phone</h3>
        <p>We sent an M-Pesa prompt to <b>${Nsh.esc(r.phone)}</b> for <b>KES ${Nsh.nsh(r.kes)}</b>.</p>
        <ol class="mp-steps">
          <li class="done"><i></i><div><b>Prompt sent</b><span>To ${Nsh.esc(r.phone)}</span></div></li>
          <li class="active" id="mp-pin"><i></i><div><b>Enter your M-Pesa PIN</b><span id="mp-hint">Unlock your phone and enter your PIN on the pop-up.</span></div></li>
          <li id="mp-ok"><i></i><div><b>Payment confirmed</b><span>${Nsh.nsh(r.usd * 100)} NSH lands in your wallet.</span></div></li>
        </ol>
        <p class="mp-wait"><span class="mp-dot"></span>Waiting for M-Pesa <span id="mp-left">2:30</span></p>
        <div class="co-done-actions"><button class="btn" type="button" data-again>Cancel</button></div>
      </div>`);
    countdown = setInterval(() => {
      const left = Math.max(0, LIMIT - Math.floor((Date.now() - started) / 1000));
      const el = $("#mp-left");
      if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (left === 120) { const h = $("#mp-hint"); if (h) h.textContent = "No pop-up? Make sure the phone is on, unlocked, and has signal."; }
    }, 1000);
    const tick = async () => {
      const t = await checkStatus(r.id);
      if (!poll) return;
      if (t?.status === "paid") {
        $("#mp-pin")?.classList.replace("active", "done");
        $("#mp-ok")?.classList.add("done");
        stopPoll();
        setTimeout(() => settle(t), 700);
        return;
      }
      if (t && (t.status === "failed" || t.status === "cancelled")) {
        $("#mp-pin")?.classList.replace("active", "fail");
        stopPoll();
        setTimeout(() => settle(t), 900);
        return;
      }
      if (Date.now() - started > LIMIT * 1000) {
        showWaiting(r, "We haven’t heard back from M-Pesa yet. If you entered your PIN, the payment will show up shortly.");
        return;
      }
      poll = setTimeout(tick, 3000);
    };
    poll = setTimeout(tick, 4000);
  }

  async function confirmReturn(id) {
    stopPoll();
    showDone(`
      <span class="co-check wait spin">${CLOCK}</span>
      <h3>Confirming your payment</h3>
      <p>Checking with the payment provider. This takes a few seconds.</p>`);
    const mine = run;
    for (let i = 0; i < 12; i++) {
      const t = await checkStatus(id);
      if (mine !== run) return;
      if (!t) break;
      if (await settle(t)) return;
      await new Promise((ok) => setTimeout(ok, 2500));
      if (mine !== run) return;
    }
    showWaiting({ id }, "The payment isn’t confirmed yet. If you completed it, it will show up in your activity shortly.");
  }

  sendForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = amountOf(sendForm.amount.value);
    const to = sendForm.to.value.trim();
    Nsh.submit(sendForm, $("#msg-send"), async () => {
      await Nsh.api("wallet/send", { body: { mode: MODE, to, amount } });
      await load();
      sendForm.reset();
      finish(sendForm, {
        title: `${Nsh.nsh(amount)} NSH sent`,
        text: `${to} has it now. Your balance is ${Nsh.nsh(balance())} NSH.`,
        again: "Send again",
      });
    }).then(refreshCheckout);
  });

  wForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = amountOf(wForm.amount.value);
    const method = wForm.method.value;
    Nsh.submit(wForm, $("#msg-withdraw"), async () => {
      const dest = wForm.destination.value.trim();
      const r = await Nsh.api("wallet/withdraw", { body: { mode: MODE, amount, method, destination: dest } });
      savePrefs({ withdraw_method: method, withdraw_destination: dest });
      await load();
      wForm.amount.value = "";
      const done = method === "M-Pesa" ? { title: "Withdrawal requested", text: `${Nsh.usd(amount)} to M-Pesa ${dest}. It arrives in 1–8 hours, depending on traffic, and shows as pending until then.` }
        : method !== "PayPal" ? { title: "Withdrawal requested", text: `${Nsh.usd(amount)} to ${method}. It shows as pending until it is paid out.` }
        : r.status === "paid" ? { title: "Sent to PayPal", text: `${Nsh.usd(amount)} is in the PayPal account for ${dest} now.` }
        : r.status === "unclaimed" ? { title: "Sent to PayPal", text: `PayPal emailed ${dest} to claim ${Nsh.usd(amount)}. If it isn’t claimed within 30 days, it comes back to your wallet.` }
        : { title: "Sending to PayPal", text: `${Nsh.usd(amount)} to ${dest}. It usually lands within a minute. Withdrawal history shows when it’s paid.` };
      finish(wForm, { ...done, again: "Withdraw more" });
    }).then(refreshCheckout);
  });

  const KYC = {
    none: ["", "Verify with ID"],
    not_started: ["", "Verify with ID"],
    in_progress: ["You started a check. Pick up where you left off.", "Continue verification"],
    awaiting_user: ["You started a check. Pick up where you left off.", "Continue verification"],
    resubmitted: ["We need a clearer photo. Continue to send it again.", "Continue verification"],
    in_review: ["Your check is being reviewed. This usually takes a few minutes. Withdrawals unlock as soon as it’s approved.", "Check status"],
    declined: ["We couldn’t verify you. Use a valid ID, take clear photos in good light, and keep your face fully visible.", "Try again", "bad"],
    expired: ["Your last check wasn’t finished. Start a new one.", "Start again"],
    abandoned: ["Your last check wasn’t finished. Start a new one.", "Start again"],
    kyc_expired: ["Your verification expired. Verify again to keep withdrawing.", "Verify again"],
  };
  function renderKyc() {
    const [text, label, tone] = KYC[me.kyc] || KYC.none;
    const state = $("#kyc-state");
    const off = !me.kyc_ready && !me.verified;
    state.textContent = off ? "Identity checks are paused right now. Try again later." : text;
    state.className = `kyc-state${tone ? ` ${tone}` : ""}`;
    state.hidden = !off && !text;
    $("#kyc-btn").textContent = label;
    $("#kyc-btn").disabled = off;
  }

  async function checkKyc() {
    const r = await Nsh.api("wallet/verify/status");
    const changed = r.kyc !== me.kyc || r.verified !== me.verified;
    if (changed) await load();
    return r;
  }

  const vForm = $("#panel-verify");
  vForm.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(vForm, $("#msg-verify"), async () => {
      if (me.kyc === "in_review") {
        const r = await checkKyc();
        return r.verified ? "You’re verified. Withdrawals are unlocked." : r.kyc === "in_review" ? "Still in review. We’ll unlock withdrawals as soon as it’s approved." : "";
      }
      const { url } = await Nsh.api("wallet/verify/start", { body: {} });
      location.href = url;
      await new Promise(() => {});
    }).then(renderKyc);
  });

  function showVerified() {
    const note = $("#kyc-state");
    note.hidden = false;
    note.className = "kyc-state ok";
    note.textContent = `You’re verified${me.name ? ` as ${me.name}` : ""}. Withdrawals are unlocked.`;
    $("#panel-verify").hidden = false;
    $("#kyc-btn").hidden = true;
    $("#msg-verify").textContent = "";
  }

  /* While a check is open, keep the page in step with Didit: quick polls right after returning, then every 15s. */
  const KYC_OPEN = ["in_progress", "awaiting_user", "resubmitted", "in_review"];
  const CHECKING = "Checking your result…";
  let kycTimer = 0;
  function watchKyc(wait = 15000, quick = 0) {
    clearTimeout(kycTimer);
    if (me.verified || !(quick > 0 || KYC_OPEN.includes(me.kyc))) return;
    kycTimer = setTimeout(async () => {
      if (document.hidden) return;
      const r = await checkKyc().catch(() => null);
      if (r?.verified) return showVerified();
      const settled = r && r.kyc !== "not_started" && !KYC_OPEN.includes(r.kyc);
      const msg = $("#msg-verify");
      if ((settled || quick <= 1) && msg.textContent === CHECKING) msg.textContent = "";
      if (!settled) watchKyc(quick > 1 ? 3000 : 15000, quick - 1);
    }, wait);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && me) watchKyc(0); });

  function kycReturned() {
    const msg = $("#msg-verify");
    msg.className = "msg";
    msg.textContent = CHECKING;
    watchKyc(0, 8);
  }

  (async () => {
    try {
      const params = new URLSearchParams(location.search);
      const returned = params.get("topup");
      const fromKyc = params.has("kyc");
      if (returned) history.replaceState(null, "", "/dashboard#add");
      else if (fromKyc) history.replaceState(null, "", "/dashboard#account");
      await load();
      Nsh.shell("wallet", me, async () => { await load(); route(); });
      convPreview();
      route();
      if (returned) confirmReturn(returned);
      if (fromKyc) kycReturned();
      else watchKyc(0);
      $("#loading").hidden = true;
      $("#page").hidden = false;
    } catch (err) {
      $("#loading").innerHTML = `<p class="empty">${Nsh.esc(err.message)}</p>`;
    }
  })();
})();
