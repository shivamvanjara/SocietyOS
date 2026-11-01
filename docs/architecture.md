# Architecture

SocietyOS starts as a JavaScript npm-workspaces monorepo and modular monolith: React/Vite in `apps/web`, Express in `apps/api`, and small shared contracts in `packages/shared`. PostgreSQL is accessed through Prisma. The API is versioned under `/api/v1`.

Tenant-owned records must carry a society identifier, and authorization must derive the active society from server-managed membership context. The first schema establishes users, societies, memberships and opaque session-token hashes. Domain records and tenant-scoped access helpers are deferred until their corresponding modules are implemented.

The app layer applies Helmet, a single configured credentialed CORS origin, JSON size limits and API rate limits. Authentication stores opaque session-token hashes in PostgreSQL through Prisma and uses the PostgreSQL driver adapter. Platform-wide management is isolated behind stored super-admin roles and records access changes in a platform audit table. Subscription and service-entitlement models remain future work. Production deployment still requires HTTPS, monitoring, backup procedures and reviewed environment configuration.
