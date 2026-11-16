---
name: database-migrations
description: Use when a change adds or alters database tables, columns, indexes or data. Keeps schema changes safe to deploy and safe to roll back.
---

# Database migrations

A deployment replaces the app while the database keeps its data. Preview and production are separate databases, and a failed health check brings back the previous commit. Every migration must survive that.

## Rules

1. **Every schema change is a migration file** in the repository, created with the project's migration tool. Never change a schema by hand or from application start-up code that is not the migration runner.
2. **Never edit a migration that has been merged.** Write a new one.
3. **Migrations run forward automatically** at deploy, before the app serves requests, and are safe to run twice.
4. **The previous version of the app must still work** on the new schema, because a rollback returns to that version without undoing the migration.

## Changing without breaking: expand, then contract

- **Add** columns as nullable or with a default. Add tables and indexes freely.
- **Rename or change a type** in steps over separate features: add the new column, write to both, copy the data, read from the new one, and only then remove the old one.
- **Remove** a column or table only in a later feature than the one that stopped using it.
- **Add a constraint** (not null, unique, foreign key) only after the existing data has been checked and corrected in the same migration or an earlier one.

## Data

- Changing data is a migration too, written so that it can be repeated and works on an empty database.
- Large updates go in batches. Do not hold a lock on a whole table in production.
- Never put real personal data or secrets in migrations or seed files.

## Verify

1. Start from an empty database and run all migrations: `docker compose run --rm` with the project's migrate command.
2. Run them again; nothing changes and nothing fails.
3. Run the tests against the migrated schema.
4. For a destructive change, say so in your summary and name the feature in which the application stopped using the old structure.
