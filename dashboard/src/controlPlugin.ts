import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { authorizeControlRequest } from "./controlAuth";
import { handleControl } from "./control";
import { createNodeControlIO } from "./nodeControl";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function maskclawControlPlugin(devControlToken = ""): Plugin {
  const io = createNodeControlIO();
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? "";
    if (!url.startsWith("/control")) {
      next();
      return;
    }
    const pathname = url.split("?")[0] ?? url;
    if (!authorizeControlRequest(pathname, req.headers, devControlToken)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "dev control token required" }));
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const result = await handleControl({ method: req.method ?? "GET", pathname, body }, io);
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result.json));
  };
  return {
    name: "maskclaw-control",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
