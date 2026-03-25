import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { NavLink, Outlet, useLoaderData } from "@remix-run/react";
import type { CSSProperties } from "react";

import { authenticate } from "../shopify.server";

const sections = [
  {
    label: "Overview",
    to: "/app?view=overview",
    accent: "#f59e0b"
  },
  {
    label: "Catalog",
    to: "/app?view=catalog",
    accent: "#0ea5e9"
  },
  {
    label: "Imports",
    to: "/app?view=imports",
    accent: "#22c55e"
  },
  {
    label: "Operations",
    to: "/app?view=operations",
    accent: "#f97316"
  }
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  return json({
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    shop: session.shop
  });
}

export default function AppLayout() {
  const { apiKey, shop } = useLoaderData<typeof loader>();

  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.shopifyApiKey = ${JSON.stringify(apiKey)};`
        }}
      />
      <div style={shellStyle}>
        <aside style={sidebarStyle}>
          <div
            style={{
              borderRadius: "1.3rem",
              padding: "1.2rem",
              background:
                "linear-gradient(145deg, rgba(245,158,11,0.2), rgba(15,23,42,0.96) 60%)"
            }}
          >
            <p style={{ margin: 0, color: "#fbbf24", fontWeight: 800, letterSpacing: "0.08em" }}>
              INVENTORY
            </p>
            <h1 style={{ marginBottom: "0.5rem", marginTop: "0.5rem", fontSize: "1.4rem" }}>
              Control Center
            </h1>
            <p style={{ margin: 0, color: "rgba(241,245,249,0.75)", lineHeight: 1.6 }}>
              Productos, inventario, importaciones y operaciones en un solo lugar.
            </p>
          </div>

          <nav style={{ marginTop: "1.25rem", display: "grid", gap: "0.65rem" }}>
            {sections.map((section) => (
              <NavLink
                key={section.label}
                to={section.to}
                prefetch="intent"
                style={({ isActive }) => ({
                  ...navLinkStyle,
                  background: isActive ? "rgba(255,255,255,0.12)" : "transparent",
                  borderColor: isActive ? section.accent : "rgba(148,163,184,0.15)",
                  color: isActive ? "#f8fafc" : "rgba(226,232,240,0.82)"
                })}
              >
                <span
                  style={{
                    width: "0.65rem",
                    height: "0.65rem",
                    borderRadius: "999px",
                    background: section.accent,
                    boxShadow: `0 0 0 4px ${section.accent}22`
                  }}
                />
                <span>{section.label}</span>
              </NavLink>
            ))}
          </nav>

          <div
            style={{
              marginTop: "auto",
              paddingTop: "1rem",
              borderTop: "1px solid rgba(148,163,184,0.18)"
            }}
          >
            <p style={{ margin: 0, color: "rgba(148,163,184,0.8)", fontSize: "0.85rem" }}>
              Store session
            </p>
            <strong style={{ display: "block", marginTop: "0.35rem", wordBreak: "break-word" }}>
              {shop}
            </strong>
          </div>
        </aside>

        <div style={contentStyle}>
          <header style={headerStyle}>
            <div>
              <p style={{ margin: 0, color: "#f59e0b", fontWeight: 800, letterSpacing: "0.08em" }}>
                SHOPIFY ADMIN APP
              </p>
              <h2 style={{ margin: "0.35rem 0 0", fontSize: "1.6rem" }}>Inventory Management</h2>
            </div>
            <div style={headerBadgeStyle}>
              <span style={{ color: "#475569" }}>Embedded admin</span>
              <strong style={{ color: "#0f172a" }}>Live</strong>
            </div>
          </header>

          <Outlet />
        </div>
      </div>
    </>
  );
}

const shellStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "280px minmax(0, 1fr)",
  background:
    "linear-gradient(180deg, #0f172a 0%, #111827 18%, #f8fafc 18%, #eef2ff 100%)"
};

const sidebarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1.25rem",
  color: "#f8fafc"
};

const navLinkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.8rem",
  border: "1px solid rgba(148,163,184,0.15)",
  borderRadius: "1rem",
  padding: "0.9rem 1rem",
  textDecoration: "none",
  fontWeight: 700,
  transition: "all 160ms ease"
};

const contentStyle: CSSProperties = {
  minWidth: 0,
  padding: "1.25rem 1.25rem 2rem"
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  marginBottom: "1rem",
  background: "rgba(255,255,255,0.78)",
  backdropFilter: "blur(16px)",
  border: "1px solid rgba(226,232,240,0.9)",
  borderRadius: "1.3rem",
  padding: "1rem 1.2rem",
  boxShadow: "0 20px 45px rgba(15, 23, 42, 0.08)"
};

const headerBadgeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  borderRadius: "999px",
  background: "#ffffff",
  padding: "0.5rem 0.85rem",
  border: "1px solid #e2e8f0"
};
