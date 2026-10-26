const { fixture } = require("../test/helpers/mock-runtime.cjs");
fixture({port:3210,autoReply:true}).then(f=>{
  console.log("Mock translator available at http://127.0.0.1:3210 (no external API)");
  process.on("SIGTERM",()=>f.close().then(()=>process.exit(0)));
});