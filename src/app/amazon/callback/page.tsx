import { redirect } from "next/navigation";
import { completeAmazonOAuth } from "@/lib/amazon-mcf";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Amazon returns here after the seller approves. Finish the link, then go back to the dashboard with a banner. */
export default async function AmazonCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let ok = false;
  try {
    await completeAmazonOAuth({
      code: first(params.spapi_oauth_code),
      state: first(params.state),
      sellingPartnerId: first(params.selling_partner_id),
    });
    ok = true;
  } catch {
    ok = false;
  }
  redirect(ok ? "/seller?amazon=connected" : "/seller?amazon=error");
}
