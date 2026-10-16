import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { consumeDownload } from "@/lib/digital";
import { ApiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const grant = consumeDownload(decodeURIComponent(token));
    const stream = Readable.toWeb(createReadStream(grant.path)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(grant.size),
        "content-disposition": contentDisposition(grant.filename),
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : "Download failed.";
    return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
}
