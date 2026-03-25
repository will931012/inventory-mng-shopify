import type { EntryContext } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { handleRequest as vercelHandleRequest } from "@vercel/remix";

import { addDocumentResponseHeaders } from "./shopify.server";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  const remixServer = <RemixServer context={remixContext} url={request.url} />;
  addDocumentResponseHeaders(request, responseHeaders);
  return vercelHandleRequest(request, responseStatusCode, responseHeaders, remixServer);
}
