/* ============================================================
   CoreTools — main.js
   Small, dependency-free progressive enhancement:
     1. Populate download cards from CORETOOLS_DOWNLOADS.
     2. Detect the visitor's OS to recommend a build.
     3. Fill in version + current year.
   The page is fully functional (with placeholder links) even if
   this script fails to run.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.CORETOOLS_DOWNLOADS || { version: "", platforms: {} };

  /** Best-effort OS detection from the user agent. Never sent anywhere. */
  function detectOS() {
    var ua = (navigator.userAgent || "").toLowerCase();
    var platform = (navigator.platform || "").toLowerCase();
    if (/win/.test(ua) || /win/.test(platform)) return "windows";
    if (/mac/.test(ua) || /mac/.test(platform)) {
      // iPads report as Mac; still fine to suggest macOS build here.
      return "macos";
    }
    if (/linux|x11|ubuntu|fedora|debian/.test(ua)) return "linux";
    return null;
  }

  function setText(selector, value, root) {
    (root || document).querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  function populateDownloads(detected) {
    var grid = document.querySelector("[data-download-grid]");
    if (!grid) return;

    Object.keys(cfg.platforms || {}).forEach(function (osKey) {
      var data = cfg.platforms[osKey];
      var card = grid.querySelector('[data-os="' + osKey + '"]');
      if (!card) return;

      var link = card.querySelector("[data-download-link]");
      var extEl = card.querySelector("[data-os-ext]");
      var noteEl = card.querySelector("[data-os-note]");
      var sizeEl = card.querySelector("[data-os-size]");

      if (extEl && data.ext) extEl.textContent = data.ext;
      if (noteEl && data.note) noteEl.textContent = data.note;

      if (sizeEl) {
        sizeEl.textContent = data.size
          ? "v" + cfg.version + " · " + data.size
          : "v" + cfg.version;
      }

      if (link) {
        var hasDirect = data.url && data.url !== "#";
        link.setAttribute(
          "aria-label",
          "Download CoreTools for " + (data.label || osKey)
        );
        if (hasDirect) {
          // Direct asset: one-click download.
          link.setAttribute("href", data.url);
          link.setAttribute("download", "");
          link.setAttribute(
            "title",
            "Download CoreTools " + (data.ext || "") + " for " + data.label
          );
        } else {
          // Fall back to the Releases page so the button always works.
          link.setAttribute("href", cfg.releaseUrl || "#");
          link.setAttribute("rel", "noopener");
          link.setAttribute(
            "title",
            "Opens GitHub Releases — download the " +
              (data.ext || "") +
              " asset for " +
              data.label
          );
        }
      }

      // Highlight the card matching the visitor's OS.
      if (osKey === detected) {
        card.classList.add("is-recommended");
        if (!card.querySelector(".recommended-badge")) {
          var badge = document.createElement("span");
          badge.className = "recommended-badge";
          badge.textContent = "Recommended for you";
          card.insertBefore(badge, card.firstChild);
        }
      }
    });
  }

  function updateHero(detected) {
    var note = document.querySelector("[data-detected-os]");
    if (note && detected && cfg.platforms[detected]) {
      note.textContent = "for " + cfg.platforms[detected].label;
    }
  }

  function updateMeta() {
    if (cfg.version) setText("[data-version]", "v" + cfg.version);

    var year = new Date().getFullYear();
    setText("[data-year]", String(year));

    document.querySelectorAll("[data-release-link]").forEach(function (a) {
      a.setAttribute("href", cfg.releaseUrl || "#");
    });

    document.querySelectorAll("[data-webapp-link]").forEach(function (a) {
      a.setAttribute("href", cfg.webAppUrl || "/app/");
    });
  }

  function init() {
    var detected = detectOS();
    updateMeta();
    updateHero(detected);
    populateDownloads(detected);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
