import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const requests = [];
const server = createServer(async (request, response) => {
  if (request.url === "/requests") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(requests));
    return;
  }
  if (request.url?.startsWith("/prefix/v1/")) {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }));
    return;
  }
  if (["/clickman.js", "/clickman.global.js"].includes(request.url)) {
    response.setHeader("content-type", "text/javascript");
    response.end(await readFile(`dist${request.url}`));
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(
    "<!doctype html><html><head><title>SDK fixture</title></head><body>Clickman browser fixture</body></html>",
  );
});
server.listen(3107, "127.0.0.1");
process.on("SIGTERM", () => server.close());
