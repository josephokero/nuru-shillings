(() => {
  const form = document.querySelector("#form");
  const msg = document.querySelector("#msg");
  const msg2 = document.querySelector("#msg2");
  const ask = document.querySelector("#ask");
  const sent = document.querySelector("#sent");
  const next = new URLSearchParams(location.search).get("next");
  const nextPath = next && /^\/?[\w-]+(\.html)?(\?[\w=&.%+-]*)?$/.test(next) ? "/" + next.replace(/^\//, "") : null;
  if (nextPath) localStorage.setItem("nsh-next", nextPath);
  else localStorage.removeItem("nsh-next");

  const signedIn = () => fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).then((s) => s.signed_in).catch(() => false);
  signedIn().then((yes) => {
    if (yes) location.replace(localStorage.getItem("nsh-next") || "/dashboard");
  });

  // The email link usually opens in another tab; once it signs in, carry on here too.
  let watching = 0;
  const watch = () => {
    clearInterval(watching);
    watching = setInterval(async () => {
      if (sent.hidden) return clearInterval(watching);
      if (await signedIn()) {
        clearInterval(watching);
        location.replace(nextPath || "/dashboard");
      }
    }, 3000);
  };

  let email = "";
  const start = () => Nsh.api("auth/start", { body: { email, website: form.website.value }, redirect: false });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    email = form.email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      msg.className = "msg err";
      msg.textContent = "Enter a valid email address.";
      return;
    }
    Nsh.submit(form, msg, async () => {
      await start();
      document.querySelector("#sent-to").textContent = email;
      ask.hidden = true;
      sent.hidden = false;
      watch();
    });
  });

  document.querySelector("#resend").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Sending…";
    msg2.className = "msg";
    msg2.textContent = "";
    try {
      await start();
      msg2.className = "msg ok";
      msg2.textContent = "A new link is on its way.";
    } catch (err) {
      msg2.className = "msg err";
      msg2.textContent = err.message;
    }
    btn.classList.remove("busy");
    btn.textContent = "Resend link";
    setTimeout(() => { btn.disabled = false; }, 30000);
  });

  const pkBox = document.querySelector("#pk-box");
  if (pkBox && Nsh.passkey.supported()) {
    pkBox.hidden = false;
    const pkBtn = document.querySelector("#pk-login");
    const pkMsg = document.querySelector("#msg-pk");
    pkBtn.addEventListener("click", async () => {
      pkBtn.disabled = true;
      pkBtn.classList.add("busy");
      pkMsg.className = "msg";
      pkMsg.textContent = "";
      try {
        const { ticket, options } = await Nsh.api("auth/passkey/options", { body: {}, redirect: false });
        const response = await Nsh.passkey.get(options);
        await Nsh.api("auth/passkey/verify", { body: { ticket, response }, redirect: false });
        location.replace(nextPath || "/dashboard");
      } catch (err) {
        pkMsg.className = "msg err";
        pkMsg.textContent = err.message;
      }
      pkBtn.disabled = false;
      pkBtn.classList.remove("busy");
    });
  }

  document.querySelector("#back").addEventListener("click", () => {
    sent.hidden = true;
    ask.hidden = false;
    msg2.textContent = "";
    form.email.focus();
  });
})();
