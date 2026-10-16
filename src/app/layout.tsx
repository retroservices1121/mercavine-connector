import type { Metadata } from "next";
import { Fraunces, Outfit } from "next/font/google";
import { config } from "@/lib/config";
import "./globals.css";

const sans = Outfit({ subsets: ["latin"], variable: "--font-sans" });
const display = Fraunces({ subsets: ["latin"], variable: "--font-display" });

export async function generateMetadata(): Promise<Metadata> {
  const cfg = config();
  return {
    title: { default: cfg.brandName, template: `%s · ${cfg.brandName}` },
    description: `Just ask Grok to find it. ${cfg.brandName} handles a secure checkout you approve. Sellers get more sales from AI shoppers.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${display.variable} antialiased`}>{children}</body>
    </html>
  );
}
