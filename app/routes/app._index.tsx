import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useLocation, useNavigation } from "@remix-run/react";
import type { CSSProperties } from "react";

import {
  buildInventoryCsv,
  createProduct,
  csvTemplate,
  deleteProducts,
  fetchAllProductIdsWithoutImages,
  fetchInventoryDashboard,
  importProductsFromCsv,
  updateProductRecord,
  updateVariantInventory
} from "../inventory.server";
import { authenticate } from "../shopify.server";

type ActionData = { ok: boolean; message: string; errors?: string[] };

const tabs = [
  { id: "overview", label: "Overview", tone: "#f59e0b" },
  { id: "catalog", label: "Catalog", tone: "#0ea5e9" },
  { id: "imports", label: "Imports", tone: "#22c55e" },
  { id: "operations", label: "Operations", tone: "#f97316" }
] as const;

const inputStyle: CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 0,
  padding: "0.55rem 0.65rem",
  fontSize: "12px",
  width: "100%"
};

const panelStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: 0,
  padding: "0.85rem",
  boxShadow: "none",
  border: "1px solid #d1d5db"
};

const darkButton: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 0,
  background: "#f9fafb",
  color: "#111827",
  padding: "0.5rem 0.7rem",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "12px"
};

const amberButton: CSSProperties = {
  ...darkButton,
  background: "#f3f4f6",
  color: "#111827"
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function productAdminUrl(shopDomain: string | undefined, productId: string) {
  return `https://${shopDomain}/admin/products/${productId.split("/").pop()}`;
}

function statusTone(status: string) {
  if (status === "ACTIVE") return { background: "#dcfce7", color: "#166534" };
  if (status === "DRAFT") return { background: "#fef3c7", color: "#92400e" };
  return { background: "#e2e8f0", color: "#334155" };
}

function parseStatus(value: FormDataEntryValue | null) {
  const upper = String(value ?? "ACTIVE").toUpperCase();
  return upper === "ARCHIVED" ? "ARCHIVED" : upper === "DRAFT" ? "DRAFT" : "ACTIVE";
}

function readProductInput(formData: FormData) {
  return {
    title: String(formData.get("title") ?? "").trim(),
    sku: String(formData.get("sku") ?? "").trim(),
    price: String(formData.get("price") ?? "0").trim(),
    quantity: Number(formData.get("quantity") ?? "0"),
    barcode: String(formData.get("barcode") ?? "").trim(),
    vendor: String(formData.get("vendor") ?? "").trim(),
    productType: String(formData.get("productType") ?? "").trim(),
    tags: String(formData.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    status: parseStatus(formData.get("status"))
  } as const;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const dashboard = await fetchInventoryDashboard(
    admin,
    url.searchParams.get("q") ?? "",
    url.searchParams.get("locationId")
  );

  return json({
    ...dashboard,
    query: url.searchParams.get("q") ?? "",
    view: url.searchParams.get("view") ?? "overview",
    csvTemplate: csvTemplate()
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const query = String(formData.get("query") ?? "");
  const locationId = String(formData.get("locationId") ?? "");

  try {
    if (intent === "export") {
      const dashboard = await fetchInventoryDashboard(admin, query, locationId);
      return new Response(buildInventoryCsv(dashboard.products), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="inventory-export-${Date.now()}.csv"`
        }
      });
    }

    if (intent === "delete-products") {
      const productIds = formData.getAll("productIds").map(String);
      const result = await deleteProducts(admin, productIds);
      return json<ActionData>({
        ok: true,
        message:
          result.skippedMissingCount > 0
            ? `${result.deletedCount} producto(s) eliminados. ${result.skippedMissingCount} ya no existian en Shopify.`
            : `${result.deletedCount} producto(s) eliminados correctamente.`
      });
    }

    if (intent === "delete-products-without-image") {
      const productIds = await fetchAllProductIdsWithoutImages(admin);

      const result = await deleteProducts(admin, productIds);

      return json<ActionData>({
        ok: true,
        message:
          productIds.length === 0
            ? "No habia productos sin imagen para eliminar."
            : result.skippedMissingCount > 0
              ? `${result.deletedCount} producto(s) sin imagen eliminados. ${result.skippedMissingCount} ya no existian en Shopify.`
              : `${result.deletedCount} producto(s) sin imagen eliminados correctamente.`
      });
    }

    if (intent === "update-inventory") {
      await updateVariantInventory(
        admin,
        locationId,
        String(formData.get("inventoryItemId") ?? ""),
        Number(formData.get("quantity") ?? "0")
      );
      return json<ActionData>({ ok: true, message: "Inventario actualizado correctamente." });
    }

    if (intent === "update-product") {
      await updateProductRecord(
        admin,
        locationId,
        String(formData.get("productId") ?? ""),
        String(formData.get("variantId") ?? ""),
        String(formData.get("inventoryItemId") ?? ""),
        readProductInput(formData)
      );
      return json<ActionData>({ ok: true, message: "Producto actualizado correctamente." });
    }

    if (intent === "create-product") {
      await createProduct(admin, locationId, readProductInput(formData));
      return json<ActionData>({ ok: true, message: "Producto creado correctamente." });
    }

    if (intent === "import-csv") {
      const uploaded = formData.get("csvFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) throw new Error("Selecciona un archivo CSV antes de importarlo.");
      const report = await importProductsFromCsv(admin, locationId, await uploaded.text());
      return json<ActionData>({
        ok: report.errors.length === 0,
        message: `Importacion completada. ${report.createdCount} creado(s), ${report.updatedCount} actualizado(s).`,
        errors: report.errors
      });
    }

    return json<ActionData>({ ok: false, message: "No se reconocio la accion solicitada." });
  } catch (error) {
    return json<ActionData>({ ok: false, message: error instanceof Error ? error.message : "Ocurrio un error inesperado." }, { status: 400 });
  }
}

export default function AppDashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const currentParams = new URLSearchParams(location.search);
  const activeView = tabs.some((tab) => tab.id === data.view) ? data.view : "overview";
  const isSubmitting = navigation.state === "submitting";

  return (
    <main style={{ color: "#0f172a" }}>
      <section
        style={{
          background: "#ffffff",
          color: "#111827",
          borderRadius: 0,
          padding: "0.85rem",
          boxShadow: "none",
          border: "1px solid #d1d5db"
        }}
      >
        <p style={{ margin: 0, color: "#6b7280", fontWeight: 700, letterSpacing: "0.04em", fontSize: "11px" }}>INVENTORY MANAGEMENT</p>
        <div style={{ marginTop: "0.45rem", display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "18px", lineHeight: 1.2 }}>Catalogo e inventario</h1>
            <p style={{ marginBottom: 0, color: "#6b7280", maxWidth: "48rem", fontSize: "12px" }}>
              Vista compacta para trabajar rapido con productos, stock e importaciones.
            </p>
          </div>
          <div style={{ minWidth: "16rem", background: "#f9fafb", borderRadius: 0, padding: "0.55rem", border: "1px solid #d1d5db" }}>
            <p style={{ margin: 0, fontSize: "11px", color: "#6b7280" }}>Tienda conectada</p>
            <strong style={{ display: "block", marginTop: "0.2rem", fontSize: "12px" }}>{data.shop?.name ?? "Tienda Shopify"}</strong>
            <span style={{ color: "#6b7280", fontSize: "11px" }}>{data.shop?.myshopifyDomain ?? "Dominio no disponible"}</span>
          </div>
        </div>
      </section>

      {actionData ? <Banner ok={actionData.ok} message={actionData.message} errors={actionData.errors} /> : null}
      {data.loadWarning ? (
        <section style={{ marginTop: "1rem", background: "#fef3c7", color: "#92400e", borderRadius: "1rem", padding: "1rem 1.2rem" }}>
          <strong>{data.loadWarning}</strong>
        </section>
      ) : null}

      <section className="dashboard-tabs" style={{ marginTop: "0.75rem" }}>
        {tabs.map((tab) => {
          const params = new URLSearchParams(currentParams);
          params.set("view", tab.id);
          if (data.selectedLocationId) params.set("locationId", data.selectedLocationId); else params.delete("locationId");
          if (data.query) params.set("q", data.query); else params.delete("q");
          const active = activeView === tab.id;
          return (
            <Link
              key={tab.id}
              to={`/app?${params.toString()}`}
              prefetch="intent"
              style={{
                display: "inline-flex", alignItems: "center", gap: "0.45rem", padding: "0.45rem 0.65rem",
                borderRadius: 0, textDecoration: "none", fontWeight: 600, fontSize: "12px",
                border: `1px solid ${active ? tab.tone : "#cbd5e1"}`,
                color: active ? "#0f172a" : "#475569", background: active ? "#f3f4f6" : "#ffffff"
              }}
            >
              <span style={{ width: "0.65rem", height: "0.65rem", borderRadius: "999px", background: tab.tone }} />
              {tab.label}
            </Link>
          );
        })}
      </section>

      {activeView === "overview" ? (
        <section className="metrics-grid" style={{ marginTop: "0.75rem" }}>
          {[
            { label: "Productos", value: data.summary.productCount },
            { label: "Variantes", value: data.summary.variantCount },
            { label: "Unidades disponibles", value: data.summary.inventoryUnits },
            { label: "Ubicaciones detectadas", value: data.locations.length }
          ].map((card) => (
            <article key={card.label} style={panelStyle}>
              <p style={{ marginTop: 0, color: "#6b7280", fontSize: "11px", marginBottom: "0.25rem" }}>{card.label}</p>
              <strong style={{ fontSize: "18px" }}>{card.value}</strong>
            </article>
          ))}
        </section>
      ) : null}

      {(activeView === "overview" || activeView === "catalog") ? (
        <section className="split-grid" style={{ marginTop: "1rem" }}>
          <article style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ marginBottom: "0.3rem", marginTop: 0 }}>Buscador y exportacion</h2>
                <p style={{ margin: 0, color: "#64748b" }}>Filtra por titulo, SKU, vendor o cualquier termino soportado por Shopify.</p>
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="export" />
                <input type="hidden" name="query" value={data.query} />
                <input type="hidden" name="locationId" value={data.selectedLocationId} />
                <button type="submit" style={darkButton}>Exportar CSV</button>
              </Form>
            </div>
            <Form method="get" style={{ marginTop: "1rem", display: "grid", gap: "0.8rem" }}>
              <input type="hidden" name="view" value={activeView} />
              <div className="split-grid" style={{ gridTemplateColumns: "2fr 1fr auto", gap: "0.8rem" }}>
                <input type="text" name="q" defaultValue={data.query} placeholder="Ej. perfume, SKU-001, vendor:Grace" style={inputStyle} />
                <select name="locationId" defaultValue={data.selectedLocationId} style={inputStyle}>
                  {data.locations.length === 0 ? <option value="">Sin ubicacion</option> : null}
                  {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
                <button type="submit" style={amberButton}>Buscar</button>
              </div>
            </Form>
          </article>
          <article style={{ ...panelStyle, background: "#fff7ed" }}>
            <h2 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Plantilla CSV</h2>
            <p style={{ color: "#9a3412", marginTop: 0 }}>Usa estas columnas para crear o actualizar productos por SKU.</p>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: "0.82rem", color: "#7c2d12", background: "rgba(255,255,255,0.75)", padding: "0.8rem", borderRadius: "0.9rem" }}>{data.csvTemplate}</pre>
          </article>
        </section>
      ) : null}

      {(activeView === "overview" || activeView === "imports") ? (
        <section className="dual-grid" style={{ marginTop: "1rem" }}>
          <CreatePanel selectedLocationId={data.selectedLocationId} isSubmitting={isSubmitting} />
          <ImportPanel selectedLocationId={data.selectedLocationId} isSubmitting={isSubmitting} />
        </section>
      ) : null}

      {(activeView === "overview" || activeView === "operations" || activeView === "catalog") ? (
        <CatalogPanel
          shopDomain={data.shop?.myshopifyDomain}
          currencyCode={data.shop?.currencyCode ?? "USD"}
          selectedLocationId={data.selectedLocationId}
          products={data.products}
          isSubmitting={isSubmitting}
        />
      ) : null}
    </main>
  );
}

function Banner({ ok, message, errors }: ActionData) {
  return (
    <section style={{ marginTop: "0.75rem", background: ok ? "#f0fdf4" : "#fef2f2", color: ok ? "#166534" : "#991b1b", border: "1px solid #d1d5db", borderRadius: 0, padding: "0.65rem 0.8rem", fontSize: "12px" }}>
      <strong>{message}</strong>
      {errors?.length ? <ul style={{ marginBottom: 0, marginTop: "0.75rem", paddingLeft: "1.25rem" }}>{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
    </section>
  );
}

function CreatePanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  return (
    <article style={panelStyle}>
      <h2 className="excel-title">Crear producto</h2>
      <Form method="post" style={{ display: "grid", gap: "0.8rem" }}>
        <input type="hidden" name="intent" value="create-product" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <div className="catalog-edit-grid">
          <input name="title" placeholder="Titulo" required style={inputStyle} />
          <input name="sku" placeholder="SKU" required style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="price" type="number" step="0.01" min="0" placeholder="Precio" style={inputStyle} />
          <input name="quantity" type="number" step="1" placeholder="Cantidad" defaultValue={0} style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="vendor" placeholder="Vendor" style={inputStyle} />
          <input name="productType" placeholder="Tipo de producto" style={inputStyle} />
        </div>
        <input name="barcode" placeholder="Barcode" style={inputStyle} />
        <input name="tags" placeholder="Tags separadas por coma" style={inputStyle} />
        <select name="status" defaultValue="ACTIVE" style={inputStyle}>
          <option value="ACTIVE">Activo</option>
          <option value="DRAFT">Borrador</option>
          <option value="ARCHIVED">Archivado</option>
        </select>
        <button type="submit" disabled={isSubmitting} style={darkButton}>{isSubmitting ? "Guardando..." : "Crear producto"}</button>
      </Form>
    </article>
  );
}

function ImportPanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  return (
    <article style={panelStyle}>
      <h2 className="excel-title">Importar CSV</h2>
      <p className="excel-subtle">Si el SKU ya existe, la app actualiza el producto y la cantidad. Si no existe, lo crea.</p>
      <Form method="post" encType="multipart/form-data" style={{ display: "grid", gap: "0.8rem" }}>
        <input type="hidden" name="intent" value="import-csv" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <input type="file" name="csvFile" accept=".csv,text/csv" style={{ border: "1px dashed #cbd5e1", borderRadius: "0.9rem", padding: "1rem", background: "#f8fafc" }} />
        <button type="submit" disabled={isSubmitting} style={amberButton}>{isSubmitting ? "Importando..." : "Importar inventario"}</button>
      </Form>
    </article>
  );
}

function CatalogPanel({
  shopDomain,
  currencyCode,
  selectedLocationId,
  products,
  isSubmitting
}: {
  shopDomain?: string;
  currencyCode: string;
  selectedLocationId: string;
  products: Awaited<ReturnType<typeof fetchInventoryDashboard>>["products"];
  isSubmitting: boolean;
}) {
  return (
    <section style={{ ...panelStyle, marginTop: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h2 className="excel-title" style={{ marginBottom: 0 }}>Catalogo e inventario</h2>
          <p className="excel-subtle" style={{ marginBottom: 0 }}>Acciones por producto: abrir, editar rapido, ajustar cantidad y borrar.</p>
        </div>
        <Form method="post" onSubmit={(event) => {
          if (!window.confirm("Se eliminaran todos los productos de la tienda que no tengan imagen. Deseas continuar?")) {
            event.preventDefault();
          }
        }}>
          <input type="hidden" name="intent" value="delete-products-without-image" />
          <button type="submit" disabled={isSubmitting} className="danger-button">
            Borrar todos sin imagen
          </button>
        </Form>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="delete-products" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <div className="catalog-table-wrap">
          <table className="catalog-table">
            <thead>
              <tr style={{ background: "#f8fafc", color: "#475569", textAlign: "left" }}>
                <th style={tableHeaderStyle}>Eliminar</th>
                <th style={tableHeaderStyle}>Producto</th>
                <th style={tableHeaderStyle}>Estado</th>
                <th style={tableHeaderStyle}>SKU / Variante</th>
                <th style={tableHeaderStyle}>Precio</th>
                <th style={tableHeaderStyle}>Inventario</th>
                <th style={tableHeaderStyle}>Acciones</th>
                <th style={tableHeaderStyle}>Ultima actualizacion</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: "1.5rem", color: "#64748b" }}>No hay productos para este filtro.</td></tr>
              ) : products.map((product) => {
                const variant = product.variants[0];
                const level = variant?.inventoryLevels.find((item) => item.locationId === selectedLocationId);
                const tone = statusTone(product.status);
                return (
                  <tr key={product.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                    <td style={tableCellStyle}><input type="checkbox" name="productIds" value={product.id} /></td>
                    <td style={tableCellStyle}>
                      <strong style={{ display: "block" }}>{product.title}</strong>
                      <span style={{ color: "#64748b", fontSize: "0.9rem" }}>{product.vendor || "Sin vendor"} · {product.productType || "Sin tipo"}</span>
                    </td>
                    <td style={tableCellStyle}><span style={{ display: "inline-flex", padding: "0.3rem 0.7rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 700, ...tone }}>{product.status}</span></td>
                    <td style={tableCellStyle}><strong>{variant?.sku || "Sin SKU"}</strong><div style={{ color: "#64748b", fontSize: "0.9rem" }}>{variant?.title ?? "Sin variante"}</div></td>
                    <td style={tableCellStyle}>{variant?.price ?? "0.00"} {currencyCode}</td>
                    <td style={tableCellStyle}>
                      {variant ? (
                        <Form method="post" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                          <input type="hidden" name="intent" value="update-inventory" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
                          <input type="number" name="quantity" defaultValue={level?.available ?? variant.inventoryQuantity} style={{ ...inputStyle, maxWidth: "110px" }} />
                          <button type="submit" style={{ ...amberButton, padding: "0.7rem 0.9rem" }}>Guardar</button>
                        </Form>
                      ) : <span style={{ color: "#64748b" }}>Sin variante</span>}
                    </td>
                    <td style={tableCellStyle}>
                      <div className="catalog-actions">
                        <a href={productAdminUrl(shopDomain, product.id)} target="_top" rel="noreferrer" className="shopify-admin-button">Abrir</a>
                        {variant ? (
                          <details>
                            <summary className="ghost-button">Editar</summary>
                            <div className="catalog-edit-panel">
                              <Form method="post" style={{ display: "grid", gap: "0.7rem" }}>
                                <input type="hidden" name="intent" value="update-product" />
                                <input type="hidden" name="locationId" value={selectedLocationId} />
                                <input type="hidden" name="productId" value={product.id} />
                                <input type="hidden" name="variantId" value={variant.id} />
                                <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
                                <div className="catalog-edit-grid">
                                  <input name="title" defaultValue={product.title} style={inputStyle} />
                                  <input name="sku" defaultValue={variant.sku} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="price" defaultValue={variant.price} style={inputStyle} />
                                  <input name="quantity" type="number" defaultValue={level?.available ?? variant.inventoryQuantity} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="vendor" defaultValue={product.vendor} style={inputStyle} />
                                  <input name="productType" defaultValue={product.productType} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="barcode" defaultValue={variant.barcode} style={inputStyle} />
                                  <input name="tags" defaultValue={product.tags.join(", ")} style={inputStyle} />
                                </div>
                                <select name="status" defaultValue={product.status} style={inputStyle}>
                                  <option value="ACTIVE">Activo</option>
                                  <option value="DRAFT">Borrador</option>
                                  <option value="ARCHIVED">Archivado</option>
                                </select>
                                <button type="submit" className="shopify-admin-button">Guardar cambios</button>
                              </Form>
                            </div>
                          </details>
                        ) : null}
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete-products" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="productIds" value={product.id} />
                          <button type="submit" className="danger-button">Borrar</button>
                        </Form>
                      </div>
                    </td>
                    <td style={tableCellStyle}>{formatDate(product.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" disabled={isSubmitting || products.length === 0} className="danger-button">Eliminar seleccionados</button>
        </div>
      </Form>
    </section>
  );
}

const tableHeaderStyle: CSSProperties = {
  padding: "0.9rem 0.75rem",
  fontSize: "0.85rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em"
};

const tableCellStyle: CSSProperties = {
  padding: "1rem 0.75rem",
  verticalAlign: "top"
};
