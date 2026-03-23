# Inventory Shopify Manager

Base inicial para una app de Shopify embebida con Remix, Polaris y Prisma.

## Requisitos

- Node.js 20+
- Una app creada en Shopify Partners
- Variables en `.env`

## Variables de entorno

Usa `.env.example` como referencia:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `DATABASE_URL`

## Comandos

```bash
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

## Siguiente paso

Conecta el proyecto con tu app de Shopify Partner y luego ajustamos autenticación, webhooks y la lógica de inventario que necesite tu tienda.
