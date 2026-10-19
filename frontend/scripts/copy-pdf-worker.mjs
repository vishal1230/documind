// pdf.js parses PDFs in a Web Worker. Serve the worker file from /public so the browser can load it.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public", { recursive: true });
// The legacy build matches the legacy main library used in DocumentViewer (polyfilled for all browsers).
copyFileSync("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/pdf.worker.min.mjs");
console.log("copied pdf.js worker to public/pdf.worker.min.mjs");
