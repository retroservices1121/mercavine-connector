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
    description: `${cfg.brandName} is a bot-first marketplace. Your agent builds the cart. You approve the charge. Sellers are paid on their own Stripe accounts.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${display.variable} antialiased`}>{children}</body>
    </html>
  );
}
