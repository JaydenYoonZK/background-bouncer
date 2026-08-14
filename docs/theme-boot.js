/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */
// Applies the theme before first paint. This lived inline in <head> until it
// turned out the page's own Content-Security-Policy (script-src 'self') was
// blocking it, so the choice never applied until app.js loaded. As a file it
// is 'self', runs as a parser-blocking script, and the flash is gone.
(function () {
  var t = new URLSearchParams(location.search).get("theme");
  if (!t) { try { t = localStorage.getItem("theme"); } catch (e) { /* storage may be blocked */ } }
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  var m = document.createElement("meta");
  m.name = "theme-color";
  m.content = t === "light" ? "#f6f4ee" : "#0d0c0a";
  document.head.appendChild(m);
})();
