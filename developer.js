(() => {
  const $ = (s) => document.querySelector(s);
  const BASE = location.origin;
  let me = null;
  let freshKey = { test: "", live: "" };

  function snippet(mode) {
    const key = freshKey[mode] || `nsh_${mode}_your_secret_key`;
    $("#snippet").innerHTML = `curl ${BASE}/v1/payments \\
  -H "<b>Authorization: Bearer ${Nsh.esc(key)}</b>" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"1800","unit":"NSH","company":"Northwind Books","reference":"order_1042"}'`;
  }

  function renderKey(mode) {
    const live = mode === "live";
    const locked = live && !me.verified;
    const k = me.keys[mode];
    $("#key-mode").textContent = live ? "Live" : "Sandbox";
    $("#key-mode").className = `tag ${live ? "ok" : "warn"}`;
    $("#key-box").classList.toggle("fresh", Boolean(freshKey[mode]));
    $("#copy-key").hidden = !freshKey[mode];
    if (freshKey[mode]) {
      $("#key-text").textContent = freshKey[mode];
      $("#key-note").textContent = "Copy it now. For your safety it is shown only once.";
    } else if (k) {
      $("#key-text").textContent = `nsh_${mode}_••••••••••••${k.last4}`;
      $("#key-note").textContent = `Created ${Nsh.when(k.created)}. Use it from your server only.`;
    } else {
      $("#key-text").textContent = locked ? "Verify to unlock" : "No key yet";
      $("#key-note").textContent = "Use it from your server only.";
    }
    $("#roll-key").textContent = k || freshKey[mode] ? "Replace key" : "Create key";
    $("#roll-key").disabled = locked;
  }

  function render() {
    const mode = Nsh.mode();
    const live = mode === "live";
    $("#sandbox-note").hidden = live;
    $("#verify-note").hidden = !live || me.verified;
    $("#pay-note").textContent = live
      ? "Live payments start as pending. Share the checkout link; it turns paid when the buyer pays."
      : "Sandbox payments are paid at once so you can test.";
    $("#hook-form").url.value = me.webhooks[mode] || "";
    renderKey(mode);
    snippet(mode);
  }

  async function loadLists() {
    const mode = Nsh.mode();
    const { payments, events } = await Nsh.api(`dev/overview?mode=${mode}`);
    $("#payments").innerHTML = payments.length ? payments.map((p) => {
      const tag = p.status === "paid" ? "ok" : p.status === "pending" ? "warn" : "";
      const action = p.status === "paid"
        ? `<button class="btn sm" type="button" data-refund="${Nsh.esc(p.id)}">Refund</button>`
        : p.status === "pending" ? `<a class="btn sm" href="${Nsh.esc(p.checkout_url)}" target="_blank" rel="noopener">Checkout</a>` : "";
      return `<li>
        <div class="what"><b>${Nsh.esc(p.company)} · ${Nsh.nsh(p.amount)} NSH</b><span>${Nsh.esc(p.id)}${p.reference ? ` · ${Nsh.esc(p.reference)}` : ""} · fee ${Nsh.nsh(p.fee)} · ${Nsh.when(p.created)}</span></div>
        <span class="tag ${tag}">${Nsh.esc(p.status)}</span>${action}
      </li>`;
    }).join("") : `<li class="empty">No payments yet. Create one above.</li>`;

    $("#events").innerHTML = events.length ? events.map((e) => {
      const s = e.delivery_status;
      const tag = s === null ? `<span class="tag">No webhook set</span>`
        : s >= 200 && s < 300 ? `<span class="tag ok">${s}</span>`
        : `<span class="tag bad">${s === 0 ? "Unreachable" : s}</span>`;
      return `<li><div class="what"><b>${Nsh.esc(e.type)}</b><span>${Nsh.esc(e.id)}${e.payment_id ? ` · ${Nsh.esc(e.payment_id)}` : ""} · ${Nsh.when(e.created_at)}</span></div>${tag}</li>`;
    }).join("") : `<li class="empty">No events yet.</li>`;

    document.querySelectorAll("[data-refund]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Refund this payment? The buyer gets the full amount back and the fee is returned to you.")) return;
      b.disabled = true;
      try {
        await Nsh.api("dev/refund", { body: { mode: Nsh.mode(), payment: b.dataset.refund } });
        await loadLists();
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    }));
  }

  async function load() {
    me = await Nsh.api(`me?mode=${Nsh.mode()}`);
    render();
    await loadLists();
  }

  $("#roll-key").addEventListener("click", async () => {
    const mode = Nsh.mode();
    if (me.keys[mode] && !confirm("Replace the key? The old key stops working right away.")) return;
    const msg = $("#key-msg");
    msg.className = "msg";
    try {
      const { key } = await Nsh.api("dev/keys", { body: { mode } });
      freshKey[mode] = key;
      me.keys[mode] = { last4: key.slice(-4), created: new Date().toISOString() };
      render();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  });

  $("#copy-key").addEventListener("click", async () => {
    await navigator.clipboard.writeText(freshKey[Nsh.mode()]).catch(() => {});
    $("#copy-key").textContent = "Copied";
    setTimeout(() => { $("#copy-key").textContent = "Copy"; }, 1500);
  });

  const hook = $("#hook-form");
  hook.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(hook, $("#hook-msg"), async () => {
      const { url } = await Nsh.api("dev/webhook", { body: { mode: Nsh.mode(), url: hook.url.value } });
      me.webhooks[Nsh.mode()] = url;
      return url ? "Saved." : "Webhook removed.";
    });
  });
  $("#hook-test").addEventListener("click", async () => {
    const msg = $("#hook-msg");
    msg.className = "msg";
    msg.textContent = "Sending…";
    try {
      const r = await Nsh.api("dev/webhook/test", { body: { mode: Nsh.mode() } });
      const s = r.delivery_status;
      if (s === null) { msg.className = "msg err"; msg.textContent = "Save a webhook URL first."; }
      else if (s >= 200 && s < 300) { msg.className = "msg ok"; msg.textContent = `Delivered. Your server answered ${s}.`; }
      else { msg.className = "msg err"; msg.textContent = s === 0 ? "We could not reach that URL." : `Your server answered ${s}.`; }
      await loadLists();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  });

  const pay = $("#pay-form");
  pay.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(pay, $("#pay-msg"), async () => {
      const p = await Nsh.api("dev/payment", {
        body: { mode: Nsh.mode(), amount: pay.amount.value.replace(/[,\s]/g, ""), unit: "NSH", company: pay.company.value, reference: pay.reference.value },
      });
      $("#pay-out").hidden = false;
      $("#pay-out").textContent = JSON.stringify(p, null, 2);
      await loadLists();
      return p.status === "pending" ? "Created. Send the checkout_url to your buyer." : "Paid in Sandbox.";
    });
  });

  (async () => {
    try {
      await load();
      Nsh.shell("business", me, async () => { $("#pay-out").hidden = true; await load(); });
      $("#loading").hidden = true;
      $("#page").hidden = false;
    } catch (err) {
      $("#loading").innerHTML = `<p class="empty">${Nsh.esc(err.message)}</p>`;
    }
  })();
})();
