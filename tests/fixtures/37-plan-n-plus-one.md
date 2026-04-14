<!-- @testing-only: Phase 37 N+1 plan fixture for gsd-architect testing. -->
<!-- Contains deliberate N+1 pattern at design level (plan text, not SQL). -->

# Plan: Product Catalog API

## Task 1: Category Listing

Fetch all product categories from the database. For each category in the
taxonomy, fetch all products belonging to that category and compute aggregate
statistics (total items, average price, stock count).

The endpoint will iterate through categories and make individual product
queries per category to build the response.

Expected behavior: returns nested category -> products structure.

## Task 2: Dashboard Statistics (GOOD pattern)

Fetch dashboard statistics using a single JOIN query that aggregates products
by category. Use GROUP BY to compute totals in one pass.

```sql
SELECT c.name, COUNT(p.id) as total, AVG(p.price) as avg_price
FROM categories c
JOIN products p ON p.category_id = c.id
GROUP BY c.name;
```

This avoids the N+1 problem by computing everything in a single query.
