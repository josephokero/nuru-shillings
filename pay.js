(async () => {
  const card = document.querySelector("#card");
  const id = new URLSearchParams(location.search).get("id") || "";
  const view = (html) => { card.innerHTML = html; };
  let p;
  try {
    p = await Nsh.api(`checkout?id=${encodeURIComponent(id)}`, { redirect: false });
    if (!p.found) throw new Error(p.error);
  } catch (err) {
    return view(`<h1>Payment not found</h1><p>${Nsh.esc(err.message)}</p>`);
  }
  const head = `<p>Pay</p><h1 style="margin:6px 0 4px">${Nsh.esc(p.company)}</h1>
    <p style="font-size:32px;font-weight:600;color:#fff;letter-spacing:-.04em;margin:18px 0 2px">${Nsh.nsh(p.amount)} NSH</p>
    <p>${Nsh.usd(p.amount)} · no fee for you</p>`;
  if (p.mode !== "live" || p.status !== "pending") {
    return view(`${head}<div class="actions"><span class="tag ${p.status === "paid" ? "ok" : ""}" style="justify-self:center">${Nsh.esc(p.status)}</span></div>`);
  }
  const signed = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).then((s) => s.signed_in).catch(() => false);
  const me = signed ? await Nsh.api("me?mode=live", { redirect: false }).catch(() => null) : null;
  if (!me) {
    const next = encodeURIComponent(`/pay?id=${id}`);
    return view(`${head}<div class="actions"><a class="btn primary block" href="/signin?next=${next}">Log in to pay</a><a class="btn block" href="/signup?next=${next}">Create a free wallet</a></div>
      <p class="auth-foot">Only ${Nsh.esc(p.company)} is shown on this payment.</p>`);
  }
  const bal = me.balances.live;
  view(`${head}
    <div class="actions">
      <button class="btn primary block" id="pay" ${bal < Number(p.amount) ? "disabled" : ""}>Pay ${Nsh.nsh(p.amount)} NSH</button>
      ${bal < Number(p.amount) ? `<a class="btn block" href="/dashboard#add">Add money to your wallet</a>` : ""}
    </div>
    <p class="msg" id="msg">${bal < Number(p.amount) ? `Your balance is ${Nsh.nsh(bal)} NSH. Add money, then come back to this page.` : `Paying from ${Nsh.esc(me.email)} · balance ${Nsh.nsh(bal)} NSH`}</p>
    <p class="auth-foot">Only ${Nsh.esc(p.company)} is shown on this payment.</p>`);
  const btn = document.querySelector("#pay");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    const msg = document.querySelector("#msg");
    try {
      await Nsh.api("checkout/pay", { body: { id } });
      view(`<div class="mark">✓</div><h1>Paid</h1><p>${Nsh.nsh(p.amount)} NSH to ${Nsh.esc(p.company)}.</p><div class="actions"><a class="btn block" href="/dashboard">Open wallet</a></div>`);
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
})();
