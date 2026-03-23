import type { ActionFunctionArgs } from "@remix-run/node";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await authenticate.webhook(request);

  await prisma.session.deleteMany({
    where: {
      shop
    }
  });

  return new Response();
}

export default function WebhookAppUninstalled() {
  return null;
}
