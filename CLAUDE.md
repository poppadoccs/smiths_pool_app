<!-- GSD:project-start source:PROJECT.md -->
## Project

**Pool Field Forms**

An iPad app for pool installation crews that replaces paper job forms with a digital workflow. Field workers select a job, take photos, fill out a form, and submit — which emails the completed form and photos to the office for review and forwarding. Built for Alex's friend who runs a pool installation business.

**Core Value:** Workers can complete and submit job forms from the field without paper — photos, form data, and job info all land in the boss's office email in one submission.

### Constraints

- **Platform**: iPad-first (web app that works great on iPad Safari or PWA)
- **Simplicity**: Field workers aren't tech people — must be dead simple to use
- **Email delivery**: Must reliably send form + photos to a configured email address
- **AI**: Needs vision AI to convert a photo of a paper form into a digital template
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Next.js | 16.2 | Full-stack React framework | Current stable. App Router with Server Actions handles form submission natively. Turbopack gives fast dev. Built-in image optimization. First-class Vercel deployment. |
| React | 19 | UI library | Ships with Next.js 16. Server Components reduce client JS bundle. Form actions built-in. |
| TypeScript | 5.x | Type safety | Non-negotiable for any 2026 project. Catches form schema mismatches at build time, pairs with Zod for runtime validation. |
| Tailwind CSS | 4.2 | Styling | CSS-first config (no tailwind.config.js). 5x faster builds. Touch-friendly utility classes for iPad UI. |
| shadcn/ui | latest (CLI v4) | UI components | Not a dependency -- copies components into your project. Touch-friendly Radix primitives. Composable, customizable, no lock-in. |
### AI / Form Generation
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| AI SDK (`ai`) | 6.x (~6.0.134) | Unified AI integration | Vercel's official SDK. `generateText` with `output` setting replaces old `generateObject`. Provider-agnostic -- swap OpenAI for Anthropic without code changes. |
| `@ai-sdk/openai` | 3.x (~3.0.48) | OpenAI provider | Connects AI SDK to GPT-4o. Vision support for image-to-form. Structured output via Zod schemas. |
| Zod | 4.x (~4.3.6) | Schema validation | Defines form template schemas that AI must conform to. Shared between AI output validation and form input validation. Single source of truth. |
### Form Handling
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| react-hook-form | 7.x (~7.72.0) | Form state management | Uncontrolled components = minimal re-renders on iPad. `useFieldArray` handles dynamic fields from AI-generated templates. 48M+ weekly downloads, battle-tested. |
| `@hookform/resolvers` | latest | Zod integration | Bridges react-hook-form with Zod schemas. Same Zod schema validates both AI output and user input. |
### Email
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Resend | 6.x (~6.9.4) | Transactional email API | Modern email API with excellent DX. Supports attachments via base64 or URL. Free tier: 3,000 emails/month (100/day) -- plenty for a small pool company. 40MB max per email including attachments. |
| `@react-email/components` | 1.x (~1.0.10) | Email templates | Build email templates with React/JSX. Type-safe. Preview in browser during development. Same team as Resend. |
### Photo Handling
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@vercel/blob` | latest | File storage | Vercel Blob for persistent photo storage. Client upload path bypasses 4.5MB server limit -- critical for iPad photos. Supports files up to 5TB. URLs can be passed to Resend as attachment paths. |
| `browser-image-compression` | latest | Client-side compression | Compresses iPad photos (often 5-12MB) before upload. Configurable max size/dimensions. ~12KB library. Canvas-based, works in Safari. |
### PWA
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Serwist (`@serwist/next`) | 9.x (~9.5.4) | Service worker / PWA | Successor to next-pwa (unmaintained). Works with Next.js 16 and Turbopack. Handles manifest, caching, installability. Workbox-based. |
### Database
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Prisma | 7.x (~7.5.0) | ORM | Type-safe database access. Migrations, schema-as-code. Works with SQLite for dev, Postgres for prod. |
| Vercel Postgres (Neon) | managed | Production database | Serverless Postgres. 60 free compute hours on Hobby plan. Stores jobs, form templates, submissions. No server to manage. |
| SQLite | - | Local development DB | Zero-config dev database. Prisma makes switching to Postgres seamless. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `next-themes` | latest | Dark/light mode | If you want theme support (optional for field app -- likely just light mode) |
| `sonner` | latest | Toast notifications | Submission confirmations, error feedback. Touch-friendly. |
| `lucide-react` | latest | Icons | Tree-shakeable icons. shadcn/ui default icon set. |
| `date-fns` | latest | Date formatting | Job dates, submission timestamps. Lightweight, tree-shakeable. |
| `uuid` | latest | ID generation | Job IDs, submission IDs. Simple, reliable. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| ESLint | Linting | Ships with Next.js. Use `next/core-web-vitals` config. |
| Prettier | Formatting | With `prettier-plugin-tailwindcss` for class sorting. |
| `react-email` CLI | Email preview | `npx react-email dev` previews email templates at localhost:3001. |
## Installation
# Core framework
# shadcn/ui init
# AI
# Forms
# Email
# Photo handling
# PWA
# Database
# Supporting
# Dev tools
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Next.js 16 | Remix / React Router 7 | If you need nested routing patterns or prefer loaders over Server Actions. Not worth it here -- Next.js has better Vercel integration and PWA tooling. |
| Resend | SendGrid, Postmark | If you need higher free tier volume (SendGrid: 100/day). Resend wins on DX and React Email integration. For a small pool company, 100/day is plenty. |
| Vercel Blob | AWS S3, Cloudinary | If you need image transformation (Cloudinary) or are not on Vercel (S3). Vercel Blob is simplest when deploying to Vercel. |
| Prisma + Vercel Postgres | Drizzle ORM, Supabase | Drizzle if you want SQL-closer syntax. Supabase if you want auth + storage + DB in one. Prisma is more mature with better migration tooling. |
| react-hook-form | TanStack Form | TanStack Form is newer, framework-agnostic. react-hook-form is more mature, has better ecosystem (resolvers, devtools), and more community examples for dynamic forms. |
| AI SDK (Vercel) | Direct OpenAI SDK | If you only ever use OpenAI and want raw control. AI SDK adds structured output with Zod, provider abstraction, and streaming -- worth the thin wrapper. |
| GPT-4o | Claude 3.5 Sonnet | Claude excels at structured extraction too. GPT-4o is recommended because AI SDK OpenAI provider is most battle-tested for vision + structured output. Can swap later via AI SDK provider abstraction. |
| Serwist | next-pwa, @ducanh2912/next-pwa | next-pwa is unmaintained. @ducanh2912/next-pwa is a fork but Serwist is the community-endorsed successor with active maintenance and Next.js 16 support. |
| shadcn/ui | Material UI, Chakra UI, Ant Design | MUI if you want Material Design. Chakra if you want runtime CSS-in-JS (worse perf). shadcn/ui is the 2025/2026 community standard for Tailwind + Radix projects. |
| No native app | React Native, Capacitor | If you need deep native APIs (NFC, Bluetooth). HTML `<input type="file" accept="image/*" capture>` handles camera natively on iPad Safari. No app store deployment needed. PWA is the right call for this scope. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `next-pwa` (original) | Unmaintained for 2+ years. Does not work with Turbopack or Next.js 16. | Serwist (`@serwist/next`) |
| `react-camera-pro` / `react-webcam` | Unnecessary complexity. iPad Safari handles camera natively via `<input type="file" accept="image/*" capture="environment">`. No need for WebRTC stream management. | Native HTML file input with `capture` attribute |
| Formik | Largely replaced by react-hook-form in the ecosystem. More re-renders, larger bundle, less active development. | react-hook-form |
| CSS Modules / styled-components | CSS-in-JS adds runtime cost. CSS Modules work but miss utility-class speed for rapid prototyping. Tailwind v4 is the standard. | Tailwind CSS 4 |
| Firebase | Overkill for this use case. Adds vendor lock-in, complex auth setup, and Firestore's document model is awkward for relational form data. | Prisma + Vercel Postgres |
| Nodemailer | Low-level SMTP library. Requires managing SMTP credentials, connection pooling, deliverability. Resend handles all of this. | Resend |
| `multer` / custom file upload middleware | Server Actions + Vercel Blob handle file uploads natively. No need for Express-style middleware in a Next.js App Router project. | `@vercel/blob` client upload |
| Expo / React Native | Building a native app means App Store review, separate build tooling, and deployment complexity. A PWA on iPad Safari does everything this project needs. | Next.js PWA |
## Stack Patterns by Variant
- Add Serwist runtime caching strategies for API routes
- Use IndexedDB (via `idb` library) for local form draft storage
- Implement background sync for submission queue
- This is explicitly out of scope for v1 per PROJECT.md
- Compress to 1MB max on client before upload
- Consider batch upload with progress indicators
- May need to switch from email attachments to email with links (Resend 40MB limit)
- Form template schema is already dynamic (AI-generated JSON)
- Just needs a template selection UI and database table for saved templates
- Architecture already supports this without rewrite
- Add NextAuth.js (Auth.js) with email magic links (simple for field workers)
- Prisma adapter works out of the box
- Keep it simple -- no password management for field workers
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Next.js 16.2 | React 19, Tailwind 4.2 | Ships with React 19. Tailwind 4 requires PostCSS or Vite plugin (Next.js uses PostCSS). |
| AI SDK 6.x | @ai-sdk/openai 3.x, Zod 4.x | AI SDK 6 deprecated `generateObject` -- use `generateText` with `output` setting. Zod 4 schemas work directly. |
| react-hook-form 7.x | @hookform/resolvers (latest), Zod 4.x | Resolvers bridge RHF with Zod validation. Ensure `@hookform/resolvers` version supports Zod 4. |
| Prisma 7.x | Vercel Postgres (Neon), SQLite | Single schema file, swap datasource between dev (SQLite) and prod (Postgres) via env vars. |
| Serwist 9.x | Next.js 16.x | Disabled in dev mode due to Turbopack. Service worker active only in production builds. |
| shadcn/ui (CLI v4) | Tailwind 4, React 19 | CLI scaffolds for Next.js 16. Copies components, not a runtime dependency. |
| Resend 6.x | @react-email/components 1.x | Same team. React Email renders to HTML string, Resend sends it. |
## Sources
- [Next.js 16.2 Blog Post](https://nextjs.org/blog/next-16-2) -- version, features (HIGH confidence)
- [Next.js PWA Guide](https://nextjs.org/docs/app/guides/progressive-web-apps) -- official PWA patterns (HIGH confidence)
- [AI SDK 6 Blog Post](https://vercel.com/blog/ai-sdk-6) -- migration from generateObject (HIGH confidence)
- [AI SDK generateObject Reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-object) -- structured output with vision (HIGH confidence)
- [AI SDK Migration Guide 5.x to 6.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0) -- breaking changes (HIGH confidence)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) -- vision + structured output compatibility (HIGH confidence)
- [MDN HTML capture attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/capture) -- iPad camera capture (HIGH confidence)
- [Resend Attachments Docs](https://resend.com/docs/dashboard/emails/attachments) -- base64 and URL attachment methods (HIGH confidence)
- [Resend Pricing](https://resend.com/pricing) -- free tier 3,000/month (HIGH confidence)
- [Vercel Blob Docs](https://vercel.com/docs/vercel-blob) -- client upload bypasses 4.5MB limit (HIGH confidence)
- [Serwist Getting Started](https://serwist.pages.dev/docs/next/getting-started) -- Next.js integration (HIGH confidence)
- [react-hook-form npm](https://www.npmjs.com/package/react-hook-form) -- v7.72.0 (HIGH confidence)
- [Zod v4 Release Notes](https://zod.dev/v4) -- v4.3.6 (HIGH confidence)
- [Prisma 7.2.0 Blog](https://www.prisma.io/blog/announcing-prisma-orm-7-2-0) -- latest version (HIGH confidence)
- [Tailwind CSS v4.2 Release](https://tailwindcss.com/blog) -- version confirmed (HIGH confidence)
- [shadcn/ui Changelog](https://ui.shadcn.com/docs/changelog) -- CLI v4, March 2026 (HIGH confidence)
- [browser-image-compression npm](https://www.npmjs.com/package/browser-image-compression) -- client-side compression (MEDIUM confidence -- version not pinned)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

### Database
- **Current Neon DB**: use `npx prisma db push` only. Never run `prisma migrate dev` or `prisma migrate reset` against it.
- Leave existing migrations alone. We can set up a separate dev database later for clean migration workflow.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



## Codex Review

After completing a feature, bug fix, or significant code change, use the `codex` skill in read-only mode to review the work before considering it done. Use model `gpt-5.4`, reasoning effort `high`, and sandbox `read-only`. Summarize any issues Codex finds and address them before marking the task complete.

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
