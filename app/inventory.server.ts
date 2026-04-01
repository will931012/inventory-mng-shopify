import { read as xlsxRead, utils as xlsxUtils } from "xlsx";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type GraphQLError = {
  message: string;
};

type UserError = {
  field?: string[] | null;
  message: string;
};

export type ShopSummary = {
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
};

export type LocationSummary = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
};

export type InventoryVariant = {
  id: string;
  title: string;
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  wholesalePrice: string;
  cost: string;
  inventoryQuantity: number;
  inventoryItemId: string;
  tracked: boolean;
  inventoryLevels: Array<{
    locationId: string;
    locationName: string;
    available: number;
  }>;
};

export type InventoryProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  totalInventory: number;
  updatedAt: string;
  imageUrl: string | null;
  imageAlt: string | null;
  variants: InventoryVariant[];
};

export type InventoryDashboardData = {
  shop: ShopSummary | null;
  locations: LocationSummary[];
  selectedLocationId: string;
  products: InventoryProduct[];
  loadWarning?: string;
  summary: {
    productCount: number;
    variantCount: number;
    inventoryUnits: number;
  };
};

export type ProductUpsertInput = {
  title: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  wholesalePrice: string;
  cost: string;
  quantity: number;
  barcode: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
};

export type VariantInput = {
  title: string;        // variant option value (e.g. "100ml EDP")
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  wholesalePrice: string;
  cost: string;
  quantity: number;
};

export type ProductGroupInput = {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  variants: VariantInput[];
};

export type SupplierColumnMapping = {
  titleCol: string;
  skuCol: string;
  barcodeCol: string;
  vendorCol: string;
  productTypeCol: string;
  tagsCol: string;
  costCol: string;
  quantityCol: string;
  retailPriceCol: string;
  wholesalePriceCol: string;
  tagColumns: string[];       // extra columns whose values become tags (e.g. SEX)
  variantTitleCols: string[]; // columns that form the variant label and are stripped from the group key
  useUpcAsSku: boolean;
};

export type SupplierPricingRules = {
  retailMultiplier: number;
  wholesaleMultiplier: number;
  defaultVendor: string;
  defaultProductType: string;
  defaultStatus: "ACTIVE" | "DRAFT" | "ARCHIVED";
};

export type ExcelInfo = {
  sheets: string[];
  headers: string[];
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: GraphQLError[];
};

type ProductsWithZeroPricePage = {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        variants: {
          nodes: Array<{
            price: string | null;
          }>;
        };
      };
    }>;
    pageInfo: {
      hasNextPage: boolean;
    };
  };
};

function normalizeTags(tags: string | string[]) {
  return (Array.isArray(tags) ? tags : tags.split(","))
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseNumber(value: string | null | undefined, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanCell(value: string | null | undefined) {
  return (value ?? "").trim();
}

function csvEscape(value: string | number | null | undefined) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      current = "";
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    if (row.some((cell) => cell.trim().length > 0)) {
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    return [];
  }

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((header) => header.trim());

  return dataRows.map((dataRow) => {
    return headers.reduce<Record<string, string>>((record, header, index) => {
      record[header] = dataRow[index]?.trim() ?? "";
      return record;
    }, {});
  });
}

function mapUserErrors(errors: UserError[] | undefined) {
  return (errors ?? []).map((error) => {
    if (error.field?.length) {
      return `${error.field.join(".")}: ${error.message}`;
    }

    return error.message;
  });
}

async function executeGraphQL<TData>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const payload = (await response.json()) as GraphQLResponse<TData>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Shopify did not return data.");
  }

  return payload.data;
}

async function fetchLocations(admin: AdminClient) {
  try {
    const data = await executeGraphQL<{
      locations: {
        nodes: Array<{
          id: string;
          name: string;
          isActive: boolean;
          fulfillsOnlineOrders: boolean;
        }>;
      };
    }>(
      admin,
      `#graphql
        query InventoryLocations {
          locations(first: 20) {
            nodes {
              id
              name
              isActive
              fulfillsOnlineOrders
            }
          }
        }
      `
    );

    return data.locations.nodes;
  } catch {
    return [];
  }
}

