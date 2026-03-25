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
  quantity: number;
  barcode: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
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
              barcode: string | null;
              price: string | null;
              inventoryQuantity: number | null;
              inventoryItem: {
                id: string;
                sku: string | null;
                tracked: boolean | null;
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
                  barcode
                  price
                  inventoryQuantity
                  inventoryItem {
                    id
                    sku
                    tracked
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
          ? `Algunas funciones avanzadas de inventario no cargaron: ${error.message}`
          : "Algunas funciones avanzadas de inventario no cargaron.",
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
        tracked: true
      }
    }
  );

  const errors = mapUserErrors(data.inventoryItemUpdate.userErrors);
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

  if (locationId) {
    await ensureInventoryActivated(admin, created.inventoryItemId, locationId);
    await setInventoryQuantity(admin, created.inventoryItemId, locationId, input.quantity);
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
    throw new Error("Los productos seleccionados ya no existen en Shopify.");
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
    "title,sku,price,quantity,barcode,vendor,productType,tags,status",
    "Perfume de muestra,SKU-001,39.99,12,1234567890123,Grace Essences,Perfume,\"nicho,importado\",ACTIVE"
  ].join("\n");
}
