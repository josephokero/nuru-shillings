(() => {
  const root = document.querySelector("#security-root");
  if (!root) return;
  const esc = Nsh.esc;
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    key: ico("M9 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8zM2 21a7 7 0 0 1 11.5-5.4M17 14a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM19.5 16.5H22"),
    phone: ico("M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2"),
    life: ico("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"),
    devices: ico("M3 5h14v10H3zM1 19h18M20 9h3v10h-3z"),
  };
  const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const device = (ua = "") => {
    const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return [br, os].filter(Boolean).join(" on ") || "Unknown device";
  };

  let s = null;
  let setup = null;
  let codes = null;
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    try {
      s = await Nsh.api("security");
      render();
    } catch (err) {
      root.innerHTML = `<h2>Security</h2><p class="msg err">${esc(err.message)}</p>`;
    }
    loading = false;
  }

  function signinLabel() {
    const el = document.querySelector("#acc-signin");
    if (!el || !s) return;
    const extra = [s.passkeys.length && "passkey", s.totp && "authenticator app"].filter(Boolean);
    el.textContent = extra.length ? `Email link + ${extra.join(" or ")}` : "Email link";
  }

  function render() {
    const pk = Nsh.passkey.supported();
    root.innerHTML = `
      <h2>Security</h2>
      <p class="note">Add a second step so a stolen email alone can never open your wallet. It’s asked when you sign in with an email link, and before live money leaves your wallet.</p>
      ${s.frozen ? `<p class="sec-warn">This account is on hold while we review a reversed payment. Contact supportnorashillings@benuru.com.</p>` : ""}
      ${!s.mfa ? `<p class="sec-warn">Two-step sign-in is off. Turn it on to protect your money. It’s required before your first withdrawal.</p>` : ""}

      <div class="sec-row">
        <span class="sec-ico">${ICONS.key}</span>
        <div><b>Passkeys <span class="sec-pill ${s.passkeys.length ? "on" : ""}">${s.passkeys.length ? `${s.passkeys.length} on` : "Off"}</span></b>
          <small>${pk ? "Sign in with Face ID, fingerprint, or your device PIN. Passkeys can’t be phished or guessed." : "This browser doesn’t support passkeys. Try a recent Chrome, Safari, Edge, or Firefox."}</small></div>
        ${pk ? `<button class="btn sm ${s.passkeys.length ? "" : "primary"}" type="button" data-act="pk-add">Add a passkey</button>` : "<span></span>"}
      </div>
      ${s.passkeys.length ? `<div class="sec-keys">${s.passkeys.map((k) => `
        <div class="sec-key"><div><b>${esc(k.name)}</b> <span>· added ${day(k.created)}${k.last_used ? ` · last used ${day(k.last_used)}` : ""}${k.synced ? " · synced" : ""}</span></div>
          <button class="btn sm" type="button" data-act="pk-remove" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Remove</button></div>`).join("")}</div>` : ""}

      <div class="sec-row">
        <span class="sec-ico">${ICONS.phone}</span>
        <div><b>Authenticator app <span class="sec-pill ${s.totp ? "on" : ""}">${s.totp ? "On" : "Off"}</span></b>
          <small>${s.totp ? `On since ${day(s.totp_since)}. Codes come from your authenticator app.` : "6-digit codes from Google Authenticator, Microsoft Authenticator, 1Password, or Authy."}</small></div>
        <button class="btn sm ${!s.totp && !s.passkeys.length ? "primary" : ""}" type="button" data-act="${s.totp ? "totp-off" : "totp-setup"}">${s.totp ? "Turn off" : "Set up"}</button>
      </div>
      ${setup ? `
      <form class="sec-setup" data-form="totp" novalidate>
        <div class="sec-qr">
          <img src="${esc(setup.qr)}" alt="QR code for your authenticator app" width="148" height="148">
          <div>
            <p class="v-muted">1. Scan this with your authenticator app.<br>Can’t scan? Enter this key:</p>
            <p class="sec-secret">${esc(setup.secret)}</p>
          </div>
        </div>
        <label class="field"><span>2. Enter the 6-digit code it shows</span>
          <input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" required></label>
        <div class="sec-actions">
          <button class="btn primary sm" type="submit" data-busy="Checking…">Turn on</button>
          <button class="btn sm" type="button" data-act="totp-cancel">Cancel</button>
        </div>
        <p class="msg" data-msg="totp"></p>
      </form>` : ""}

      ${s.mfa ? `
      <div class="sec-row">
        <span class="sec-ico">${ICONS.life}</span>
        <div><b>Recovery codes</b>
          <small>${s.recovery_left} of 10 left. Each code works once if you lose your phone or passkey.</small></div>
        <button class="btn sm" type="button" data-act="codes-new">New codes</button>
      </div>` : ""}
      ${codes ? `
      <div class="sec-setup">
        <p class="sec-warn">Save these recovery codes somewhere safe, like a password manager. They are shown only once.</p>
        <div class="sec-codes">${codes.map((c) => `<span>${esc(c)}</span>`).join("")}</div>
        <div class="sec-actions">
          <button class="btn sm" type="button" data-act="codes-copy">Copy</button>
          <button class="btn sm" type="button" data-act="codes-download">Download</button>
          <button class="btn sm primary" type="button" data-act="codes-done">I’ve saved them</button>
        </div>
      </div>` : ""}

      <div class="sec-row">
        <span class="sec-ico">${ICONS.devices}</span>
        <div><b>Devices</b><small>Signed in on ${s.sessions} ${s.sessions === 1 ? "device" : "devices"}.</small></div>
        <button class="btn sm" type="button" data-act="revoke" ${s.sessions > 1 ? "" : "disabled"}>Log out other devices</button>
      </div>

      ${s.events.length ? `
      <h3 class="v-muted" style="margin:18px 0 6px;font-size:13px;font-weight:600">Recent security activity</h3>
      <ul class="sec-log">${s.events.map((e) => `
        <li><b>${esc(e.label)}${e.method ? ` <span class="sec-pill">${esc(e.method.replace("+", " + "))}</span>` : ""}</b>
          <span>${esc(device(e.device))} · ${esc(Nsh.when(e.at))}</span></li>`).join("")}</ul>` : ""}
      <p class="msg" data-msg="main"></p>`;
    signinLabel();
  }

  const say = (text, ok) => {
    const m = root.querySelector('[data-msg="main"]');
    if (!m) return;
    m.className = `msg ${ok ? "ok" : "err"}`;
    m.textContent = text;
  };

  async function act(btn, work) {
    btn.disabled = true;
    btn.classList.add("busy");
    try {
      const text = await work();
      if (text) { render(); say(text, true); }
    } catch (err) {
      if (err.message !== "Cancelled.") say(err.message);
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  }

  const refresh = async (text) => {
    s = await Nsh.api("security");
    return text;
  };

  function showCodes(list) {
    if (list?.length) codes = list;
  }

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === "pk-add") {
      return act(btn, async () => {
        const { ticket, options } = await Nsh.api("security/passkeys/options", { body: {} });
        const response = await Nsh.passkey.create(options);
        const name = device(navigator.userAgent);
        const r = await Nsh.api("security/passkeys/add", { body: { ticket, response, name } });
        showCodes(r.recovery_codes);
        return refresh("Passkey added. You can now log in with it.");
      });
    }
    if (a === "pk-remove") {
      if (!confirm(`Remove the passkey “${btn.dataset.name}”? It will no longer sign you in.`)) return;
      return act(btn, async () => {
        await Nsh.api("security/passkeys/remove", { body: { id: btn.dataset.id } });
        return refresh("Passkey removed.");
      });
    }
    if (a === "totp-setup") {
      return act(btn, async () => {
        setup = await Nsh.api("security/totp/setup", { body: {} });
        render();
        root.querySelector('[data-form="totp"] input')?.focus();
      });
    }
    if (a === "totp-cancel") { setup = null; return render(); }
    if (a === "totp-off") {
      if (!confirm("Turn off the authenticator app? You can set it up again any time.")) return;
      return act(btn, async () => {
        await Nsh.api("security/totp/disable", { body: {} });
        return refresh("Authenticator app turned off.");
      });
    }
    if (a === "codes-new") {
      if (!confirm("Make new recovery codes? Your old codes will stop working.")) return;
      return act(btn, async () => {
        showCodes((await Nsh.api("security/recovery", { body: {} })).recovery_codes);
        return refresh("New recovery codes made. Save them now.");
      });
    }
    if (a === "codes-copy") {
      navigator.clipboard?.writeText(codes.join("\n")).then(() => { btn.textContent = "Copied"; }).catch(() => {});
      return;
    }
    if (a === "codes-download") {
      const blob = new Blob([`Nora Shillings recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "nora-shillings-recovery-codes.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      return;
    }
    if (a === "codes-done") { codes = null; return render(); }
    if (a === "revoke") {
      return act(btn, async () => {
        const r = await Nsh.api("security/sessions/revoke", { body: {} });
        return refresh(`Logged out ${r.revoked} other ${r.revoked === 1 ? "device" : "devices"}.`);
      });
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.name !== "code") return;
    const d = e.target.value.replace(/\D/g, "").slice(0, 6);
    e.target.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
  });

  root.addEventListener("submit", (e) => {
    const form = e.target.closest('[data-form="totp"]');
    if (!form) return;
    e.preventDefault();
    Nsh.submit(form, form.querySelector('[data-msg="totp"]'), async () => {
      const code = form.code.value.replace(/\D/g, "");
      if (code.length !== 6) throw new Error("Enter the 6-digit code from your app.");
      const r = await Nsh.api("security/totp/enable", { body: { setup: setup.setup, code } });
      setup = null;
      showCodes(r.recovery_codes);
      await refresh();
      render();
      say("Authenticator app is on. You’ll be asked for a code when you sign in with an email link.", true);
    });
  });

  const visible = () => (location.hash.replace(/^#\/?/, "") || "home") === "account";
  addEventListener("hashchange", () => { if (visible()) load(); });
  if (visible()) load();
  else setTimeout(() => { if (!s) load(); }, 1500);
})();
