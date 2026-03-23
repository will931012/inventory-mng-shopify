import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { authenticate } from "../shopify.server";

type ShopInfo = {
  name: string;
  email: string;
  myshopifyDomain: string;
  plan: {
    displayName: string;
    partnerDevelopment: boolean;
    shopifyPlus: boolean;
  };
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query AppDashboardShop {
        shop {
          name
          email
          myshopifyDomain
          plan {
            displayName
            partnerDevelopment
            shopifyPlus
          }
        }
      }
    `
  );

  const payload = (await response.json()) as { data?: { shop?: ShopInfo } };

  return json({
    shop: payload.data?.shop ?? null,
    session: {
      shop: session.shop,
      scope: session.scope ?? "No definido"
    }
  });
}

export default function AppDashboard() {
  const { shop, session } = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "2rem",
        color: "#0f172a"
      }}
    >
      <div style={{ maxWidth: "72rem", margin: "0 auto" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <p style={{ margin: 0, color: "#b45309", fontWeight: 700, letterSpacing: "0.08em" }}>
            DASHBOARD
          </p>
          <h1 style={{ marginBottom: "0.5rem" }}>Inventory Shopify Manager</h1>
          <p style={{ margin: 0, color: "#475569" }}>Base inicial conectada a tu tienda Shopify.</p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "1rem"
          }}
        >
          <section
            style={{
              background: "#ffffff",
              borderRadius: "1rem",
              padding: "1.5rem",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)"
            }}
          >
            <h2 style={{ marginTop: 0 }}>Estado de la conexion</h2>
            <dl style={{ margin: 0, display: "grid", gap: "0.9rem" }}>
              <div>
                <dt style={{ color: "#64748b", fontSize: "0.9rem" }}>Tienda</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{shop?.name ?? session.shop}</dd>
              </div>
              <div>
                <dt style={{ color: "#64748b", fontSize: "0.9rem" }}>Dominio</dt>
                <dd style={{ margin: 0 }}>{shop?.myshopifyDomain ?? session.shop}</dd>
              </div>
              <div>
                <dt style={{ color: "#64748b", fontSize: "0.9rem" }}>Email</dt>
                <dd style={{ margin: 0 }}>{shop?.email ?? "No disponible"}</dd>
              </div>
              <div>
                <dt style={{ color: "#64748b", fontSize: "0.9rem" }}>Plan</dt>
                <dd style={{ margin: 0 }}>{shop?.plan.displayName ?? "Sin datos"}</dd>
              </div>
              <div>
                <dt style={{ color: "#64748b", fontSize: "0.9rem" }}>Scopes</dt>
                <dd style={{ margin: 0 }}>{session.scope}</dd>
              </div>
            </dl>
          </section>

          <section
            style={{
              background: "#ffffff",
              borderRadius: "1rem",
              padding: "1.5rem",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)"
            }}
          >
            <h2 style={{ marginTop: 0 }}>Lo que ya quedo listo</h2>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.8 }}>
              <li>Autenticacion embebida para Shopify.</li>
              <li>Persistencia de sesiones con Prisma y SQLite.</li>
              <li>Dashboard inicial dentro del admin.</li>
              <li>Webhook de desinstalacion preparado.</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
