// node 早期的common.js 规范
const http = require('http');
const server = http.createServer((req,res)=>{
    res.end('Hello World!')
})
server.listen(1314,'0.0.0.0',()=>{
    console.log('Node service run on port 1314')
})