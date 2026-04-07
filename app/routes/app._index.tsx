import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigation } from "@remix-run/react";
import React, { useState, useRef } from "react";
import type { CSSProperties } from "react";

import {
  attachProductImages,
  buildInventoryCsv,
  buildNormalizedCsv,
  bulkEditTags,
  bulkUpdatePrices,
  createProduct,
  createProductGroup,
  createStagedUpload,
  csvTemplate,
  deleteProductImage,
  deleteProducts,
  fetchAllProductIdsWithZeroPrice,
  fetchDuplicateUPCs,
  fetchInventoryDashboard,
  fetchProductImages,
  fetchProductsWithoutBarcode,
  fetchProductsWithoutImages,
  getExcelInfo,
  importProductsFromCsv,
  normalizeExcelWorkbook,
  normalizeSupplierCsv,
  setInventoryItemsToMinimum,
  setZeroStockVariantsToMinimum,
  updateProductRecord,
  updateVariantInventory
} from "../inventory.server";
import type { DuplicateUPCGroup, ExcelInfo, NoBarcodeProduct, NoImageProduct, ProductGroupInput, SupplierColumnMapping, SupplierPricingRules } from "../inventory.server";
import { authenticate } from "../shopify.server";

type ProductImageEntry = { id: string; url: string; alt: string };

type StagedTarget = { url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> };

type ActionData =
  | { ok: boolean; message: string; errors?: string[] }
  | ExcelInfo
  | { preview: true; products: ProductGroupInput[] }
  | { images: ProductImageEntry[] }
  | { noImageProducts: NoImageProduct[] }
  | { stagedUpload: StagedTarget }
  | { noBarcodeProducts: NoBarcodeProduct[] }
  | { duplicateUPCs: DuplicateUPCGroup[] };

const tabs = [
  { id: "overview",   label: "Overview",   icon: "📊" },
  { id: "catalog",    label: "Catalog",    icon: "🗂️"  },
  { id: "imports",    label: "Import",     icon: "📥"  },
  { id: "supplier",   label: "Supplier",   icon: "📦"  },
  { id: "images",     label: "Images",     icon: "🖼️"  },
  { id: "operations", label: "Operations", icon: "⚙️"  },
] as const;

// ─── Design tokens ─────────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "0.55rem 0.75rem",
  fontSize: "13px",
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
  color: "#0f172a",
};

const panelStyle: CSSProperties = {
  background: "#fff",
  borderRadius: "12px",
  padding: "1.25rem 1.5rem",
  border: "1px solid #e2e8f0",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
};

const darkButton: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "0.35rem",
  borderRadius: "8px", padding: "0.5rem 1rem",
  fontSize: "13px", fontWeight: 600, cursor: "pointer",
  border: "1px solid #e2e8f0", background: "#f8fafc", color: "#374151",
  transition: "background 0.15s, border-color 0.15s", whiteSpace: "nowrap" as const, lineHeight: 1,
};