export async function fetchAllProductIdsWithZeroPrice(admin: AdminClient) {
  const productIds: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: ProductsWithZeroPricePage = await executeGraphQL<ProductsWithZeroPricePage>(
      admin,
      `#graphql
        query ProductsWithZeroPricePage($cursor: String) {
          products(first: 100, after: $cursor, sortKey: ID) {
            edges {
              cursor
              node {
                id
                variants(first: 20) {
                  nodes {
                    price
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
      {
        cursor
      }
    );

    for (const edge of data.products.edges) {
      const hasZeroPrice = edge.node.variants.nodes.some((variant) => {
        const price = Number(variant.price ?? "0");
        return Number.isFinite(price) && price === 0;
      });

      if (hasZeroPrice) {
        productIds.push(edge.node.id);
      }
    }

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.edges.at(-1)?.cursor ?? null;

    if (!cursor) {
      hasNextPage = false;
    }
  }

  return productIds;
}

export async function fetchInventoryDashboard(
  admin: AdminClient,
  searchQuery: string,
  preferredLocationId?: string | null
): Promise<InventoryDashboardData> {
  const locations = await fetchLocations(admin);
  const selectedLocationId =
    preferredLocationId && locations.some((location) => location.id === preferredLocationId)
      ? preferredLocationId
      : locations[0]?.id ?? "";

  try {
    const data = await executeGraphQL<{
      shop: ShopSummary;
      products: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          status: string;
          vendor: string | null;
          productType: string | null;
          tags: string[];
          totalInventory: number | null;
          updatedAt: string;
          featuredImage: {
            url: string;
            altText: string | null;
          } | null;
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              compareAtPrice: string | null;
              barcode: string | null;
              price: string | null;
              inventoryQuantity: number | null;
              wholesaleMeta: { value: string } | null;
              inventoryItem: {
                id: string;
                sku: string | null;
                tracked: boolean | null;
                unitCost: { amount: string } | null;
                inventoryLevels: {
                  nodes: Array<{
                    location: {
                      id: string;
                      name: string;
                    };
                    quantities: Array<{
                      name: string;
                      quantity: number;
                    }>;
                  }>;
                };
              };
            }>;
          };
        }>;
      };
    }>(
      admin,
      `#graphql
        query InventoryDashboard($query: String!) {
          shop {
            name
            myshopifyDomain
            currencyCode
          }
          products(first: 40, sortKey: UPDATED_AT, reverse: true, query: $query) {
            nodes {
              id
              title
              handle
              status
              vendor
              productType
              tags
              totalInventory
              updatedAt
              featuredImage {
                url
                altText
              }
              variants(first: 20) {
                nodes {
                  id
                  title
                  compareAtPrice
                  barcode
                  price
                  inventoryQuantity
                  wholesaleMeta: metafield(namespace: "custom", key: "wholesale_price") {
                    value
                  }
                  inventoryItem {
                    id
                    sku
                    tracked
                    unitCost {
                      amount
                    }
                    inventoryLevels(first: 20) {
                      nodes {
                        location {
                          id
                          name
                        }
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        query: searchQuery.trim()
      }
    );

    const products = data.products.nodes.map<InventoryProduct>((product) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor ?? "",
      productType: product.productType ?? "",
      tags: product.tags ?? [],
      totalInventory: product.totalInventory ?? 0,
      updatedAt: product.updatedAt,
      imageUrl: product.featuredImage?.url ?? null,
      imageAlt: product.featuredImage?.altText ?? null,
      variants: product.variants.nodes.map((variant) => ({
        id: variant.id,
        title: variant.title,
        sku: variant.inventoryItem?.sku ?? "",
        barcode: variant.barcode ?? "",
        price: variant.price ?? "0.00",
        compareAtPrice: variant.compareAtPrice ?? "",
        wholesalePrice: variant.wholesaleMeta?.value ?? "",
        cost: variant.inventoryItem?.unitCost?.amount ?? "",
        inventoryQuantity: variant.inventoryQuantity ?? 0,
        inventoryItemId: variant.inventoryItem.id,
        tracked: Boolean(variant.inventoryItem.tracked),
        inventoryLevels: variant.inventoryItem.inventoryLevels.nodes.map((level) => ({
          locationId: level.location.id,
          locationName: level.location.name,
          available: level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0
        }))
      }))
    }));

    return {
      shop: data.shop,
      locations,
      selectedLocationId,
      products,
      summary: {
        productCount: products.length,
        variantCount: products.reduce((total, product) => total + product.variants.length, 0),
        inventoryUnits: products.reduce((total, product) => total + product.totalInventory, 0)
      }
    };
  } catch (error) {
    const fallback = await executeGraphQL<{
      shop: ShopSummary;
      products: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          status: string;
          vendor: string | null;
          productType: string | null;
          tags: string[];
          totalInventory: number | null;
          updatedAt: string;
          featuredImage: {
            url: string;
            altText: string | null;
          } | null;
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              barcode: string | null;
              price: string | null;
              inventoryQuantity: number | null;
              inventoryItem: {
                id: string;
                sku: string | null;
                tracked: boolean | null;
              };
            }>;
          };
        }>;
      };
    }>(
      admin,
      `#graphql
        query InventoryDashboardFallback($query: String!) {
          shop {
            name
            myshopifyDomain
            currencyCode
          }
          products(first: 40, sortKey: UPDATED_AT, reverse: true, query: $query) {
            nodes {
              id
              title
              handle
              status
              vendor
              productType
              tags
              totalInventory
              updatedAt
              featuredImage {
                url
                altText
              }
              variants(first: 20) {
                nodes {
                  id
                  title
                  barcode
                  price
                  inventoryQuantity
                  inventoryItem {
                    id
                    sku
                    tracked
                  }
                }
              }
            }
          }
        }
      `,
      {
        query: searchQuery.trim()
      }
    );

    const products = fallback.products.nodes.map<InventoryProduct>((product) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor ?? "",
      productType: product.productType ?? "",
      tags: product.tags ?? [],
      totalInventory: product.totalInventory ?? 0,
      updatedAt: product.updatedAt,
      imageUrl: product.featuredImage?.url ?? null,
      imageAlt: product.featuredImage?.altText ?? null,
      variants: product.variants.nodes.map((variant) => ({
        id: variant.id,
        title: variant.title,
        sku: variant.inventoryItem?.sku ?? "",
        barcode: variant.barcode ?? "",
        price: variant.price ?? "0.00",
        compareAtPrice: "",
        wholesalePrice: "",
        cost: "",
        inventoryQuantity: variant.inventoryQuantity ?? 0,
        inventoryItemId: variant.inventoryItem.id,
        tracked: Boolean(variant.inventoryItem.tracked),
        inventoryLevels: []
      }))
    }));

    return {
      shop: fallback.shop,
      locations: [],
      selectedLocationId: "",
      products,
      loadWarning:
        error instanceof Error
          ? `Some advanced inventory features failed to load: ${error.message}`
          : "Some advanced inventory features failed to load.",
      summary: {
        productCount: products.length,
        variantCount: products.reduce((total, product) => total + product.variants.length, 0),
        inventoryUnits: products.reduce((total, product) => total + product.totalInventory, 0)
      }
    };
  }
}

