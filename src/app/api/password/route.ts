import { NextRequest, NextResponse } from "next/server";

const AUTH_SERVER_URL =
  process.env.ACCOUNT_SERVER_URL || "https://auth.interactor.com";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    action?: string;
    email?: string;
    token?: string;
    password?: string;
  };

  if (body.action === "request") {
    if (!body.email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }

    const origin = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
    const redirectUri = `${new URL(origin).origin}/password`;

    let res: Response;
    try {
      res = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/password/reset-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: body.email, redirect_uri: redirectUri }),
      });
    } catch {
      return NextResponse.json({ error: "Auth server unreachable." }, { status: 502 });
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  if (body.action === "reset") {
    if (!body.token || !body.password) {
      return NextResponse.json({ error: "Token and password are required." }, { status: 400 });
    }

    let res: Response;
    try {
      res = await fetch(`${AUTH_SERVER_URL}/api/v1/admin/password/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: body.token, password: body.password }),
      });
    } catch {
      return NextResponse.json({ error: "Auth server unreachable." }, { status: 502 });
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({ error: "Invalid action." }, { status: 400 });
}
