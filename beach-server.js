const http = require("http");
const fs = require("fs");
const path = require("path");
const { getBeachWeather, clearCache, getBeaches } = require("./lib/beach-weather");

const ROOT = __dirname;
const PORT = 8081;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  let filePath = req.url.split("?")[0];
  if (filePath === "/") filePath = "/index.html";
  filePath = path.join(ROOT, path.normalize(filePath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };

    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];

  if (pathname === "/api/beach-weather") {
    try {
      if (req.url.includes("refresh=1")) clearCache();
      const data = await getBeachWeather();
      sendJson(res, 200, { success: true, ...data });
    } catch (error) {
      sendJson(res, 502, { success: false, message: error.message });
    }
    return;
  }

  if (pathname === "/api/beaches") {
    sendJson(res, 200, { success: true, beaches: getBeaches() });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`해수욕장 대시보드: http://127.0.0.1:${PORT}`);
  console.log("종료: Ctrl+C");
});
