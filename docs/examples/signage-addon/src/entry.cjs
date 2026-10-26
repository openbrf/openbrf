// The server entry point the host loads. It requires the bundle and reads
// `exports.createPlugin`, so the assignment is written out rather than left to
// the bundler's interop.
exports.createPlugin = require("./server.ts").createPlugin;
