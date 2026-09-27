# Inventory Module — Phase 1: Rate Tracking & Comparison

## Goal
Add an `inventory` module to Securo so a workspace can catalog items it **buys** (with parent/variant hierarchy), record supplier rates over time (including bulk slabs), and compare prices across suppliers and dates.

Existing invoice `Product` model stays untouched — that's what you sell; this is what you buy.

## Decision: Why separate from invoice Products?
The invoice catalog answers "what do we charge?" — it has billing cadences, fiscal refs, external gateway sync. Inventory answers "what did we pay, from whom, when?" — it needs suppliers, date-stamped rates, bulk tiers, variants. Merging them creates a god-table that serves neither well. Separate module, clean boundary. If a future phase needs to link "bought item X → sold as product Y → margin", a simple FK bridge does it without coupling the schemas.

---

## Data Model

### Tables

**1. `inventory_items`** — Parent items (e.g., "JK Copier Paper")
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| workspace_id | UUID FK workspaces | CASCADE delete |
| user_id | UUID FK users | SET NULL on delete |
| name | String(300) | e.g., "JK Copier Paper" |
| description | Text | nullable |
| item_type | String(50) | e.g., "paper_reel", "ream", "carton" — free text, workspace's vocabulary |
| unit | String(30) | default counting unit: "ctn", "ream", "kg", "ton" |
| active | Boolean | default true, soft archive |
| custom_fields | JSON | nullable, extensibility |
| created_at | DateTime(tz) | |
| updated_at | DateTime(tz) | |

Indexes: `(workspace_id, active)`, unique `(workspace_id, name)`.

**2. `inventory_variants`** — Specific variants of a parent item
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| item_id | UUID FK inventory_items | CASCADE |
| workspace_id | UUID FK workspaces | CASCADE (denormalized for query speed) |
| name | String(300) | e.g., "70 GSM Easy", "Color Paper", "Satia brand" |
| sku | String(100) | nullable, optional internal code |
| attributes | JSON | nullable — structured: `{"gsm": 70, "brand": "Satia", "packing": "ream"}` |
| active | Boolean | default true |
| created_at | DateTime(tz) | |
| updated_at | DateTime(tz) | |

Indexes: `(item_id)`, unique `(workspace_id, item_id, name)`.

**3. `inventory_suppliers`** — Who you buy from
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| workspace_id | UUID FK workspaces | CASCADE |
| user_id | UUID FK users | SET NULL |
| name | String(300) | |
| contact_info | JSON | nullable — `{"phone": "...", "email": "...", "address": "..."}` |
| notes | Text | nullable |
| active | Boolean | default true |
| created_at | DateTime(tz) | |
| updated_at | DateTime(tz) | |

Indexes: unique `(workspace_id, name)`.

Note: Could reuse `Payee` model, but payees are counterparties from bank transactions (sync-created, often hundreds of card descriptors). Suppliers are intentionally created business contacts with rates attached. Different lifecycle, different UI. A future phase can link supplier ↔ payee if needed.

**4. `inventory_rates`** — A supplier's price for a variant, on a date, at a quantity tier
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| variant_id | UUID FK inventory_variants | CASCADE |
| supplier_id | UUID FK inventory_suppliers | CASCADE |
| workspace_id | UUID FK workspaces | CASCADE (denormalized) |
| rate | Decimal(15,2) | price per unit |
| currency | String(3) | workspace currency default |
| min_qty | Decimal(12,2) | default 1 — the minimum order qty for this rate slab |
| unit | String(30) | nullable — override variant's unit if rate is per different unit (e.g., rate per "ton" on a "ctn" item) |
| effective_date | Date | when this rate was quoted/valid |
| notes | Text | nullable |
| created_at | DateTime(tz) | |

Indexes: `(variant_id, supplier_id, effective_date)`, `(workspace_id, effective_date)`.

No unique constraint on (variant_id, supplier_id, effective_date, min_qty) — same supplier can quote different rates same day for different conversations. Rates are append-only history, not upserted.

### Relationships
```
InventoryItem 1──* InventoryVariant 1──* InventoryRate *──1 InventorySupplier
```

---

## Task Breakdown

### Phase 1A: Backend — Models + Migration + CRUD
**~2-3 hours**

