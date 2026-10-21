// Minimal static server for docs/ (keep-alive, correct MIME types): node tests/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','docs');
const port=+(process.argv[2]||process.env.PORT||8767);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.txt':'text/plain; charset=utf-8','.css':'text/css'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  const file=path.normalize(path.join(root,p));
  if(!file.startsWith(root)){res.writeHead(403);res.end();return;}
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()){res.writeHead(404);res.end('not found');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':st.size,'Cache-Control':'no-cache'});
    fs.createReadStream(file).pipe(res);
  });
}).listen(port,'127.0.0.1',()=>console.log(`serving ${root} at http://127.0.0.1:${port}/`));
