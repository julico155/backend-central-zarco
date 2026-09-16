-- Up Migration
-- Foto de producto para mostrar en el POS y en el catálogo que consulta el
-- agente de WhatsApp. Se sirve siempre a través del backend
-- (GET /products/:id/image, mismo guard que el resto del catálogo) — nunca
-- una URL directa al bucket, igual que payment-proofs.
alter table products
  add column image_key text null,
  add column image_mime_type text null;

-- Down Migration
alter table products
  drop column if exists image_mime_type,
  drop column if exists image_key;
