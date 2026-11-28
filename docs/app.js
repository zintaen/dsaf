/* DSAF Docs Interactions: Theme Override, Accessible Focusgroup Tabs, Copy Controls */

(() => {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const themeBtn = document.getElementById("theme-toggle-btn");
  const systemMq = window.matchMedia("(prefers-color-scheme: dark)");
  let manualTheme = meta && (meta.content === "light" || meta.content === "dark") ? meta.content : null;

  function getRenderedScheme() {
    if (meta?.content === "light" || meta?.content === "dark") return meta.content;
    return systemMq.matches ? "dark" : "light";
  }

  function syncThemeBtn() {
    if (!themeBtn) return;
    const current = getRenderedScheme();
    const next = current === "dark" ? "light" : "dark";
    themeBtn.textContent = next === "dark" ? "Dark" : "Light";
    themeBtn.setAttribute("aria-label", `Switch to ${next} theme`);
  }

  if (themeBtn && meta) {
    syncThemeBtn();
    themeBtn.addEventListener("click", () => {
      const target = getRenderedScheme() === "dark" ? "light" : "dark";
      const systemScheme = systemMq.matches ? "dark" : "light";
      manualTheme = target === systemScheme ? null : target;
      meta.content = manualTheme || "light dark";
      try {
        if (target === systemScheme) {
          localStorage.removeItem("color-scheme");
        } else {
          localStorage.setItem("color-scheme", target);
        }
      } catch {
        // In-session meta.content & manualTheme remain intact when storage is blocked
      }
      syncThemeBtn();
    });

    window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== "color-scheme") return;
      const nextVal = e.key === null ? null : e.newValue;
      manualTheme = nextVal === "light" || nextVal === "dark" ? nextVal : null;
      meta.content = manualTheme || "light dark";
      syncThemeBtn();
    });

    systemMq.addEventListener("change", () => {
      let stored = null;
      let storageOk = false;
      try {
        stored = localStorage.getItem("color-scheme");
        storageOk = true;
      } catch {}
      if (storageOk) {
        manualTheme = stored === "light" || stored === "dark" ? stored : null;
      }
      meta.content = manualTheme === "light" || manualTheme === "dark" ? manualTheme : "light dark";
      syncThemeBtn();
    });
  }

  /* Single-row accessible tabs with hidden="until-found" + beforematch */
  const tablist = document.querySelector('[focusgroup^="tablist"]');
  if (tablist) {
    const tabs = Array.from(tablist.querySelectorAll("button"));
    const panels = Array.from(document.querySelectorAll('.panels-stack > [role="tabpanel"]'));

    function activateTab(nextTab, { focus = false, scroll = true } = {}) {
      for (const tab of tabs) {
        const selected = tab === nextTab;
        tab.setAttribute("role", "tab");
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
      if (scroll && tablist.scrollWidth > tablist.clientWidth) {
        const listRect = tablist.getBoundingClientRect();
        const tabRect = nextTab.getBoundingClientRect();
        if (tabRect.left < listRect.left) {
          tablist.scrollLeft -= listRect.left - tabRect.left + 8;
        } else if (tabRect.right > listRect.right) {
          tablist.scrollLeft += tabRect.right - listRect.right + 8;
        }
      }
      if (focus) nextTab.focus();
    }

    activateTab(tabs[0], { scroll: false });
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
        if (ownerTab) activateTab(ownerTab, { scroll: false });
      });
    }
  }

  function fallbackCopyText(text) {
    const prevFocus = document.activeElement;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      return typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
      if (prevFocus && typeof prevFocus.focus === "function" && prevFocus.isConnected) {
        prevFocus.focus({ preventScroll: true });
      }
    }
  }

  /* Copy buttons */
  const copyStatus = document.getElementById("copy-status");
  for (const btn of document.querySelectorAll("[data-copy-target]")) {
    const orig = btn.textContent;
    const labelCtx = (btn.getAttribute("aria-label") || "snippet").replace(/^Copy\s+/i, "");
    let timerId = null;
    btn.addEventListener("click", async () => {
      const targetEl = document.getElementById(btn.getAttribute("data-copy-target"));
      const text = targetEl?.textContent?.trim();
      if (!text) return;
      let copied = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {}
      if (!copied) {
        copied = fallbackCopyText(text);
      }
      btn.textContent = copied ? "Copied" : "Copy failed";
      if (copyStatus) {
        const statusMsg = copied ? `Copied ${labelCtx} to clipboard.` : `Failed to copy ${labelCtx}.`;
        copyStatus.textContent = "";
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            copyStatus.textContent = statusMsg;
          });
        } else {
          copyStatus.textContent = statusMsg;
        }
      }
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        btn.textContent = orig;
        timerId = null;
      }, 1500);
    });
  }
})();
