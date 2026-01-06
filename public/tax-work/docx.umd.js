/*
  Placeholder for docx UMD bundle.

  IMPORTANT:
  - Your app uses a strict Content Security Policy: script-src 'self'.
  - That means we cannot load docx from a CDN.

  To enable Word export in Tax Work, replace this file with the real UMD build of the "docx" library.

  Recommended source (official):
  - npm package: "docx"
  - file: node_modules/docx/build/index.umd.js

  Then copy that file here as:
  capro-backend/public/tax-work/docx.umd.js

  After that, window.docx will be available and export will work.
*/

// Keep an explicit marker so the UI can show a helpful message
window.__DOCX_LIBRARY_PLACEHOLDER__ = true;
