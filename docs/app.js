/* DSAF Promo Site Interactions: Theme Toggle, Accessible Tabs, Copy Controls */

(() => {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const themeBtn = document.getElementById("theme-toggle-btn");
  const systemMq = window.matchMedia("(prefers-color-scheme: dark)");

  function getRenderedScheme() {
    if (meta?.content === "light" || meta?.content === "dark") return meta.content;
    return systemMq.matches ? "dark" : "light";
  }

  function syncThemeAria() {
    if (!themeBtn) return;
    const current = getRenderedScheme();
    themeBtn.setAttribute("aria-label", current === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  if (themeBtn && meta) {
    syncThemeAria();
    themeBtn.addEventListener("click", () => {
      const target = getRenderedScheme() === "dark" ? "light" : "dark";
      const systemScheme = systemMq.matches ? "dark" : "light";
      try {
        if (target === systemScheme) {
          localStorage.removeItem("color-scheme");
          meta.content = "light dark";
        } else {
          localStorage.setItem("color-scheme", target);
          meta.content = target;
        }
      } catch {
        meta.content = target;
      }
      syncThemeAria();
    });

    window.addEventListener("storage", (e) => {
      if (e.key !== "color-scheme") return;
      meta.content = e.newValue === "light" || e.newValue === "dark" ? e.newValue : "light dark";
      syncThemeAria();
    });

    systemMq.addEventListener("change", syncThemeAria);
  }

  /* Accessible Tabbed Inspector (beforematch + arrow keys + focusgroupstart sync) */
  const tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('.panels-stack > [role="tabpanel"]'));

    function activateTab(nextTab, { focus = false } = {}) {
      for (const tab of tabs) {
        const selected = tab === nextTab;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        tab.toggleAttribute("focusgroupstart", selected);
      }
      for (const panel of panels) {
        const match = panel.getAttribute("aria-labelledby") === nextTab.id;
        if (match) {
          panel.removeAttribute("hidden");
        } else {
          panel.setAttribute("hidden", "until-found");
        }
      }
      nextTab.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (focus) nextTab.focus();
    }

    for (const tab of tabs) {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (e) => {
        const idx = tabs.indexOf(tab);
        let nextIdx = -1;
        if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
        else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = tabs.length - 1;
        if (nextIdx !== -1) {
          e.preventDefault();
          activateTab(tabs[nextIdx], { focus: true });
        }
      });
    }

    for (const panel of panels) {
      panel.addEventListener("beforematch", () => {
        const ownerId = panel.getAttribute("aria-labelledby");
        const ownerTab = tabs.find((t) => t.id === ownerId);
        if (ownerTab) activateTab(ownerTab);
      });
    }
  }

  /* Copy buttons */
  for (const btn of document.querySelectorAll("[data-copy-target]")) {
    btn.addEventListener("click", async () => {
      const targetEl = document.getElementById(btn.getAttribute("data-copy-target"));
      const text = targetEl?.textContent?.trim();
      if (!text) return;
      const orig = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Ready";
      }
      setTimeout(() => {
        btn.textContent = orig;
      }, 1500);
    });
  }
})();
