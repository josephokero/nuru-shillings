(() => {
  if (document.querySelector(".nx-assist")) return;

  const SUPPORT = "supportnorashillings@benuru.com";
  const SUGGESTIONS = [
    "How do I add money?",
    "What does a payment cost?",
    "Do I need a registered company?",
    "Is my name shown to buyers?",
  ];
  const LOCAL = [
    [/rate|worth|dollar|usd|convert/i, "100 Nuru Shillings equal 1 US dollar. The same rate is used to buy, pay, refund, and sell back. 10 USD is 1,000 NSH."],
    [/add|deposit|top ?up|buy|fund/i, "Open your wallet and choose Add money. You can use PayPal, a supported card, or M-Pesa. The money is in your wallet immediately at 100 NSH to 1 USD. You verify your name and country once before live money moves."],
    [/withdraw|cash ?out|sell/i, "Sell your balance back at 100 NSH to 1 USD and withdraw to PayPal, a supported card, or M-Pesa in your verified name. Withdrawing is free. If the method rejects it, the amount returns to your wallet."],
    [/fee|cost|price|charge|1%/i, "Opening an account, adding money, and withdrawing are free. A company pays 1% of each payment that is paid. The buyer pays no Nuru fee. A refund returns the payment and the fee."],
    [/regist|company name|business name|incorporat/i, "Your business does not have to be a registered company. You give it a name, Nuru records that name on its own servers, and that is the only name a checkout shows."],
    [/private|privacy|anonym|name shown|identity|trace|public/i, "Checkout shows the company name only. Your name is not shown to other buyers, and payments are not written to a public ledger. They stay on Nuru's private chain."],
    [/adult|categor|blocked|refus|allowed/i, "Shops, services, subscriptions, marketplaces, apps, and adult sites can take payment on their own page. Nuru does not refuse a site because card networks refuse its category. Anything illegal, fraud, weapons, drugs, stolen data, or material that exploits children is not allowed."],
    [/refund/i, "A company refunds with the original payment id. The full amount returns to the buyer's wallet and the 1% fee returns to the company. Each payment can be refunded once."],
    [/api|webhook|developer|key|integrat|sandbox/i, "Create a payment with one request: amount, unit NSH, reference, and company. Keep the secret key on your server. Webhooks send payment.paid and payment.refunded. Switch to Sandbox to test for free, and open Business tools from your wallet for keys and webhooks. See the Docs page."],
    [/verify|verification|kyc/i, "Verification is free and done once: confirm the name on the account and your country. Until then a wallet cannot add money, pay, or withdraw."],
    [/password|sign ?in|sign ?up|log ?in|login|link/i, "There is no password. Enter your email on the sign-in page and open the link we send; it works once and expires after 20 minutes. If it does not arrive, check spam and choose Resend. Nuru never asks you to forward a sign-in link."],
    [/support|contact|email|help|human|agent/i, "Write to " + SUPPORT + " with your payment id if it is about a payment. You can also use the Help centre or Community pages."],
  ];

  const root = document.createElement("div");
  root.className = "nx-assist";
  root.innerHTML = `
    <button class="nx-launch" type="button" aria-expanded="false" aria-controls="nx-panel">
      <span class="nx-dot" aria-hidden="true"></span><span>Ask Nuru</span>
    </button>
    <section class="nx-panel" id="nx-panel" role="dialog" aria-label="Nuru assistant" hidden>
      <header class="nx-head">
        <div><strong>Nuru assistant</strong><small>Answers about the wallet, payments, and the API</small></div>
        <button class="nx-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="nx-log" aria-live="polite"></div>
      <div class="nx-suggest"></div>
      <form class="nx-form">
        <textarea rows="1" maxlength="2000" placeholder="Ask a question" aria-label="Your question"></textarea>
        <button type="submit" aria-label="Send">↑</button>
      </form>
      <p class="nx-note">Never share a sign-in link, secret key, PIN, or card code.</p>
    </section>`;
  document.body.appendChild(root);

  const launch = root.querySelector(".nx-launch");
  const panel = root.querySelector(".nx-panel");
  const log = root.querySelector(".nx-log");
  const suggest = root.querySelector(".nx-suggest");
  const form = root.querySelector(".nx-form");
  const input = form.querySelector("textarea");
  const history = [];
  let busy = false;

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(text) {
    const lines = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").split(/\n/);
    let html = "";
    let list = null;
    for (const line of lines) {
      const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        if (!list) { html += "<ul>"; list = true; }
        html += `<li>${item[1]}</li>`;
        continue;
      }
      if (list) { html += "</ul>"; list = null; }
      if (line.trim()) html += `<p>${line}</p>`;
    }
    if (list) html += "</ul>";
    return html.replace(new RegExp(SUPPORT.replace(/\./g, "\\."), "g"), `<a href="mailto:${SUPPORT}">${SUPPORT}</a>`);
  }

  function add(role, text) {
    const el = document.createElement("div");
    el.className = `nx-msg nx-${role}`;
    el.innerHTML = role === "user" ? `<p>${esc(text)}</p>` : render(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function localAnswer(q) {
    const hit = LOCAL.find(([re]) => re.test(q));
    return hit ? hit[1] : `I can help with the wallet, the rate, fees, privacy, refunds, and the API. For anything else, write to ${SUPPORT}.`;
  }

  async function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    suggest.hidden = true;
    add("user", q);
    history.push({ role: "user", content: q });
    const wait = add("bot", "…");
    wait.classList.add("nx-wait");
    let reply;
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await r.json().catch(() => ({}));
      reply = r.ok && data.reply ? data.reply : localAnswer(q);
    } catch {
      reply = localAnswer(q);
    }
    wait.remove();
    add("bot", reply);
    history.push({ role: "assistant", content: reply });
    busy = false;
  }

  function open(state) {
    panel.hidden = !state;
    launch.setAttribute("aria-expanded", String(state));
    root.classList.toggle("is-open", state);
    if (state) {
      if (!log.children.length) add("bot", "Hi. Ask me about adding money, paying, withdrawing, fees, privacy, or the API.");
      input.focus();
    }
  }

  SUGGESTIONS.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.addEventListener("click", () => ask(s));
    suggest.appendChild(b);
  });

  launch.addEventListener("click", () => open(panel.hidden));
  root.querySelector(".nx-close").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) open(false); });
  document.querySelectorAll("[data-open-assistant]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); open(true); }));

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = "";
    input.style.height = "auto";
    ask(q);
  });
})();
