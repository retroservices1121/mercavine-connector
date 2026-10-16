import { handleMcp } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function route(req: Request) {
  return handleMcp(req);
}

export const GET = route;
export const POST = route;
export const DELETE = route;
