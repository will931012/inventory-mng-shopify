import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigation } from "@remix-run/react";
import React, { useState, useRef } from "react";
import type { CSSProperties } from "react";

import {
  buildInventoryCsv,
  buildNormalizedCsv,
  createProduct,
  csvTemplate,
  deleteProducts,
  fetchAllProductIdsWithZeroPrice,
  fetchInventoryDashboard,
  getExcelInfo,
  importProductsFromCsv,
  normalizeExcelWorkbook,
  normalizeSupplierCsv,
  updateProductRecord,
  updateVariantInventory
} from "../inventory.server";
import type { ExcelInfo, ProductUpsertInput, SupplierColumnMapping, SupplierPricingRules } from "../inventory.server";
import { authenticate } from "../shopify.server";

type ActionData =
  | { ok: boolean; message: string; errors?: string[] }
  | ExcelInfo
  | { preview: true; products: ProductUpsertInput[] };

const tabs = [
  { id: "overview", label: "Overview", tone: "#f59e0b" },
  { id: "catalog", label: "Catalog", tone: "#0ea5e9" },
  { id: "imports", label: "Imports", tone: "#22c55e" },
  { id: "operations", label: "Operations", tone: "#f97316" },
  { id: "supplier", label: "Supplier", tone: "#8b5cf6" }
] as const;

const inputStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  padding: "0.5rem 0.65rem",
  fontSize: "12px",
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
  color: "#111827"
};

const panelStyle: CSSProperties = {
  background: "#ffffff",
  borderRadius: "6px",
  padding: "1rem",
  border: "1px solid #e5e7eb"
};

const darkButton: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  background: "#f9fafb",
  color: "#1f2937",
  padding: "0.48rem 0.75rem",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "12px",
  transition: "background 0.12s, border-color 0.12s",
  whiteSpace: "nowrap" as const
};

// Primary action button — used for import / save actions
const primaryButton: CSSProperties = {
  ...darkButton,
  background: "#1d4ed8",
  color: "#ffffff",
  borderColor: "#1d4ed8"
};

