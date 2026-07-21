/* ============================================================
   CoreTools — main.js
   Dependency-free progressive enhancement:
     1. Populate download cards from CORETOOLS_DOWNLOADS and
        verify each installer is actually served (same-origin).
     2. Detect the visitor's OS to recommend a build.
     3. Load SHA-256 checksums for download verification.
     4. Reveal-on-scroll micro-animations (reduced-motion aware).
     5. Sentence Polisher UI (engine in polisher.js).
   The page remains fully functional if this script fails.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.CORETOOLS_DOWNLOADS || { version: "", platforms: {} };

  /* ---------------------- OS detection ---------------------- */

  /** Best-effort OS detection from the user agent. Never sent anywhere. */
  function detectOS() {
    var ua = (navigator.userAgent || "").toLowerCase();
    var platform = (navigator.platform || "").toLowerCase();
    if (/win/.test(ua) || /win/.test(platform)) return "windows";
    if (/mac/.test(ua) || /mac/.test(platform)) return "macos";
    if (/linux|x11|ubuntu|fedora|debian/.test(ua)) return "linux";
    return null;
  }

  function setText(selector, value, root) {
    (root || document).querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  function formatBytes(n) {
    if (!n || isNaN(n)) return "";
    var mb = n / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  }

  /* ---------------------- download cards ---------------------- */

  /**
   * Mark a download button as not-yet-available (the CI build hasn't published
   * this installer). Prevents "file wasn't available" errors and steers the
   * visitor to the in-browser version instead.
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
      e.preventDefault();
      window.location.href = cfg.webAppUrl || "/app/";
    });
  }

  /**
   * HEAD-check a same-origin installer URL. Same-origin only, so it is allowed
   * by the site's strict connect-src 'self' CSP and never leaves the site.
   * On success, fill in the real file size from Content-Length.
   */
  function verifyAvailable(link, data, sizeEl) {
    var url = data.url || "";
    if (url.charAt(0) !== "/") return; // only probe same-site paths
    if (!window.fetch) return;
    fetch(url, { method: "HEAD" })
      .then(function (res) {
        if (!res.ok) {
          markUnavailable(link, data);
          return;
        }
        var len = parseInt(res.headers.get("content-length") || "", 10);
        var size = formatBytes(len);
        if (sizeEl && size) {
          sizeEl.textContent = "v" + cfg.version + " · " + size;
        }
      })
      .catch(function () {
        markUnavailable(link, data);
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
      if (sizeEl) sizeEl.textContent = "v" + cfg.version;

      if (link && data.url) {
        link.setAttribute("href", data.url);
        link.setAttribute("download", "");
        link.setAttribute(
          "aria-label",
          "Download CoreTools for " + (data.label || osKey)
        );
        link.setAttribute(
          "title",
          "Download CoreTools " + (data.ext || "") + " for " + data.label
        );
        verifyAvailable(link, data, sizeEl);
      }

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

  /* ------------------------ checksums ------------------------ */

  /**
   * Load SHA256SUMS.txt (generated by CI next to the installers) and render
   * one entry per file. Same-origin fetch only.
   */
  function loadChecksums() {
    var list = document.querySelector("[data-checksums]");
    if (!list || !window.fetch) return;
    fetch("/downloads/SHA256SUMS.txt")
      .then(function (res) {
        if (!res.ok) throw new Error("no checksums");
        return res.text();
      })
      .then(function (text) {
        var rows = text
          .split("\n")
          .map(function (line) {
            // "<sha256>  <filename>" (standard sha256sum format)
            var m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
            return m ? { hash: m[1], file: m[2] } : null;
          })
          .filter(Boolean);
        if (!rows.length) throw new Error("empty");
        list.innerHTML = "";
        rows.forEach(function (row) {
          var li = document.createElement("li");
          var file = document.createElement("span");
          file.className = "file";
          file.textContent = row.file;
          var hash = document.createElement("span");
          hash.className = "hash";
          hash.textContent = row.hash;
          li.appendChild(file);
          li.appendChild(hash);
          list.appendChild(li);
        });
      })
      .catch(function () {
        list.innerHTML = "";
        var li = document.createElement("li");
        li.className = "muted";
        li.textContent =
          "Checksums will appear here once the next build is published.";
        list.appendChild(li);
      });
  }

  /* ------------------- reveal micro-animations ------------------- */

  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) {
        el.classList.add("in");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach(function (el) {
      io.observe(el);
    });
  }

  /* --------------------------- meta --------------------------- */

  function updateMeta(detected) {
    if (cfg.version) setText("[data-version]", "v" + cfg.version);
    setText("[data-year]", String(new Date().getFullYear()));

    document.querySelectorAll("[data-webapp-link]").forEach(function (a) {
      a.setAttribute("href", cfg.webAppUrl || "/app/");
    });

    var note = document.querySelector("[data-detected-os]");
    if (note && detected && cfg.platforms[detected]) {
      note.textContent = "for " + cfg.platforms[detected].label;
    }
  }

  /* --------------------------- init --------------------------- */

  function init() {
    var detected = detectOS();
    updateMeta(detected);
    populateDownloads(detected);
    loadChecksums();
    initReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
