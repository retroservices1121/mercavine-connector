"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";

export function AccountActions({ botId, revoked }: { botId: string; revoked: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        disabled={revoked}
        onClick={async () => {
          await fetch(`/api/v1/bots/${botId}/revoke`, { method: "POST" });
          router.refresh();
        }}
      >
        {revoked ? "Bot revoked" : "Revoke this bot"}
      </Button>
      <Button
        variant="vine"
        onClick={async () => {
          const options = await fetch("/api/v1/passkeys/register/options", { method: "POST" }).then((res) => res.json());
          if (options.error) {
            setMessage(options.error.message);
            return;
          }
          const assertion = await startRegistration({ optionsJSON: options });
          const verified = await fetch("/api/v1/passkeys/register/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(assertion),
          });
          setMessage(verified.ok ? "Passkey enrolled. Approval will ask for it." : "Passkey enrollment failed.");
          router.refresh();
        }}
      >
        Enroll a passkey
      </Button>
      {message ? <p className="w-full text-sm text-[var(--muted)]">{message}</p> : null}
    </div>
  );
}
