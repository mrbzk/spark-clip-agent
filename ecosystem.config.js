// pm2 process file — `pm2 start ecosystem.config.js` on the Hostinger VPS.
module.exports = {
  apps: [
    {
      name: "spark-clip-agent",
      script: "src/index.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: { NODE_ENV: "production" },
    },
  ],
};
