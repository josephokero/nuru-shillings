const onPage = document.querySelector(".legal-onpage");
const narrow = window.matchMedia("(max-width: 800px)");

function fitMenu() {
  if (onPage) onPage.open = !narrow.matches;
}
fitMenu();
narrow.addEventListener("change", fitMenu);

const sectionLinks = [...document.querySelectorAll(".legal-toc a[href^='#']")];

sectionLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    const target = document.getElementById(link.getAttribute("href").slice(1));
    if (!target) return;
    event.preventDefault();
    if (onPage && narrow.matches) onPage.open = false;
    const top = target.getBoundingClientRect().top + window.scrollY - 24;
    window.scrollTo({ top, behavior: "smooth" });
    sectionLinks.forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
    history.replaceState(null, "", link.getAttribute("href"));
  });
});

const headings = sectionLinks
  .map((link) => document.getElementById(link.getAttribute("href").slice(1)))
  .filter(Boolean);

if ("IntersectionObserver" in window && headings.length) {
  const watch = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      sectionLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${id}`));
    });
  }, { rootMargin: "0px 0px -70% 0px" });
  headings.forEach((heading) => watch.observe(heading));
}
