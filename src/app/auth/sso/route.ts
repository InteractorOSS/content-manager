import { signIn } from "@/lib/auth";
import type { NextRequest } from "next/server";

// Headless entry point for *.interactor.com deployments — proxy.ts redirects
// here instead of rendering a local login/register/password page, mirroring
// product-manager's build.interactor.com behavior.
export async function GET(request: NextRequest) {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl") ?? "/dashboard";
  await signIn("interactor", { redirectTo: callbackUrl });
}
