import { handleOauth } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = (req: Request) => handleOauth(req);
export const GET = route;
export const POST = route;
export const OPTIONS = route;
