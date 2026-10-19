import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted fonts (SIL Open Font License, see app/fonts): builds work offline and pages
// make no third-party font requests. Inter covers Latin text, Noto Sans Devanagari covers Hindi.
const inter = localFont({
  src: "./fonts/inter-latin-var.woff2",
  weight: "100 900",
  variable: "--font-inter",
  display: "swap",
});
const devanagari = localFont({
  src: [
    { path: "./fonts/noto-sans-devanagari-400.woff2", weight: "400" },
    { path: "./fonts/noto-sans-devanagari-500.woff2", weight: "500" },
    { path: "./fonts/noto-sans-devanagari-600.woff2", weight: "600" },
  ],
  variable: "--font-devanagari",
  display: "swap",
  preload: false, // only downloaded when Hindi text appears
});

export const metadata: Metadata = {
  title: "DocuMind",
  description: "Chat with your own documents, with citations",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content", // keep the composer above the mobile keyboard
  themeColor: "#f7f7f5",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${devanagari.variable}`}>
      <body className="font-sans text-ink">{children}</body>
    </html>
  );
}
