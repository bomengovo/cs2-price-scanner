import http from "node:http";
const port = Number(process.argv[2] || 3000);
http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("port holder"); }).listen(port, "127.0.0.1");
