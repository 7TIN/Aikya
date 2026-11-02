# db-branch

A small Bun HTTP server.

## Setup

```bash
bun install
```

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start the server with hot reload (`--watch`) |
| `bun run build` | Bundle the server into `dist/` |
| `bun run start` | Run the built server from `dist/` |
| `bun run typecheck` | Type check the project |

The server listens on `PORT` (default `3000`) and binds to `HOST` (default `0.0.0.0`).

## Routes

- `GET /` — simple HTML landing page
- `GET /api/health` — JSON health check
- `POST /api/echo` — returns the request body as JSON

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
