-- Up Migration
-- Descripción del producto para el catálogo (POS y agente de WhatsApp) —
-- hasta ahora products no tenía ningún campo de texto libre, solo el name.
alter table products add column description text null;

-- Down Migration
alter table products drop column if exists description;
