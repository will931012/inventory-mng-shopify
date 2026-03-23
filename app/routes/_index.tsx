import { Link } from "@remix-run/react";

export default function Index() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        background:
          "radial-gradient(circle at top left, rgba(251,191,36,0.22), transparent 35%), linear-gradient(180deg, #f8fafc, #e2e8f0)"
      }}
    >
      <section
        style={{
          maxWidth: "52rem",
          background: "#ffffff",
          borderRadius: "1.5rem",
          padding: "2.5rem",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.12)"
        }}
      >
        <p style={{ margin: 0, color: "#b45309", fontWeight: 700, letterSpacing: "0.08em" }}>
          SHOPIFY APP
        </p>
        <h1 style={{ fontSize: "3rem", marginBottom: "1rem", lineHeight: 1.05 }}>
          Inventory Shopify Manager
        </h1>
        <p style={{ color: "#475569", fontSize: "1.1rem", lineHeight: 1.7 }}>
          Base inicial de una app embebida para gestionar productos e inventario de tu tienda desde Shopify.
        </p>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "1.5rem" }}>
          <a
            href="/app"
            style={{
              background: "#111827",
              color: "#ffffff",
              padding: "0.9rem 1.2rem",
              borderRadius: "0.85rem",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            Abrir dashboard
          </a>
          <Link
            to="/auth/login"
            prefetch="intent"
            style={{
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              padding: "0.9rem 1.2rem",
              borderRadius: "0.85rem",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            Instalar en una tienda
          </Link>
        </div>
      </section>
    </main>
  );
}