const primaryButton: CSSProperties = {
  ...darkButton, background: "#2563eb", color: "#fff", borderColor: "#2563eb",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function productAdminUrl(shopDomain: string | undefined, productId: string) {
  return `https://${shopDomain}/admin/products/${productId.split("/").pop()}`;
}

function statusBadge(status: string): { bg: string; color: string; label: string } {
  if (status === "ACTIVE")  return { bg: "#dcfce7", color: "#15803d", label: "Active" };
  if (status === "DRAFT")   return { bg: "#fef9c3", color: "#a16207", label: "Draft" };
  return                           { bg: "#f1f5f9", color: "#475569", label: "Archived" };
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

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const dashboard = await fetchInventoryDashboard(
    admin,
    url.searchParams.get("q") ?? "",
    url.searchParams.get("locationId")
  );

  if (dashboard.locationsAccessDenied) {
    throw redirect("/auth");
  }

  return json({
    ...dashboard,
    query: url.searchParams.get("q") ?? "",
    view: url.searchParams.get("view") ?? "overview",
    csvTemplate: csvTemplate()
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

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

    if (intent === "set-zero-stock-to-two") {
      const inventoryItemIds = formData.getAll("inventoryItemIds").map(String).filter(Boolean);
      let result:
        | { updatedCount: number; errors: string[]; skippedUntrackedCount?: number };

      if (inventoryItemIds.length > 0) {
        result = await setInventoryItemsToMinimum(admin, locationId, inventoryItemIds, 2);
      } else {
        const dashboard = await fetchInventoryDashboard(admin, query, locationId);
        const resolvedLocationId = dashboard.selectedLocationId || locationId;
        result = await setZeroStockVariantsToMinimum(admin, resolvedLocationId, dashboard.products, 2);
      }

      if (result.updatedCount === 0 && result.errors.length === 0) {
        return json<ActionData>({
          ok: true,
          message: "No variants with stock 0 were found in this view."
        });
      }

      const messageParts = [`${result.updatedCount} variant(s) with stock 0 updated to 2.`];
      if ((result.skippedUntrackedCount ?? 0) > 0) {
        messageParts.push(`${result.skippedUntrackedCount} untracked variant(s) skipped.`);
      }

      return json<ActionData>({
        ok: result.errors.length === 0,
        message: messageParts.join(" "),
        errors: result.errors
      });
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
      const group: ProductGroupInput = JSON.parse(productJson);
      await createProductGroup(admin, locationId, group);
      const variantNote = group.variants.length > 1 ? ` (${group.variants.length} variants)` : "";
      return json<ActionData>({ ok: true, message: `"${group.title}"${variantNote} imported successfully.` });
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
        variantTitleCols: formData.getAll("variantTitleCols").map(String).filter(Boolean),
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

      // Collect per-sheet status overrides (sent as sheetStatus_<SheetName> fields)
      const sheetStatusOverrides: Record<string, "ACTIVE" | "DRAFT" | "ARCHIVED"> = {};
      for (const [key, val] of formData.entries()) {
        if (key.startsWith("sheetStatus_")) {
          const sheetName = key.slice("sheetStatus_".length);
          const s = String(val).toUpperCase();
          if (s === "ACTIVE" || s === "DRAFT" || s === "ARCHIVED") {
            sheetStatusOverrides[sheetName] = s;
          }
        }
      }

      if (isExcel) {
        const buffer = await uploaded.arrayBuffer();
        const selectedSheets = formData.getAll("selectedSheets").map(String).filter(Boolean);
        normalized = normalizeExcelWorkbook(buffer, selectedSheets, mapping, rules, sheetStatusOverrides);
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

      let createdCount = 0;
      const importErrors: string[] = [];
      for (const group of normalized) {
        try {
          await createProductGroup(admin, locationId, group);
          createdCount++;
        } catch (e) {
          importErrors.push(`"${group.title}": ${e instanceof Error ? e.message : "error"}`);
        }
      }
      return json<ActionData>({
        ok: importErrors.length === 0,
        message: `Supplier import complete. ${createdCount} product(s) created.`,
        errors: importErrors
      });
    }

    if (intent === "load-no-image-products") {
      const products = await fetchProductsWithoutImages(admin);
      return json({ noImageProducts: products });
    }

    if (intent === "create-staged-upload") {
      const filename = String(formData.get("filename") ?? "image.jpg");
      const mimeType = String(formData.get("mimeType") ?? "image/jpeg");
      const fileSize = parseInt(String(formData.get("fileSize") ?? "0"), 10);
      const target = await createStagedUpload(admin, filename, mimeType, fileSize);
      return json({ stagedUpload: target });
    }

    if (intent === "attach-images") {
      const productId = String(formData.get("productId") ?? "").trim();
      if (!productId) throw new Error("Select a product.");
      const urls = formData.getAll("imageUrl").map(String).filter(Boolean);
      const alts = formData.getAll("imageAlt").map(String);
      if (!urls.length) throw new Error("Add at least one image URL.");
      const images = urls.map((url, i) => ({ url, alt: alts[i] ?? "" }));
      await attachProductImages(admin, productId, images);
      return json<ActionData>({ ok: true, message: `${images.length} image(s) added successfully.` });
    }

    if (intent === "delete-image") {
      const productId = String(formData.get("productId") ?? "").trim();
      const mediaId = String(formData.get("mediaId") ?? "").trim();
      if (!productId || !mediaId) throw new Error("Missing product or media ID.");
      await deleteProductImage(admin, productId, mediaId);
      return json<ActionData>({ ok: true, message: "Image deleted." });
    }

    if (intent === "fetch-product-images") {
      const productId = String(formData.get("productId") ?? "").trim();
      if (!productId) throw new Error("Select a product.");
      const images = await fetchProductImages(admin, productId);
      return json({ images });
    }

    if (intent === "bulk-update-prices") {
      const productIds = formData.getAll("productIds").map(String).filter(Boolean);
      const mode = String(formData.get("priceMode") ?? "percent") as "percent" | "fixed";
      const value = parseFloat(String(formData.get("priceValue") ?? "0")) || 0;
      if (!productIds.length) throw new Error("Select at least one product.");
      const result = await bulkUpdatePrices(admin, productIds, mode, value);
      return json<ActionData>({
        ok: result.errors.length === 0,
        message: `${result.updatedCount} product(s) updated.`,
        errors: result.errors,
      });
    }

    if (intent === "bulk-edit-tags") {
      const productIds = formData.getAll("productIds").map(String).filter(Boolean);
      const tagsToAdd = String(formData.get("tagsToAdd") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const tagsToRemove = String(formData.get("tagsToRemove") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!productIds.length) throw new Error("Select at least one product.");
      const result = await bulkEditTags(admin, productIds, tagsToAdd, tagsToRemove);
      return json<ActionData>({
        ok: result.errors.length === 0,
        message: `Tags updated on ${result.updatedCount} product(s).`,
        errors: result.errors,
      });
    }

    if (intent === "load-no-barcode-products") {
      const products = await fetchProductsWithoutBarcode(admin);
      return json({ noBarcodeProducts: products });
    }

    if (intent === "scan-duplicate-upcs") {
      const groups = await fetchDuplicateUPCs(admin);
      return json({ duplicateUPCs: groups });
    }

    return json<ActionData>({ ok: false, message: "Unknown action." });
  } catch (error) {
    return json<ActionData>({ ok: false, message: error instanceof Error ? error.message : "An unexpected error occurred." }, { status: 400 });
  }
}

// ─── App shell ────────────────────────────────────────────────────────────────

export default function AppDashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const currentParams = new URLSearchParams(location.search);
  const activeView = (tabs as readonly { id: string }[]).some((t) => t.id === data.view) ? data.view : "overview";
  const isSubmitting = navigation.state === "submitting";
  const submittingIntent = String(navigation.formData?.get("intent") ?? "");

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a" }}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 30,
        background: "#0f172a",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        padding: "0 1.5rem", height: "54px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div style={{
            width: "32px", height: "32px", borderRadius: "8px", flexShrink: 0,
            background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "16px", boxShadow: "0 2px 8px rgba(37,99,235,0.45)",
          }}>🧴</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "13px", color: "#f1f5f9", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
              Inventory Manager
            </div>
            <div style={{ fontSize: "10px", color: "#475569", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              Shopify Admin
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          {data.loadWarning && (
            <div style={{
              display: "flex", alignItems: "center", gap: "0.35rem",
              background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.25)",
              padding: "0.28rem 0.65rem", borderRadius: "6px",
            }}>
              <span style={{ fontSize: "11px", color: "#fbbf24" }}>⚠ {data.loadWarning}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <div style={{
              width: "30px", height: "30px", borderRadius: "50%", flexShrink: 0,
              background: "linear-gradient(135deg, #334155, #1e293b)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "11px", fontWeight: 700, color: "#94a3b8",
              border: "1px solid rgba(255,255,255,0.1)",
            }}>
              {(data.shop?.name ?? "S")[0]?.toUpperCase()}
            </div>
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#f1f5f9" }}>{data.shop?.name ?? "Shopify Store"}</div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>{data.shop?.myshopifyDomain ?? ""}</div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Tab bar ────────────────────────────────────────────────── */}
      <nav style={{
        background: "#fff",
        borderBottom: "1px solid #e2e8f0",
        padding: "0 1.5rem",
        display: "flex",
        overflowX: "auto",
        scrollbarWidth: "none" as const,
        WebkitOverflowScrolling: "touch" as CSSProperties["WebkitOverflowScrolling"],
      }}>
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
                padding: "0 1.1rem", height: "44px",
                fontSize: "13px", fontWeight: active ? 600 : 400,
                color: active ? "#1d4ed8" : "#64748b",
                borderBottom: `2px solid ${active ? "#2563eb" : "transparent"}`,
                textDecoration: "none", whiteSpace: "nowrap",
                transition: "color 0.1s", marginBottom: "-1px",
                letterSpacing: "-0.01em",
              }}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* ── Content ────────────────────────────────────────────────── */}
      <main style={{ padding: "1.5rem", maxWidth: "1400px", margin: "0 auto" }}>
        {actionData && "ok" in actionData && (
          <div style={{ marginBottom: "1.25rem" }}>
            <Banner ok={actionData.ok} message={actionData.message} errors={"errors" in actionData ? actionData.errors : undefined} />
          </div>
        )}

        {!data.selectedLocationId && (
          <div style={{ marginBottom: "1.25rem" }}>
            <Banner
              ok={false}
              message="No inventory location is available. Please reinstall or reauthorize the Shopify app, then refresh."
            />
          </div>
        )}

        {activeView === "overview" && (
          <OverviewTab summary={data.summary} locations={data.locations} shop={data.shop} />
        )}

        {activeView === "catalog" && (
          <>
            <div style={{ ...panelStyle, marginBottom: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem", flexWrap: "wrap", gap: "0.5rem" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>Catalog</h2>
                  <p style={{ margin: "0.15rem 0 0", fontSize: "12px", color: "#64748b" }}>
                    {data.products.length} product{data.products.length !== 1 ? "s" : ""} loaded
                    {data.query ? ` · filtered by "${data.query}"` : ""}
                  </p>
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="export" />
                  <input type="hidden" name="query" value={data.query} />
                  <input type="hidden" name="locationId" value={data.selectedLocationId} />
                  <button type="submit" style={darkButton}>↓ Export CSV</button>
                </Form>
              </div>
              <Form method="get" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                <input type="hidden" name="view" value="catalog" />
                <input
                  type="text" name="q"
                  defaultValue={data.query}
                  placeholder="Search by title, SKU, vendor…"
                  style={{ ...inputStyle, flex: "1 1 200px", width: "auto" }}
                />
                <select name="locationId" defaultValue={data.selectedLocationId} style={{ ...inputStyle, width: "auto", flex: "0 0 auto" }}>
                  {data.locations.length === 0 ? <option value="">No location</option> : null}
                  {data.locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                </select>
                <button type="submit" style={primaryButton}>Search</button>
              </Form>
            </div>
            <CatalogPanel
              shopDomain={data.shop?.myshopifyDomain}
              currencyCode={data.shop?.currencyCode ?? "USD"}
              selectedLocationId={data.selectedLocationId}
              products={data.products}
              isSubmitting={isSubmitting}
              submittingIntent={submittingIntent}
            />
          </>
        )}

        {activeView === "imports" && (
          <ImportsTab
            selectedLocationId={data.selectedLocationId}
            isSubmitting={isSubmitting}
            csvTemplate={data.csvTemplate}
          />
        )}

        {activeView === "supplier" && (
          <SupplierPanel selectedLocationId={data.selectedLocationId} isSubmitting={isSubmitting} />
        )}

        {activeView === "images" && (
          <ImagesTab products={data.products} />
        )}

        {activeView === "operations" && (
          <OperationsPanel
            selectedLocationId={data.selectedLocationId}
            query={data.query}
            products={data.products}
            isSubmitting={isSubmitting}
            submittingIntent={submittingIntent}
          />
        )}
      </main>
    </div>
  );
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function Banner({ ok, message, errors }: { ok: boolean; message: string; errors?: string[] }) {
  return (
    <div style={{
      display: "flex", gap: "0.75rem", alignItems: "flex-start",
      padding: "0.85rem 1rem",
      background: ok ? "#f0fdf4" : "#fef2f2",
      border: `1px solid ${ok ? "#86efac" : "#fca5a5"}`,
      borderRadius: "10px",
      fontSize: "13px",
      color: ok ? "#166534" : "#991b1b",
    }}>
      <span style={{
        flexShrink: 0, width: "20px", height: "20px", borderRadius: "50%",
        background: ok ? "#22c55e" : "#ef4444",
        color: "#fff", fontSize: "11px", fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center", marginTop: "1px",
      }}>
        {ok ? "✓" : "✕"}
      </span>
      <div>
        <strong>{message}</strong>
        {errors?.length ? (
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.25rem", lineHeight: 1.7 }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  summary,
  locations,
  shop,
}: {
  summary: { productCount: number; variantCount: number; inventoryUnits: number; totalStoreProducts: number };
  locations: { id: string; name: string }[];
  shop: { name?: string; myshopifyDomain?: string; currencyCode?: string } | null | undefined;
}) {
  const displayCount = summary.totalStoreProducts > 0 ? summary.totalStoreProducts : summary.productCount;
  const metrics = [
    { label: "Products",        value: displayCount,           accent: "#6366f1", bg: "#f5f3ff", icon: "🛍️", note: summary.totalStoreProducts > 0 ? "store total" : undefined },
    { label: "Variants",        value: summary.variantCount,   accent: "#0ea5e9", bg: "#f0f9ff", icon: "🔀" },
    { label: "Inventory units", value: summary.inventoryUnits, accent: "#22c55e", bg: "#f0fdf4", icon: "📦" },
    { label: "Locations",       value: locations.length,       accent: "#f59e0b", bg: "#fffbeb", icon: "📍" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem" }}>
        {metrics.map((m) => (
          <article key={m.label} style={{
            ...panelStyle, padding: "1.25rem",
            borderTop: `3px solid ${m.accent}`,
            display: "flex", flexDirection: "column", gap: "0.75rem",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{
                fontSize: "10px", fontWeight: 700, textTransform: "uppercase",
                letterSpacing: "0.07em", color: "#64748b",
              }}>{m.label}</span>
              <span style={{
                width: "30px", height: "30px", borderRadius: "8px",
                background: m.bg,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px",
              }}>{m.icon}</span>
            </div>
            <strong style={{ fontSize: "28px", fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", lineHeight: 1 }}>
              {m.value.toLocaleString()}
            </strong>
            {"note" in m && m.note && (
              <span style={{ fontSize: "10px", color: "#94a3b8", marginTop: "-0.4rem" }}>{m.note}</span>
            )}
          </article>
        ))}
      </div>

      {/* Store info */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1rem" }}>
        <article style={panelStyle}>
          <h2 style={{ margin: "0 0 1rem", fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>Store info</h2>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[
              { label: "Store name", value: shop?.name ?? "—" },
              { label: "Domain",     value: shop?.myshopifyDomain ?? "—" },
              { label: "Currency",   value: shop?.currencyCode ?? "—" },
              { label: "Locations",  value: locations.map((l) => l.name).join(", ") || "—" },
            ].map(({ label, value }, i, arr) => (
              <div key={label} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "0.6rem 0",
                borderBottom: i < arr.length - 1 ? "1px solid #f1f5f9" : "none",
                gap: "1rem",
              }}>
                <span style={{ fontSize: "12px", color: "#64748b" }}>{label}</span>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a", textAlign: "right" }}>{value}</span>
              </div>
            ))}
          </div>
        </article>

        <article style={{ ...panelStyle, background: "linear-gradient(135deg, #fffbeb 0%, #fff7ed 100%)", border: "1px solid #fed7aa" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "14px", fontWeight: 700, color: "#92400e" }}>Quick start</h2>
          <p style={{ margin: "0 0 1rem", fontSize: "12px", color: "#b45309", lineHeight: 1.6 }}>
            Use the tabs above to manage your inventory.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", fontSize: "12px", color: "#78350f" }}>
            {[
              ["🗂️ Catalog", "Browse, search and edit products"],
              ["📥 Import",  "Create products or import via CSV"],
              ["📦 Supplier","Normalize Excel/CSV supplier files"],
              ["⚙️ Operations","Bulk delete zero-price products"],
            ].map(([icon, desc]) => (
              <div key={icon} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, minWidth: "90px" }}>{icon}</span>
                <span style={{ color: "#92400e" }}>{desc}</span>
              </div>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}

// ─── Imports tab ──────────────────────────────────────────────────────────────

function ImportsTab({
  selectedLocationId,
  isSubmitting,
  csvTemplate,
}: {
  selectedLocationId: string;
  isSubmitting: boolean;
  csvTemplate: string;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "1.25rem" }}>
      {/* Create product */}
      <article style={panelStyle}>
        <h2 style={{ margin: "0 0 1.1rem", fontSize: "14px", fontWeight: 700 }}>Create product</h2>
        <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          <input type="hidden" name="intent" value="create-product" />
          <input type="hidden" name="locationId" value={selectedLocationId} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
            <Field label="Title *"><input name="title" placeholder="e.g. Chanel N°5" required style={inputStyle} /></Field>
            <Field label="SKU *"><input name="sku" placeholder="e.g. CH-N5-100" required style={inputStyle} /></Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
            <Field label="Retail price"><input name="price" type="number" step="0.01" min="0" placeholder="0.00" style={inputStyle} /></Field>
            <Field label="Quantity"><input name="quantity" type="number" step="1" placeholder="0" defaultValue={0} style={inputStyle} /></Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
            <Field label="Wholesale price"><input name="wholesalePrice" type="number" step="0.01" min="0" placeholder="0.00" style={inputStyle} /></Field>
            <Field label="Cost"><input name="cost" type="number" step="0.01" min="0" placeholder="0.00" style={inputStyle} /></Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
            <Field label="Compare-at price"><input name="compareAtPrice" type="number" step="0.01" min="0" placeholder="0.00" style={inputStyle} /></Field>
            <Field label="Barcode / UPC"><input name="barcode" placeholder="Optional" style={inputStyle} /></Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem" }}>
            <Field label="Vendor / Brand"><input name="vendor" placeholder="e.g. Chanel" style={inputStyle} /></Field>
            <Field label="Product type"><input name="productType" placeholder="e.g. Perfume" style={inputStyle} /></Field>
          </div>
          <Field label="Tags"><input name="tags" placeholder="comma separated" style={inputStyle} /></Field>
          <Field label="Status">
            <select name="status" defaultValue="ACTIVE" style={inputStyle}>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </Field>
          <button type="submit" disabled={isSubmitting} style={{ ...primaryButton, marginTop: "0.25rem", width: "100%", padding: "0.65rem" }}>
            {isSubmitting ? "Creating…" : "Create product"}
          </button>
        </Form>
      </article>

      {/* Import + template */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <article style={panelStyle}>
          <h2 style={{ margin: "0 0 0.4rem", fontSize: "14px", fontWeight: 700 }}>Import CSV</h2>
          <p style={{ margin: "0 0 0.9rem", fontSize: "12px", color: "#64748b", lineHeight: 1.6 }}>
            If the SKU already exists the product is updated; otherwise it is created.
          </p>
          <Form method="post" encType="multipart/form-data" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <input type="hidden" name="intent" value="import-csv" />
            <input type="hidden" name="locationId" value={selectedLocationId} />
            <label style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem",
              border: "2px dashed #86efac", borderRadius: "10px", padding: "1.5rem",
              background: "#f0fdf4", cursor: "pointer", color: "#166534", fontSize: "13px", textAlign: "center",
            }}>
              <span style={{ fontSize: "28px" }}>📄</span>
              <span>Click to select a <strong>.csv</strong> file</span>
              <input type="file" name="csvFile" accept=".csv,text/csv" style={{ display: "none" }} />
            </label>
            <button type="submit" disabled={isSubmitting} style={{ ...primaryButton, width: "100%", padding: "0.65rem" }}>
              {isSubmitting ? "Importing…" : "Import inventory"}
            </button>
          </Form>
        </article>

        <article style={{ ...panelStyle, background: "#fffbeb", border: "1px solid #fde68a" }}>
          <h2 style={{ margin: "0 0 0.35rem", fontSize: "13px", fontWeight: 700, color: "#92400e" }}>CSV column reference</h2>
          <p style={{ margin: "0 0 0.6rem", fontSize: "11px", color: "#b45309" }}>These columns are recognized on import.</p>
          <pre style={{
            margin: 0, fontSize: "10.5px", color: "#78350f",
            background: "rgba(255,255,255,0.65)", padding: "0.75rem",
            borderRadius: "6px", whiteSpace: "pre-wrap", lineHeight: 1.8,
          }}>{csvTemplate}</pre>
        </article>
      </div>
    </div>
  );
}

// Field wrapper for labeled inputs
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#374151", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Catalog panel ────────────────────────────────────────────────────────────

type CatalogSortKey = "updated" | "price_asc" | "price_desc" | "stock_asc" | "stock_desc" | "title";

function CatalogPanel({
  shopDomain,
  currencyCode,
  selectedLocationId,
  products,
  isSubmitting,
  submittingIntent,
}: {
  shopDomain?: string;
  currencyCode: string;
  selectedLocationId: string;
  products: Awaited<ReturnType<typeof fetchInventoryDashboard>>["products"];
  isSubmitting: boolean;
  submittingIntent: string;
}) {
  const bulkPriceFetcher = useFetcher<ActionData>();
  const bulkTagFetcher   = useFetcher<ActionData>();

  const [vendorFilter, setVendorFilter] = useState("");
  const [sortKey, setSortKey]           = useState<CatalogSortKey>("updated");
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [bulkPriceMode, setBulkPriceMode] = useState<"percent" | "fixed">("percent");
  const [bulkPriceValue, setBulkPriceValue] = useState("10");
  const [bulkTagsAdd, setBulkTagsAdd]     = useState("");
  const [bulkTagsRemove, setBulkTagsRemove] = useState("");
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState("");
  const hasInventoryLocation = Boolean(selectedLocationId);
  const inlinePriceFetcher = useFetcher<ActionData>();

  const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();

  const sorted = [...products]
    .filter((p) => !vendorFilter || p.vendor === vendorFilter)
    .sort((a, b) => {
      const av = a.variants[0]; const bv = b.variants[0];
      if (sortKey === "price_asc") return (parseFloat(av?.price ?? "0")) - (parseFloat(bv?.price ?? "0"));
      if (sortKey === "price_desc") return (parseFloat(bv?.price ?? "0")) - (parseFloat(av?.price ?? "0"));
      if (sortKey === "stock_asc") return a.totalInventory - b.totalInventory;
      if (sortKey === "stock_desc") return b.totalInventory - a.totalInventory;
      if (sortKey === "title") return a.title.localeCompare(b.title);
      return 0; // "updated" — keep server order
    });

  const allChecked = sorted.length > 0 && sorted.every((p) => selectedIds.has(p.id));

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(sorted.map((p) => p.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  const isBulkUpdatingPrice = bulkPriceFetcher.state !== "idle" && submittingIntent === "";
  const isBulkUpdatingTags  = bulkTagFetcher.state !== "idle";

  const thStyle: CSSProperties = {
    padding: "0.6rem 0.85rem",
    fontSize: "10px", fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.07em",
    color: "#64748b", whiteSpace: "nowrap", textAlign: "left",
  };
  const tdStyle: CSSProperties = {
    padding: "0.8rem 0.85rem", verticalAlign: "top",
    fontSize: "13px", borderTop: "1px solid #f1f5f9",
  };

  return (
    <section style={panelStyle}>
      {/* Filters row */}
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.85rem", alignItems: "center" }}>
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}
          style={{ ...inputStyle, width: "auto", minWidth: "140px" }}>
          <option value="">All vendors</option>
          {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as CatalogSortKey)}
          style={{ ...inputStyle, width: "auto", minWidth: "160px" }}>
          <option value="updated">Sort: Recently updated</option>
          <option value="title">Sort: Title A→Z</option>
          <option value="price_asc">Sort: Price low→high</option>
          <option value="price_desc">Sort: Price high→low</option>
          <option value="stock_asc">Sort: Stock low→high</option>
          <option value="stock_desc">Sort: Stock high→low</option>
        </select>
        {vendorFilter && (
          <span style={{ fontSize: "12px", color: "#64748b" }}>
            {sorted.length} product{sorted.length !== 1 ? "s" : ""} from <strong>{vendorFilter}</strong>
          </span>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div style={{
          background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "10px",
          padding: "0.75rem 1rem", marginBottom: "0.85rem",
          display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end",
        }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#1d4ed8", alignSelf: "center" }}>
            {selectedIds.size} selected
          </span>

          {/* Bulk price */}
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "0.2rem" }}>Price mode</div>
              <select value={bulkPriceMode} onChange={(e) => setBulkPriceMode(e.target.value as "percent" | "fixed")}
                style={{ ...inputStyle, width: "auto", fontSize: "12px" }}>
                <option value="percent">% change</option>
                <option value="fixed">Fixed +/-</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "0.2rem" }}>
                {bulkPriceMode === "percent" ? "%" : currencyCode}
              </div>
              <input type="number" step="0.01" value={bulkPriceValue}
                onChange={(e) => setBulkPriceValue(e.target.value)}
                style={{ ...inputStyle, width: "80px", fontSize: "12px" }}
                placeholder="10" />
            </div>
            <bulkPriceFetcher.Form method="post" onSubmit={(e) => {
              if (!window.confirm(`Apply price change to ${selectedIds.size} product(s)?`)) e.preventDefault();
            }}>
              <input type="hidden" name="intent" value="bulk-update-prices" />
              <input type="hidden" name="priceMode" value={bulkPriceMode} />
              <input type="hidden" name="priceValue" value={bulkPriceValue} />
              {[...selectedIds].map((id) => <input key={id} type="hidden" name="productIds" value={id} />)}
              <button type="submit" disabled={isBulkUpdatingPrice}
                style={{ ...primaryButton, fontSize: "12px", padding: "0.42rem 0.75rem" }}>
                {isBulkUpdatingPrice ? "Updating…" : "Apply price"}
              </button>
            </bulkPriceFetcher.Form>
          </div>

          <div style={{ width: "1px", height: "32px", background: "#bfdbfe", alignSelf: "center" }} />

          {/* Bulk tags */}
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "0.2rem" }}>Add tags</div>
              <input type="text" value={bulkTagsAdd} onChange={(e) => setBulkTagsAdd(e.target.value)}
                placeholder="tag1, tag2" style={{ ...inputStyle, width: "130px", fontSize: "12px" }} />
            </div>
            <div>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: "0.2rem" }}>Remove tags</div>
              <input type="text" value={bulkTagsRemove} onChange={(e) => setBulkTagsRemove(e.target.value)}
                placeholder="tag1, tag2" style={{ ...inputStyle, width: "130px", fontSize: "12px" }} />
            </div>
            <bulkTagFetcher.Form method="post">
              <input type="hidden" name="intent" value="bulk-edit-tags" />
              <input type="hidden" name="tagsToAdd" value={bulkTagsAdd} />
              <input type="hidden" name="tagsToRemove" value={bulkTagsRemove} />
              {[...selectedIds].map((id) => <input key={id} type="hidden" name="productIds" value={id} />)}
              <button type="submit" disabled={isBulkUpdatingTags || (!bulkTagsAdd && !bulkTagsRemove)}
                style={{ ...darkButton, fontSize: "12px", padding: "0.42rem 0.75rem", background: "#f5f3ff", borderColor: "#c4b5fd", color: "#6d28d9" }}>
                {isBulkUpdatingTags ? "Updating…" : "Apply tags"}
              </button>
            </bulkTagFetcher.Form>
          </div>

          <button type="button" onClick={() => setSelectedIds(new Set())}
            style={{ ...darkButton, fontSize: "12px", padding: "0.42rem 0.65rem", alignSelf: "flex-end" }}>
            Clear
          </button>
        </div>
      )}

      {/* Bulk fetcher result banners */}
      {bulkPriceFetcher.data && "ok" in bulkPriceFetcher.data && (
        <div style={{ marginBottom: "0.75rem" }}>
          <Banner ok={bulkPriceFetcher.data.ok} message={bulkPriceFetcher.data.message}
            errors={"errors" in bulkPriceFetcher.data ? bulkPriceFetcher.data.errors : undefined} />
        </div>
      )}
      {bulkTagFetcher.data && "ok" in bulkTagFetcher.data && (
        <div style={{ marginBottom: "0.75rem" }}>
          <Banner ok={bulkTagFetcher.data.ok} message={bulkTagFetcher.data.message}
            errors={"errors" in bulkTagFetcher.data ? bulkTagFetcher.data.errors : undefined} />
        </div>
      )}

      <Form method="post">
        <input type="hidden" name="intent" value="delete-products" />
        <input type="hidden" name="locationId" value={selectedLocationId} />

        <div style={{ overflowX: "auto", margin: "0 -1.5rem", padding: "0 1.5rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "960px" }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
                <th style={{ ...thStyle, width: "36px" }}>
                  <input type="checkbox" checked={allChecked} style={{ cursor: "pointer" }}
                    onChange={(e) => toggleAll(e.target.checked)} />
                </th>
                <th style={thStyle}>Product</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>SKU / Barcode</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                <th style={thStyle}>Stock</th>
                <th style={thStyle}>Actions</th>
                <th style={thStyle}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "3rem", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                    <div style={{ fontSize: "32px", marginBottom: "0.5rem" }}>🔍</div>
                    No products match this filter.
                  </td>
                </tr>
              ) : sorted.map((product, rowIndex) => {
                const variant = product.variants[0];
                const level = variant?.inventoryLevels.find((item) => item.locationId === selectedLocationId);
                const badge = statusBadge(product.status);
                const isEditingPrice = editingPriceId === product.id;
                // Pricing sanity flags
                const price   = parseFloat(variant?.price ?? "0");
                const cost    = parseFloat(variant?.cost ?? "0");
                const ws      = parseFloat(variant?.wholesalePrice ?? "0");
                const priceSanityWarn = (cost > 0 && cost > price) || (ws > 0 && ws > price);
                return (
                  <tr key={product.id} style={{ background: priceSanityWarn ? "#fffbeb" : rowIndex % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={{ ...tdStyle, width: "36px" }}>
                      <input type="checkbox" name="productIds" value={product.id}
                        checked={selectedIds.has(product.id)}
                        onChange={(e) => toggleOne(product.id, e.target.checked)}
                        style={{ cursor: "pointer" }} />
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600, color: "#0f172a", lineHeight: 1.3, maxWidth: "240px" }}>{product.title}</div>
                      <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "0.2rem" }}>
                        {product.vendor || "No vendor"}{product.productType ? ` · ${product.productType}` : ""}
                      </div>
                      {priceSanityWarn && (
                        <div style={{ fontSize: "10px", color: "#b45309", marginTop: "0.2rem", fontWeight: 600 }}>
                          ⚠ Cost or wholesale exceeds retail
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        display: "inline-flex", padding: "0.25rem 0.6rem", borderRadius: "999px",
                        fontSize: "11px", fontWeight: 700,
                        background: badge.bg, color: badge.color,
                      }}>{badge.label}</span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600, color: "#374151" }}>
                        {variant?.sku || <span style={{ color: "#94a3b8", fontFamily: "inherit", fontWeight: 400 }}>No SKU</span>}
                      </div>
                      {variant?.barcode ? (
                        <div style={{ fontSize: "11px", color: "#64748b", marginTop: "0.15rem" }}>UPC: {variant.barcode}</div>
                      ) : (
                        <div style={{ fontSize: "11px", color: "#f59e0b", marginTop: "0.15rem" }}>No barcode</div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                      {isEditingPrice ? (
                        <inlinePriceFetcher.Form method="post" style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-end" }}>
                          <input type="hidden" name="intent" value="update-product" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="variantId" value={variant?.id ?? ""} />
                          <input type="hidden" name="inventoryItemId" value={variant?.inventoryItemId ?? ""} />
                          <input type="hidden" name="title" value={product.title} />
                          <input type="hidden" name="sku" value={variant?.sku ?? ""} />
                          <input type="hidden" name="compareAtPrice" value={variant?.compareAtPrice ?? ""} />
                          <input type="hidden" name="wholesalePrice" value={variant?.wholesalePrice ?? ""} />
                          <input type="hidden" name="cost" value={variant?.cost ?? ""} />
                          <input type="hidden" name="quantity" value={String(level?.available ?? variant?.inventoryQuantity ?? 0)} />
                          <input type="hidden" name="barcode" value={variant?.barcode ?? ""} />
                          <input type="hidden" name="vendor" value={product.vendor} />
                          <input type="hidden" name="productType" value={product.productType} />
                          <input type="hidden" name="tags" value={product.tags.join(", ")} />
                          <input type="hidden" name="status" value={product.status} />
                          <input type="number" name="price" step="0.01" value={editingPriceValue}
                            onChange={(e) => setEditingPriceValue(e.target.value)}
                            style={{ ...inputStyle, width: "90px", textAlign: "right", fontSize: "13px", fontWeight: 700 }}
                            autoFocus />
                          <div style={{ display: "flex", gap: "0.25rem" }}>
                            <button type="submit" style={{ ...primaryButton, fontSize: "11px", padding: "0.25rem 0.5rem" }}>✓</button>
                            <button type="button" onClick={() => setEditingPriceId(null)}
                              style={{ ...darkButton, fontSize: "11px", padding: "0.25rem 0.5rem" }}>✕</button>
                          </div>
                        </inlinePriceFetcher.Form>
                      ) : (
                        <div
                          onClick={() => { setEditingPriceId(product.id); setEditingPriceValue(variant?.price ?? "0"); }}
                          title="Click to edit price"
                          style={{ cursor: "pointer", padding: "0.2rem 0.4rem", borderRadius: "4px", display: "inline-block" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#eff6ff")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ fontWeight: 700, fontSize: "13px" }}>
                            {variant?.price ?? "0.00"} <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "11px" }}>{currencyCode}</span>
                          </div>
                          {variant?.wholesalePrice ? <div style={{ fontSize: "11px", color: "#7c3aed", marginTop: "0.1rem" }}>WS: {variant.wholesalePrice}</div> : null}
                          {variant?.cost ? <div style={{ fontSize: "11px", color: "#64748b", marginTop: "0.1rem" }}>Cost: {variant.cost}</div> : null}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {variant ? (
                        <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                          <input type="hidden" name="intent" value="update-inventory" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
                          <input
                            type="number" name="quantity"
                            defaultValue={level?.available ?? variant.inventoryQuantity}
                            disabled={!hasInventoryLocation}
                            style={{ ...inputStyle, width: "80px", textAlign: "center" }}
                          />
                          <button
                            type="submit"
                            disabled={!hasInventoryLocation}
                            title={!hasInventoryLocation ? "Reauthorize the app with read_locations first." : undefined}
                            style={{ ...primaryButton, padding: "0.42rem 0.65rem", fontSize: "12px", opacity: hasInventoryLocation ? 1 : 0.6 }}
                          >
                            Save
                          </button>
                        </Form>
                      ) : <span style={{ color: "#94a3b8", fontSize: "12px" }}>—</span>}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                        <a href={productAdminUrl(shopDomain, product.id)} target="_top" rel="noreferrer"
                          style={{ ...darkButton, fontSize: "12px", padding: "0.35rem 0.65rem", textDecoration: "none" }}>
                          ↗ Open
                        </a>
                        {variant ? (
                          <details style={{ position: "relative" }}>
                            <summary style={{ ...darkButton, fontSize: "12px", padding: "0.35rem 0.65rem", listStyle: "none", userSelect: "none" }}>
                              Edit
                            </summary>
                            <div style={{
                              position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10,
                              background: "#fff", border: "1px solid #e2e8f0", borderRadius: "10px",
                              padding: "1rem", width: "420px", maxWidth: "90vw",
                              boxShadow: "0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
                            }}>
                              <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                                <input type="hidden" name="intent" value="update-product" />
                                <input type="hidden" name="locationId" value={selectedLocationId} />
                                <input type="hidden" name="productId" value={product.id} />
                                <input type="hidden" name="variantId" value={variant.id} />
                                <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
                                  <Field label="Title"><input name="title" defaultValue={product.title} style={inputStyle} /></Field>
                                  <Field label="SKU"><input name="sku" defaultValue={variant.sku} style={inputStyle} /></Field>
                                  <Field label="Price"><input name="price" type="number" step="0.01" defaultValue={variant.price} style={inputStyle} /></Field>
                                  <Field label="Quantity"><input name="quantity" type="number" defaultValue={level?.available ?? variant.inventoryQuantity} style={inputStyle} /></Field>
                                  <Field label="Wholesale"><input name="wholesalePrice" type="number" step="0.01" defaultValue={variant.wholesalePrice} style={inputStyle} /></Field>
                                  <Field label="Cost"><input name="cost" type="number" step="0.01" defaultValue={variant.cost} style={inputStyle} /></Field>
                                  <Field label="Compare-at"><input name="compareAtPrice" type="number" step="0.01" defaultValue={variant.compareAtPrice} style={inputStyle} /></Field>
                                  <Field label="Barcode"><input name="barcode" defaultValue={variant.barcode} style={inputStyle} /></Field>
                                  <Field label="Vendor"><input name="vendor" defaultValue={product.vendor} style={inputStyle} /></Field>
                                  <Field label="Type"><input name="productType" defaultValue={product.productType} style={inputStyle} /></Field>
                                </div>
                                <Field label="Tags"><input name="tags" defaultValue={product.tags.join(", ")} style={inputStyle} /></Field>
                                <Field label="Status">
                                  <select name="status" defaultValue={product.status} style={inputStyle}>
                                    <option value="ACTIVE">Active</option>
                                    <option value="DRAFT">Draft</option>
                                    <option value="ARCHIVED">Archived</option>
                                  </select>
                                </Field>
                                <button type="submit" style={{ ...primaryButton, width: "100%", padding: "0.6rem" }}>
                                  Save changes
                                </button>
                              </Form>
                            </div>
                          </details>
                        ) : null}
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="delete-products" />
                          <input type="hidden" name="locationId" value={selectedLocationId} />
                          <input type="hidden" name="productIds" value={product.id} />
                          <button type="submit"
                            onClick={(e) => { if (!window.confirm(`Delete "${product.title}"?`)) e.preventDefault(); }}
                            style={{ ...darkButton, fontSize: "12px", padding: "0.35rem 0.65rem", background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca" }}>
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontSize: "11px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                      {formatDate(product.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {sorted.length > 0 && (
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>Check boxes then use bulk actions bar above, or delete selected below.</span>
            <button type="submit" disabled={isSubmitting} style={{ ...darkButton, background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca" }}>
              Delete selected
            </button>
          </div>
        )}
      </Form>
    </section>
  );
}

// ─── Operations tab ───────────────────────────────────────────────────────────

function OperationsPanel({
  selectedLocationId,
  query,
  products,
  isSubmitting,
  submittingIntent,
}: {
  selectedLocationId: string;
  query: string;
  products: Awaited<ReturnType<typeof fetchInventoryDashboard>>["products"];
  isSubmitting: boolean;
  submittingIntent: string;
}) {
  const noBarcodeFetcher = useFetcher<{ noBarcodeProducts?: NoBarcodeProduct[] }>();
  const dupUPCFetcher    = useFetcher<{ duplicateUPCs?: DuplicateUPCGroup[] }>();
  const hasInventoryLocation = Boolean(selectedLocationId);

  const zeroInView = products.filter((p) => p.variants.some((v) => Number(v.price ?? "0") === 0));
  const zeroStockVariants = products.flatMap((product) =>
    product.variants.filter((variant) => {
      const level = variant.inventoryLevels.find((item) => item.locationId === selectedLocationId);
      const quantity = level?.available ?? variant.inventoryQuantity ?? 0;
      return variant.tracked && quantity === 0;
    })
  );
  const zeroStockVariantsInView = products.reduce((total, product) => {
    return total + product.variants.filter((variant) => {
      const level = variant.inventoryLevels.find((item) => item.locationId === selectedLocationId);
      const quantity = level?.available ?? variant.inventoryQuantity ?? 0;
      return variant.tracked && quantity === 0;
    }).length;
  }, 0);
  const priceSanityIssues = products.filter((p) => {
    const v = p.variants[0];
    if (!v) return false;
    const price = parseFloat(v.price ?? "0");
    const cost  = parseFloat(v.cost ?? "0");
    const ws    = parseFloat(v.wholesalePrice ?? "0");
    return (cost > 0 && cost > price) || (ws > 0 && ws > price);
  });

  const deletingView = isSubmitting && submittingIntent === "delete-products-with-zero-price";
  const deletingAll  = isSubmitting && submittingIntent === "delete-all-products-with-zero-price";
  const fixingZeroStock = isSubmitting && submittingIntent === "set-zero-stock-to-two";

  const noBarcodeProducts = noBarcodeFetcher.data?.noBarcodeProducts ?? null;
  const duplicateUPCs     = dupUPCFetcher.data?.duplicateUPCs ?? null;
  const isScanningBarcode = noBarcodeFetcher.state !== "idle";
  const isScanningUPC     = dupUPCFetcher.state !== "idle";

  const opRow = (content: React.ReactNode): CSSProperties => ({
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: "1rem", flexWrap: "wrap",
    background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px",
    padding: "0.85rem 1rem",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "860px" }}>

      {/* ── Pricing sanity ── */}
      {priceSanityIssues.length > 0 && (
        <article style={{ ...panelStyle, border: "1px solid #fde68a", background: "#fffbeb" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.85rem" }}>
            <span style={{ background: "#fef3c7", color: "#d97706", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", flexShrink: 0 }}>⚠</span>
            <div>
              <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#92400e" }}>Pricing sanity issues</h2>
              <p style={{ margin: 0, fontSize: "12px", color: "#b45309" }}>{priceSanityIssues.length} product(s) where cost or wholesale exceeds retail price.</p>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {priceSanityIssues.slice(0, 20).map((p) => {
              const v = p.variants[0]!;
              return (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.45rem 0.7rem", background: "#fff", borderRadius: "6px", border: "1px solid #fde68a", fontSize: "12px", gap: "1rem", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, color: "#0f172a" }}>{p.title}</span>
                  <span style={{ color: "#92400e", whiteSpace: "nowrap" }}>
                    Retail {v.price} · Cost {v.cost || "—"} · WS {v.wholesalePrice || "—"}
                  </span>
                </div>
              );
            })}
            {priceSanityIssues.length > 20 && <p style={{ margin: "0.2rem 0 0", fontSize: "11px", color: "#94a3b8" }}>…and {priceSanityIssues.length - 20} more</p>}
          </div>
        </article>
      )}

      {/* ── No-barcode scanner ── */}
      <article style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: noBarcodeProducts !== null ? "0.85rem" : 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>Products without barcode</h2>
            <p style={{ margin: "0.15rem 0 0", fontSize: "12px", color: "#64748b" }}>
              {noBarcodeProducts !== null ? `${noBarcodeProducts.length} product(s) missing a UPC/barcode.` : "Scan entire catalog for products with no barcode."}
            </p>
          </div>
          <button type="button" disabled={isScanningBarcode}
            style={{ ...darkButton, background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}
            onClick={() => {
              const fd = new FormData(); fd.append("intent", "load-no-barcode-products");
              noBarcodeFetcher.submit(fd, { method: "post" });
            }}>
            {isScanningBarcode ? "Scanning…" : "Scan for missing barcodes"}
          </button>
        </div>
        {noBarcodeProducts !== null && noBarcodeProducts.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {noBarcodeProducts.slice(0, 30).map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0.7rem", background: "#fafafa", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "12px", gap: "1rem" }}>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{p.title}</span>
                <span style={{ color: "#64748b" }}>{p.vendor || "—"} · SKU: {p.sku || "—"}</span>
              </div>
            ))}
            {noBarcodeProducts.length > 30 && <p style={{ margin: "0.2rem 0 0", fontSize: "11px", color: "#94a3b8" }}>…and {noBarcodeProducts.length - 30} more</p>}
          </div>
        )}
        {noBarcodeProducts !== null && noBarcodeProducts.length === 0 && (
          <p style={{ margin: 0, fontSize: "12px", color: "#15803d" }}>✓ All products have a barcode.</p>
        )}
      </article>

      {/* ── Duplicate UPC scanner ── */}
      <article style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: duplicateUPCs !== null ? "0.85rem" : 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>Duplicate UPCs</h2>
            <p style={{ margin: "0.15rem 0 0", fontSize: "12px", color: "#64748b" }}>
              {duplicateUPCs !== null ? `${duplicateUPCs.length} barcode(s) shared by multiple products.` : "Find barcodes assigned to more than one product."}
            </p>
          </div>
          <button type="button" disabled={isScanningUPC}
            style={{ ...darkButton, background: "#faf5ff", borderColor: "#ddd6fe", color: "#6d28d9" }}
            onClick={() => {
              const fd = new FormData(); fd.append("intent", "scan-duplicate-upcs");
              dupUPCFetcher.submit(fd, { method: "post" });
            }}>
            {isScanningUPC ? "Scanning…" : "Scan for duplicate UPCs"}
          </button>
        </div>
        {duplicateUPCs !== null && duplicateUPCs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {duplicateUPCs.slice(0, 20).map((g) => (
              <div key={g.barcode} style={{ background: "#faf5ff", border: "1px solid #ddd6fe", borderRadius: "8px", padding: "0.6rem 0.85rem" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#6d28d9", fontFamily: "monospace", marginBottom: "0.3rem" }}>
                  UPC: {g.barcode} <span style={{ fontWeight: 400, color: "#7c3aed" }}>({g.products.length} products)</span>
                </div>
                {g.products.map((p) => (
                  <div key={p.id} style={{ fontSize: "12px", color: "#374151", paddingLeft: "0.5rem" }}>
                    {p.title} {p.sku ? `· SKU: ${p.sku}` : ""} {p.vendor ? `· ${p.vendor}` : ""}
                  </div>
                ))}
              </div>
            ))}
            {duplicateUPCs.length > 20 && <p style={{ margin: "0.2rem 0 0", fontSize: "11px", color: "#94a3b8" }}>…and {duplicateUPCs.length - 20} more</p>}
          </div>
        )}
        {duplicateUPCs !== null && duplicateUPCs.length === 0 && (
          <p style={{ margin: 0, fontSize: "12px", color: "#15803d" }}>✓ No duplicate barcodes found.</p>
        )}
      </article>

      {/* ── Zero-stock fixer ── */}
      <article style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>Fix stock 0 to 2</h2>
            <p style={{ margin: "0.15rem 0 0", fontSize: "12px", color: "#64748b" }}>
              Applies to the current filtered view and only to tracked variants with stock 0.{" "}
              {zeroStockVariantsInView > 0
                ? <strong style={{ color: "#b45309" }}>{zeroStockVariantsInView} variant(s) found.</strong>
                : "None found."}
            </p>
          </div>
          <Form method="post" onSubmit={(e) => { if (!window.confirm(`Set ${zeroStockVariantsInView} zero-stock variant(s) to quantity 2?`)) e.preventDefault(); }}>
            <input type="hidden" name="intent" value="set-zero-stock-to-two" />
            <input type="hidden" name="locationId" value={selectedLocationId} />
            <input type="hidden" name="query" value={query} />
            {zeroStockVariants.map((variant) => (
              <input key={variant.inventoryItemId} type="hidden" name="inventoryItemIds" value={variant.inventoryItemId} />
            ))}
            <button
              type="submit"
              disabled={isSubmitting || zeroStockVariantsInView === 0 || !hasInventoryLocation}
              title={!hasInventoryLocation ? "Reauthorize the app with read_locations first." : undefined}
              style={{ ...darkButton, background: "#fffbeb", color: "#b45309", borderColor: "#fcd34d" }}
            >
              {fixingZeroStock ? "Updating..." : "Set stock 0 -> 2"}
            </button>
          </Form>
        </div>
      </article>

      {/* ── Danger Zone ── */}
      <article style={{ ...panelStyle, border: "1px solid #fca5a5", background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
          <span style={{
            background: "#fee2e2", color: "#dc2626", borderRadius: "8px",
            width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "15px", flexShrink: 0,
          }}>⚠</span>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#991b1b" }}>Danger Zone</h2>
            <p style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>These actions permanently delete products and cannot be undone.</p>
          </div>
        </div>

        <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div style={opRow(null)}>
            <div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a", marginBottom: "0.2rem" }}>
                Delete $0.00 products — current view
              </div>
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                Affects only current search filter.{" "}
                {zeroInView.length > 0
                  ? <strong style={{ color: "#dc2626" }}>{zeroInView.length} found.</strong>
                  : "None found."}
              </div>
            </div>
            <Form method="post" onSubmit={(e) => { if (!window.confirm(`Delete ${zeroInView.length} zero-price product(s)?`)) e.preventDefault(); }}>
              <input type="hidden" name="intent" value="delete-products-with-zero-price" />
              <input type="hidden" name="locationId" value={selectedLocationId} />
              <input type="hidden" name="query" value={query} />
              <button type="submit" disabled={isSubmitting || zeroInView.length === 0}
                style={{ ...darkButton, background: "#fef2f2", color: "#dc2626", borderColor: "#fca5a5" }}>
                {deletingView ? "Deleting…" : "Delete view 0.00"}
              </button>
            </Form>
          </div>

          <div style={opRow(null)}>
            <div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a", marginBottom: "0.2rem" }}>
                Delete $0.00 products — entire store
              </div>
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                Scans all products in the store. May take a few seconds.
              </div>
            </div>
            <Form method="post" onSubmit={(e) => { if (!window.confirm("Delete ALL zero-price products from the entire store?")) e.preventDefault(); }}>
              <input type="hidden" name="intent" value="delete-all-products-with-zero-price" />
              <button type="submit" disabled={isSubmitting}
                style={{ ...darkButton, background: "#fef2f2", color: "#dc2626", borderColor: "#fca5a5" }}>
                {deletingAll ? "Deleting…" : "Delete all 0.00"}
              </button>
            </Form>
          </div>
        </div>
      </article>

      {zeroInView.length > 0 && (
        <article style={panelStyle}>
          <h2 style={{ margin: "0 0 0.85rem", fontSize: "13px", fontWeight: 700 }}>
            Zero-price products in view <span style={{ color: "#dc2626", marginLeft: "0.25rem" }}>({zeroInView.length})</span>
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {zeroInView.slice(0, 30).map((p) => (
              <div key={p.id} style={{
                display: "flex", justifyContent: "space-between",
                padding: "0.45rem 0.7rem", background: "#fef2f2",
                borderRadius: "6px", border: "1px solid #fecaca", fontSize: "12px",
              }}>
                <span style={{ color: "#374151" }}>{p.title}</span>
                <span style={{ color: "#dc2626", fontWeight: 700 }}>$0.00</span>
              </div>
            ))}
            {zeroInView.length > 30 && (
              <p style={{ margin: "0.25rem 0 0", fontSize: "11px", color: "#94a3b8" }}>
                …and {zeroInView.length - 30} more
              </p>
            )}
          </div>
        </article>
      )}
    </div>
  );
}

// ─── Import queue ─────────────────────────────────────────────────────────────

function ProductQueueRow({
  index,
  product,
  locationId,
  onSkip,
  onStatusChange,
}: {
  index: number;
  product: ProductGroupInput;
  locationId: string;
  onSkip: () => void;
  onStatusChange: (status: "done" | "error") => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const isImporting = fetcher.state !== "idle";
  const isDone  = fetcher.data && "ok" in fetcher.data && fetcher.data.ok;
  const isError = fetcher.data && "ok" in fetcher.data && !fetcher.data.ok;
  const errorMsg = isError && "message" in fetcher.data! ? (fetcher.data as { message: string }).message : "";
  const reportedRef = React.useRef(false);

  React.useEffect(() => {
    if (!reportedRef.current && fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data) {
      reportedRef.current = true;
      onStatusChange(fetcher.data.ok ? "done" : "error");
    }
  }, [fetcher.state, fetcher.data, onStatusChange]);

  const v0 = product.variants[0];
  const multi = product.variants.length > 1;
  const priceRange = multi
    ? `$${Math.min(...product.variants.map(v => parseFloat(v.price) || 0)).toFixed(2)}–$${Math.max(...product.variants.map(v => parseFloat(v.price) || 0)).toFixed(2)}`
    : v0 ? `$${v0.price}` : "—";

  const cell: CSSProperties = { padding: "0.6rem 0.65rem", verticalAlign: "top", fontSize: "12px", borderTop: "1px solid #f1f5f9" };

  if (isDone) {
    return (
      <tr style={{ background: "#f0fdf4" }}>
        <td colSpan={7} style={{ padding: "0.45rem 0.75rem", fontSize: "11px", color: "#166534" }}>
          ✓ #{index} — <strong>{product.title}</strong>{multi ? ` (${product.variants.length} variants)` : ""}
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: isError ? "#fef2f2" : "transparent" }}>
      <td style={{ ...cell, color: "#94a3b8", textAlign: "center", width: "2rem", fontWeight: 600 }}>{index}</td>
      <td style={cell}>
        <div style={{ fontWeight: 600, color: "#0f172a" }}>{product.title}</div>
        {multi && (
          <div style={{ fontSize: "10px", color: "#64748b", marginTop: "0.15rem" }}>
            {product.variants.map(v => v.title).join(" · ")}
          </div>
        )}
        {isError && <div style={{ color: "#dc2626", fontSize: "11px", marginTop: "0.2rem" }}>{errorMsg}</div>}
      </td>
      <td style={{ ...cell, color: "#64748b" }}>{product.vendor || "—"}</td>
      <td style={{ ...cell, textAlign: "center" }}>
        <span style={{
          display: "inline-flex", alignItems: "center",
          background: multi ? "#e0f2fe" : "#f1f5f9",
          color: multi ? "#0369a1" : "#64748b",
          borderRadius: "999px", fontSize: "10px", fontWeight: 700,
          padding: "0.15rem 0.55rem", whiteSpace: "nowrap",
        }}>
          {product.variants.length} {product.variants.length === 1 ? "variant" : "variants"}
        </span>
      </td>
      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 }}>
        {priceRange}
      </td>
      <td style={{ ...cell, maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#64748b", fontSize: "11px" }}>
        {product.tags.slice(0, 4).join(", ")}
        {product.tags.length > 4 ? ` +${product.tags.length - 4}` : ""}
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <fetcher.Form method="post" style={{ display: "flex", gap: "0.35rem" }}>
          <input type="hidden" name="intent" value="import-single-product" />
          <input type="hidden" name="locationId" value={locationId} />
          <input type="hidden" name="productJson" value={JSON.stringify(product)} />
          <button type="submit" disabled={isImporting}
            style={{ ...primaryButton, fontSize: "11px", padding: "0.3rem 0.6rem" }}>
            {isImporting ? "…" : "Import"}
          </button>
          <button type="button" onClick={onSkip} disabled={isImporting}
            style={{ ...darkButton, fontSize: "11px", padding: "0.3rem 0.6rem" }}>
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
  products: ProductGroupInput[];
  locationId: string;
  onClose: () => void;
}) {
  const [skipped, setSkipped] = React.useState<Set<number>>(new Set());
  const [importedCount, setImportedCount] = React.useState(0);
  const [errorCount, setErrorCount]   = React.useState(0);
  const [filter, setFilter]           = React.useState("");
  const [page, setPage]               = React.useState(0);
  const PAGE_SIZE = 30;

  const handleStatusChange = React.useCallback((status: "done" | "error") => {
    if (status === "done") setImportedCount((n) => n + 1);
    else setErrorCount((n) => n + 1);
  }, []);

  const filtered = products
    .map((p, i) => ({ p, i }))
    .filter(({ i, p }) =>
      !skipped.has(i) &&
      (!filter ||
        p.title.toLowerCase().includes(filter.toLowerCase()) ||
        (p.variants[0]?.sku ?? "").toLowerCase().includes(filter.toLowerCase()) ||
        p.vendor.toLowerCase().includes(filter.toLowerCase()))
    );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);
  const pageItems  = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const remaining  = products.length - importedCount - skipped.size - errorCount;

  const stats = [
    { label: "Total",     value: products.length,        color: "#374151", bg: "#f8fafc", border: "#e2e8f0" },
    { label: "Imported",  value: importedCount,           color: "#166534", bg: "#f0fdf4", border: "#86efac" },
    { label: "Skipped",   value: skipped.size,            color: "#64748b", bg: "#f8fafc", border: "#e2e8f0" },
    { label: "Errors",    value: errorCount,              color: "#991b1b", bg: "#fef2f2", border: "#fca5a5" },
    { label: "Remaining", value: Math.max(0, remaining),  color: "#1e40af", bg: "#eff6ff", border: "#bfdbfe" },
  ];

  return (
    <article style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700 }}>Import Queue</h2>
          <p style={{ margin: "0.2rem 0 0", fontSize: "12px", color: "#64748b" }}>
            Review each product and import or skip individually.
          </p>
        </div>
        <button type="button" onClick={onClose} style={darkButton}>← Back to config</button>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        {stats.map((s) => (
          <div key={s.label} style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            padding: "0.5rem 0.85rem", borderRadius: "8px",
            border: `1px solid ${s.border}`, background: s.bg, minWidth: "5rem",
          }}>
            <strong style={{ fontSize: "18px", fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</strong>
            <span style={{ fontSize: "10px", color: "#64748b", marginTop: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Filter */}
      <input
        type="text" value={filter}
        onChange={(e) => { setFilter(e.target.value); setPage(0); }}
        placeholder="Filter by title, SKU or brand…"
        style={{ ...inputStyle, marginBottom: "0.85rem" }}
      />

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "10px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
              {["#", "Title / Variants", "Brand", "Variants", "Price", "Tags", "Action"].map((h) => (
                <th key={h} style={{
                  padding: "0.55rem 0.65rem", fontSize: "10px", fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b",
                  whiteSpace: "nowrap", textAlign: "left",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageItems.map(({ p, i }) => (
              <ProductQueueRow
                key={i} index={i + 1} product={p} locationId={locationId}
                onSkip={() => setSkipped((prev) => new Set([...prev, i]))}
                onStatusChange={handleStatusChange}
              />
            ))}
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "2.5rem", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                  No products match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} style={darkButton}>
            ← Prev
          </button>
          <span style={{ fontSize: "12px", color: "#64748b" }}>
            Page {safePage + 1} / {totalPages} · {filtered.length} products
          </span>
          <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1} style={darkButton}>
            Next →
          </button>
        </div>
      )}
    </article>
  );
}

// ─── Supplier panel ───────────────────────────────────────────────────────────

const SUPPLIER_FIELDS = [
  { name: "titleCol",        label: "Product name",          required: true  },
  { name: "skuCol",          label: "SKU / Internal code",   required: false },
  { name: "barcodeCol",      label: "Barcode / UPC / EAN",   required: false },
  { name: "costCol",         label: "Cost (supplier price)", required: false },
  { name: "quantityCol",     label: "Stock quantity",        required: false },
  { name: "vendorCol",       label: "Brand / Manufacturer",  required: false },
  { name: "productTypeCol",  label: "Product type",          required: false },
  { name: "tagsCol",         label: "Base tags column",      required: false },
  { name: "retailPriceCol",  label: "Retail price",          required: false },
  { name: "wholesalePriceCol", label: "Wholesale price",     required: false },
] as const;

const SUPPLIER_MAPPING_KEY = "supplierColumnMapping_v1";

function SupplierPanel({ selectedLocationId, isSubmitting }: { selectedLocationId: string; isSubmitting: boolean }) {
  const detectorFetcher = useFetcher<ExcelInfo>();
  const previewFetcher  = useFetcher<ActionData>();
  const formRef         = useRef<HTMLFormElement>(null);
  const [csvHeaders, setCsvHeaders]                       = useState<string[]>([]);
  const [isExcel, setIsExcel]                             = useState(false);
  const [tagColumnsSelected, setTagColumnsSelected]       = useState<string[]>([]);
  const [variantColsSelected, setVariantColsSelected]     = useState<string[]>([]);
  const [queueProducts, setQueueProducts]                 = useState<ProductGroupInput[] | null>(null);
  const [sheetStatusOverrides, setSheetStatusOverrides]   = useState<Record<string, "ACTIVE" | "DRAFT" | "ARCHIVED">>({});
  const [savedMappingName, setSavedMappingName]           = useState("");
  const [savedMappings, setSavedMappings]                 = useState<Array<{ name: string; data: Record<string, string> }>>([]);

  React.useEffect(() => {
    if (previewFetcher.data && "preview" in previewFetcher.data) {
      setQueueProducts(previewFetcher.data.products);
    }
  }, [previewFetcher.data]);

  // Load saved mappings from localStorage on mount
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(SUPPLIER_MAPPING_KEY);
      if (raw) setSavedMappings(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  function saveCurrentMapping() {
    if (!formRef.current || !savedMappingName.trim()) return;
    const fd = new FormData(formRef.current);
    const data: Record<string, string> = {};
    SUPPLIER_FIELDS.forEach(({ name }) => { data[name] = String(fd.get(name) ?? ""); });
    data.defaultVendor = String(fd.get("defaultVendor") ?? "");
    data.defaultProductType = String(fd.get("defaultProductType") ?? "");
    data.defaultStatus = String(fd.get("defaultStatus") ?? "DRAFT");
    data.retailMultiplier = String(fd.get("retailMultiplier") ?? "2.5");
    data.wholesaleMultiplier = String(fd.get("wholesaleMultiplier") ?? "1.5");
    const next = [...savedMappings.filter((m) => m.name !== savedMappingName.trim()), { name: savedMappingName.trim(), data }];
    setSavedMappings(next);
    try { localStorage.setItem(SUPPLIER_MAPPING_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function loadMapping(mapping: { name: string; data: Record<string, string> }) {
    if (!formRef.current) return;
    const form = formRef.current;
    Object.entries(mapping.data).forEach(([key, value]) => {
      const el = form.elements.namedItem(key) as HTMLSelectElement | HTMLInputElement | null;
      if (el) el.value = value;
    });
  }

  function deleteMapping(name: string) {
    const next = savedMappings.filter((m) => m.name !== name);
    setSavedMappings(next);
    try { localStorage.setItem(SUPPLIER_MAPPING_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  const handlePreview = () => {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    fd.set("subaction", "preview");
    previewFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const isPreviewing  = previewFetcher.state === "submitting";
  const excelInfo     = detectorFetcher.data && "sheets" in detectorFetcher.data ? detectorFetcher.data : null;
  const headers       = isExcel ? (excelInfo?.headers ?? []) : csvHeaders;
  const isDetecting   = detectorFetcher.state === "submitting";
  const hasFile       = headers.length > 0;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setCsvHeaders([]); setIsExcel(false); return; }
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      setIsExcel(true); setCsvHeaders([]); setTagColumnsSelected([]); setVariantColsSelected([]);
      const fd = new FormData();
      fd.append("intent", "detect-excel-sheets");
      fd.append("csvFile", file);
      detectorFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    } else {
      setIsExcel(false); setTagColumnsSelected([]); setVariantColsSelected([]);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
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

  const toggle = (_list: string[], set: React.Dispatch<React.SetStateAction<string[]>>, col: string) => {
    set((prev) => prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]);
  };

  if (queueProducts) {
    return (
      <ImportQueuePanel
        products={queueProducts}
        locationId={selectedLocationId}
        onClose={() => setQueueProducts(null)}
      />
    );
  }

  const sectionTitle = (title: string, desc?: string) => (
    <div style={{ marginBottom: "0.75rem" }}>
      <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>{title}</h3>
      {desc && <p style={{ margin: "0.2rem 0 0", fontSize: "12px", color: "#64748b" }}>{desc}</p>}
    </div>
  );

  const chipBase = (active: boolean, activeColor: string, activeBg: string): CSSProperties => ({
    fontSize: "12px", padding: "0.25rem 0.6rem", borderRadius: "6px", cursor: "pointer",
    border: `1px solid ${active ? activeColor : "#e2e8f0"}`,
    background: active ? activeBg : "#f8fafc",
    color: active ? activeColor : "#374151",
    fontWeight: active ? 600 : 400,
    transition: "all 0.1s",
  });

  return (
    <article style={panelStyle}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ margin: "0 0 0.25rem", fontSize: "15px", fontWeight: 700 }}>Supplier normalizer</h2>
        <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
          Upload a supplier Excel or CSV file, map columns, and import or download a Shopify-ready CSV.
        </p>
      </div>

      {/* ── Saved mappings ── */}
      {savedMappings.length > 0 && (
        <div style={{ marginBottom: "1rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "0.85rem 1rem" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", marginBottom: "0.5rem" }}>Saved column mappings</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {savedMappings.map((m) => (
              <div key={m.name} style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                <button type="button" onClick={() => loadMapping(m)}
                  style={{ ...darkButton, fontSize: "12px", padding: "0.3rem 0.65rem", background: "#ede9fe", borderColor: "#c4b5fd", color: "#6d28d9" }}>
                  ↩ {m.name}
                </button>
                <button type="button" onClick={() => deleteMapping(m.name)}
                  style={{ ...darkButton, fontSize: "11px", padding: "0.25rem 0.45rem", background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca" }}
                  title="Delete saved mapping">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Form ref={formRef} method="post" encType="multipart/form-data"
        style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <input type="hidden" name="intent" value="normalize-supplier" />
        <input type="hidden" name="locationId" value={selectedLocationId} />
        {tagColumnsSelected.map((col) => <input key={col} type="hidden" name="tagColumns" value={col} />)}
        {variantColsSelected.map((col) => <input key={col} type="hidden" name="variantTitleCols" value={col} />)}
        {/* Per-sheet status overrides as hidden fields */}
        {Object.entries(sheetStatusOverrides).map(([sheet, status]) => (
          <React.Fragment key={sheet}>
            <input type="hidden" name={`sheetStatus_${sheet}`} value={status} />
          </React.Fragment>
        ))}

        {/* ── File upload ── */}
        <div>
          {sectionTitle("1. Upload supplier file", "Accepts .xlsx (multi-sheet) and .csv")}
          <label style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: "0.5rem", padding: "2rem",
            border: "2px dashed #c4b5fd", borderRadius: "12px",
            background: "#faf5ff", cursor: "pointer", textAlign: "center",
          }}>
            <span style={{ fontSize: "32px" }}>📂</span>
            <span style={{ fontWeight: 600, fontSize: "13px", color: "#5b21b6" }}>Click to select file</span>
            <span style={{ fontSize: "12px", color: "#7c3aed" }}>.xlsx, .xls, .csv</span>
            <input type="file" name="csvFile" accept=".csv,.xlsx,.xls,text/csv" onChange={handleFileChange} style={{ display: "none" }} />
          </label>
          {isDetecting && (
            <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", color: "#7c3aed", fontSize: "12px" }}>
              <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
              Detecting Excel sheets…
            </div>
          )}
        </div>

        {/* ── Sheet selector ── */}
        {isExcel && excelInfo && (
          <div style={{ background: "#faf5ff", border: "1px solid #ddd6fe", borderRadius: "10px", padding: "1rem" }}>
            {sectionTitle(`${excelInfo.sheets.length} sheets detected`, "Select which sheets to import and set per-sheet status:")}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {excelInfo.sheets.map((sheet) => (
                <div key={sheet} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <label style={{
                    display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer",
                    background: "#ede9fe", border: "1px solid #c4b5fd", borderRadius: "6px",
                    padding: "0.3rem 0.65rem", fontSize: "12px", fontWeight: 500, flexShrink: 0,
                  }}>
                    <input type="checkbox" name="selectedSheets" value={sheet} defaultChecked />
                    {sheet}
                  </label>
                  <select
                    value={sheetStatusOverrides[sheet] ?? ""}
                    onChange={(e) => {
                      const val = e.target.value as "" | "ACTIVE" | "DRAFT" | "ARCHIVED";
                      setSheetStatusOverrides((prev) => {
                        const next = { ...prev };
                        if (val) next[sheet] = val; else delete next[sheet];
                        return next;
                      });
                    }}
                    style={{ ...inputStyle, width: "auto", fontSize: "12px", flex: "0 0 auto" }}
                  >
                    <option value="">Status: use default</option>
                    <option value="ACTIVE">Active</option>
                    <option value="DRAFT">Draft</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                </div>
              ))}
            </div>
            {excelInfo.headers.length > 0 && (
              <p style={{ margin: "0.6rem 0 0", fontSize: "11px", color: "#6d28d9" }}>
                <strong>{excelInfo.headers.length} columns:</strong> {excelInfo.headers.join(" · ")}
              </p>
            )}
          </div>
        )}

        {hasFile && (
          <>
            {!isExcel && (
              <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "8px", padding: "0.65rem 0.9rem", fontSize: "12px", color: "#166534" }}>
                CSV — <strong>{headers.length} columns:</strong> {headers.join(" · ")}
              </div>
            )}

            {/* ── Column mapping ── */}
            <div>
              {sectionTitle("2. Column mapping", "Map each supplier column to its Shopify field.")}
              {/* Use key to reset selects when file type changes */}
              <div key={isExcel ? "excel" : "csv"} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "0.55rem" }}>
                {SUPPLIER_FIELDS.map(({ name, label, required }) => (
                  <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", alignItems: "center" }}>
                    <label style={{ fontSize: "12px", fontWeight: required ? 700 : 400, color: required ? "#0f172a" : "#374151" }}>
                      {label}{required ? " *" : ""}
                    </label>
                    <select
                      name={name}
                      style={{ ...inputStyle, fontSize: "12px" }}
                      defaultValue={isExcel && name === "productTypeCol" ? "__sheetName" : ""}
                    >
                      <option value="">— Skip —</option>
                      {isExcel && name === "productTypeCol" && (
                        <option value="__sheetName">Sheet name (auto)</option>
                      )}
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Tag columns ── */}
            <div>
              {sectionTitle("3. Extra columns as tags", "Click to tag columns. SEX: M→Male, L→Lady, U→Unisex.")}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                {headers.map((h) => (
                  <button key={h} type="button" onClick={() => toggle(tagColumnsSelected, setTagColumnsSelected, h)}
                    style={chipBase(tagColumnsSelected.includes(h), "#7c3aed", "#f0ebff")}>
                    {tagColumnsSelected.includes(h) ? "✓ " : ""}{h}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Variant overrides ── */}
            <div>
              {sectionTitle("4. Variant dimension override", "Auto-detected: SIZE, ML, CONCENTRATION, TYPE. Override here if needed.")}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                {headers.map((h) => (
                  <button key={h} type="button" onClick={() => toggle(variantColsSelected, setVariantColsSelected, h)}
                    style={chipBase(variantColsSelected.includes(h), "#0369a1", "#e0f2fe")}>
                    {variantColsSelected.includes(h) ? "✓ " : ""}{h}
                  </button>
                ))}
              </div>
              {variantColsSelected.length > 0 && (
                <p style={{ margin: "0.5rem 0 0", fontSize: "11px", color: "#0369a1" }}>
                  Variant label: <strong>{variantColsSelected.join(" / ")}</strong>
                </p>
              )}
            </div>

            {/* ── UPC as SKU ── */}
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "13px", cursor: "pointer" }}>
              <input type="checkbox" name="useUpcAsSku" value="1" defaultChecked style={{ width: "15px", height: "15px" }} />
              Use UPC/Barcode as SKU when no SKU column is mapped
            </label>

            {/* ── Pricing rules ── */}
            <div>
              {sectionTitle("5. Pricing rules", "Applied when price columns are absent or zero.")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <Field label="Retail multiplier">
                  <input name="retailMultiplier" type="number" step="0.01" min="1" defaultValue="2.5" style={inputStyle} />
                  <span style={{ display: "block", marginTop: "0.25rem", fontSize: "11px", color: "#64748b" }}>price = cost × 2.5</span>
                </Field>
                <Field label="Wholesale multiplier">
                  <input name="wholesaleMultiplier" type="number" step="0.01" min="1" defaultValue="1.5" style={inputStyle} />
                  <span style={{ display: "block", marginTop: "0.25rem", fontSize: "11px", color: "#64748b" }}>price = cost × 1.5</span>
                </Field>
              </div>
            </div>

            {/* ── Defaults ── */}
            <div>
              {sectionTitle("6. Default values")}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem" }}>
                <Field label="Default vendor">
                  <input name="defaultVendor" placeholder="e.g. MTZ" style={inputStyle} />
                </Field>
                <Field label="Default type">
                  <input name="defaultProductType" placeholder="e.g. Perfume" style={inputStyle} />
                </Field>
                <Field label="Initial status">
                  <select name="defaultStatus" defaultValue="DRAFT" style={inputStyle}>
                    <option value="ACTIVE">Active</option>
                    <option value="DRAFT">Draft</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                </Field>
              </div>
            </div>

            {/* ── Save mapping ── */}
            <div style={{ paddingTop: "0.75rem", borderTop: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", marginBottom: "0.4rem" }}>
                Save current column mapping
              </div>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <input type="text" value={savedMappingName} onChange={(e) => setSavedMappingName(e.target.value)}
                  placeholder="Mapping name (e.g. Supplier A)" style={{ ...inputStyle, flex: "1 1 160px", width: "auto", fontSize: "12px" }} />
                <button type="button" onClick={saveCurrentMapping} disabled={!savedMappingName.trim()}
                  style={{ ...darkButton, fontSize: "12px", padding: "0.42rem 0.75rem", background: "#f0fdf4", borderColor: "#86efac", color: "#166534" }}>
                  💾 Save mapping
                </button>
              </div>
            </div>

            {/* ── Actions ── */}
            <div style={{
              display: "flex", gap: "0.75rem", flexWrap: "wrap",
              paddingTop: "0.75rem", borderTop: "1px solid #e2e8f0",
            }}>
              <button type="submit" name="subaction" value="download"
                disabled={isSubmitting || isPreviewing} style={darkButton}>
                {isSubmitting ? "Processing…" : "↓ Download normalized CSV"}
              </button>
              <button type="submit" name="subaction" value="import"
                disabled={isSubmitting || isPreviewing} style={primaryButton}>
                {isSubmitting ? "Importing…" : "→ Import to Shopify"}
              </button>
              <button type="button" onClick={handlePreview}
                disabled={isSubmitting || isPreviewing}
                style={{ ...darkButton, background: "#f5f3ff", borderColor: "#c4b5fd", color: "#6d28d9" }}>
                {isPreviewing ? "Loading…" : "Preview & import one by one"}
              </button>
            </div>
          </>
        )}

        {!hasFile && !isDetecting && (
          <div style={{ background: "#faf5ff", border: "1px solid #ddd6fe", borderRadius: "10px", padding: "1.25rem" }}>
            <strong style={{ display: "block", marginBottom: "0.65rem", fontSize: "13px", color: "#3730a3" }}>What this normalizer does</strong>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 2, fontSize: "12px", color: "#4c1d95" }}>
              <li>Accepts <strong>.xlsx</strong> (multiple sheets) and <strong>.csv</strong></li>
              <li>For Excel: auto-detects sheets, let you choose which to process</li>
              <li>Map supplier columns (DESCRIPTION, UPC, COST, BRAND…) to Shopify fields</li>
              <li>Auto-groups rows with the same name as one product with multiple variants</li>
              <li>Auto-detects SIZE, ML, CONCENTRATION, TYPE as variant dimensions</li>
              <li>Calculate retail and wholesale prices from COST using multipliers</li>
              <li>Download a Shopify-ready CSV or import directly in bulk or one by one</li>
            </ul>
          </div>
        )}
      </Form>
    </article>
  );
}

// ─── Images tab ───────────────────────────────────────────────────────────────

function ImagesTab({ products }: { products: Array<{ id: string; title: string; imageUrl: string | null }> }) {
  const [mode, setMode] = useState<"assign" | "manage">("assign");

  const modeBtn = (active: boolean): CSSProperties => ({
    ...darkButton,
    ...(active ? { background: "#0f172a", color: "#fff", borderColor: "#0f172a" } : {}),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={() => setMode("assign")} style={modeBtn(mode === "assign")}>
          ⚡ Quick Assign
        </button>
        <button type="button" onClick={() => setMode("manage")} style={modeBtn(mode === "manage")}>
          🖼️ Manage Images
        </button>
      </div>

      {mode === "assign" && <QuickAssignPanel />}
      {mode === "manage" && <ManageImagesPanel products={products} />}
    </div>
  );
}

// ── Quick Assign ──────────────────────────────────────────────────────────────

// ── Background upload job types ───────────────────────────────────────────────

type JobStatus = "queued" | "staging" | "uploading" | "attaching" | "done" | "error";

type UploadJob = {
  id: string;
  productId: string;
  productTitle: string;
  file: File;
  status: JobStatus;
  error?: string;
};

function QuickAssignPanel() {
  const loadFetcher  = useFetcher<{ noImageProducts?: NoImageProduct[] }>();
  const stageFetcher = useFetcher<{ stagedUpload?: StagedTarget }>();
  const attachFetcher = useFetcher<{ ok: boolean; message: string }>();

  const [queue, setQueue]     = useState<NoImageProduct[]>([]);
  const [jobs, setJobs]       = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Refs for stable access inside effects
  const processingIdRef  = React.useRef<string | null>(null);
  const jobsRef          = React.useRef<UploadJob[]>([]);
  const prevStageState   = React.useRef(stageFetcher.state);
  const prevAttachState  = React.useRef(attachFetcher.state);
  jobsRef.current = jobs;

  const current        = queue[0] ?? null;
  const loaded         = loadFetcher.data && "noImageProducts" in loadFetcher.data;
  const isLoadingQueue = loadFetcher.state !== "idle";
  const totalLoaded    = (loadFetcher.data as { noImageProducts?: NoImageProduct[] } | undefined)?.noImageProducts?.length ?? 0;

  function updateJob(id: string, patch: Partial<UploadJob>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  // Load queue on mount
  React.useEffect(() => {
    const fd = new FormData();
    fd.append("intent", "load-no-image-products");
    loadFetcher.submit(fd, { method: "post" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Populate queue when loader returns
  React.useEffect(() => {
    if (loadFetcher.state === "idle" && loadFetcher.data && "noImageProducts" in loadFetcher.data) {
      setQueue(loadFetcher.data.noImageProducts ?? []);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadFetcher.state]);

  // Pick up next queued job → submit to stageFetcher
  React.useEffect(() => {
    if (processingIdRef.current) return;
    const nextJob = jobs.find((j) => j.status === "queued");
    if (!nextJob) return;
    processingIdRef.current = nextJob.id;
    updateJob(nextJob.id, { status: "staging" });
    const fd = new FormData();
    fd.append("intent", "create-staged-upload");
    fd.append("filename", nextJob.file.name);
    fd.append("mimeType", nextJob.file.type || "image/jpeg");
    fd.append("fileSize", String(nextJob.file.size));
    stageFetcher.submit(fd, { method: "post" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  // stageFetcher completed → upload to CDN (external URL, no Shopify auth needed)
  React.useEffect(() => {
    const wasWorking = prevStageState.current !== "idle";
    prevStageState.current = stageFetcher.state;
    if (!wasWorking || stageFetcher.state !== "idle") return;

    const jobId = processingIdRef.current;
    if (!jobId) return;
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;

    const data = stageFetcher.data as { stagedUpload?: StagedTarget } | undefined;
    if (!data?.stagedUpload) {
      updateJob(jobId, { status: "error", error: "Failed to get staged upload slot from Shopify." });
      processingIdRef.current = null;
      return;
    }

    const { url, resourceUrl, parameters } = data.stagedUpload;
    updateJob(jobId, { status: "uploading" });

    const cdnForm = new FormData();
    parameters.forEach(({ name, value }) => cdnForm.append(name, value));
    cdnForm.append("file", job.file);

    fetch(url, { method: "POST", body: cdnForm })
      .then((res) => {
        if (!res.ok) return res.text().then((t) => { throw new Error(`CDN ${res.status}: ${t.slice(0, 120)}`); });
        updateJob(jobId, { status: "attaching" });
        const af = new FormData();
        af.append("intent", "attach-images");
        af.append("productId", job.productId);
        af.append("imageUrl", resourceUrl);
        af.append("imageAlt", job.productTitle);
        attachFetcher.submit(af, { method: "post" });
      })
      .catch((e: Error) => {
        updateJob(jobId, { status: "error", error: e.message });
        processingIdRef.current = null;
      });
  });

  // attachFetcher completed → mark done or error, unlock queue
  React.useEffect(() => {
    const wasWorking = prevAttachState.current !== "idle";
    prevAttachState.current = attachFetcher.state;
    if (!wasWorking || attachFetcher.state !== "idle") return;

    const jobId = processingIdRef.current;
    if (!jobId) return;

    if (attachFetcher.data?.ok) {
      updateJob(jobId, { status: "done" });
    } else {
      updateJob(jobId, { status: "error", error: attachFetcher.data?.message ?? "Failed to attach image." });
    }
    processingIdRef.current = null; // triggers [jobs] effect → picks up next queued job
  });

  function enqueue(file: File, product: NoImageProduct) {
    if (!file.type.startsWith("image/")) return;
    const job: UploadJob = {
      id: `${Date.now()}-${Math.random()}`,
      productId: product.id,
      productTitle: product.title,
      file,
      status: "queued",
    };
    setJobs((prev) => [...prev, job]);
    setQueue((q) => q.slice(1)); // advance immediately — upload runs in background
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!current) return;
    const file = e.dataTransfer.files[0];
    if (file) enqueue(file, current);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!current) return;
    const file = e.target.files?.[0];
    if (file) enqueue(file, current);
    e.target.value = "";
  }

  // Job buckets for the status panel
  const activeJobs  = jobs.filter((j) => j.status !== "done" && j.status !== "error");
  const errorJobs   = jobs.filter((j) => j.status === "error");
  const doneCount   = jobs.filter((j) => j.status === "done").length;

  const statusLabel: Record<JobStatus, string> = {
    queued:    "Queued",
    staging:   "Creating slot…",
    uploading: "Uploading…",
    attaching: "Saving to product…",
    done:      "Done",
    error:     "Error",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "700px" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header / progress */}
      <article style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
              Products without images
            </h2>
            <p style={{ margin: "0.2rem 0 0", fontSize: "12px", color: "#64748b" }}>
              {isLoadingQueue ? "Scanning catalog…" : loaded ? `${queue.length} remaining · sorted by UPC priority` : ""}
            </p>
          </div>
          <button type="button" disabled={isLoadingQueue} style={darkButton}
            onClick={() => {
              const fd = new FormData();
              fd.append("intent", "load-no-image-products");
              loadFetcher.submit(fd, { method: "post" });
            }}>
            ↺ Refresh
          </button>
        </div>

        {loaded && totalLoaded > 0 && (
          <div style={{ marginTop: "0.85rem", height: "6px", borderRadius: "3px", background: "#e2e8f0", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: "3px",
              background: "linear-gradient(90deg, #2563eb, #4f46e5)",
              width: `${Math.max(4, ((totalLoaded - queue.length) / totalLoaded) * 100)}%`,
              transition: "width 0.4s ease",
            }} />
          </div>
        )}
      </article>

      {/* Upload queue status */}
      {(activeJobs.length > 0 || doneCount > 0 || errorJobs.length > 0) && (
        <article style={{ ...panelStyle, padding: "0.85rem 1.25rem" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", marginBottom: "0.6rem" }}>
            Upload queue
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {activeJobs.map((job) => (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "12px" }}>
                <div style={{
                  width: "14px", height: "14px", borderRadius: "50%", flexShrink: 0,
                  border: "2px solid #e0e7ff", borderTopColor: "#4f46e5",
                  animation: "spin 0.8s linear infinite",
                }} />
                <span style={{ color: "#374151", flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {job.productTitle}
                </span>
                <span style={{ color: "#6d28d9", flexShrink: 0 }}>{statusLabel[job.status]}</span>
              </div>
            ))}
            {errorJobs.map((job) => (
              <div key={job.id} style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "12px" }}>
                  <span style={{ color: "#dc2626", flexShrink: 0 }}>✕</span>
                  <span style={{ color: "#374151", flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {job.productTitle}
                  </span>
                  <span style={{ color: "#dc2626", flexShrink: 0 }}>Error</span>
                </div>
                {job.error && (
                  <div style={{
                    fontSize: "11px", color: "#991b1b", background: "#fef2f2",
                    border: "1px solid #fecaca", borderRadius: "6px",
                    padding: "0.3rem 0.6rem", marginLeft: "1.3rem", wordBreak: "break-all",
                  }}>
                    {job.error}
                  </div>
                )}
              </div>
            ))}
            {doneCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "12px", color: "#15803d" }}>
                <span>✓</span>
                <span>{doneCount} image{doneCount !== 1 ? "s" : ""} uploaded successfully</span>
              </div>
            )}
          </div>
        </article>
      )}

      {/* All done */}
      {loaded && queue.length === 0 && activeJobs.length === 0 && (
        <article style={{ ...panelStyle, textAlign: "center" as const, padding: "2.5rem" }}>
          <div style={{ fontSize: "40px", marginBottom: "0.75rem" }}>🎉</div>
          <strong style={{ fontSize: "15px", color: "#0f172a" }}>All products have images!</strong>
          <p style={{ margin: "0.4rem 0 0", fontSize: "13px", color: "#64748b" }}>
            Every product in your catalog has at least one image.
          </p>
        </article>
      )}

      {/* Current product + drop zone */}
      {current && (
        <article style={panelStyle}>
          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a", lineHeight: 1.3 }}>
                  {current.title}
                </h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
                  {current.barcode && (
                    <span style={{ fontSize: "11px", fontWeight: 600, padding: "0.2rem 0.55rem", background: "#eff6ff", color: "#1d4ed8", borderRadius: "5px", border: "1px solid #bfdbfe" }}>
                      UPC: {current.barcode}
                    </span>
                  )}
                  {current.sku && (
                    <span style={{ fontSize: "11px", padding: "0.2rem 0.55rem", background: "#f8fafc", color: "#475569", borderRadius: "5px", border: "1px solid #e2e8f0" }}>
                      SKU: {current.sku}
                    </span>
                  )}
                  {current.vendor && (
                    <span style={{ fontSize: "11px", padding: "0.2rem 0.55rem", background: "#f8fafc", color: "#475569", borderRadius: "5px", border: "1px solid #e2e8f0" }}>
                      {current.vendor}
                    </span>
                  )}
                  {current.productType && (
                    <span style={{ fontSize: "11px", padding: "0.2rem 0.55rem", background: "#f8fafc", color: "#475569", borderRadius: "5px", border: "1px solid #e2e8f0" }}>
                      {current.productType}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <a
                  href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(current.title + (current.barcode ? " " + current.barcode : ""))}`}
                  target="_blank" rel="noreferrer"
                  style={{ ...darkButton, fontSize: "12px", padding: "0.35rem 0.65rem", textDecoration: "none", background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}
                  title="Search Google Images for this product"
                >
                  🔍 Google Images
                </a>
                <button type="button" onClick={() => setQueue((q) => q.slice(1))} style={darkButton}>
                  Skip →
                </button>
              </div>
            </div>
            {current.description && (
              <p style={{
                margin: "0.75rem 0 0", fontSize: "12px", color: "#475569",
                lineHeight: 1.6, borderTop: "1px solid #f1f5f9", paddingTop: "0.75rem",
                display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>
                {current.description}
              </p>
            )}
          </div>

          {/* Drop zone — always ready */}
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: "0.75rem", padding: "2.5rem 1rem", borderRadius: "12px", cursor: "pointer",
              border: `2px dashed ${dragOver ? "#2563eb" : "#cbd5e1"}`,
              background: dragOver ? "#eff6ff" : "#f8fafc",
              transition: "all 0.15s", minHeight: "180px",
            }}
          >
            <div style={{
              width: "48px", height: "48px", borderRadius: "12px",
              background: dragOver ? "#dbeafe" : "#f1f5f9",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px",
            }}>🖼️</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#374151" }}>
                {dragOver ? "Drop the image" : "Drag & drop an image here"}
              </div>
              <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "0.25rem" }}>
                or click to browse · uploads run in background
              </div>
            </div>
            <input type="file" accept="image/*" onChange={handleFileInput} style={{ display: "none" }} />
          </label>
        </article>
      )}
    </div>
  );
}

// ── Manage Images ─────────────────────────────────────────────────────────────

function ManageImagesPanel({ products }: { products: Array<{ id: string; title: string; imageUrl: string | null }> }) {
  const fetcher       = useFetcher<{ images?: ProductImageEntry[] }>();
  const attachFetcher = useFetcher<{ ok: boolean; message: string }>();
  const deleteFetcher = useFetcher<{ ok: boolean; message: string }>();

  const [selectedProductId, setSelectedProductId] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([{ url: "", alt: "" }]);

  const fetchedImages: ProductImageEntry[] =
    fetcher.data?.images ?? [];

  const isLoading   = fetcher.state !== "idle";
  const isAttaching = attachFetcher.state !== "idle";

  function handleProductChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setSelectedProductId(id);
    if (id) {
      const fd = new FormData();
      fd.append("intent", "fetch-product-images");
      fd.append("productId", id);
      fetcher.submit(fd, { method: "post" });
    }
  }

  function addRow() { setRows((r) => [...r, { url: "", alt: "" }]); }
  function removeRow(i: number) { setRows((r) => r.filter((_, idx) => idx !== i)); }
  function updateRow(i: number, field: "url" | "alt", value: string) {
    setRows((r) => r.map((row, idx) => idx === i ? { ...row, [field]: value } : row));
  }

  const filtered = search.trim()
    ? products.filter((p) => p.title.toLowerCase().includes(search.toLowerCase()))
    : products;

  const selectedProduct = products.find((p) => p.id === selectedProductId);

  const prevAttachState = React.useRef(attachFetcher.state);
  React.useEffect(() => {
    if (prevAttachState.current === "submitting" && attachFetcher.state === "idle") {
      if (attachFetcher.data?.ok && selectedProductId) {
        setRows([{ url: "", alt: "" }]);
        const fd = new FormData();
        fd.append("intent", "fetch-product-images");
        fd.append("productId", selectedProductId);
        fetcher.submit(fd, { method: "post" });
      }
    }
    prevAttachState.current = attachFetcher.state;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>

      {attachFetcher.data && "ok" in attachFetcher.data && (
        <Banner ok={attachFetcher.data.ok} message={attachFetcher.data.message} />
      )}
      {deleteFetcher.data && "ok" in deleteFetcher.data && (
        <Banner ok={deleteFetcher.data.ok} message={deleteFetcher.data.message} />
      )}

      {/* Product selector */}
      <article style={panelStyle}>
        <h2 style={{ margin: "0 0 1rem", fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
          1. Select product
        </h2>
        <Field label="Filter">
          <input type="text" placeholder="Search by title…" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, maxWidth: "400px" }} />
        </Field>
        <div style={{ marginTop: "0.75rem" }}>
          <Field label="Product">
            <select value={selectedProductId} onChange={handleProductChange}
              style={{ ...inputStyle, maxWidth: "600px" }}>
              <option value="">— Select a product —</option>
              {filtered.map((p) => (
                <option key={p.id} value={p.id}>{p.title}{!p.imageUrl ? " ⚠ no image" : ""}</option>
              ))}
            </select>
          </Field>
        </div>
      </article>

      {/* Current images */}
      {selectedProductId && (
        <article style={panelStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
              2. Images — {selectedProduct?.title}
            </h2>
            {isLoading && <span style={{ fontSize: "12px", color: "#64748b" }}>Loading…</span>}
          </div>

          {fetchedImages.length === 0 && !isLoading && (
            <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>No images yet.</p>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
            {fetchedImages.map((img) => (
              <div key={img.id} style={{
                position: "relative", borderRadius: "8px", overflow: "hidden",
                border: "1px solid #e2e8f0", width: "120px",
              }}>
                <img src={img.url} alt={img.alt} style={{ width: "120px", height: "120px", objectFit: "cover", display: "block" }} />
                {img.alt && (
                  <div style={{
                    padding: "0.3rem 0.4rem", fontSize: "10px", color: "#64748b",
                    background: "#f8fafc", borderTop: "1px solid #e2e8f0",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{img.alt}</div>
                )}
                <deleteFetcher.Form method="post" style={{ position: "absolute", top: "4px", right: "4px" }}>
                  <input type="hidden" name="intent" value="delete-image" />
                  <input type="hidden" name="productId" value={selectedProductId} />
                  <input type="hidden" name="mediaId" value={img.id} />
                  <button type="submit"
                    onClick={(e) => { if (!window.confirm("Delete this image?")) e.preventDefault(); }}
                    title="Delete image"
                    style={{
                      width: "22px", height: "22px", borderRadius: "50%",
                      background: "rgba(220,38,38,0.85)", color: "#fff",
                      border: "none", cursor: "pointer", fontSize: "12px", lineHeight: 1,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >✕</button>
                </deleteFetcher.Form>
              </div>
            ))}
          </div>
        </article>
      )}

      {/* Add images by URL */}
      {selectedProductId && (
        <article style={panelStyle}>
          <h2 style={{ margin: "0 0 1rem", fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
            3. Add images by URL
          </h2>
          <attachFetcher.Form method="post">
            <input type="hidden" name="intent" value="attach-images" />
            <input type="hidden" name="productId" value={selectedProductId} />

            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginBottom: "1rem" }}>
              {rows.map((row, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 220px auto", gap: "0.5rem", alignItems: "end" }}>
                  <Field label={i === 0 ? "Image URL" : ""}>
                    <input type="url" name="imageUrl" value={row.url}
                      onChange={(e) => updateRow(i, "url", e.target.value)}
                      placeholder="https://…/image.jpg" style={inputStyle} />
                  </Field>
                  <Field label={i === 0 ? "Alt text (optional)" : ""}>
                    <input type="text" name="imageAlt" value={row.alt}
                      onChange={(e) => updateRow(i, "alt", e.target.value)}
                      placeholder="Description…" style={inputStyle} />
                  </Field>
                  {rows.length > 1
                    ? <button type="button" onClick={() => removeRow(i)}
                        style={{ ...darkButton, background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca", padding: "0.55rem 0.65rem" }}>✕</button>
                    : <div />}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button type="button" onClick={addRow} style={darkButton}>+ Add row</button>
              <button type="submit" disabled={isAttaching} style={primaryButton}>
                {isAttaching ? "Saving…" : `↑ Add image(s)`}
              </button>
            </div>
          </attachFetcher.Form>
        </article>
      )}
    </div>
  );
}
