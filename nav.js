(() => {
  const bar = document.querySelector(".reference-site > .ref-nav");
  if (!bar || bar.querySelector(".nav-toggle")) return;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ghosts = [...bar.querySelectorAll(".ref-actions a.ref-ghost")];
  const login = ghosts.find((a) => /log\s*in/i.test(a.textContent));
  const start = bar.querySelector(".ref-actions a.ref-light");
  const rows = [...bar.querySelectorAll("nav a"), ...ghosts.filter((a) => a !== login)];

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-toggle";
  btn.setAttribute("aria-label", "Open menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "nav-sheet");
  btn.innerHTML = "<span></span><span></span><span></span>";

  const sheet = document.createElement("div");
  sheet.className = "nav-sheet";
  sheet.id = "nav-sheet";
  sheet.inert = true;
  sheet.innerHTML = `
    <nav aria-label="Menu">${rows.map((a, i) =>
      `<a href="${esc(a.getAttribute("href"))}" style="--i:${i}"><span>${esc(a.textContent.trim())}</span><i aria-hidden="true"></i></a>`).join("")}
    </nav>
    <div class="nav-sheet-actions" style="--i:${rows.length}">
      ${login ? `<a class="ns-ghost" href="${esc(login.getAttribute("href"))}">Log in</a>` : ""}
      ${start ? `<a class="ns-light" href="${esc(start.getAttribute("href"))}">Start free</a>` : ""}
    </div>`;

  const scrim = document.createElement("div");
  scrim.className = "nav-scrim";

  bar.append(btn, sheet);
  document.body.appendChild(scrim);
  bar.classList.add("has-menu");

  const set = (open) => {
    bar.classList.toggle("is-open", open);
    scrim.classList.toggle("is-on", open);
    document.documentElement.classList.toggle("nav-locked", open);
    sheet.inert = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  btn.addEventListener("click", () => set(!bar.classList.contains("is-open")));
  sheet.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  scrim.addEventListener("click", () => set(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bar.classList.contains("is-open")) { set(false); btn.focus(); }
  });
  matchMedia("(min-width: 801px)").addEventListener("change", (e) => { if (e.matches) set(false); });
})();
