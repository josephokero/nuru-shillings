(() => {
  const search = document.querySelector("[data-help-search]");
  if (search) {
    const items = [...document.querySelectorAll(".help-q")];
    const groups = [...document.querySelectorAll("[data-help-group]")];
    const empty = document.querySelector(".help-empty");
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      items.forEach((item) => {
        const hit = !q || item.textContent.toLowerCase().includes(q);
        item.hidden = !hit;
        if (hit) shown += 1;
        if (q && hit) item.open = true;
        if (!q) item.open = false;
      });
      groups.forEach((g) => {
        g.hidden = !g.querySelector(".help-q:not([hidden])");
      });
      if (empty) empty.hidden = shown > 0;
    });
  }

  document.querySelectorAll("form[data-contact]").forEach((form) => {
    const status = form.querySelector(".status");
    const button = form.querySelector("button[type='submit']");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.kind = form.dataset.contact;
      button.disabled = true;
      status.className = "status";
      status.textContent = "Sending…";
      try {
        const r = await fetch("/api/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || "We could not send that.");
        form.reset();
        status.className = "status ok";
        status.textContent = "Sent. A copy is on its way to your inbox, and we will reply there.";
      } catch (err) {
        status.className = "status err";
        status.textContent = err.message && err.message !== "Failed to fetch"
          ? err.message
          : "We could not send that. Write to supportnorashillings@benuru.com.";
      } finally {
        button.disabled = false;
      }
    });
  });
})();
