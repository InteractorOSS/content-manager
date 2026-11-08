# Interactor CMS

A standalone Next.js content management system for the Interactor website — the source of
truth for posts, categories, media, FAQs, and form submissions. It exposes a public read
API, an authenticated REST API, and an MCP server so any client can manage content.

**Integrating with this CMS from the outside?** Start at the hosted docs:
**[https://cms.interactor.com/docs](https://cms.interactor.com/docs)** — the public read
API, authentication and permissions, the full REST reference, and the MCP tool reference.

## Running locally

```
docker compose up -d      # start local Postgres (port 5460)
npm install
npx prisma db seed        # seed roles/permissions
npm run dev                # dev server on port 4021
```

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server on port 4021 |
| `npm run build` | Production build |
| `npm run typecheck` | Must pass before commit |
| `npm run lint` | Must pass before commit (zero warnings) |
| `npm test` | Vitest suite — must pass before commit |
| `npx prisma migrate dev` | Create/apply migrations |
| `npx prisma db seed` | Seed roles/permissions |

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security
issue, see [SECURITY.md](SECURITY.md).
