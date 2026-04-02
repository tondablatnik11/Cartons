import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kartony Bor – WH 8496",
  description: "Řízení zásob kartonů – Warehouse 8496",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