| # | Task | Files | Depends |
|---|------|-------|---------|
| 1 | Create 4 model files | `models/inventory_item.py`, `models/inventory_variant.py`, `models/inventory_supplier.py`, `models/inventory_rate.py` + register in `models/__init__.py` | — |
| 2 | Alembic migration | `alembic/versions/XXX_add_inventory_module.py` | 1 |
| 3 | Pydantic schemas | `schemas/inventory.py` (all 4 entities, Create/Update/Read) | 1 |
| 4 | Service layer | `services/inventory_service.py` — CRUD for items+variants+suppliers+rates, rate comparison query | 1, 3 |
| 5 | API routes | `api/inventory.py` — REST endpoints under `/api/inventory/` | 4 |
| 6 | Register in main.py | Add inventory router | 5 |
| 7 | Add `inventory` to module system | `services/module_service.py` (ModuleId + CATALOG), default_enabled=False | — |
| 8 | Backend tests | `tests/test_inventory.py` — CRUD + rate comparison | 5 |

### Phase 1B: Frontend — UI
**~3-4 hours**

| # | Task | Files | Depends |
|---|------|-------|---------|
| 9 | TypeScript types | `types/index.ts` — inventory interfaces | Phase 1A |
| 10 | API client namespace | `lib/api.ts` — `inventory.*` methods | 9 |
| 11 | Module registration | `lib/modules.ts` — add `'inventory'` | 7 |
| 12 | Inventory list page | `pages/inventory.tsx` — items list with variant expand | 10 |
| 13 | Item detail / variants | `pages/inventory-item.tsx` — variants table, add/edit | 12 |
| 14 | Suppliers page | `pages/suppliers.tsx` — supplier CRUD | 10 |
| 15 | Rate entry form | Component in item detail — add rate for variant+supplier+date+qty | 13 |
| 16 | **Rate comparison view** | Table/grid: variants × suppliers, filterable by date range, qty tier. The key deliverable. | 15 |
| 17 | Routes + nav | `App.tsx` routes, sidebar nav entry | 12 |
| 18 | i18n keys | `locales/en.json` | 12 |

---

## API Endpoints

```
# Items
GET    /api/inventory/items                 — list (workspace-scoped, ?search, ?active)
POST   /api/inventory/items                 — create item (+ optional variants inline)
GET    /api/inventory/items/:id             — get with variants
PATCH  /api/inventory/items/:id             — update
DELETE /api/inventory/items/:id             — archive (set active=false)

# Variants
POST   /api/inventory/items/:id/variants    — add variant
PATCH  /api/inventory/variants/:id          — update variant
DELETE /api/inventory/variants/:id          — archive variant

# Suppliers
GET    /api/inventory/suppliers             — list
POST   /api/inventory/suppliers             — create
PATCH  /api/inventory/suppliers/:id         — update
DELETE /api/inventory/suppliers/:id         — archive

# Rates
POST   /api/inventory/rates                 — record a rate (variant_id, supplier_id, rate, date, min_qty)
GET    /api/inventory/rates                 — list rates (?variant_id, ?supplier_id, ?date_from, ?date_to, ?min_qty)
DELETE /api/inventory/rates/:id             — remove rate entry

# Comparison (the key query)
GET    /api/inventory/compare               — ?variant_ids[]=...&supplier_ids[]=...&date_from=&date_to=&qty=
  Returns: matrix of variant × supplier with best/latest rates, % difference
```

---

## Rate Comparison Logic

The compare endpoint answers: "For variant X at quantity Y, which supplier is cheapest, and how have rates changed?"

```python
# Pseudocode
for each (variant_id, supplier_id) pair:
    find latest rate where min_qty <= requested_qty and effective_date in range
    return {variant, supplier, rate, effective_date, rate_per_unit}
# Then rank by rate ascending, compute % diff from cheapest
```

Bulk slab logic: a supplier's rate for "min 10 ctn" applies to any order >= 10 ctn. Query picks the highest min_qty slab that's <= the requested qty. If no qty filter, returns all slabs.

---

## What's NOT in Phase 1 (add when needed)

- **Stock tracking** (ordered/received/sold/leftover) → Phase 2
- **Profit margin calculation** (link to invoice products) → Phase 2
- **Purchase orders** → Phase 3
- **Barcode/SKU scanning** → Phase 3
- **Rate alerts** (notify when a supplier's price changes >X%) → Phase 2
- **Bulk import of rates** (CSV) → Phase 2
- **Supplier ↔ Payee linking** → when someone asks

---

## Execution Order

1. Models → Migration → verify tables exist
2. Schemas + Service + Routes → verify with pytest
3. Module system registration → verify feature flag works
4. Frontend types + API client
5. Pages: list → detail → suppliers → rate entry → comparison view
6. Manual browser test of full flow

Each backend task commits atomically. Frontend can be one commit or split at page boundaries.
