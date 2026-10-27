# NidusLab Finance & Accounting

Static front-end (HTML/CSS/JS) + Supabase (Postgres, Auth, Storage, Realtime). Hosted on Vercel.

- `index.html`, `css/`, `js/`, `assets/` — the app (no build step).
- `supabase/schema.sql` — tables, RLS policies, receipt bucket, realtime. Every object is prefixed `fin_` so it is safe on a shared Supabase project.
- `js/config.js` — Supabase URL + publishable key (public by design; data is protected by RLS).

Roles: `PENDING` (no access) → `EMPLOYEE` (view only) → `FINANCE` / `ADMIN` (add, edit, delete). Admins approve users under **Users & Access**.
