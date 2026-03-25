import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { CSSProperties } from "react";

import {
  buildInventoryCsv,
  createProduct,
  csvTemplate,
  deleteProducts,
  fetchInventoryDashboard,
  importProductsFromCsv,
  updateVariantInventory
} from "../inventory.server";
import { authenticate } from "../shopify.server";

type ActionData =
  | {
      ok: true;
      message: string;
      errors?: string[];
    }
  | {
      ok: false;
      message: string;
      errors?: string[];
    };

function getStatusTone(status: string) {
  switch (status) {
    case "ACTIVE":
      return { background: "#dcfce7", color: "#166534" };
    case "DRAFT":
      return { background: "#fef3c7", color: "#92400e" };
    case "ARCHIVED":
      return { background: "#e2e8f0", color: "#334155" };
    default:
      return { background: "#e2e8f0", color: "#334155" };
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const locationId = url.searchParams.get("locationId");
  const dashboard = await fetchInventoryDashboard(admin, query, locationId);

  return json({
    ...dashboard,
    query,
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
    switch (intent) {
      case "export": {
        const dashboard = await fetchInventoryDashboard(admin, query, locationId);
        const csv = buildInventoryCsv(dashboard.products);

        return new Response(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="inventory-export-${Date.now()}.csv"`
          }
        });
      }

      case "delete-products": {
        const productIds = formData.getAll("productIds").map((value) => String(value));
        await deleteProducts(admin, productIds);

        return json<ActionData>({
          ok: true,
          message: `${productIds.length} producto(s) eliminados correctamente.`
        });
      }

      case "update-inventory": {
        const inventoryItemId = String(formData.get("inventoryItemId") ?? "");
        const quantity = Number(formData.get("quantity") ?? "0");
        await updateVariantInventory(admin, locationId, inventoryItemId, quantity);

        return json<ActionData>({
          ok: true,
          message: "Inventario actualizado correctamente."
        });
      }

      case "create-product": {
        await createProduct(admin, locationId, {
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
          status:
            String(formData.get("status") ?? "ACTIVE").toUpperCase() === "ARCHIVED"
              ? "ARCHIVED"
              : String(formData.get("status") ?? "ACTIVE").toUpperCase() === "DRAFT"
                ? "DRAFT"
                : "ACTIVE"
        });

        return json<ActionData>({
          ok: true,
          message: "Producto creado correctamente."
        });
      }

      case "import-csv": {
        const uploaded = formData.get("csvFile");
        if (!(uploaded instanceof File) || uploaded.size === 0) {
          throw new Error("Selecciona un archivo CSV antes de importarlo.");
        }

        const report = await importProductsFromCsv(admin, locationId, await uploaded.text());
        const baseMessage = `Importacion completada. ${report.createdCount} creado(s), ${report.updatedCount} actualizado(s).`;

        return json<ActionData>({
          ok: report.errors.length === 0,
          message:
            report.errors.length > 0
              ? `${baseMessage} Algunas filas necesitaron revision.`
              : baseMessage,
          errors: report.errors
        });
      }

      default:
        return json<ActionData>({
          ok: false,
          message: "No se reconocio la accion solicitada."
        });
    }
  } catch (error) {
    return json<ActionData>(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Ocurrio un error inesperado."
      },
      { status: 400 }
    );
  }
}

export default function AppDashboard() {
  const { shop, locations, selectedLocationId, products, summary, query, csvTemplate, loadWarning } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top left, rgba(251,191,36,0.22), transparent 25%), linear-gradient(180deg, #fff7ed, #f8fafc 42%, #e2e8f0)",
        padding: "2rem",
        color: "#0f172a"
      }}
    >
      <div style={{ maxWidth: "88rem", margin: "0 auto" }}>
        <section
          style={{
            background: "rgba(15, 23, 42, 0.92)",
            color: "#f8fafc",
            borderRadius: "1.5rem",
            padding: "1.75rem",
            boxShadow: "0 24px 60px rgba(15, 23, 42, 0.22)"
          }}
        >
          <p style={{ margin: 0, color: "#f59e0b", fontWeight: 700, letterSpacing: "0.08em" }}>
            INVENTORY MANAGEMENT
          </p>
          <div
            style={{
              marginTop: "0.75rem",
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              flexWrap: "wrap"
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: "2.4rem", lineHeight: 1.05 }}>
                Control total de catalogo e inventario
              </h1>
              <p style={{ marginBottom: 0, color: "rgba(248,250,252,0.78)", maxWidth: "48rem" }}>
                Crea productos, importa lotes por CSV, exporta tu inventario y elimina catalogo
                directamente desde Shopify.
              </p>
            </div>
            <div
              style={{
                minWidth: "18rem",
                background: "rgba(255,255,255,0.08)",
                borderRadius: "1rem",
                padding: "1rem"
              }}
            >
              <p style={{ margin: 0, fontSize: "0.85rem", color: "rgba(248,250,252,0.6)" }}>
                Tienda conectada
              </p>
              <strong style={{ display: "block", marginTop: "0.3rem", fontSize: "1.05rem" }}>
                {shop?.name ?? "Tienda Shopify"}
              </strong>
              <span style={{ color: "rgba(248,250,252,0.75)" }}>
                {shop?.myshopifyDomain ?? "Dominio no disponible"}
              </span>
            </div>
          </div>
        </section>

        {actionData ? (
          <section
            style={{
              marginTop: "1rem",
              background: actionData.ok ? "#dcfce7" : "#fee2e2",
              color: actionData.ok ? "#166534" : "#991b1b",
              borderRadius: "1rem",
              padding: "1rem 1.2rem"
            }}
          >
            <strong>{actionData.message}</strong>
            {actionData.errors?.length ? (
              <ul style={{ marginBottom: 0, marginTop: "0.75rem", paddingLeft: "1.25rem" }}>
                {actionData.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {loadWarning ? (
          <section
            style={{
              marginTop: "1rem",
              background: "#fef3c7",
              color: "#92400e",
              borderRadius: "1rem",
              padding: "1rem 1.2rem"
            }}
          >
            <strong>{loadWarning}</strong>
            <div style={{ marginTop: "0.4rem" }}>
              Reautoriza la app si aun no aceptaste `read_locations`, o seguimos funcionando en modo
              compatible mientras tanto.
            </div>
          </section>
        ) : null}

        <section
          style={{
            marginTop: "1rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "1rem"
          }}
        >
          {[
            { label: "Productos", value: summary.productCount },
            { label: "Variantes", value: summary.variantCount },
            { label: "Unidades disponibles", value: summary.inventoryUnits },
            { label: "Ubicaciones detectadas", value: locations.length }
          ].map((card) => (
            <article
              key={card.label}
              style={{
                background: "#ffffff",
                borderRadius: "1.2rem",
                padding: "1.25rem",
                boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)"
              }}
            >
              <p style={{ marginTop: 0, color: "#64748b", fontSize: "0.95rem" }}>{card.label}</p>
              <strong style={{ fontSize: "2rem" }}>{card.value}</strong>
            </article>
          ))}
        </section>

        <section
          style={{
            marginTop: "1rem",
            display: "grid",
            gridTemplateColumns: "2fr 1fr",
            gap: "1rem"
          }}
        >
          <article
            style={{
              background: "#ffffff",
              borderRadius: "1.25rem",
              padding: "1.5rem",
              boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)"
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "1rem",
                flexWrap: "wrap"
              }}
            >
              <div>
                <h2 style={{ marginBottom: "0.3rem", marginTop: 0 }}>Buscador y exportacion</h2>
                <p style={{ margin: 0, color: "#64748b" }}>
                  Filtra por titulo, SKU, vendor o cualquier termino soportado por Shopify.
                </p>
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="export" />
                <input type="hidden" name="query" value={query} />
                <input type="hidden" name="locationId" value={selectedLocationId} />
                <button
                  type="submit"
                  style={{
                    border: 0,
                    borderRadius: "0.9rem",
                    background: "#0f172a",
                    color: "#ffffff",
                    padding: "0.85rem 1rem",
                    fontWeight: 700,
                    cursor: "pointer"
                  }}
                >
                  Exportar CSV
                </button>
              </Form>
            </div>

            <Form method="get" style={{ marginTop: "1rem", display: "grid", gap: "0.8rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: "0.8rem" }}>
                <input
                  type="text"
                  name="q"
                  defaultValue={query}
                  placeholder="Ej. perfume, SKU-001, vendor:Grace"
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: "0.85rem",
                    padding: "0.85rem 1rem",
                    fontSize: "1rem"
                  }}
                />
                <select
                  name="locationId"
                  defaultValue={selectedLocationId}
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: "0.85rem",
                    padding: "0.85rem 1rem",
                    fontSize: "1rem"
                  }}
                >
                  {locations.length === 0 ? (
                    <option value="">Sin ubicacion</option>
                  ) : null}
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  style={{
                    border: 0,
                    borderRadius: "0.85rem",
                    background: "#f59e0b",
                    color: "#111827",
                    padding: "0.85rem 1rem",
                    fontWeight: 700,
                    cursor: "pointer"
                  }}
                >
                  Buscar
                </button>
              </div>
            </Form>
          </article>

          <article
            style={{
              background: "#fff7ed",
              borderRadius: "1.25rem",
              padding: "1.5rem",
              boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)"
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Plantilla CSV</h2>
            <p style={{ color: "#9a3412", marginTop: 0 }}>
              Usa estas columnas para crear o actualizar productos por SKU.
            </p>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                margin: 0,
                fontSize: "0.82rem",
                color: "#7c2d12",
                background: "rgba(255,255,255,0.75)",
                padding: "0.8rem",
                borderRadius: "0.9rem"
              }}
            >
              {csvTemplate}
            </pre>
          </article>
        </section>

        <section
          style={{
            marginTop: "1rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "1rem"
          }}
        >
          <article
            style={{
              background: "#ffffff",
              borderRadius: "1.25rem",
              padding: "1.5rem",
              boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)"
            }}
          >
            <h2 style={{ marginTop: 0 }}>Crear producto</h2>
            <Form method="post" style={{ display: "grid", gap: "0.8rem" }}>
              <input type="hidden" name="intent" value="create-product" />
              <input type="hidden" name="locationId" value={selectedLocationId} />
              <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "0.8rem" }}>
                <input name="title" placeholder="Titulo" required style={inputStyle} />
                <input name="sku" placeholder="SKU" required style={inputStyle} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.8rem" }}>
                <input name="price" type="number" step="0.01" min="0" placeholder="Precio" style={inputStyle} />
                <input
                  name="quantity"
                  type="number"
                  step="1"
                  placeholder="Cantidad"
                  defaultValue={0}
                  style={inputStyle}
                />
                <select name="status" defaultValue="ACTIVE" style={inputStyle}>
                  <option value="ACTIVE">Activo</option>
                  <option value="DRAFT">Borrador</option>
                  <option value="ARCHIVED">Archivado</option>
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
                <input name="vendor" placeholder="Vendor" style={inputStyle} />
                <input name="productType" placeholder="Tipo de producto" style={inputStyle} />
              </div>
              <input name="barcode" placeholder="Barcode" style={inputStyle} />
              <input name="tags" placeholder="Tags separadas por coma" style={inputStyle} />
              <button type="submit" disabled={isSubmitting} style={primaryButtonStyle}>
                {isSubmitting ? "Guardando..." : "Crear producto"}
              </button>
            </Form>
          </article>

          <article
            style={{
              background: "#ffffff",
              borderRadius: "1.25rem",
              padding: "1.5rem",
              boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)"
            }}
          >
            <h2 style={{ marginTop: 0 }}>Importar CSV</h2>
            <p style={{ color: "#64748b" }}>
              Si el SKU ya existe, la app actualiza el producto y la cantidad. Si no existe, lo crea.
            </p>
            <Form method="post" encType="multipart/form-data" style={{ display: "grid", gap: "0.8rem" }}>
              <input type="hidden" name="intent" value="import-csv" />
              <input type="hidden" name="locationId" value={selectedLocationId} />
              <input
                type="file"
                name="csvFile"
                accept=".csv,text/csv"
                style={{
                  border: "1px dashed #cbd5e1",
                  borderRadius: "0.9rem",
                  padding: "1rem",
                  background: "#f8fafc"
                }}
              />
              <button type="submit" disabled={isSubmitting} style={secondaryButtonStyle}>
                {isSubmitting ? "Importando..." : "Importar inventario"}
              </button>
            </Form>
          </article>
        </section>

        <section
          style={{
            marginTop: "1rem",
            background: "#ffffff",
            borderRadius: "1.25rem",
            padding: "1.5rem",
            boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)"
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "1rem",
              flexWrap: "wrap"
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Catalogo e inventario</h2>
              <p style={{ marginBottom: 0, color: "#64748b" }}>
                Edita cantidades por variante y borra productos completos del catalogo.
              </p>
            </div>
          </div>

          <Form method="post">
            <input type="hidden" name="intent" value="delete-products" />
            <input type="hidden" name="locationId" value={selectedLocationId} />
            <div style={{ overflowX: "auto", marginTop: "1rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "980px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", color: "#475569", textAlign: "left" }}>
                    <th style={tableHeaderStyle}>Eliminar</th>
                    <th style={tableHeaderStyle}>Producto</th>
                    <th style={tableHeaderStyle}>Estado</th>
                    <th style={tableHeaderStyle}>SKU / Variante</th>
                    <th style={tableHeaderStyle}>Precio</th>
                    <th style={tableHeaderStyle}>Inventario</th>
                    <th style={tableHeaderStyle}>Ultima actualizacion</th>
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "1.5rem", color: "#64748b" }}>
                        No hay productos para este filtro.
                      </td>
                    </tr>
                  ) : (
                    products.map((product) => {
                      const primaryVariant = product.variants[0];
                      const locationLevel = primaryVariant?.inventoryLevels.find(
                        (level) => level.locationId === selectedLocationId
                      );
                      const statusTone = getStatusTone(product.status);

                      return (
                        <tr key={product.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                          <td style={tableCellStyle}>
                            <input type="checkbox" name="productIds" value={product.id} />
                          </td>
                          <td style={tableCellStyle}>
                            <div style={{ display: "flex", gap: "0.9rem", alignItems: "center" }}>
                              {product.imageUrl ? (
                                <img
                                  src={product.imageUrl}
                                  alt={product.imageAlt ?? product.title}
                                  style={{
                                    width: "56px",
                                    height: "56px",
                                    objectFit: "cover",
                                    borderRadius: "0.85rem"
                                  }}
                                />
                              ) : (
                                <div
                                  style={{
                                    width: "56px",
                                    height: "56px",
                                    borderRadius: "0.85rem",
                                    display: "grid",
                                    placeItems: "center",
                                    background: "#f8fafc",
                                    color: "#94a3b8",
                                    fontWeight: 700
                                  }}
                                >
                                  {product.title.slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div>
                                <strong style={{ display: "block" }}>{product.title}</strong>
                                <span style={{ color: "#64748b", fontSize: "0.9rem" }}>
                                  {product.vendor || "Sin vendor"} · {product.productType || "Sin tipo"}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td style={tableCellStyle}>
                            <span
                              style={{
                                display: "inline-flex",
                                padding: "0.3rem 0.7rem",
                                borderRadius: "999px",
                                fontSize: "0.85rem",
                                fontWeight: 700,
                                ...statusTone
                              }}
                            >
                              {product.status}
                            </span>
                          </td>
                          <td style={tableCellStyle}>
                            {product.variants.map((variant) => (
                              <div key={variant.id} style={{ marginBottom: "0.4rem" }}>
                                <strong>{variant.sku || "Sin SKU"}</strong>
                                <div style={{ color: "#64748b", fontSize: "0.9rem" }}>{variant.title}</div>
                              </div>
                            ))}
                          </td>
                          <td style={tableCellStyle}>
                            {product.variants.map((variant) => (
                              <div key={variant.id} style={{ marginBottom: "0.4rem" }}>
                                {variant.price} {shop?.currencyCode ?? "USD"}
                              </div>
                            ))}
                          </td>
                          <td style={tableCellStyle}>
                            {primaryVariant ? (
                              <Form method="post" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                                <input type="hidden" name="intent" value="update-inventory" />
                                <input type="hidden" name="locationId" value={selectedLocationId} />
                                <input
                                  type="hidden"
                                  name="inventoryItemId"
                                  value={primaryVariant.inventoryItemId}
                                />
                                <input
                                  type="number"
                                  name="quantity"
                                  defaultValue={locationLevel?.available ?? primaryVariant.inventoryQuantity}
                                  style={{ ...inputStyle, maxWidth: "110px" }}
                                />
                                <button type="submit" style={miniButtonStyle}>
                                  Guardar
                                </button>
                              </Form>
                            ) : (
                              <span style={{ color: "#64748b" }}>Sin variante</span>
                            )}
                          </td>
                          <td style={tableCellStyle}>{formatDate(product.updatedAt)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="submit"
                disabled={isSubmitting || products.length === 0}
                style={{
                  border: 0,
                  borderRadius: "0.9rem",
                  background: "#991b1b",
                  color: "#ffffff",
                  padding: "0.85rem 1rem",
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Eliminar seleccionados
              </button>
            </div>
          </Form>
        </section>
      </div>
    </main>
  );
}

const inputStyle: CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: "0.85rem",
  padding: "0.85rem 1rem",
  fontSize: "1rem",
  width: "100%"
};

const primaryButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: "0.9rem",
  background: "#0f172a",
  color: "#ffffff",
  padding: "0.85rem 1rem",
  fontWeight: 700,
  cursor: "pointer"
};

const secondaryButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: "0.9rem",
  background: "#f59e0b",
  color: "#111827",
  padding: "0.85rem 1rem",
  fontWeight: 700,
  cursor: "pointer"
};

const miniButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: "0.8rem",
  background: "#dbeafe",
  color: "#1d4ed8",
  padding: "0.7rem 0.9rem",
  fontWeight: 700,
  cursor: "pointer"
};

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
