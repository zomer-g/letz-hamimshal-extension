// Cross-browser namespace shim. Loaded FIRST in every extension context.
//
// Our code calls `chrome.*` with `await` (promise style). On Chrome MV3 the
// `chrome.*` APIs already return promises. On Firefox the promise-based APIs
// live under `browser.*` while `chrome.*` is callback-style — so we alias
// `chrome` → `browser` there, and all our `await chrome.*` code runs unchanged.
// No-op on Chrome (where `browser` is undefined).
(function () {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser !== globalThis.chrome) {
    try { globalThis.chrome = globalThis.browser; } catch {}
  }
})();
