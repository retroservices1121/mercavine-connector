import { handleApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function route(req: Request) {
  return handleApi(req);
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const DELETE = route;
export const OPTIONS = route;
