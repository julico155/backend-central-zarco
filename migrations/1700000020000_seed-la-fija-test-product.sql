-- Up Migration
--
-- Semilla controlada para la prueba de integración de La Fija: UNA categoría
-- ("Hamburguesas") y UN producto real ("La Fija"), con el UUID y el code
-- exactos que ya usa el catálogo del agente de WhatsApp.
--
-- A propósito NO se usa `on conflict do nothing`: eso taparía justo el caso
-- que importa detectar — que el UUID o el code ya estén tomados por OTRA
-- fila. Si el catálogo quedó inconsistente con lo que espera la prueba, esta
-- migración falla ruidosamente en vez de dejar pasar una fila equivocada.
--
-- Es convergente, no "insertar una sola vez": si la fila ya existe con el
-- MISMO id y el MISMO code, se actualiza a los valores declarados abajo
-- (nombre, categoría, precio, flags). Correr la migración dos veces deja
-- siempre el mismo estado. Ojo: eso pisa un precio cambiado a mano por
-- PATCH /products — es deliberado, esta fila es de prueba y su fuente de
-- verdad es este archivo.
--
-- Importes en BOB (bolivianos), como el resto del esquema: price 25 = Bs 25.

do $$
declare
  k_product_id   constant uuid := '08856059-3cd2-4beb-aab7-62ba1cd7eb63';
  k_product_code constant text := 'la_fija';
  k_product_name constant text := 'La Fija';
  k_price        constant numeric(10,2) := 25;
  k_sort_order   constant integer := 10;
  k_category     constant text := 'Hamburguesas';
  v_category_id    uuid;
  v_category_count integer;
  v_by_id   products%rowtype;
  v_by_code products%rowtype;
begin
  ---------------------------------------------------------------------------
  -- Categoría. `categories.name` no tiene unique, así que un nombre repetido
  -- es ambiguo: no hay forma de elegir bien y adivinar sería peor que fallar.
  ---------------------------------------------------------------------------
  select count(*) into v_category_count
  from categories
  where btrim(lower(name)) = lower(k_category);

  if v_category_count > 1 then
    raise exception
      'Hay % categorías llamadas "%": ambiguo. Resolver el duplicado a mano antes de correr esta migración.',
      v_category_count, k_category;
  end if;

  if v_category_count = 1 then
    select id into v_category_id
    from categories
    where btrim(lower(name)) = lower(k_category);

    update categories
    set is_active = true, updated_at = now()
    where id = v_category_id and is_active is distinct from true;

    raise notice 'Categoría "%" ya existía (%), se reutiliza.', k_category, v_category_id;
  else
    insert into categories (name, sort_order, is_active)
    values (k_category, 1, true)
    returning id into v_category_id;

    raise notice 'Categoría "%" creada (%).', k_category, v_category_id;
  end if;

  ---------------------------------------------------------------------------
  -- Producto. Dos claves independientes que tienen que apuntar a la MISMA
  -- fila: el UUID (pk) y el code (unique). Cualquier combinación en la que
  -- no coincidan es un catálogo inconsistente -> excepción, no silencio.
  ---------------------------------------------------------------------------
  select * into v_by_id   from products where id   = k_product_id;
  select * into v_by_code from products where code = k_product_code;

  if v_by_id.id is not null and v_by_code.id is not null then
    if v_by_id.id <> v_by_code.id then
      raise exception
        'Conflicto: el UUID % es el producto "%" (code %) y el code "%" pertenece a otro producto (%). Catálogo inconsistente.',
        k_product_id, v_by_id.name, v_by_id.code, k_product_code, v_by_code.id;
    end if;

    update products
    set name        = k_product_name,
        category_id = v_category_id,
        price       = k_price,
        is_active   = true,
        is_available = true,
        sort_order  = k_sort_order,
        updated_at  = now()
    where id = k_product_id;

    raise notice 'Producto "%" (%) ya existía: actualizado a los valores de la prueba.',
      k_product_name, k_product_id;

  elsif v_by_id.id is not null then
    raise exception
      'Conflicto de UUID: % ya existe como "%" con code "%", se esperaba code "%".',
      k_product_id, v_by_id.name, v_by_id.code, k_product_code;

  elsif v_by_code.id is not null then
    raise exception
      'Conflicto de code: "%" ya existe como "%" con UUID %, se esperaba UUID %.',
      k_product_code, v_by_code.name, v_by_code.id, k_product_id;

  else
    insert into products (id, code, name, category_id, price, is_active, is_available, sort_order)
    values (k_product_id, k_product_code, k_product_name, v_category_id, k_price, true, true, k_sort_order);

    raise notice 'Producto "%" creado (%).', k_product_name, k_product_id;
  end if;
end $$;

-- Down Migration
--
-- No-op deliberado: esta migración NO revierte la semilla de catálogo.
--
-- El Up es convergente, no "insert-only": si la categoría "Hamburguesas" o el
-- producto "La Fija" ya existían (creados a mano, por el POS o por otra
-- semilla), los reutiliza y los actualiza en vez de fallar. Una vez aplicado,
-- el estado final es idéntico se haya creado la fila acá o antes — no queda
-- ninguna marca que permita distinguir "esto lo creé yo" de "esto ya estaba".
--
-- Por eso un Down que borre es inseguro por construcción: no puede saber qué
-- está borrando. En el peor caso se lleva puesto un producto real del catálogo
-- vivo, y con él el precio, la foto y el sort_order que alguien configuró.
-- Fallar hacia el lado de dejar datos de más es recuperable; borrar catálogo
-- de producción no lo es.
--
-- Si de verdad hay que sacar estas filas, se hace a mano y con criterio,
-- verificando antes que no estén referenciadas por pedidos:
--
--   select count(*) from order_items
--   where product_id = '08856059-3cd2-4beb-aab7-62ba1cd7eb63';
--
--   delete from products where id = '08856059-3cd2-4beb-aab7-62ba1cd7eb63';
--   -- y la categoría solo si quedó sin productos:
--   delete from categories c
--   where c.id = '<id de Hamburguesas>'
--     and not exists (select 1 from products p where p.category_id = c.id);
--
-- node-pg-migrate exige una sentencia en el Down para poder desregistrar la
-- migración; este select no toca nada.
select 1 where false;
