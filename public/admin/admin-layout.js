// The firm admin panel on a phone (ledger task DS5).
//
// Below 992px the sidebar is a drawer behind the Menu button, and the task
// board's filters are a sheet behind the Filters button. The scrim, Escape,
// choosing a page and applying the filters close them; a window that grows
// past 992px closes both, since that layout has neither. admin.css does the
// drawing; this file only opens and closes, and talks to no server.
(() => {
  const body = document.body;
  const menu = document.getElementById("sidebarToggle");
  const sidebar = document.getElementById("adminSidebar");
  const scrim = document.getElementById("sidebarScrim");
  const filtersButton = document.querySelector(".filter-toggle");
  if (!menu || !sidebar || !scrim) return;

  const isOpen = (name) => body.classList.contains(name);
  const syncScrim = () => {
    scrim.hidden = !isOpen("sidebar-open") && !isOpen("filters-open");
  };

  function setDrawer(open) {
    body.classList.toggle("sidebar-open", open);
    menu.setAttribute("aria-expanded", String(open));
    syncScrim();
    if (open) sidebar.querySelector("a")?.focus();
  }

  function setFilters(open) {
    body.classList.toggle("filters-open", open);
    filtersButton?.setAttribute("aria-expanded", String(open));
    syncScrim();
  }

  menu.addEventListener("click", () => setDrawer(!isOpen("sidebar-open")));
  scrim.addEventListener("click", () => {
    setDrawer(false);
    setFilters(false);
  });
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("a")) setDrawer(false);
  });
  filtersButton?.addEventListener("click", () => setFilters(!isOpen("filters-open")));
  document.querySelector("[data-close-filters]")?.addEventListener("click", () => setFilters(false));
  document.getElementById("taskFilterApply")?.addEventListener("click", () => setFilters(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isOpen("sidebar-open")) {
      setDrawer(false);
      menu.focus();
    }
    if (isOpen("filters-open")) {
      setFilters(false);
      filtersButton?.focus();
    }
  });
  window.matchMedia("(min-width: 992px)").addEventListener("change", (event) => {
    if (!event.matches) return;
    setDrawer(false);
    setFilters(false);
  });
})();
