// PM2 process definition for the VPS deployment. tsx needs Node >= 22.5
// (node:sqlite), so the interpreter points at the nvm-managed Node 22 binary
// rather than the system Node the pm2 daemon itself runs under.
module.exports = {
  apps: [
    {
      name: "proofdesk",
      cwd: __dirname,
      interpreter: process.env.PROOFDESK_NODE_BIN || "node",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/main.ts live",
      env: {
        PROOFDESK_NETWORK: "devnet",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "400M",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
