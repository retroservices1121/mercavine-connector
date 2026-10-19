export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initMonitoring } = await import("./lib/monitoring");
    await initMonitoring();
    const { getDb } = await import("./lib/db");
    const { sweepExpired } = await import("./lib/cart");
    const { retryDueWebhooks } = await import("./lib/webhooks");
    const { scheduleBackups } = await import("./lib/backup");
    getDb();
    scheduleBackups();
    const { scheduleStoreJobs } = await import("./lib/store-jobs");
    scheduleStoreJobs();
    setInterval(() => {
      try {
        sweepExpired();
        retryDueWebhooks();
      } catch (error) {
        console.error(error instanceof Error ? error.message : "sweep failed");
        void import("./lib/monitoring").then((m) => m.captureError(error, { job: "sweep" }));
      }
    }, 60_000);
  }
}

/** Next.js calls this for uncaught errors in routes, pages and server actions. */
export async function onRequestError(error: unknown, request: { path: string; method: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureError } = await import("./lib/monitoring");
  captureError(error, { path: request.path, method: request.method });
}
