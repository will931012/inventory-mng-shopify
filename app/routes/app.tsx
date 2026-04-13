import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { NavLink, Outlet, useLoaderData, useLocation, useRouteError } from "@remix-run/react";
import type { CSSProperties } from "react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";

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
  const location = useLocation();
  const currentParams = new URLSearchParams(location.search);

  return (
    <AppProvider apiKey={apiKey} isEmbeddedApp>
      <div className="app-shell" style={shellStyle}>
        <aside className="app-sidebar" style={sidebarStyle}>
          <div
            style={{
              padding: "0.75rem",
              background: "#ffffff",
              border: "1px solid #d1d5db"
            }}
          >
            <p style={{ margin: 0, color: "#6b7280", fontWeight: 700, fontSize: "11px", letterSpacing: "0.04em" }}>INVENTORY</p>
            <h1 style={{ marginBottom: "0.25rem", marginTop: "0.35rem", fontSize: "14px" }}>Control Center</h1>
            <p style={{ margin: 0, color: "#6b7280", lineHeight: 1.4, fontSize: "12px" }}>Vista compacta para catalogo e inventario.</p>
          </div>

          <nav style={{ marginTop: "0.75rem", display: "grid", gap: "0.35rem" }}>
            {sections.map((section) => (
              (() => {
                const params = new URLSearchParams(currentParams);
                params.set("view", section.label.toLowerCase());
                const to = `/app?${params.toString()}`;

                return (
              <NavLink
                key={section.label}
                to={to}
                prefetch="intent"
                style={({ isActive }) => ({
                  ...navLinkStyle,
                  background: isActive ? "#f3f4f6" : "#ffffff",
                  borderColor: isActive ? section.accent : "#d1d5db",
                  color: "#111827"
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
                );
              })()
            ))}
          </nav>

          <div
            style={{
              marginTop: "auto",
              paddingTop: "0.75rem",
              borderTop: "1px solid #d1d5db"
            }}
          >
            <p style={{ margin: 0, color: "#6b7280", fontSize: "11px" }}>
              Store session
            </p>
            <strong style={{ display: "block", marginTop: "0.25rem", wordBreak: "break-word", fontSize: "12px" }}>
              {shop}
            </strong>
            <a
              href={`https://${shop}/admin/apps`}
              target="_top"
              style={{
                display: "block",
                marginTop: "0.6rem",
                padding: "0.45rem 0.6rem",
                fontSize: "11px",
                fontWeight: 600,
                color: "#b91c1c",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "6px",
                textDecoration: "none",
                textAlign: "center",
                cursor: "pointer"
              }}
            >
              Exit / Uninstall app
            </a>
          </div>
        </aside>

        <div className="app-content" style={contentStyle}>
          <header style={headerStyle}>
            <div>
              <p style={{ margin: 0, color: "#6b7280", fontWeight: 700, letterSpacing: "0.04em", fontSize: "11px" }}>
                SHOPIFY ADMIN APP
              </p>
              <h2 style={{ margin: "0.2rem 0 0", fontSize: "16px" }}>Inventory Management</h2>
            </div>
            <div style={headerBadgeStyle}>
              <span style={{ color: "#475569", fontSize: "11px" }}>Embedded admin</span>
              <strong style={{ color: "#0f172a", fontSize: "11px" }}>Live</strong>
            </div>
          </header>

          <Outlet />
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = boundary.headers;

const shellStyle: CSSProperties = {
  minHeight: "100vh"
};

const sidebarStyle: CSSProperties = {
  display: "flex"
};

const navLinkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.55rem",
  border: "1px solid #d1d5db",
  borderRadius: 0,
  padding: "0.6rem 0.7rem",
  textDecoration: "none",
  fontWeight: 600,
  fontSize: "12px",
  transition: "all 160ms ease"
};

const contentStyle: CSSProperties = {
  minWidth: 0
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  marginBottom: "0.75rem",
  background: "#ffffff",
  border: "1px solid #d1d5db",
  borderRadius: 0,
  padding: "0.7rem 0.9rem",
  boxShadow: "none"
};

const headerBadgeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  borderRadius: 0,
  background: "#f9fafb",
  padding: "0.35rem 0.55rem",
  border: "1px solid #d1d5db"
};
