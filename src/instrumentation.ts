export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./lib/db");
    const { sweepExpired } = await import("./lib/cart");
    const { retryDueWebhooks } = await import("./lib/webhooks");
    getDb();
    setInterval(() => {
      try {
        sweepExpired();
        retryDueWebhooks();
      } catch (error) {
        console.error(error instanceof Error ? error.message : "sweep failed");
      }
    }, 60_000);
  }
}
