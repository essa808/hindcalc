const http = require('http'), fs = require('fs');
const html = fs.readFileSync('dist/index.html');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8099, () => console.log('serving dist/index.html on http://localhost:8099'));
