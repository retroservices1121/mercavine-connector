"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function RefreshButton({ token }: { token: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="mt-6">
      <Button
        variant="vine"
        onClick={async () => {
          const response = await fetch(`/api/v1/approvals/${encodeURIComponent(token)}/refresh`, { method: "POST" });
          const body = await response.json();
          setMessage(response.ok ? `Your bot can clone cart ${body.cloned_cart_id}.` : "The bot could not be notified.");
        }}
      >
        Ask my bot to refresh
      </Button>
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
    </div>
  );
}
