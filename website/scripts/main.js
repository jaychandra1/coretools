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
        link.setAttribute(
          "aria-label",
          "Download CoreTools for " + (data.label || osKey)
        );
        if (data.url) {
          link.setAttribute("href", data.url);
          link.setAttribute("download", "");
          link.setAttribute(
            "title",
            "Download CoreTools " + (data.ext || "") + " for " + data.label
          );
          // The installer is committed by CI and may not exist yet. Verify it
          // is actually served before letting a visitor click into a 404.
          verifyAvailable(link, data);
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

  /**
   * Mark a download button as not-yet-available (the CI build hasn't published
   * this installer). Prevents the "File wasn't available on site" error and
   * steers the visitor to the in-browser version instead.
   */
  function markUnavailable(link, data) {
    link.classList.add("is-unavailable");
    link.setAttribute("aria-disabled", "true");
    link.removeAttribute("download");
    link.setAttribute("href", cfg.webAppUrl || "/app/");
    link.setAttribute(
      "title",
      "The " + (data.label || "") + " installer is being built — use it in your browser for now"
    );
    var label = link.querySelector(".dl-label");
    if (label) label.textContent = "Coming soon";
    else link.textContent = "Coming soon";
    link.addEventListener("click", function (e) {
      // Send them to the web app instead of a dead download.
      e.preventDefault();
      window.location.href = cfg.webAppUrl || "/app/";
    });
  }

  /**
   * HEAD-check a same-origin installer URL. Same-origin only, so it is allowed
   * by the site's strict connect-src 'self' CSP and never leaves the site.
   */
  function verifyAvailable(link, data) {
    var url = data.url || "";
    // Only check same-site paths; external URLs can't be probed under the CSP.
    if (url.charAt(0) !== "/") return;
    if (!window.fetch) return;
    fetch(url, { method: "HEAD" })
      .then(function (res) {
        if (!res.ok) markUnavailable(link, data);
      })
      .catch(function () {
        markUnavailable(link, data);
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
