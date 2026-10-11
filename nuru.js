/*! Nora Shillings checkout · https://norashillings.benuru.com/docs#apps
 *
 *   <script src="https://norashillings.benuru.com/nuru.js"></script>
 *   const result = await Nuru.deposit(deposit.url);   // { status: "succeeded" | "declined" | "cancelled" | "expired" | "closed", id }
 */
(() => {
  if (window.Nuru) return;
  const ORIGIN = new URL(document.currentScript?.src || "https://norashillings.benuru.com/nuru.js").origin;
  const W = 440;
  const H = 720;

  const CSS = `
    .nuru-veil{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font:14px/1.5 Inter,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#ededed;animation:nuru-in .25s ease both}
    .nuru-veil div{max-width:340px;text-align:center}
    .nuru-veil i{display:block;width:44px;height:44px;margin:0 auto 18px;border-radius:50%;background:#fff;box-shadow:0 0 40px rgba(255,255,255,.35);animation:nuru-glow 2s ease-in-out infinite}
    .nuru-veil b{display:block;font-size:17px;font-weight:600;letter-spacing:-.01em}
    .nuru-veil p{margin:6px 0 18px;color:#a1a1a1}
    .nuru-veil button{margin:0 4px;height:36px;padding:0 14px;border:1px solid #333;border-radius:9px;background:#111;color:#ededed;font:inherit;font-weight:500;cursor:pointer}
    .nuru-veil button:first-of-type{border-color:#fff;background:#fff;color:#000}
    @keyframes nuru-in{from{opacity:0}}
    @keyframes nuru-glow{50%{transform:scale(.88);box-shadow:0 0 20px rgba(255,255,255,.2)}}`;

  function veil(onFocus, onCancel) {
    if (!document.getElementById("nuru-css")) {
      const style = document.createElement("style");
      style.id = "nuru-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const el = document.createElement("div");
    el.className = "nuru-veil";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `<div><i></i><b>Finish in the Nora Shillings window</b><p>Don’t see it? Bring it back to confirm securely.</p><button type="button">Show window</button><button type="button">Cancel</button></div>`;
    const [show, cancel] = el.querySelectorAll("button");
    show.addEventListener("click", onFocus);
    cancel.addEventListener("click", onCancel);
    document.body.appendChild(el);
    return el;
  }

  function urlOf(target) {
    const raw = typeof target === "object" && target ? target.url || target.id : target;
    const url = new URL(/^dep_/.test(String(raw)) ? `${ORIGIN}/deposit?id=${raw}` : String(raw), ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== "/deposit") throw new Error("Nuru.deposit needs the url (or id) returned by POST /v1/deposits.");
    return url;
  }

  function deposit(target, options = {}) {
    const url = urlOf(target);
    const id = url.searchParams.get("id");
    const left = Math.round((window.screenX || 0) + Math.max(0, ((window.outerWidth || W) - W) / 2));
    const top = Math.round((window.screenY || 0) + Math.max(0, ((window.outerHeight || H) - H) / 3));
    const win = window.open(url.toString(), `nuru-${id}`, `popup=yes,width=${W},height=${H},left=${left},top=${top}`);
    if (!win) {
      if (options.redirect !== false) window.location.assign(url.toString());
      return Promise.resolve({ status: "blocked", id });
    }
    win.focus();

    return new Promise((resolve) => {
      let done = false;
      let shade = null;
      const finish = (status) => {
        if (done) return;
        done = true;
        removeEventListener("message", onMessage);
        clearInterval(timer);
        shade?.remove();
        const result = { status, id };
        const hook = { succeeded: options.onSuccess, declined: options.onDecline, cancelled: options.onCancel }[status] || options.onClose;
        try { hook?.(result); } catch (err) { setTimeout(() => { throw err; }); }
        resolve(result);
      };
      const onMessage = (e) => {
        if (e.origin !== ORIGIN || e.source !== win || e.data?.type !== "nuru:deposit" || e.data.id !== id) return;
        finish(e.data.status);
      };
      addEventListener("message", onMessage);
      const timer = setInterval(() => { if (win.closed) finish("closed"); }, 400);
      if (options.overlay !== false) shade = veil(() => win.focus(), () => { win.close(); finish("closed"); });
    });
  }

  window.Nuru = Object.freeze({ deposit, version: "1" });
})();