const amberButton: CSSProperties = {
  ...darkButton,
  background: "#f0fdf4",
  color: "#166534",
  borderColor: "#86efac"
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
    compareAtPrice: String(formData.get("compareAtPrice") ?? "").trim(),
    wholesalePrice: String(formData.get("wholesalePrice") ?? "").trim(),
    cost: String(formData.get("cost") ?? "").trim(),
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
            ? `${result.deletedCount} product(s) deleted. ${result.skippedMissingCount} no longer existed in Shopify.`
            : `${result.deletedCount} product(s) deleted successfully.`
      });
    }

    if (intent === "delete-products-with-zero-price") {
      const dashboard = await fetchInventoryDashboard(admin, query, locationId);
      const productIds = dashboard.products
        .filter((product) => product.variants.some((variant) => Number(variant.price ?? "0") === 0))
        .map((product) => product.id);

      if (productIds.length === 0) {
        return json<ActionData>({
          ok: true,
          message: "No products with price 0.00 found in this view."
        });
      }

      const result = await deleteProducts(admin, productIds);

      return json<ActionData>({
        ok: true,
        message:
          result.skippedMissingCount > 0
            ? `${result.deletedCount} product(s) with price 0.00 deleted in this view. ${result.skippedMissingCount} no longer existed in Shopify.`
            : `${result.deletedCount} product(s) with price 0.00 deleted from this view.`
      });
    }

    if (intent === "delete-all-products-with-zero-price") {
      const productIds = await fetchAllProductIdsWithZeroPrice(admin);

      if (productIds.length === 0) {
        return json<ActionData>({
          ok: true,
          message: "No products with price 0.00 found in the entire store."
        });
      }

      const result = await deleteProducts(admin, productIds);

      return json<ActionData>({
        ok: true,
        message:
          result.skippedMissingCount > 0
            ? `${result.deletedCount} product(s) with price 0.00 deleted from the store. ${result.skippedMissingCount} no longer existed in Shopify.`
            : `${result.deletedCount} product(s) with price 0.00 deleted from the entire store.`
      });
    }

    if (intent === "update-inventory") {
      await updateVariantInventory(
        admin,
        locationId,
        String(formData.get("inventoryItemId") ?? ""),
        Number(formData.get("quantity") ?? "0")
      );
      return json<ActionData>({ ok: true, message: "Inventory updated successfully." });
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
      return json<ActionData>({ ok: true, message: "Product updated successfully." });
    }

    if (intent === "create-product") {
      await createProduct(admin, locationId, readProductInput(formData));
      return json<ActionData>({ ok: true, message: "Product created successfully." });
    }

    if (intent === "import-single-product") {
      const productJson = String(formData.get("productJson") ?? "");
      const product: ProductUpsertInput = JSON.parse(productJson);
      await createProduct(admin, locationId, product);
      return json<ActionData>({ ok: true, message: `"${product.title}" imported successfully.` });
    }

    if (intent === "import-csv") {
      const uploaded = formData.get("csvFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) throw new Error("Select a CSV file before importing.");
      const report = await importProductsFromCsv(admin, locationId, await uploaded.text());
      return json<ActionData>({
        ok: report.errors.length === 0,
        message: `Import complete. ${report.createdCount} created, ${report.updatedCount} updated.`,
        errors: report.errors
      });
    }

    if (intent === "detect-excel-sheets") {
      const uploaded = formData.get("csvFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) throw new Error("Select an Excel file.");
      const buffer = await uploaded.arrayBuffer();
      const info = getExcelInfo(buffer);
      return json<ActionData>(info);
    }

    if (intent === "normalize-supplier") {
      const uploaded = formData.get("csvFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) throw new Error("Select the supplier file.");

      const mapping: SupplierColumnMapping = {
        titleCol: String(formData.get("titleCol") ?? ""),
        skuCol: String(formData.get("skuCol") ?? ""),
        barcodeCol: String(formData.get("barcodeCol") ?? ""),
        vendorCol: String(formData.get("vendorCol") ?? ""),
        productTypeCol: String(formData.get("productTypeCol") ?? ""),
        tagsCol: String(formData.get("tagsCol") ?? ""),
        costCol: String(formData.get("costCol") ?? ""),
        quantityCol: String(formData.get("quantityCol") ?? ""),
        retailPriceCol: String(formData.get("retailPriceCol") ?? ""),
        wholesalePriceCol: String(formData.get("wholesalePriceCol") ?? ""),
        tagColumns: formData.getAll("tagColumns").map(String).filter(Boolean),
        useUpcAsSku: formData.get("useUpcAsSku") === "1"
      };

      const rules: SupplierPricingRules = {
        retailMultiplier: parseFloat(String(formData.get("retailMultiplier") ?? "2.5")) || 2.5,
        wholesaleMultiplier: parseFloat(String(formData.get("wholesaleMultiplier") ?? "1.5")) || 1.5,
        defaultVendor: String(formData.get("defaultVendor") ?? ""),
        defaultProductType: String(formData.get("defaultProductType") ?? ""),
        defaultStatus: parseStatus(formData.get("defaultStatus"))
      };

      const isExcel = uploaded.name.toLowerCase().endsWith(".xlsx") || uploaded.name.toLowerCase().endsWith(".xls");
      let normalized;

      if (isExcel) {
        const buffer = await uploaded.arrayBuffer();
        const selectedSheets = formData.getAll("selectedSheets").map(String).filter(Boolean);
        normalized = normalizeExcelWorkbook(buffer, selectedSheets, mapping, rules);
      } else {
        const csvText = await uploaded.text();
        normalized = normalizeSupplierCsv(csvText, mapping, rules);
      }

      if (!normalized.length) throw new Error("The supplier file has no valid rows to normalize.");

      const subaction = String(formData.get("subaction") ?? "download");

      if (subaction === "preview") {
        return json<ActionData>({ preview: true, products: normalized });
      }

      if (subaction === "download") {
        return new Response(buildNormalizedCsv(normalized), {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="supplier-normalized-${Date.now()}.csv"`
          }
        });
      }

      const report = await importProductsFromCsv(admin, locationId, buildNormalizedCsv(normalized));
      return json<ActionData>({
        ok: report.errors.length === 0,
        message: `Supplier import complete. ${report.createdCount} created, ${report.updatedCount} updated.`,
        errors: report.errors
      });
    }

    return json<ActionData>({ ok: false, message: "Unknown action." });
  } catch (error) {
    return json<ActionData>({ ok: false, message: error instanceof Error ? error.message : "An unexpected error occurred." }, { status: 400 });
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
  const submittingIntent = navigation.formData?.get("intent");

  return (
    <main style={{ color: "#0f172a" }}>
      <section style={{ background: "#fff", borderRadius: "6px", padding: "0.85rem 1rem", border: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <p style={{ margin: 0, color: "#9ca3af", fontWeight: 700, letterSpacing: "0.07em", fontSize: "10px", textTransform: "uppercase" }}>Inventory Management</p>
          <h1 style={{ margin: "0.2rem 0 0.1rem", fontSize: "17px", lineHeight: 1.2, color: "#111827" }}>Catalog & Inventory</h1>
          <p style={{ margin: 0, color: "#6b7280", fontSize: "12px" }}>
            Manage products, stock, imports and supplier normalization.
          </p>
        </div>
        <div style={{ background: "#f8fafc", borderRadius: "6px", padding: "0.55rem 0.8rem", border: "1px solid #e5e7eb", textAlign: "right" }}>
          <p style={{ margin: 0, fontSize: "10px", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>Connected store</p>
          <strong style={{ display: "block", marginTop: "0.15rem", fontSize: "13px", color: "#111827" }}>{data.shop?.name ?? "Shopify Store"}</strong>
          <span style={{ color: "#6b7280", fontSize: "11px" }}>{data.shop?.myshopifyDomain ?? "Domain unavailable"}</span>
        </div>
      </section>

      {actionData && "ok" in actionData ? (
        <Banner ok={actionData.ok} message={actionData.message} errors={"errors" in actionData ? actionData.errors : undefined} />
      ) : null}
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
                display: "inline-flex", alignItems: "center", gap: "0.4rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "999px",
                textDecoration: "none", fontWeight: 600, fontSize: "12px",
                border: `1px solid ${active ? tab.tone : "#e5e7eb"}`,
                color: active ? "#0f172a" : "#6b7280",
                background: active ? "#fff" : "transparent",
                boxShadow: active ? `0 0 0 2px ${tab.tone}22` : "none",
                transition: "all 0.12s ease"
              }}
            >
              <span style={{ width: "6px", height: "6px", borderRadius: "999px", background: tab.tone, flexShrink: 0 }} />
              {tab.label}
            </Link>
          );
        })}
      </section>

      {activeView === "overview" ? (
        <section className="metrics-grid" style={{ marginTop: "0.75rem" }}>
          {[
            { label: "Products", value: data.summary.productCount, accent: "#6366f1" },
            { label: "Variants", value: data.summary.variantCount, accent: "#0ea5e9" },
            { label: "Available units", value: data.summary.inventoryUnits, accent: "#22c55e" },
            { label: "Locations", value: data.locations.length, accent: "#f59e0b" }
          ].map((card) => (
            <article key={card.label} style={{ ...panelStyle, borderTop: `3px solid ${card.accent}` }}>
              <p style={{ marginTop: 0, color: "#6b7280", fontSize: "11px", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{card.label}</p>
              <strong style={{ fontSize: "22px", color: "#111827" }}>{card.value.toLocaleString()}</strong>
            </article>
          ))}
        </section>
      ) : null}

      {(activeView === "overview" || activeView === "catalog") ? (
        <section className="split-grid" style={{ marginTop: "1rem" }}>
          <article style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ marginBottom: "0.3rem", marginTop: 0 }}>Search & Export</h2>
                <p style={{ margin: 0, color: "#64748b" }}>Filter by title, SKU, vendor or any term supported by Shopify.</p>
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="export" />
                <input type="hidden" name="query" value={data.query} />
                <input type="hidden" name="locationId" value={data.selectedLocationId} />
                <button type="submit" style={darkButton}>Export CSV</button>
              </Form>
            </div>
            <Form method="get" style={{ marginTop: "1rem", display: "grid", gap: "0.8rem" }}>
              <input type="hidden" name="view" value={activeView} />
              <div className="split-grid" style={{ gridTemplateColumns: "2fr 1fr auto", gap: "0.8rem" }}>
                <input type="text" name="q" defaultValue={data.query} placeholder="e.g. perfume, SKU-001, vendor:Grace" style={inputStyle} />
                <select name="locationId" defaultValue={data.selectedLocationId} style={inputStyle}>
                  {data.locations.length === 0 ? <option value="">No location</option> : null}
                  {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
                <button type="submit" style={primaryButton}>Search</button>
              </div>
            </Form>
          </article>
          <article style={{ ...panelStyle, background: "#fff7ed" }}>
            <h2 style={{ marginTop: 0, marginBottom: "0.5rem" }}>CSV Template</h2>
            <p style={{ color: "#9a3412", marginTop: 0 }}>Use these columns to create or update products by SKU.</p>
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

      {activeView === "supplier" ? (
        <section style={{ marginTop: "1rem" }}>
          <SupplierPanel selectedLocationId={data.selectedLocationId} isSubmitting={isSubmitting} />
        </section>
      ) : null}

      {(activeView === "overview" || activeView === "operations" || activeView === "catalog") ? (
        <CatalogPanel
          shopDomain={data.shop?.myshopifyDomain}
          currencyCode={data.shop?.currencyCode ?? "USD"}
          selectedLocationId={data.selectedLocationId}
          query={data.query}
          products={data.products}
          isSubmitting={isSubmitting}
          submittingIntent={String(submittingIntent ?? "")}
        />
      ) : null}
    </main>
  );
}

function Banner({ ok, message, errors }: { ok: boolean; message: string; errors?: string[] }) {
  return (
    <section
      style={{
        marginTop: "0.75rem",
        background: ok ? "#f0fdf4" : "#fef2f2",
        color: ok ? "#166534" : "#991b1b",
        border: `1px solid ${ok ? "#86efac" : "#fca5a5"}`,
        borderRadius: "6px",
        padding: "0.65rem 0.9rem",
        fontSize: "12px",
        display: "flex",
        gap: "0.5rem",
        alignItems: "flex-start"
      }}
    >
      <span style={{ fontSize: "14px", lineHeight: 1.4, flexShrink: 0 }}>{ok ? "✓" : "✕"}</span>
      <div>
        <strong>{message}</strong>
        {errors?.length ? (
          <ul style={{ marginBottom: 0, marginTop: "0.5rem", paddingLeft: "1.25rem" }}>
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function CreatePanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  return (
    <article style={panelStyle}>
      <h2 className="excel-title">Create product</h2>
      <Form method="post" style={{ display: "grid", gap: "0.8rem" }}>
        <input type="hidden" name="intent" value="create-product" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <div className="catalog-edit-grid">
          <input name="title" placeholder="Title" required style={inputStyle} />
          <input name="sku" placeholder="SKU" required style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="price" type="number" step="0.01" min="0" placeholder="Retail price" style={inputStyle} />
          <input name="quantity" type="number" step="1" placeholder="Quantity" defaultValue={0} style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="wholesalePrice" type="number" step="0.01" min="0" placeholder="Wholesale price" style={inputStyle} />
          <input name="cost" type="number" step="0.01" min="0" placeholder="Supplier cost" style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="compareAtPrice" type="number" step="0.01" min="0" placeholder="Compare at price (optional)" style={inputStyle} />
          <input name="barcode" placeholder="Barcode" style={inputStyle} />
        </div>
        <div className="catalog-edit-grid">
          <input name="vendor" placeholder="Vendor" style={inputStyle} />
          <input name="productType" placeholder="Product type" style={inputStyle} />
        </div>
        <input name="tags" placeholder="Tags, comma separated" style={inputStyle} />
        <select name="status" defaultValue="ACTIVE" style={inputStyle}>
          <option value="ACTIVE">Active</option>
          <option value="DRAFT">Draft</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <button type="submit" disabled={isSubmitting} style={darkButton}>{isSubmitting ? "Saving..." : "Create product"}</button>
      </Form>
    </article>
  );
}

function ImportPanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  return (
    <article style={panelStyle}>
      <h2 className="excel-title">Import CSV</h2>
      <p className="excel-subtle">If the SKU already exists, the app updates the product and quantity. Otherwise, it creates it.</p>
      <Form method="post" encType="multipart/form-data" style={{ display: "grid", gap: "0.8rem" }}>
        <input type="hidden" name="intent" value="import-csv" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <input type="file" name="csvFile" accept=".csv,text/csv" style={{ border: "2px dashed #d1fae5", borderRadius: "6px", padding: "1rem", background: "#f0fdf4", width: "100%", boxSizing: "border-box", cursor: "pointer", color: "#166534", fontSize: "12px" }} />
        <button type="submit" disabled={isSubmitting} style={primaryButton}>{isSubmitting ? "Importing..." : "Import inventory"}</button>
      </Form>
    </article>
  );
}

function CatalogPanel({
  shopDomain,
  currencyCode,
  selectedLocationId,
  query,
  products,
  isSubmitting,
  submittingIntent
}: {
  shopDomain?: string;
  currencyCode: string;
  selectedLocationId: string;
  query: string;
  products: Awaited<ReturnType<typeof fetchInventoryDashboard>>["products"];
  isSubmitting: boolean;
  submittingIntent: string;
}) {
  const deletingViewZeroPrice = isSubmitting && submittingIntent === "delete-products-with-zero-price";
  const deletingAllZeroPrice = isSubmitting && submittingIntent === "delete-all-products-with-zero-price";

  return (
    <section style={{ ...panelStyle, marginTop: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap", marginBottom: "0.25rem" }}>
        <div>
          <h2 className="excel-title" style={{ marginBottom: "0.2rem" }}>Catalog</h2>
          <p className="excel-subtle" style={{ marginBottom: 0 }}>Open in Shopify, quick-edit fields, adjust stock or delete.</p>
          {deletingAllZeroPrice ? (
            <p style={{ marginTop: "0.4rem", color: "#b45309", fontSize: "12px" }}>
              Deleting all products with price 0.00...
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <Form method="post" onSubmit={(event) => {
            if (!window.confirm("Products in this view with price 0.00 will be deleted. Continue?")) {
              event.preventDefault();
            }
          }}>
            <input type="hidden" name="intent" value="delete-products-with-zero-price" />
            <input type="hidden" name="locationId" value={selectedLocationId} />
            <input type="hidden" name="query" value={query} />
            <button type="submit" disabled={isSubmitting} className="danger-button">
              {deletingViewZeroPrice ? "Deleting view..." : "Delete view 0.00"}
            </button>
          </Form>
          <Form method="post" onSubmit={(event) => {
            if (!window.confirm("All products in the store with price 0.00 will be deleted. Continue?")) {
              event.preventDefault();
            }
          }}>
            <input type="hidden" name="intent" value="delete-all-products-with-zero-price" />
            <button type="submit" disabled={isSubmitting} className="danger-button">
              {deletingAllZeroPrice ? "Deleting entire store..." : "Delete all 0.00"}
            </button>
          </Form>
        </div>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="delete-products" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        <div className="catalog-table-wrap">
          <table className="catalog-table">
            <thead>
              <tr style={{ background: "#f8fafc", color: "#475569", textAlign: "left" }}>
                <th style={tableHeaderStyle}>Delete</th>
                <th style={tableHeaderStyle}>Product</th>
                <th style={tableHeaderStyle}>Status</th>
                <th style={tableHeaderStyle}>SKU / Variant</th>
                <th style={tableHeaderStyle}>Prices</th>
                <th style={tableHeaderStyle}>Inventory</th>
                <th style={tableHeaderStyle}>Actions</th>
                <th style={tableHeaderStyle}>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: "1.5rem", color: "#64748b" }}>No products match this filter.</td></tr>
              ) : products.map((product) => {
                const variant = product.variants[0];
                const level = variant?.inventoryLevels.find((item) => item.locationId === selectedLocationId);
                const tone = statusTone(product.status);
                return (
                  <tr key={product.id}>
                    <td style={tableCellStyle}><input type="checkbox" name="productIds" value={product.id} /></td>
                    <td style={tableCellStyle}>
                      <strong style={{ display: "block" }}>{product.title}</strong>
                      <span style={{ color: "#64748b", fontSize: "0.9rem" }}>{product.vendor || "No vendor"} · {product.productType || "No type"}</span>
                    </td>
                    <td style={tableCellStyle}><span style={{ display: "inline-flex", padding: "0.3rem 0.7rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 700, ...tone }}>{product.status}</span></td>
                    <td style={tableCellStyle}><strong>{variant?.sku || "No SKU"}</strong><div style={{ color: "#64748b", fontSize: "0.9rem" }}>{variant?.title ?? "No variant"}</div></td>
                    <td style={tableCellStyle}>
                      <div><strong>{variant?.price ?? "0.00"}</strong> <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>{currencyCode}</span></div>
                      {variant?.wholesalePrice ? <div style={{ color: "#7c3aed", fontSize: "0.85rem" }}>Wholesale: {variant.wholesalePrice}</div> : null}
                      {variant?.cost ? <div style={{ color: "#6b7280", fontSize: "0.85rem" }}>Cost: {variant.cost}</div> : null}
                    </td>
                    <td style={tableCellStyle}>
                      {variant ? (
                        <Form method="post" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                          <input type="hidden" name="intent" value="update-inventory" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
                          <input type="number" name="quantity" defaultValue={level?.available ?? variant.inventoryQuantity} style={{ ...inputStyle, maxWidth: "110px" }} />
                          <button type="submit" style={{ ...primaryButton, padding: "0.45rem 0.9rem" }}>Save</button>
                        </Form>
                      ) : <span style={{ color: "#64748b" }}>No variant</span>}
                    </td>
                    <td style={tableCellStyle}>
                      <div className="catalog-actions">
                        <a href={productAdminUrl(shopDomain, product.id)} target="_top" rel="noreferrer" className="shopify-admin-button">Open</a>
                        {variant ? (
                          <details>
                            <summary className="ghost-button">Edit</summary>
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
                                  <input name="price" placeholder="Retail price" defaultValue={variant.price} style={inputStyle} />
                                  <input name="quantity" type="number" defaultValue={level?.available ?? variant.inventoryQuantity} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="wholesalePrice" type="number" step="0.01" placeholder="Wholesale price" defaultValue={variant.wholesalePrice} style={inputStyle} />
                                  <input name="cost" type="number" step="0.01" placeholder="Supplier cost" defaultValue={variant.cost} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="compareAtPrice" type="number" step="0.01" placeholder="Compare at price" defaultValue={variant.compareAtPrice} style={inputStyle} />
                                  <input name="barcode" defaultValue={variant.barcode} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="vendor" defaultValue={product.vendor} style={inputStyle} />
                                  <input name="productType" defaultValue={product.productType} style={inputStyle} />
                                </div>
                                <div className="catalog-edit-grid">
                                  <input name="tags" defaultValue={product.tags.join(", ")} style={inputStyle} />
                                  <select name="status" defaultValue={product.status} style={inputStyle}>
                                    <option value="ACTIVE">Active</option>
                                    <option value="DRAFT">Draft</option>
                                    <option value="ARCHIVED">Archived</option>
                                  </select>
                                </div>
                                <button type="submit" className="shopify-admin-button">Save changes</button>
                              </Form>
                            </div>
                          </details>
                        ) : null}
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete-products" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="productIds" value={product.id} />
                          <button type="submit" className="danger-button">Delete</button>
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
          <button type="submit" disabled={isSubmitting || products.length === 0} className="danger-button">Delete selected</button>
        </div>
      </Form>
    </section>
  );
}

// ─── Import Queue ──────────────────────────────────────────────────────────────

function ProductQueueRow({
  index,
  product,
  locationId,
  onSkip,
  onStatusChange,
}: {
  index: number;
  product: ProductUpsertInput;
  locationId: string;
  onSkip: () => void;
  onStatusChange: (status: "done" | "error") => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const isImporting = fetcher.state !== "idle";
  const isDone = fetcher.data && "ok" in fetcher.data && fetcher.data.ok;
  const isError = fetcher.data && "ok" in fetcher.data && !fetcher.data.ok;
  const errorMsg = isError && "message" in fetcher.data! ? (fetcher.data as { message: string }).message : "";
  const reportedRef = React.useRef(false);

  React.useEffect(() => {
    if (!reportedRef.current && fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data) {
      reportedRef.current = true;
      onStatusChange(fetcher.data.ok ? "done" : "error");
    }
  }, [fetcher.state, fetcher.data, onStatusChange]);

  if (isDone) {
    return (
      <tr style={{ background: "#f0fdf4" }}>
        <td
          colSpan={9}
          style={{ padding: "0.35rem 0.6rem", fontSize: "11px", color: "#166534" }}
        >
          ✓ #{index} — {product.title}
        </td>
      </tr>
    );
  }

  const cellPad: CSSProperties = { padding: "0.4rem 0.5rem", verticalAlign: "top" };

  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9", background: isError ? "#fef2f2" : "transparent" }}>
      <td style={{ ...cellPad, color: "#9ca3af", textAlign: "center", width: "2.5rem" }}>{index}</td>
      <td style={cellPad}>
        <div style={{ fontWeight: 600, fontSize: "12px" }}>{product.title}</div>
        {isError && (
          <div style={{ color: "#dc2626", fontSize: "11px", marginTop: "0.2rem" }}>{errorMsg}</div>
        )}
      </td>
      <td style={{ ...cellPad, color: "#6b7280", fontSize: "12px" }}>{product.vendor || "—"}</td>
      <td style={{ ...cellPad, fontFamily: "monospace", fontSize: "11px" }}>
        <div>{product.sku || "—"}</div>
        <div style={{ color: "#9ca3af" }}>{product.barcode}</div>
      </td>
      <td style={{ ...cellPad, textAlign: "right", fontSize: "12px", whiteSpace: "nowrap" }}>
        {product.cost ? `$${product.cost}` : "—"}
      </td>
      <td style={{ ...cellPad, textAlign: "right", fontSize: "12px", whiteSpace: "nowrap" }}>
        ${product.price}
      </td>
      <td style={{ ...cellPad, textAlign: "right", fontSize: "12px", whiteSpace: "nowrap" }}>
        {product.wholesalePrice ? `$${product.wholesalePrice}` : "—"}
      </td>
      <td
        style={{
          ...cellPad,
          maxWidth: "11rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#6b7280",
          fontSize: "11px",
        }}
      >
        {product.tags.join(", ")}
      </td>
      <td style={{ ...cellPad, whiteSpace: "nowrap" }}>
        <fetcher.Form method="post" style={{ display: "flex", gap: "0.3rem" }}>
          <input type="hidden" name="intent" value="import-single-product" />
          <input type="hidden" name="locationId" value={locationId} />
          <input type="hidden" name="productJson" value={JSON.stringify(product)} />
          <button
            type="submit"
            disabled={isImporting}
            style={{
              ...darkButton,
              fontSize: "11px",
              padding: "0.2rem 0.45rem",
              background: "#dbeafe",
              borderColor: "#93c5fd",
              color: "#1e40af",
            }}
          >
            {isImporting ? "..." : "Import"}
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={isImporting}
            style={{ ...darkButton, fontSize: "11px", padding: "0.2rem 0.45rem" }}
          >
            Skip
          </button>
        </fetcher.Form>
      </td>
    </tr>
  );
}

function ImportQueuePanel({
  products,
  locationId,
  onClose,
}: {
  products: ProductUpsertInput[];
  locationId: string;
  onClose: () => void;
}) {
  const [skipped, setSkipped] = React.useState<Set<number>>(new Set());
  const [importedCount, setImportedCount] = React.useState(0);
  const [errorCount, setErrorCount] = React.useState(0);
  const [filter, setFilter] = React.useState("");
  const [page, setPage] = React.useState(0);
  const PAGE_SIZE = 30;

  const handleStatusChange = React.useCallback((status: "done" | "error") => {
    if (status === "done") setImportedCount((n) => n + 1);
    else setErrorCount((n) => n + 1);
  }, []);

  const filtered = products
    .map((p, i) => ({ p, i }))
    .filter(
      ({ i, p }) =>
        !skipped.has(i) &&
        (!filter ||
          p.title.toLowerCase().includes(filter.toLowerCase()) ||
          p.sku.toLowerCase().includes(filter.toLowerCase()) ||
          p.vendor.toLowerCase().includes(filter.toLowerCase()))
    );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const remaining = products.length - importedCount - skipped.size;

  const statItems = [
    { label: "Total", value: products.length, color: "#374151" },
    { label: "Imported", value: importedCount, color: "#166534", bg: "#f0fdf4", border: "#86efac" },
    { label: "Skipped", value: skipped.size, color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
    { label: "Errors", value: errorCount, color: "#991b1b", bg: "#fef2f2", border: "#fca5a5" },
    { label: "Remaining", value: Math.max(0, remaining), color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  ];

  return (
    <article style={panelStyle}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "14px" }}>Import Queue</h2>
          <p style={{ margin: "0.2rem 0 0", color: "#6b7280", fontSize: "12px" }}>
            Review each product and import individually, or skip.
          </p>
        </div>
        <button type="button" onClick={onClose} style={darkButton}>
          ← Back to configuration
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
        {statItems.map((s) => (
          <div
            key={s.label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "0.4rem 0.75rem",
              borderRadius: "6px",
              border: `1px solid ${s.border ?? "#e5e7eb"}`,
              background: s.bg ?? "#f9fafb",
              minWidth: "5rem",
            }}
          >
            <strong style={{ fontSize: "16px", color: s.color, lineHeight: 1 }}>{s.value}</strong>
            <span style={{ fontSize: "10px", color: "#6b7280", marginTop: "0.15rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Filter */}
      <input
        type="text"
        value={filter}
        onChange={(e) => { setFilter(e.target.value); setPage(0); }}
        placeholder="Filter by title, SKU or brand..."
        style={{ ...inputStyle, marginBottom: "0.75rem" }}
      />

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: "6px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <thead>
            <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
              {["#", "Title", "Brand", "SKU / Barcode", "Cost", "Price", "Wholesale", "Tags", "Action"].map((h) => (
                <th key={h} style={{ padding: "0.5rem 0.55rem", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageItems.map(({ p, i }) => (
              <ProductQueueRow
                key={i}
                index={i + 1}
                product={p}
                locationId={locationId}
                onSkip={() => setSkipped((prev) => new Set([...prev, i]))}
                onStatusChange={handleStatusChange}
              />
            ))}
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: "2rem", textAlign: "center", color: "#6b7280", fontSize: "12px" }}>
                  No products match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} style={darkButton}>
            ← Prev
          </button>
          <span style={{ fontSize: "12px", color: "#6b7280" }}>
            Page {safePage + 1} / {totalPages} &nbsp;·&nbsp; {filtered.length} shown
          </span>
          <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1} style={darkButton}>
            Next →
          </button>
        </div>
      )}
    </article>
  );
}

// ───────────────────────────────────────────────────────────────────────────────

const SUPPLIER_FIELDS = [
  { name: "titleCol", label: "Product name / Description", required: true },
  { name: "skuCol", label: "SKU / Internal code" },
  { name: "barcodeCol", label: "Barcode / UPC / EAN" },
  { name: "costCol", label: "Cost (supplier price)" },
  { name: "quantityCol", label: "Stock quantity" },
  { name: "vendorCol", label: "Brand / Manufacturer" },
  { name: "productTypeCol", label: "Product type / Category" },
  { name: "tagsCol", label: "Base tags column" },
  { name: "retailPriceCol", label: "Retail price (if already in the file)" },
  { name: "wholesalePriceCol", label: "Wholesale price (if already in the file)" }
] as const;

function SupplierPanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  const detectorFetcher = useFetcher<ExcelInfo>();
  const previewFetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [isExcel, setIsExcel] = useState(false);
  const [tagColumnsSelected, setTagColumnsSelected] = useState<string[]>([]);
  const [queueProducts, setQueueProducts] = useState<ProductUpsertInput[] | null>(null);

  React.useEffect(() => {
    if (previewFetcher.data && "preview" in previewFetcher.data) {
      setQueueProducts(previewFetcher.data.products);
    }
  }, [previewFetcher.data]);

  const handlePreview = () => {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    fd.set("subaction", "preview");
    previewFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const isPreviewing = previewFetcher.state === "submitting";

  const excelInfo = detectorFetcher.data && "sheets" in detectorFetcher.data ? detectorFetcher.data : null;
  const headers = isExcel ? (excelInfo?.headers ?? []) : csvHeaders;
  const isDetecting = detectorFetcher.state === "submitting";
  const hasFile = headers.length > 0;

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) { setCsvHeaders([]); setIsExcel(false); return; }
    const ext = file.name.toLowerCase();
    if (ext.endsWith(".xlsx") || ext.endsWith(".xls")) {
      setIsExcel(true);
      setCsvHeaders([]);
      setTagColumnsSelected([]);
      const fd = new FormData();
      fd.append("intent", "detect-excel-sheets");
      fd.append("csvFile", file);
      detectorFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    } else {
      setIsExcel(false);
      setTagColumnsSelected([]);
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (!text) return;
        const firstLine = text.split(/\r?\n/)[0] ?? "";
        const hdrs: string[] = [];
        let cur = ""; let inQ = false;
        for (const c of firstLine) {
          if (c === '"') { inQ = !inQ; continue; }
          if (c === "," && !inQ) { hdrs.push(cur.trim()); cur = ""; continue; }
          cur += c;
        }
        if (cur) hdrs.push(cur.trim());
        setCsvHeaders(hdrs.filter(Boolean));
      };
      reader.readAsText(file);
    }
  };

  const toggleTagCol = (col: string) => {
    setTagColumnsSelected((prev) => prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]);
  };

  // Show queue view instead of the form when preview data is loaded
  if (queueProducts) {
    return (
      <ImportQueuePanel
        products={queueProducts}
        locationId={selectedLocationId}
        onClose={() => setQueueProducts(null)}
      />
    );
  }

  return (
    <article style={panelStyle}>
      <h2 className="excel-title">Normalize supplier list</h2>
      <p className="excel-subtle">
        Upload your supplier file (.xlsx with multiple sheets or .csv), map the columns and configure your price margins.
      </p>

      <Form ref={formRef} method="post" encType="multipart/form-data" style={{ display: "grid", gap: "1.1rem" }}>
        <input type="hidden" name="intent" value="normalize-supplier" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        {tagColumnsSelected.map((col) => (
          <input key={col} type="hidden" name="tagColumns" value={col} />
        ))}

        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "0.4rem" }}>
            Supplier file (.xlsx or .csv)
          </label>
          <input
            type="file"
            name="csvFile"
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={handleFileChange}
            style={{ border: "2px dashed #c7d2fe", borderRadius: "6px", padding: "1.25rem", background: "#f5f3ff", width: "100%", boxSizing: "border-box", cursor: "pointer", color: "#5b21b6", fontSize: "12px" }}
          />
          {isDetecting && <p style={{ margin: "0.4rem 0 0", fontSize: "12px", color: "#7c3aed" }}>Detecting Excel sheets...</p>}
        </div>

        {isExcel && excelInfo && (
          <div style={{ background: "#faf5ff", border: "1px solid #ddd6fe", padding: "0.75rem" }}>
            <strong style={{ fontSize: "12px", display: "block", marginBottom: "0.5rem", color: "#5b21b6" }}>
              {excelInfo.sheets.length} sheets detected — check which ones to import:
            </strong>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {excelInfo.sheets.map((sheet) => (
                <label key={sheet} style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", background: "#ede9fe", padding: "0.25rem 0.5rem", border: "1px solid #c4b5fd" }}>
                  <input type="checkbox" name="selectedSheets" value={sheet} defaultChecked />
                  {sheet}
                </label>
              ))}
            </div>
          </div>
        )}

        {hasFile ? (
          <>
            <section style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "0.65rem 0.85rem", fontSize: "12px", color: "#166534" }}>
              {isExcel ? "Excel" : "CSV"} — <strong>{headers.length} columns detected</strong>: {headers.join(" · ")}
            </section>

            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, marginTop: 0, marginBottom: "0.5rem" }}>Column mapping</h3>
              <p style={{ fontSize: "12px", color: "#6b7280", marginTop: 0, marginBottom: "0.75rem" }}>Select which supplier column maps to each app field.</p>
              <div style={{ display: "grid", gap: "0.45rem" }}>
                {SUPPLIER_FIELDS.map(({ name, label, required }) => (
                  <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", alignItems: "center" }}>
                    <label style={{ fontSize: "12px", fontWeight: required ? 600 : 400 }}>{label}{required ? " *" : ""}</label>
                    <select name={name} style={inputStyle}>
                      <option value="">-- Skip --</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, marginTop: 0, marginBottom: "0.4rem" }}>Extra columns as tags</h3>
              <p style={{ fontSize: "12px", color: "#6b7280", marginTop: 0, marginBottom: "0.5rem" }}>
                Click the columns to automatically convert their values into tags. SEX is translated: M→Male, L→Lady, U→Unisex.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                {headers.map((h) => {
                  const active = tagColumnsSelected.includes(h);
                  return (
                    <button key={h} type="button" onClick={() => toggleTagCol(h)}
                      style={{ fontSize: "11px", padding: "0.25rem 0.5rem", border: `1px solid ${active ? "#8b5cf6" : "#cbd5e1"}`,
                        background: active ? "#ddd6fe" : "#f8fafc", cursor: "pointer", fontWeight: active ? 700 : 400 }}>
                      {h}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input type="checkbox" name="useUpcAsSku" value="1" defaultChecked />
              Use UPC/Barcode as SKU when no SKU column is mapped
            </label>

            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, marginTop: 0, marginBottom: "0.5rem" }}>Pricing rules</h3>
              <p style={{ fontSize: "12px", color: "#6b7280", marginTop: 0, marginBottom: "0.75rem" }}>
                If price columns are empty (as in the MTZ list), prices are calculated by multiplying the cost.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "0.3rem" }}>Retail multiplier</label>
                  <input name="retailMultiplier" type="number" step="0.01" min="1" defaultValue="2.5" style={inputStyle} />
                  <small style={{ color: "#6b7280", fontSize: "11px" }}>e.g. 2.5 → price = cost x 2.5</small>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "0.3rem" }}>Wholesale multiplier</label>
                  <input name="wholesaleMultiplier" type="number" step="0.01" min="1" defaultValue="1.5" style={inputStyle} />
                  <small style={{ color: "#6b7280", fontSize: "11px" }}>e.g. 1.5 → price = cost x 1.5</small>
                </div>
              </div>
            </div>

            <div>
              <h3 style={{ fontSize: "13px", fontWeight: 700, marginTop: 0, marginBottom: "0.5rem" }}>Default values</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", marginBottom: "0.3rem" }}>Default vendor</label>
                  <input name="defaultVendor" placeholder="e.g. MTZ" style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", marginBottom: "0.3rem" }}>Default product type</label>
                  <input name="defaultProductType" placeholder="e.g. Perfume" style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", marginBottom: "0.3rem" }}>Initial status</label>
                  <select name="defaultStatus" defaultValue="DRAFT" style={inputStyle}>
                    <option value="ACTIVE">Active</option>
                    <option value="DRAFT">Draft</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <button type="submit" name="subaction" value="download" disabled={isSubmitting || isPreviewing} style={darkButton}>
                {isSubmitting ? "Processing..." : "Download normalized CSV"}
              </button>
              <button type="submit" name="subaction" value="import" disabled={isSubmitting || isPreviewing} style={primaryButton}>
                {isSubmitting ? "Importing..." : "Import directly to Shopify"}
              </button>
              <button
                type="button"
                onClick={handlePreview}
                disabled={isSubmitting || isPreviewing}
                style={{ ...darkButton, background: "#ede9fe", borderColor: "#a78bfa", color: "#5b21b6" }}
              >
                {isPreviewing ? "Loading queue..." : "Preview & import one by one"}
              </button>
            </div>
          </>
        ) : (
          !isDetecting && (
            <div style={{ background: "#faf5ff", border: "1px solid #ddd6fe", padding: "1rem", fontSize: "12px", color: "#5b21b6" }}>
              <strong style={{ display: "block", marginBottom: "0.5rem", color: "#3730a3" }}>What this normalizer does</strong>
              <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.9 }}>
                <li>Accepts <strong>.xlsx</strong> (Excel with multiple sheets like the MTZ list) and <strong>.csv</strong></li>
                <li>For Excel: auto-detects sheets and lets you choose which ones to process</li>
                <li>Map supplier columns (DESCRIPTION, UPC, COST, BRAND...) to Shopify fields</li>
                <li>Calculate retail and wholesale price from COST using multipliers</li>
                <li>Columns like CONCENTRATION, SEX, SIZE are automatically converted to tags</li>
                <li>Download a Shopify-ready CSV or import directly — 4,109 products at once</li>
              </ul>
            </div>
          )
        )}
      </Form>
    </article>
  );
}

const tableHeaderStyle: CSSProperties = {
  padding: "0.6rem 0.7rem",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6b7280",
  whiteSpace: "nowrap"
};

const tableCellStyle: CSSProperties = {
  padding: "0.75rem 0.7rem",
  verticalAlign: "top"
};
