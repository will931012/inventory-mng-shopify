import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";

import { login } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return login(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return login(request);
}

export default function AuthLogin() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background:
          "linear-gradient(135deg, rgba(245,158,11,0.14), rgba(15,23,42,0.08)), #f8fafc",
        padding: "2rem"
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "28rem",
          background: "#ffffff",
          borderRadius: "1rem",
          padding: "2rem",
          boxShadow: "0 20px 45px rgba(15, 23, 42, 0.08)"
        }}
      >
        <h1 style={{ marginTop: 0, fontSize: "1.75rem" }}>Conectar tienda Shopify</h1>
        <p style={{ color: "#475569", lineHeight: 1.6 }}>
          Introduce el dominio de tu tienda para instalar y abrir la app embebida.
        </p>
        <Form method="post" reloadDocument target="_top">
          <label htmlFor="shop" style={{ display: "block", fontWeight: 600, marginBottom: "0.5rem" }}>
            Dominio de la tienda
          </label>
          <input
            id="shop"
            name="shop"
            type="text"
            placeholder="tu-tienda.myshopify.com"
            autoComplete="on"
            style={{
              width: "100%",
              border: "1px solid #cbd5e1",
              borderRadius: "0.75rem",
              padding: "0.9rem 1rem",
              fontSize: "1rem"
            }}
          />
          {actionData?.shop ? (
            <p style={{ color: "#b91c1c", marginTop: "0.75rem" }}>{actionData.shop}</p>
          ) : null}
          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            style={{
              width: "100%",
              marginTop: "1rem",
              border: 0,
              borderRadius: "0.75rem",
              padding: "0.9rem 1rem",
              background: "#111827",
              color: "#ffffff",
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {navigation.state === "submitting" ? "Conectando..." : "Instalar app"}
          </button>
        </Form>
      </div>
    </main>
  );
}
