import Link from "next/link";
import { config } from "@/lib/config";

export const SUPPORT_EMAIL = "privacy@mercavine.com";

export function SiteFooter() {
  const cfg = config();
  return (
    <footer className="mt-16 bg-[var(--vine)] text-[#f4efe4]">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 sm:grid-cols-2 md:grid-cols-4 md:px-10">
        <div>
          <p className="display text-2xl">{cfg.brandName}</p>
          <p className="mt-2 text-sm text-[#d7e7d4]">Shop by asking. Sell to the bots doing the asking.</p>
        </div>
        <nav aria-label="Company" className="space-y-2 text-sm">
          <p className="font-medium">Company</p>
          <Link href="/#about" className="block text-[#d7e7d4] hover:text-white">About</Link>
          <Link href="/#sellers" className="block text-[#d7e7d4] hover:text-white">Sell on {cfg.brandName}</Link>
          <Link href="/developers" className="block text-[#d7e7d4] hover:text-white">Developers</Link>
        </nav>
        <nav aria-label="Legal" className="space-y-2 text-sm">
          <p className="font-medium">Legal</p>
          <Link href="/privacy" className="block text-[#d7e7d4] hover:text-white">Privacy</Link>
          <Link href="/terms" className="block text-[#d7e7d4] hover:text-white">Terms</Link>
        </nav>
        <div id="contact" className="space-y-2 text-sm">
          <p className="font-medium">Contact</p>
          <p className="text-[#d7e7d4]">{cfg.brandName}</p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="block text-[#d7e7d4] underline hover:text-white">{SUPPORT_EMAIL}</a>
        </div>
      </div>
      <p className="border-t border-white/10 px-5 py-4 text-center text-xs text-[#d7e7d4]">© {new Date().getFullYear()} {cfg.brandName}</p>
    </footer>
  );
}
