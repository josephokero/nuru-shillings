(() => {
  const $ = (s) => document.querySelector(s);
  let me = null;
  let open = "";

  const LABELS = {
    add: ["＋", "Added"],
    send: ["↗", "Sent to"],
    receive: ["↙", "Received from"],
    withdraw: ["↑", "Withdrawn to"],
    pay: ["→", "Paid"],
    payment: ["↙", "Payment from checkout"],
    refund: ["↺", "Refund"],
  };

  function render() {
    const mode = Nsh.mode();
    const live = mode === "live";
    const bal = me.balances[mode];
    $("#bal").textContent = Nsh.nsh(bal);
    $("#bal-usd").textContent = `${Nsh.usd(bal)}${live ? "" : " in test money"}`;
    $("#bal-label").textContent = live ? "Balance" : "Sandbox balance";
    $("#sandbox-note").hidden = live;
    $("#verify-note").hidden = !live || me.verified;
    $("#add-note").textContent = live
      ? "Choose an amount. 100 NSH are added for every dollar."
      : "Sandbox top-ups are instant and free. Test money only.";

    $("#acc-email").textContent = me.email;
    $("#acc-name").textContent = me.name || "—";
    $("#acc-country").textContent = me.country || "—";
    const tag = $("#verified-tag");
    tag.textContent = me.verified ? "Verified" : "Not verified";
    tag.className = `tag ${me.verified ? "ok" : "warn"}`;

    const list = $("#activity");
    if (!me.activity.length) {
      list.innerHTML = `<li class="empty">No activity yet${live ? "" : " in Sandbox"}.</li>`;
      return;
    }
    list.innerHTML = me.activity.map((a) => {
      const [icon, label] = LABELS[a.kind] || ["•", a.kind];
      const income = a.amount > 0;
      const who = a.kind === "add" ? `${a.counterparty || ""}${a.method ? ` · ${a.method}` : ""}`
        : a.kind === "withdraw" ? `${a.method} · ${a.counterparty}`
        : a.counterparty || "";
      const title = ["send", "receive", "withdraw"].includes(a.kind) ? `${label} ${a.kind === "withdraw" ? a.method : a.counterparty}` : label;
      const status = a.status === "pending" ? ` · <span class="tag warn">Pending</span>` : "";
      return `<li>
        <span class="ico">${icon}</span>
        <div class="what"><b>${Nsh.esc(title)}</b><span>${Nsh.esc(a.kind === "send" || a.kind === "receive" ? "" : who)}${a.ref ? ` · ${Nsh.esc(a.ref)}` : ""} · ${Nsh.when(a.created_at)}${status}</span></div>
        <span class="amt ${income ? "in" : ""}">${income ? "+" : "−"}${Nsh.nsh(Math.abs(a.amount))} NSH</span>
      </li>`;
    }).join("");
  }

  async function load() {
    me = await Nsh.api(`me?mode=${Nsh.mode()}`);
    render();
  }

  function show(name) {
    open = open === name ? "" : name;
    for (const p of ["add", "send", "withdraw", "verify"]) $(`#panel-${p}`).hidden = open !== p;
    document.querySelectorAll(".balance .actions .btn").forEach((b) => b.classList.toggle("on", b.dataset.open === open));
    if (open) $(`#panel-${open}`).querySelector("input")?.focus();
  }
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    const want = b.dataset.open;
    if (Nsh.mode() === "live" && !me.verified && want !== "verify") return show("verify");
    show(want);
  }));

  const addForm = $("#panel-add");
  const preview = () => {
    const usd = parseInt(addForm.usd.value, 10) || 0;
    $("#add-preview").textContent = `${Nsh.nsh(usd * 100)} NSH`;
    addForm.querySelectorAll("#chips button").forEach((c) => c.classList.toggle("on", Number(c.dataset.usd) === usd));
  };
  addForm.querySelectorAll("#chips button").forEach((c) => c.addEventListener("click", () => { addForm.usd.value = c.dataset.usd; preview(); }));
  addForm.usd.addEventListener("input", preview);
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(addForm, $("#msg-add"), async () => {
      await Nsh.api("wallet/add", { body: { mode: Nsh.mode(), usd: parseInt(addForm.usd.value, 10), method: addForm.method.value } });
      await load();
      return `Added ${$("#add-preview").textContent}.`;
    });
  });

  const sendForm = $("#panel-send");
  sendForm.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(sendForm, $("#msg-send"), async () => {
      const amount = sendForm.amount.value.replace(/[,\s]/g, "");
      await Nsh.api("wallet/send", { body: { mode: Nsh.mode(), to: sendForm.to.value, amount } });
      await load();
      const done = `Sent ${Nsh.nsh(amount)} NSH to ${sendForm.to.value}.`;
      sendForm.reset();
      return done;
    });
  });

  const wForm = $("#panel-withdraw");
  const destLabel = () => {
    const m = wForm.method.value;
    $("#dest-label").textContent = m === "PayPal" ? "PayPal email" : m === "M-Pesa" ? "M-Pesa phone number" : "Card’s last 4 digits";
    wForm.destination.placeholder = m === "PayPal" ? "you@example.com" : m === "M-Pesa" ? "+254 7XX XXX XXX" : "4242";
  };
  wForm.method.addEventListener("change", destLabel);
  wForm.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(wForm, $("#msg-withdraw"), async () => {
      const amount = wForm.amount.value.replace(/[,\s]/g, "");
      const r = await Nsh.api("wallet/withdraw", { body: { mode: Nsh.mode(), amount, method: wForm.method.value, destination: wForm.destination.value } });
      await load();
      wForm.amount.value = "";
      return r.status === "pending"
        ? `Withdrawal of ${Nsh.nsh(amount)} NSH requested. It shows as pending until it is paid out.`
        : `Withdrew ${Nsh.nsh(amount)} NSH (Sandbox).`;
    });
  });

  const vForm = $("#panel-verify");
  vForm.addEventListener("submit", (e) => {
    e.preventDefault();
    Nsh.submit(vForm, $("#msg-verify"), async () => {
      await Nsh.api("wallet/verify", { body: { name: vForm.name.value, country: vForm.country.value } });
      await load();
      setTimeout(() => show(""), 1200);
      return "You’re verified. Live is ready.";
    });
  });

  (async () => {
    try {
      await load();
      Nsh.shell("wallet", me, async () => { show(""); await load(); });
      $("#loading").hidden = true;
      $("#page").hidden = false;
    } catch (err) {
      $("#loading").innerHTML = `<p class="empty">${Nsh.esc(err.message)}</p>`;
    }
  })();
})();
