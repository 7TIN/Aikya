const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  development: process.env.NODE_ENV !== "production",

  routes: {
    "/": () =>
      new Response(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>db-branch</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        margin: 0;
        background: #0b0b0f;
        color: #f5f5f7;
      }
      main { text-align: center; }
      code { color: #f472b6; }
    </style>
  </head>
  <body>
    <main>
      <h1>db-branch server</h1>
      <p>Running on <code>${hostname}:${port}</code></p>
      <p>Try <a href="/api/health" style="color:#60a5fa">/api/health</a></p>
    </main>
  </body>
</html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),

    "/api/health": () =>
      Response.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }),

    "/api/echo": {
      POST: async (req) => {
        const body = await req.text();
        return Response.json({ received: body });
      },
    },
  },

  error(error) {
    console.error(error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  },

  fetch() {
    return Response.json({ error: "Not Found" }, { status: 404 });
  },
});

console.log(`Server listening on http://localhost:${server.port}`);
