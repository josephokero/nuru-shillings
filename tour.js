(() => {
  const KEY = "nsh-tour";
  const GAP = 14;
  const PAD = 8;
  const small = () => matchMedia("(max-width: 640px)").matches;

  const STEPS = [
    {
      title: "Welcome to Nuru Shillings",
      text: "I’m Nuru, your guide. Let me show you where everything lives. It takes less than a minute.",
      next: "Show me around",
      back: "Skip",
    },
    {
      target: [".w-balance", ".w-hero", ".balance"],
      title: "This is your balance",
      text: "Everything you hold, in Nuru Shillings. The dollar value sits right under it. 100 NSH is always $1.",
    },
    {
      target: [".w-actions", ".app-actions", ".balance .actions"],
      title: "Add, send and withdraw",
      text: "Add money with PayPal, card or M-Pesa. Send to anyone with a Nuru account in seconds. Withdraw whenever you like. All free.",
    },
    {
      target: [".w-account-mini", ".w-account", "#verify-note", '.side-nav a[href="#account"]'],
      title: "Verify once to withdraw",
      text: "Adding, sending and paying work right away. Before your first withdrawal, a quick ID photo and selfie. It’s free and done once.",
    },
    {
      target: [".w-activity", "#activity-card", '.side-nav a[href="#activity"]'],
      title: "Your activity",
      text: "Every payment in and out shows up here, newest first. Open View all to filter, search and export.",
    },
    {
      target: ['.side-nav a[href="/developer"]', ".tabs .biz", ".w-promo", "#menu-btn"],
      title: "Business tools",
      text: "Selling online? Create checkout links and API keys here. Your customers see your business name, never yours.",
      menuText: "Selling online? Open the menu and choose Business tools for checkout links and API keys. Your customers see your business name, never yours.",
    },
    {
      title: "You’re all set",
      text: "You can take this tour again from the menu any time. Questions? The Help centre is always open.",
      next: "Start using my wallet",
      back: "Back",
    },
  ];

  let uid = 0;
  function globe() {
    const id = `nsh-orb-${++uid}`;
    return `<span class="tour-orb" aria-hidden="true"><svg viewBox="0 0 64 64">
      <defs>
        <radialGradient id="${id}-g" cx="36%" cy="30%" r="78%">
          <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#ececec"/><stop offset="1" stop-color="#a9a9a9"/>
        </radialGradient>
        <clipPath id="${id}-c"><circle cx="32" cy="32" r="28"/></clipPath>
      </defs>
      <circle cx="32" cy="32" r="28" fill="url(#${id}-g)"/>
      <g clip-path="url(#${id}-c)" fill="none" stroke="#000" stroke-opacity=".1" stroke-width="1.1">
        <ellipse cx="32" cy="32" rx="11" ry="28"/>
        <ellipse cx="32" cy="32" rx="21" ry="28"/>
        <path d="M32 4v56M4 32h56M7 19h50M7 45h50"/>
      </g>
      <g class="tour-look">
        <g class="tour-eyes">
          <ellipse cx="24.5" cy="30.5" rx="3.3" ry="4.4" fill="#0a0a0a"/>
          <ellipse cx="39.5" cy="30.5" rx="3.3" ry="4.4" fill="#0a0a0a"/>
          <circle cx="25.7" cy="28.9" r="1.15" fill="#fff"/>
          <circle cx="40.7" cy="28.9" r="1.15" fill="#fff"/>
        </g>
        <path d="M28.3 39.6q3.7 2.8 7.4 0" fill="none" stroke="#0a0a0a" stroke-width="1.8" stroke-linecap="round"/>
      </g>
    </svg></span>`;
  }

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && r.right > 0 && r.left < innerWidth;
  };
  const find = (step) => {
    for (const sel of step.target || []) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    return null;
  };

  function run(startAt = 0) {
    if (document.querySelector(".tour")) return;
    const steps = STEPS.filter((s) => !s.target || find(s));
    const total = steps.length;
    let i = Math.min(startAt, total - 1);
    let target = null;
    let raf = 0;

    const root = document.createElement("div");
    root.className = "tour center";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "tour-title");
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-spot"></div>
      <div class="tour-card">
        <div class="tour-head">
          ${globe()}
          <div class="tour-who"><b>Nuru</b><span id="tour-count"></span></div>
          <button class="tour-skip" type="button" data-skip>Skip tour</button>
        </div>
        <h2 id="tour-title"></h2>
        <p id="tour-text" aria-live="polite"></p>
        <div class="tour-foot">
          <div class="tour-dots">${steps.map(() => "<i></i>").join("")}</div>
          <div class="tour-btns">
            <button class="btn sm" type="button" data-back></button>
            <button class="btn sm primary" type="button" data-next></button>
          </div>
        </div>
      </div>`;
    document.body.append(root);
    document.body.classList.add("tour-on");

    const $ = (s) => root.querySelector(s);
    const spot = $(".tour-spot");
    const card = $(".tour-card");
    const look = $(".tour-look");
    const backBtn = $("[data-back]");
    const nextBtn = $("[data-next]");

    const close = () => {
      localStorage.removeItem(KEY);
      removeEventListener("keydown", onKey, true);
      removeEventListener("resize", follow);
      removeEventListener("scroll", follow, true);
      document.body.classList.remove("tour-on");
      root.remove();
    };

    function place(animate) {
      root.classList.toggle("snap", !animate);
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      if (!target) {
        Object.assign(spot.style, { top: `${innerHeight / 2}px`, left: `${innerWidth / 2}px`, width: "0px", height: "0px" });
        Object.assign(card.style, { top: `${Math.max(12, (innerHeight - ch) / 2)}px`, left: `${(innerWidth - cw) / 2}px` });
        look.style.transform = "";
        return;
      }
      const r = target.getBoundingClientRect();
      const box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
      const radius = Math.min(16, box.height / 2);
      Object.assign(spot.style, {
        top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: `${radius}px`,
      });

      let top;
      let left;
      if (small()) {
        top = innerHeight - ch;
        left = 10;
      } else {
        const below = box.top + box.height + GAP;
        const above = box.top - GAP - ch;
        const clampX = (x) => Math.min(Math.max(12, x), innerWidth - cw - 12);
        const clampY = (y) => Math.min(Math.max(12, y), innerHeight - ch - 12);
        if (below + ch <= innerHeight - 12) [top, left] = [below, clampX(box.left)];
        else if (above >= 12) [top, left] = [above, clampX(box.left)];
        else if (box.left + box.width + GAP + cw <= innerWidth - 12) [top, left] = [clampY(box.top), box.left + box.width + GAP];
        else if (box.left - GAP - cw >= 12) [top, left] = [clampY(box.top), box.left - GAP - cw];
        else [top, left] = [innerHeight - ch - 12, clampX(box.left)];
        Object.assign(card.style, { top: `${top}px`, left: `${left}px` });
      }

      const dx = r.left + r.width / 2 - (left + 32);
      const dy = r.top + r.height / 2 - (top + 36);
      const len = Math.hypot(dx, dy) || 1;
      look.style.transform = `translate(${((dx / len) * 2.2).toFixed(2)}px, ${((dy / len) * 2.2).toFixed(2)}px)`;
    }

    function follow() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => place(false));
    }

    function show(n) {
      i = n;
      const step = steps[i];
      target = step.target ? find(step) : null;
      const isMenu = target?.id === "menu-btn";

      root.classList.toggle("center", !target);
      $("#tour-title").textContent = step.title;
      $("#tour-text").textContent = isMenu && step.menuText ? step.menuText : step.text;
      $("#tour-count").textContent = `Step ${i} of ${total - 2}`;
      $("#tour-count").hidden = !target;
      root.querySelectorAll(".tour-dots i").forEach((d, k) => {
        d.className = k === i ? "on" : k < i ? "done" : "";
      });
      backBtn.textContent = step.back || "Back";
      nextBtn.textContent = step.next || (i === total - 2 ? "Finish" : "Next");

      card.classList.remove("in");
      void card.offsetWidth;
      card.classList.add("in");

      if (target) {
        const r = target.getBoundingClientRect();
        const room = small() ? innerHeight - card.offsetHeight - 24 : innerHeight - 24;
        if (r.top < 72 || r.bottom > room) {
          const y = small() ? r.top + scrollY - 76 : r.top + scrollY - Math.max(76, (innerHeight - r.height) / 2 - 80);
          scrollTo({ top: Math.max(0, y), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        }
      }
      place(true);
      nextBtn.focus({ preventScroll: true });
    }

    const go = (d) => {
      const n = i + d;
      if (n < 0) return;
      if (n >= total) return close();
      show(n);
    };

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Tab") {
        const f = [...root.querySelectorAll("button:not([hidden])")].filter((b) => b.offsetParent);
        const at = f.indexOf(document.activeElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }

    backBtn.addEventListener("click", () => (i === 0 ? close() : go(-1)));
    nextBtn.addEventListener("click", () => go(1));
    $("[data-skip]").addEventListener("click", close);
    addEventListener("keydown", onKey, true);
    addEventListener("resize", follow);
    addEventListener("scroll", follow, true);
    show(i);
  }

  function addReplay() {
    const nav = document.querySelector(".side-nav");
    if (!nav || nav.querySelector("[data-tour]")) return;
    const help = nav.querySelector('a[href="/help"]');
    const link = document.createElement("a");
    link.href = "#home";
    link.dataset.tour = "";
    link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg><span>Take the tour</span>`;
    link.addEventListener("click", () => {
      document.body.classList.remove("side-open");
      document.querySelector("#menu-btn")?.setAttribute("aria-expanded", "false");
      setTimeout(() => run(1), 380);
    });
    (help?.nextElementSibling ? help.nextElementSibling.after(link) : nav.append(link));
  }

  function ready() {
    addReplay();
    const side = document.querySelector("#side");
    if (side) new MutationObserver(addReplay).observe(side, { childList: true });
    if (localStorage.getItem(KEY) !== "1") return;
    let wait = 450;
    if (location.hash && location.hash !== "#home") {
      location.hash = "#home";
      wait = 800;
    }
    setTimeout(() => run(0), wait);
  }

  window.NshTour = { start: () => run(0) };

  const page = document.querySelector("#page");
  if (!page) return;
  if (!page.hidden) return ready();
  const mo = new MutationObserver(() => {
    if (page.hidden) return;
    mo.disconnect();
    requestAnimationFrame(ready);
  });
  mo.observe(page, { attributes: true, attributeFilter: ["hidden"] });
})();
