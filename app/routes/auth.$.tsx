import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.admin(request);
    return null;
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
