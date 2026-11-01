const http = require("http");
const fs = require("fs");
const path = require("path");

const PERCO_HOST = "srv-perco1";
const PERCO_PORT = 80;
const LOCAL_PORT = 3000;

const server = http.createServer((req, res) => {
    if (req.url === "/" && req.method === "GET") {
        const htmlPath = path.join(__dirname, "index.html");
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end("Error loading index.html");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(data);
        });
        return;
    }

    const options = {
        hostname: PERCO_HOST,
        port: PERCO_PORT,
        path: req.url,
        method: req.method,
        headers: {
            ...req.headers,
            host: PERCO_HOST
        }
    };

    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on("error", (e) => {
        res.writeHead(502);
        res.end("Proxy error: " + e.message);
    });

    req.pipe(proxyReq);
});

server.listen(LOCAL_PORT, () => {
    console.log("Server running at http://localhost:" + LOCAL_PORT);
});