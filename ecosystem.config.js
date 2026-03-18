module.exports = {
  apps: [
    {
      name: 'meteora-lp-monitor',
      script: 'dist/index.js',
      interpreter: 'node',
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
    },
  ],
};