async function updateProductBasics(
  admin: AdminClient,
  productId: string,
  input: ProductUpsertInput
) {
  const data = await executeGraphQL<{
    productUpdate: {
      product: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation UpdateProduct($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      product: {
        id: productId,
        title: input.title,
        vendor: input.vendor || null,
        productType: input.productType || null,
        tags: input.tags,
        status: input.status
      }
    }
  );

  const errors = mapUserErrors(data.productUpdate.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function updateVariantDetails(
  admin: AdminClient,
  productId: string,
  variantId: string,
  input: ProductUpsertInput
) {
  const data = await executeGraphQL<{
    productVariantsBulkUpdate: {
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation UpdateVariantDetails($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: [
        {
          id: variantId,
          price: input.price,
          compareAtPrice: input.compareAtPrice || null,
          barcode: input.barcode || null
        }
      ]
    }
  );

  const errors = mapUserErrors(data.productVariantsBulkUpdate.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function updateInventoryItem(
  admin: AdminClient,
  inventoryItemId: string,
  input: ProductUpsertInput
) {
  const data = await executeGraphQL<{
    inventoryItemUpdate: {
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: inventoryItemId,
      input: {
        sku: input.sku,
        tracked: true,
        ...(input.cost ? { cost: input.cost } : {})
      }
    }
  );

  const errors = mapUserErrors(data.inventoryItemUpdate.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function setWholesalePrice(admin: AdminClient, variantId: string, wholesalePrice: string) {
  const value = cleanCell(wholesalePrice);
  if (!value || value === "0" || value === "0.00") return;

  const data = await executeGraphQL<{
    metafieldsSet: {
      metafields: Array<{ id: string }> | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation SetWholesalePrice($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: variantId,
          namespace: "custom",
          key: "wholesale_price",
          value,
          type: "number_decimal"
        }
      ]
    }
  );

  const errors = mapUserErrors(data.metafieldsSet.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function ensureInventoryActivated(
  admin: AdminClient,
  inventoryItemId: string,
  locationId: string
) {
  const data = await executeGraphQL<{
    inventoryActivate: {
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      inventoryItemId,
      locationId
    }
  );

  const errors = mapUserErrors(data.inventoryActivate.userErrors).filter(
    (message) => !message.toLowerCase().includes("already")
  );

  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function setInventoryQuantity(
  admin: AdminClient,
  inventoryItemId: string,
  locationId: string,
  quantity: number
) {
  const data = await executeGraphQL<{
    inventorySetQuantities: {
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation SetInventoryQuantity($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId,
            locationId,
            quantity
          }
        ]
      }
    }
  );

  const errors = mapUserErrors(data.inventorySetQuantities.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function findVariantBySku(admin: AdminClient, sku: string) {
  const data = await executeGraphQL<{
    productVariants: {
      nodes: Array<{
        id: string;
        product: {
          id: string;
        };
        inventoryItem: {
          id: string;
        };
      }>;
    };
  }>(
    admin,
    `#graphql
      query VariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          nodes {
            id
            product {
              id
            }
            inventoryItem {
              id
            }
          }
        }
      }
    `,
    {
      query: `sku:${sku}`
    }
  );

  return data.productVariants.nodes[0] ?? null;
}

async function createProductRecord(admin: AdminClient, input: ProductUpsertInput) {
  const data = await executeGraphQL<{
    productCreate: {
      product: {
        id: string;
        variants: {
          nodes: Array<{
            id: string;
            inventoryItem: {
              id: string;
            };
          }>;
        };
      } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation CreateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 1) {
              nodes {
                id
                inventoryItem {
                  id
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      product: {
        title: input.title,
        vendor: input.vendor || null,
        productType: input.productType || null,
        tags: input.tags,
        status: input.status
      }
    }
  );

  const errors = mapUserErrors(data.productCreate.userErrors);
  if (errors.length) {
    throw new Error(errors.join("; "));
  }

  const product = data.productCreate.product;
  const variant = product?.variants.nodes[0];

  if (!product || !variant) {
    throw new Error("Shopify did not return the created product variant.");
  }

  return {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id
  };
}

export async function createProduct(
  admin: AdminClient,
  locationId: string,
  input: ProductUpsertInput
) {
  const created = await createProductRecord(admin, input);
  await updateVariantDetails(admin, created.productId, created.variantId, input);
  await updateInventoryItem(admin, created.inventoryItemId, input);
  await setWholesalePrice(admin, created.variantId, input.wholesalePrice);

  if (locationId) {
    await ensureInventoryActivated(admin, created.inventoryItemId, locationId);
    await setInventoryQuantity(admin, created.inventoryItemId, locationId, input.quantity);
  }
}

export async function createProductGroup(
  admin: AdminClient,
  locationId: string,
  group: ProductGroupInput
) {
  // Single variant: delegate to existing single-variant flow
  if (group.variants.length <= 1) {
    const v = group.variants[0] ?? {
      title: "Default Title", sku: "", barcode: "",
      price: "0.00", compareAtPrice: "", wholesalePrice: "", cost: "", quantity: 10,
    };
    return createProduct(admin, locationId, {
      title: group.title, sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice,
      wholesalePrice: v.wholesalePrice, cost: v.cost, quantity: v.quantity,
      barcode: v.barcode, vendor: group.vendor, productType: group.productType,
      tags: group.tags, status: group.status,
    });
  }

  // Multi-variant: create product with productOptions so Shopify auto-creates one variant per value
  const data = await executeGraphQL<{
    productCreate: {
      product: {
        id: string;
        variants: { nodes: Array<{ id: string; title: string; inventoryItem: { id: string } }> };
      } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation CreateProductGroup($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 50) {
              nodes { id title inventoryItem { id } }
            }
          }
          userErrors { field message }
        }
      }
    `,
    {
      product: {
        title: group.title,
        vendor: group.vendor || null,
        productType: group.productType || null,
        tags: group.tags,
        status: group.status,
        productOptions: [
          { name: "Size", values: group.variants.map((v) => ({ name: v.title })) },
        ],
      },
    }
  );

  const errors = mapUserErrors(data.productCreate.userErrors);
  if (errors.length) throw new Error(errors.join("; "));

  const product = data.productCreate.product;
  if (!product) throw new Error("Shopify did not return the created product.");

  // Map returned variant nodes by title (Shopify variant.title = the option value for single-option products)
  const nodeByTitle = new Map(
    product.variants.nodes.map((n) => [n.title.toLowerCase().trim(), n])
  );

  // Bulk-update price, compareAtPrice, barcode, SKU for all variants in one call
  const bulkVariants = group.variants
    .map((v) => {
      const node = nodeByTitle.get(v.title.toLowerCase().trim());
      if (!node) return null;
      return {
        id: node.id,
        price: v.price || "0.00",
        compareAtPrice: v.compareAtPrice || null,
        barcode: v.barcode || null,
        inventoryItem: { sku: v.sku || null },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (bulkVariants.length) {
    await executeGraphQL(
      admin,
      `#graphql
        mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }
      `,
      { productId: product.id, variants: bulkVariants }
    );
  }

  // Set cost, wholesale price, and inventory per variant
  for (const v of group.variants) {
    const node = nodeByTitle.get(v.title.toLowerCase().trim());
    if (!node) continue;
    const asInput: ProductUpsertInput = {
      title: group.title, sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice,
      wholesalePrice: v.wholesalePrice, cost: v.cost, quantity: v.quantity,
      barcode: v.barcode, vendor: group.vendor, productType: group.productType,
      tags: group.tags, status: group.status,
    };
    await updateInventoryItem(admin, node.inventoryItem.id, asInput);
    await setWholesalePrice(admin, node.id, v.wholesalePrice);
    if (locationId) {
      await ensureInventoryActivated(admin, node.inventoryItem.id, locationId);
      await setInventoryQuantity(admin, node.inventoryItem.id, locationId, v.quantity);
    }
  }
}

export async function updateProductRecord(
  admin: AdminClient,
  locationId: string,
  productId: string,
  variantId: string,
  inventoryItemId: string,
  input: ProductUpsertInput
) {
  await updateProductBasics(admin, productId, input);
  await updateVariantDetails(admin, productId, variantId, input);
  await updateInventoryItem(admin, inventoryItemId, input);
  await setWholesalePrice(admin, variantId, input.wholesalePrice);

  if (locationId) {
    await updateVariantInventory(admin, locationId, inventoryItemId, input.quantity);
  }
}

export async function updateVariantInventory(
  admin: AdminClient,
  locationId: string,
  inventoryItemId: string,
  quantity: number
) {
  if (!locationId) {
    throw new Error("No inventory location is available. Reinstall the app after adding read_locations.");
  }

  await ensureInventoryActivated(admin, inventoryItemId, locationId);
  await setInventoryQuantity(admin, inventoryItemId, locationId, quantity);
}

export async function deleteProducts(admin: AdminClient, productIds: string[]) {
  if (productIds.length === 0) {
    throw new Error("Select at least one product to delete.");
  }

  const skippedMissing: string[] = [];
  const failures: string[] = [];

  for (const productId of productIds) {
    try {
      const data = await executeGraphQL<{
        productDelete: {
          deletedProductId: string | null;
          userErrors: UserError[];
        };
      }>(
        admin,
        `#graphql
          mutation DeleteProduct($productId: ID!) {
            productDelete(input: { id: $productId }) {
              deletedProductId
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          productId
        }
      );

      const errors = mapUserErrors(data.productDelete.userErrors);
      const missingError = errors.find((message) => message.toLowerCase().includes("product does not exist"));

      if (missingError) {
        skippedMissing.push(productId);
        continue;
      }

      if (errors.length) {
        failures.push(`${productId}: ${errors.join("; ")}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delete error";
      if (message.toLowerCase().includes("product does not exist")) {
        skippedMissing.push(productId);
        continue;
      }

      failures.push(`${productId}: ${message}`);
    }
  }

  if (failures.length) {
    throw new Error(failures.join("; "));
  }

  if (skippedMissing.length === productIds.length) {
    throw new Error("The selected products no longer exist in Shopify.");
  }

  if (skippedMissing.length > 0) {
    return {
      deletedCount: productIds.length - skippedMissing.length,
      skippedMissingCount: skippedMissing.length
    };
  }

  return {
    deletedCount: productIds.length,
    skippedMissingCount: 0
  };
}

export async function importProductsFromCsv(
  admin: AdminClient,
  locationId: string,
  csvText: string
) {
  const records = parseCsv(csvText);

  if (!records.length) {
    throw new Error("The CSV file is empty or the header row is missing.");
  }

  let createdCount = 0;
  let updatedCount = 0;
  const errors: string[] = [];

  for (const [index, record] of records.entries()) {
    const title = cleanCell(record.title);
    const sku = cleanCell(record.sku);
    const input: ProductUpsertInput = {
      title: title || `Imported item ${index + 1}`,
      sku,
      price: cleanCell(record.price) || "0.00",
      compareAtPrice: cleanCell(record.compareAtPrice),
      wholesalePrice: cleanCell(record.wholesalePrice),
      cost: cleanCell(record.cost),
      quantity: parseNumber(record.quantity, 0),
      barcode: cleanCell(record.barcode),
      vendor: cleanCell(record.vendor),
      productType: cleanCell(record.productType),
      tags: normalizeTags(record.tags),
      status:
        cleanCell(record.status).toUpperCase() === "ARCHIVED"
          ? "ARCHIVED"
          : cleanCell(record.status).toUpperCase() === "DRAFT"
            ? "DRAFT"
            : "ACTIVE"
    };

    try {
      const existing = sku ? await findVariantBySku(admin, sku) : null;

      if (!existing) {
        await createProduct(admin, locationId, input);
        createdCount += 1;
      } else {
        await updateProductBasics(admin, existing.product.id, input);
        await updateVariantDetails(admin, existing.product.id, existing.id, input);
        await updateInventoryItem(admin, existing.inventoryItem.id, input);

        if (locationId) {
          await updateVariantInventory(admin, locationId, existing.inventoryItem.id, input.quantity);
        }

        updatedCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import error";
      errors.push(`Row ${index + 2}: ${message}`);
    }
  }

  return {
    createdCount,
    updatedCount,
    errors
  };
}

export function buildInventoryCsv(products: InventoryProduct[]) {
  const header = [
    "productId",
    "variantId",
    "title",
    "status",
    "vendor",
    "productType",
    "tags",
    "variantTitle",
    "sku",
    "barcode",
    "price",
    "compareAtPrice",
    "wholesalePrice",
    "cost",
    "quantity",
    "updatedAt"
  ];

  const rows = products.flatMap((product) =>
    product.variants.map((variant) =>
      [
        product.id,
        variant.id,
        product.title,
        product.status,
        product.vendor,
        product.productType,
        product.tags.join(", "),
        variant.title,
        variant.sku,
        variant.barcode,
        variant.price,
        variant.compareAtPrice,
        variant.wholesalePrice,
        variant.cost,
        variant.inventoryQuantity,
        product.updatedAt
      ]
        .map(csvEscape)
        .join(",")
    )
  );

  return [header.join(","), ...rows].join("\n");
}

export function csvTemplate() {
  return [
    "title,sku,price,compareAtPrice,wholesalePrice,cost,quantity,barcode,vendor,productType,tags,status",
    "Sample Perfume,SKU-001,39.99,49.99,24.99,15.00,12,1234567890123,Grace Essences,Perfume,\"niche,imported\",ACTIVE"
  ].join("\n");
}

const SEX_MAP: Record<string, string> = {
  M: "Male",
  L: "Lady",
  F: "Female",
  U: "Unisex"
};

// Well-known column names (upper-cased) that typically distinguish product variants
const AUTO_VARIANT_COL_NAMES = [
  "SIZE", "TALLA", "ML", "OZ", "VOLUMEN", "VOLUME",
  "CONCENTRATION", "CONC", "CONCENTRACION", "CONCENTRACIÓN",
  "TYPE", "TIPO", "FORMAT", "FORMATO", "PRESENTATION", "PRESENTACION",
  "PESO", "WEIGHT", "CAPACITY",
];

function applySupplierMapping(
  records: Record<string, unknown>[],
  mapping: SupplierColumnMapping,
  rules: SupplierPricingRules
): ProductGroupInput[] {
  const groupMap = new Map<string, ProductGroupInput>();

  // Auto-detect variant columns from well-known names when none are manually selected
  const recordKeys = Object.keys(records[0] ?? {});
  const autoVariantCols =
    mapping.variantTitleCols.length > 0
      ? mapping.variantTitleCols
      : recordKeys.filter((k) => AUTO_VARIANT_COL_NAMES.includes(k.toUpperCase()));

  for (const record of records) {
    const get = (col: string) => String(record[col] ?? "").trim();

    const cost = parseNumber(get(mapping.costCol), 0);
    const retailFromCol = mapping.retailPriceCol ? parseNumber(get(mapping.retailPriceCol), 0) : 0;
    const wholesaleFromCol = mapping.wholesalePriceCol ? parseNumber(get(mapping.wholesalePriceCol), 0) : 0;
    const retail = retailFromCol > 0 ? retailFromCol : cost * rules.retailMultiplier;
    const wholesale = wholesaleFromCol > 0 ? wholesaleFromCol : cost * rules.wholesaleMultiplier;

    const rawTitle = get(mapping.titleCol);
    if (!rawTitle.trim()) continue;

    const barcode = get(mapping.barcodeCol);
    let sku = get(mapping.skuCol);
    if (!sku && mapping.useUpcAsSku && barcode) sku = barcode;

    // Build variant label from auto-detected (or manually selected) variant columns
    const variantParts = autoVariantCols
      .map((col) => get(col))
      .filter((v) => v && v !== "0");
    // Fall back to SKU so each row stays unique even if no variant columns exist
    const variantTitle = variantParts.join(" / ").trim() || sku || "Default Title";

    // Always group by exact product title — automatic multi-variant grouping
    const effectiveKey = rawTitle;

    // Build tags
    const baseTags = normalizeTags(get(mapping.tagsCol));
    const extraTags = mapping.tagColumns
      .map((col) => {
        const val = get(col);
        if (!val) return null;
        return SEX_MAP[val.toUpperCase()] ?? val;
      })
      .filter((v): v is string => v !== null && v.length > 0);
    const sheetTag = String(record.__sheetName ?? "").trim();
    const allTags = [...new Set([...baseTags, ...extraTags, ...(sheetTag ? [sheetTag] : [])])];

    const variant: VariantInput = {
      title: variantTitle,
      sku,
      barcode,
      price: retail.toFixed(2),
      compareAtPrice: "",
      wholesalePrice: wholesale.toFixed(2),
      cost: cost > 0 ? cost.toFixed(2) : "",
      quantity: parseNumber(get(mapping.quantityCol), 10),
    };

    if (!groupMap.has(effectiveKey)) {
      groupMap.set(effectiveKey, {
        title: effectiveKey,
        vendor: get(mapping.vendorCol) || rules.defaultVendor,
        productType: get(mapping.productTypeCol) || rules.defaultProductType,
        tags: allTags,
        status: rules.defaultStatus,
        variants: [],
      });
    }
    groupMap.get(effectiveKey)!.variants.push(variant);
  }

  return [...groupMap.values()];
}

export function normalizeSupplierCsv(
  csvText: string,
  mapping: SupplierColumnMapping,
  rules: SupplierPricingRules
): ProductGroupInput[] {
  const records = parseCsv(csvText);
  if (!records.length) return [];
  return applySupplierMapping(records, mapping, rules);
}

export function getExcelInfo(buffer: ArrayBuffer): ExcelInfo {
  const wb = xlsxRead(buffer, { type: "array" });
  // Collect all unique headers across all sheets
  const headerSet = new Set<string>();
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = xlsxUtils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
    const firstRow = rows[0] ?? [];
    firstRow.forEach((h) => { if (h) headerSet.add(String(h)); });
  }
  return { sheets: wb.SheetNames, headers: [...headerSet] };
}

export function normalizeExcelWorkbook(
  buffer: ArrayBuffer,
  selectedSheets: string[],
  mapping: SupplierColumnMapping,
  rules: SupplierPricingRules
): ProductGroupInput[] {
  const wb = xlsxRead(buffer, { type: "array" });
  const allRecords: Record<string, unknown>[] = [];

  const sheetsToProcess = selectedSheets.length > 0
    ? selectedSheets
    : wb.SheetNames;

  for (const name of sheetsToProcess) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = xlsxUtils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
    // Inject sheet name so applySupplierMapping can use it as a category tag
    rows.forEach((r) => { r.__sheetName = name; });
    allRecords.push(...rows);
  }

  return applySupplierMapping(allRecords, mapping, rules);
}

// ─── Product Images ───────────────────────────────────────────────────────────

export async function attachProductImages(
  admin: AdminClient,
  productId: string,
  images: Array<{ url: string; alt: string }>
): Promise<void> {
  const media = images.map((img) => ({
    originalSource: img.url,
    alt: img.alt,
    mediaContentType: "IMAGE",
  }));

  const res = await admin.graphql(
    `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        mediaUserErrors { field message }
      }
    }`,
    { variables: { productId, media } }
  );

  const json = (await res.json()) as {
    data?: { productCreateMedia?: { mediaUserErrors?: UserError[] } };
    errors?: GraphQLError[];
  };

  const gqlErrors = json.errors ?? [];
  if (gqlErrors.length > 0) throw new Error(gqlErrors.map((e) => e.message).join("; "));

  const userErrors = json.data?.productCreateMedia?.mediaUserErrors ?? [];
  if (userErrors.length > 0) throw new Error(userErrors.map((e) => e.message).join("; "));
}

export async function fetchProductImages(
  admin: AdminClient,
  productId: string
): Promise<Array<{ id: string; url: string; alt: string }>> {
  const res = await admin.graphql(
    `query productMedia($id: ID!) {
      product(id: $id) {
        media(first: 50) {
          nodes {
            ... on MediaImage {
              id
              image { url altText }
            }
          }
        }
      }
    }`,
    { variables: { id: productId } }
  );

  const json = (await res.json()) as {
    data?: {
      product?: {
        media?: { nodes?: Array<{ id?: string; image?: { url?: string; altText?: string | null } }> };
      };
    };
  };

  return (json.data?.product?.media?.nodes ?? [])
    .filter((n) => n.id && n.image?.url)
    .map((n) => ({ id: n.id!, url: n.image!.url!, alt: n.image!.altText ?? "" }));
}

export async function deleteProductImage(
  admin: AdminClient,
  productId: string,
  mediaId: string
): Promise<void> {
  const res = await admin.graphql(
    `mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        userErrors { field message }
      }
    }`,
    { variables: { productId, mediaIds: [mediaId] } }
  );

  const json = (await res.json()) as {
    data?: { productDeleteMedia?: { userErrors?: UserError[] } };
    errors?: GraphQLError[];
  };

  const gqlErrors = json.errors ?? [];
  if (gqlErrors.length > 0) throw new Error(gqlErrors.map((e) => e.message).join("; "));
}

export function buildNormalizedCsv(groups: ProductGroupInput[]) {
  // Matches the official Shopify product CSV import template column order
  const header = [
    "Title", "URL handle", "Description", "Vendor", "Product category", "Type", "Tags",
    "Published on online store", "Status", "SKU", "Barcode",
    "Option1 name", "Option1 value", "Option1 Linked To",
    "Option2 name", "Option2 value", "Option2 Linked To",
    "Option3 name", "Option3 value", "Option3 Linked To",
    "Price", "Compare-at price", "Cost per item", "Charge tax", "Tax code",
    "Unit price total measure", "Unit price total measure unit",
    "Unit price base measure", "Unit price base measure unit",
    "Inventory tracker", "Inventory quantity", "Continue selling when out of stock",
    "Weight value (grams)", "Weight unit for display", "Requires shipping", "Fulfillment service",
    "Product image URL", "Image position", "Image alt text", "Variant image URL", "Gift card",
    "SEO title", "SEO description", "Color (product.metafields.shopify.color-pattern)",
    "Google Shopping / Google product category", "Google Shopping / Gender",
    "Google Shopping / Age group", "Google Shopping / Manufacturer part number (MPN)",
    "Google Shopping / Ad group name", "Google Shopping / Ads labels",
    "Google Shopping / Condition", "Google Shopping / Custom product",
    "Google Shopping / Custom label 0", "Google Shopping / Custom label 1",
    "Google Shopping / Custom label 2", "Google Shopping / Custom label 3",
    "Google Shopping / Custom label 4",
    "Wholesale price"
  ];

  function toHandle(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
  }
  function toShopifyStatus(s: string) {
    return ({ ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived" } as Record<string, string>)[s.toUpperCase()] ?? "Draft";
  }

  const rows: string[] = [];

  for (const group of groups) {
    const handle = toHandle(group.title);
    const multi = group.variants.length > 1;

    group.variants.forEach((v, idx) => {
      const first = idx === 0;
      rows.push([
        first ? group.title : "",
        handle,
        "",
        first ? group.vendor : "",
        "",
        first ? group.productType : "",
        first ? group.tags.join(", ") : "",
        first ? "TRUE" : "",
        first ? toShopifyStatus(group.status) : "",
        v.sku,
        v.barcode,
        multi ? "Size" : "Title",
        multi ? v.title : "Default Title",
        "", "", "", "", "", "", "",     // Option linked-tos + Options 2&3
        v.price,
        v.compareAtPrice,
        v.cost,
        "TRUE", "", "", "", "", "",     // Charge tax + tax/unit price fields
        "shopify",
        String(v.quantity),
        "DENY",
        "", "",                         // Weight
        "TRUE",
        "manual",
        "", "", "", "",                 // Images
        first ? "FALSE" : "",
        "", "",                         // SEO
        "",                             // Color metafield
        "", "", "", "", "", "", "", "", "", "", "", "", "",  // Google Shopping
        v.wholesalePrice,
      ].map(csvEscape).join(","));
    });
  }

  return [header.join(","), ...rows].join("\n");
}
