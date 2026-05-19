# Changelog

## 2026-05-17

### Project Setup
- Scaffolded Next.js 16 + TypeScript + Tailwind CSS v4 project
- Configured for BC Cancer Agency, INITIO Medical Imaging, UBC Hospital, BC Women's Hospital

### Core Features
- **Availability submission** — residents check off which shifts they can cover
- **Auto-scheduling** — greedy equalization algorithm assigns residents evenly based on availability; enforces one clinic per resident per day
- **Schedule view** — published schedule visible to all residents with shift totals per resident
- **Shift swaps** — residents can post swap requests; another resident accepts by offering one of their own shifts; updates immediately with no admin approval required

### Admin Dashboard
- Shifts tab: set scheduling period with per-day clinic toggles (weekends off by default)
- Availability tab: view all resident submissions with coverage progress bars
- Schedule tab: generate, manually edit, and publish the schedule
- Swaps tab: view and cancel all swap requests

### Database
- Neon Postgres via `@vercel/postgres` for persistent storage
- Tables: `shifts`, `availability_submissions`, `schedule` (singleton row), `swap_requests`

### Infrastructure
- GitHub repo: https://github.com/PierreBoerkoel/ContrastScheduling
- Deployed to Vercel: https://contrast-scheduling.vercel.app

---

### Authentication (Clerk v7)
- All pages require sign-in; public routes: `/`, `/sign-in`, `/sign-up`, `/api/admin/setup`
- Resident identity comes from Clerk session — no manual name entry anywhere
- Admin role stored in Clerk `publicMetadata.role = "admin"`
- Sign-in and sign-up pages use Clerk hosted components

### Self-assignment of unassigned shifts
- On the published schedule, unassigned shifts show a **Take shift** button
- Any logged-in resident can claim an unassigned shift; conflict-safe (409 if already taken)

### Residents tab (admin)
- Admin can view all registered accounts (name, email, role, join date)
- Admin can remove any account except their own

---

## Clerk instance notes
- Dev instance: `blessed-buck-95.clerk.accounts.dev`
- Admin account: pierreboerkoel@gmail.com — role set via Clerk API (`publicMetadata: { role: "admin" }`)
- Free-tier dev instances can expire; if keys stop working, get new ones from https://dashboard.clerk.com and update Vercel env vars + redeploy
