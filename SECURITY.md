# Redact Local — security policy

## What this project promises

Redact Local is a static, offline page. Its security claims are narrow and testable:

1. **No outbound network traffic.** Enforced twice: by a strict Content-Security-Policy
   (`default-src 'none'; connect-src 'none'`) and by replacing every network primitive
   (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `Worker`,
   `RTCPeerConnection`) with stubs that throw. The header badge counts blocked calls.
2. **No persistence.** No cookies, `localStorage`, `sessionStorage`, IndexedDB or service worker.
3. **No third-party code.** No CDNs, web fonts, analytics, badges or remote images.
4. **Metadata removal on export.** Exports are re-rendered into a new canvas and re-encoded, which drops
   EXIF/GPS/XMP.

## Reporting a vulnerability

Please open a **private security advisory** on this repository
(*Security* → *Advisories* → *Report a vulnerability*). Do not open a public issue for something that
could get a source hurt.

Useful reports include: a way to make the page send data anywhere, a way to recover redacted pixels from
an export produced by this tool, or a redaction that renders differently from what the export contains.

## Not in scope

These are real risks, but outside what a browser page can defend against:

- A compromised operating system, browser, browser extension, or clipboard manager.
- Screenshots, screen recording or shoulder-surfing while you work.
- A copy of the *original* image that you shared before redacting.
- Reverse-engineering of weak redactions that the UI already warns about (blur, small pixelation).
- Hosting: if you use the GitHub Pages copy, GitHub sees your IP address. Run the files locally instead.

## Threat model in one line

This tool protects the image *while it is on your machine*. It cannot protect a machine that is already
compromised, and it cannot unsend a file you shared earlier.
