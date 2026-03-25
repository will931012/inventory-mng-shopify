import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.admin(request);

    const url = new URL(request.url);
    const params = new URLSearchParams();
    const shop = url.searchParams.get("shop");
    const host = url.searchParams.get("host");
    const embedded = url.searchParams.get("embedded");

    if (shop) {
      params.set("shop", shop);
    }

    if (host) {
      params.set("host", host);
    }

    params.set("embedded", embedded ?? "1");

    throw redirect(params.toString() ? `/app?${params.toString()}` : "/app");
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown authentication error";
    console.error("Shopify auth callback failed", error);

    return json(
      {
        error: message
      },
      { status: 500 }
    );
  }
}

export default function AuthCatchAll() {
  return null;
}
