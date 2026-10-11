(() => {
  const $ = (s) => document.querySelector(s);
  const { esc } = Nsh;
  const nsh = (n) => Number(n).toLocaleString("en-US");
  const usd = (n) => `$${(Number(n) / 100).toFixed(2)}`;
  const when = (iso) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} days ago`;
  };
  const STATUS = { paid: ["Sent", "ok"], failed: ["Returned", "bad"], processing: ["Sending", "warn"], unclaimed: ["Awaiting claim", "warn"] };

  function card(w) {
    const mpesa = w.method === "M-Pesa";
    const late = Date.now() - new Date(w.created_at) > 8 * 3600e3;
    return `
      <article class="ad-card" data-id="${esc(w.id)}">
        <div class="ad-card-top">
          <div class="ad-amt">
            <b>${mpesa ? `KES ${nsh(w.kes)}` : usd(w.amount)}</b>
            <span>${usd(w.amount)} · ${nsh(w.amount)} NSH</span>
          </div>
          <span class="tag ${late ? "bad" : "warn"}">${w.status === "review" ? "PayPal review" : late ? "Over 8 hours" : "Waiting"}</span>
        </div>
        <dl class="ad-kv">
          <div><dt>Send to</dt><dd><b class="ad-dest">${esc(w.method)} ${esc(w.destination)}</b><button type="button" class="ad-copy" data-copy="${esc(w.destination)}">Copy</button></dd></div>
          <div><dt>Account</dt><dd>${esc(w.user.name || "—")}${w.user.verified ? ` <span class="tag ok">ID verified</span>` : ` <span class="tag bad">Not verified</span>`}</dd></div>
          <div><dt>Email</dt><dd>${esc(w.user.email)}</dd></div>
          <div><dt>Requested</dt><dd>${when(w.created_at)} · ${ago(w.created_at)}</dd></div>
          <div><dt>Withdrawal</dt><dd><code>${esc(w.id)}</code></dd></div>
        </dl>
        <form class="ad-approve">
          <label class="field"><span>${mpesa ? "M-Pesa code from the SMS" : "PayPal transaction ID"}</span>
            <input class="input" name="receipt" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${mpesa ? "SJK3H2ABCD" : "5TY05013RG002845M"}"></label>
          <button class="btn primary" type="submit">Mark as sent</button>
        </form>
        <details class="ad-return">
          <summary>Can’t send it? Return it to their wallet</summary>
          <form class="ad-return-form">
            <label class="field"><span>Reason the user will see</span>
              <input class="input" name="reason" maxlength="200" placeholder="That number isn’t registered for M-Pesa."></label>
            <button class="btn ad-danger" type="submit">Return ${nsh(w.amount)} NSH to wallet</button>
          </form>
        </details>
        <p class="msg" role="alert"></p>
      </article>`;
  }

  function recentRow(w) {
    const [label, tone] = STATUS[w.status] || [w.status, "warn"];
    const at = w.paid_at || w.refunded_at || w.created_at;
    return `<li>
      <div><b>${w.method === "M-Pesa" ? `KES ${nsh(w.kes)}` : usd(w.amount)} · ${esc(w.method)} ${esc(w.destination)}</b>
        <span>${esc(w.user.name || w.user.email)} · ${when(at)}${w.receipt ? ` · ${esc(w.receipt)}` : ""}${w.failure ? ` · ${esc(w.failure)}` : ""}</span></div>
      <span class="tag ${tone}">${label}</span>
    </li>`;
  }

  async function load() {
    try {
      const d = await Nsh.api("admin/withdrawals");
      $("#ad-open").innerHTML = d.open.length
        ? d.open.map(card).join("")
        : `<div class="ad-empty"><b>Nothing waiting</b><span>New M-Pesa withdrawals show up here, and you get an email for each one.</span></div>`;
      $("#ad-recent").innerHTML = d.recent.length ? d.recent.map(recentRow).join("") : `<li class="ad-none">Nothing yet.</li>`;
      document.title = `${d.open.length ? `(${d.open.length}) ` : ""}Withdrawal approvals · Nora Shillings`;
    } catch (err) {
      $("#ad-open").innerHTML = `<div class="ad-empty"><b>Can’t open approvals</b><span>${esc(err.message)}</span></div>`;
    }
  }

  async function act(article, form, route, payload, busy) {
    const msg = article.querySelector(".msg");
    const btn = form.querySelector("button[type=submit]");
    const label = btn.textContent;
    msg.className = "msg";
    msg.textContent = "";
    article.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
    btn.textContent = busy;
    try {
      await Nsh.api(route, { body: { id: article.dataset.id, ...payload } });
      article.classList.add("done");
      await load();
    } catch (err) {
      article.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
      btn.textContent = label;
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  }

  document.addEventListener("submit", (e) => {
    const article = e.target.closest(".ad-card");
    if (!article) return;
    e.preventDefault();
    if (e.target.matches(".ad-approve")) {
      act(article, e.target, "admin/withdrawals/approve", { receipt: e.target.receipt.value }, "Saving…");
    } else if (e.target.matches(".ad-return-form")) {
      act(article, e.target, "admin/withdrawals/return", { reason: e.target.reason.value }, "Returning…");
    }
  });

  document.addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      await navigator.clipboard.writeText(copy.dataset.copy).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    }
    if (e.target.closest("#ad-refresh")) load();
  });

  addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  load();
})();
