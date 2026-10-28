(async () => {
  const token = location.hash.slice(1);
  history.replaceState(null, "", "/auth");
  const show = (text) => {
    document.querySelector("#wait").hidden = true;
    document.querySelector("#bad").hidden = false;
    if (text) document.querySelector("#why").textContent = text;
  };
  const done = (created) => {
    if (created) localStorage.setItem("nsh-tour", "1");
    const next = localStorage.getItem("nsh-next");
    localStorage.removeItem("nsh-next");
    location.replace(next || "/dashboard");
  };
  if (!token) return show("The link is missing its code. Open it again from your email.");
  try {
    const r = await Nsh.api("auth/verify", { body: { token }, redirect: false });
    if (!r.mfa) return done(r.created);
    document.querySelector("#wait h1").textContent = "One more step";
    document.querySelector("#wait p").textContent = "Your account has two-step sign-in.";
    await Nsh.secondStep({
      methods: r.methods,
      title: "Two-step sign-in",
      lead: "Your email link worked. Now confirm with your passkey or authenticator app.",
      cancelLabel: "Cancel and go back",
      submit: (p) => Nsh.api("auth/mfa", { body: { ...p, ticket: r.ticket }, redirect: false }),
      passkeyOptions: () => Nsh.api("auth/mfa/passkey", { body: { ticket: r.ticket }, redirect: false }),
    });
    done(r.created);
  } catch (err) {
    if (err.message === "Cancelled.") return location.replace("/signin");
    show(err.message);
  }
})();
