-- Up Migration

-- Visibilidad por canal: en qué canal se vende cada producto SUELTO y cada
-- promoción. Un producto puede estar apagado en un canal y aun así venderse
-- dentro de un combo de ese canal (los componentes de una promoción no miran
-- estos flags, solo is_active/is_available). Default true: nada cambia hasta
-- que alguien apague un flag.
alter table products
  add column sell_on_whatsapp boolean not null default true,
  add column sell_on_pos boolean not null default true;

alter table promotions
  add column sell_on_whatsapp boolean not null default true,
  add column sell_on_pos boolean not null default true;

-- Down Migration
alter table promotions
  drop column if exists sell_on_pos,
  drop column if exists sell_on_whatsapp;
alter table products
  drop column if exists sell_on_pos,
  drop column if exists sell_on_whatsapp;
