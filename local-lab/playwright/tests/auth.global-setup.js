const fs = require('node:fs');

module.exports = async () => {
  // Credentials arrive once through stdin, not CLI arguments, files, or reports.
  const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!/^[0-9a-f]{32}$/.test(fixture.run_id || '') ||
      !/^fixture-[0-9a-f]{32}@example\.invalid$/.test(fixture.email || '') ||
      typeof fixture.password !== 'string' || fixture.password.length < 32) {
    throw new Error('Invalid LOCAL_LAB fixture input');
  }
  process.env.JKH_FIXTURE_RUN_ID = fixture.run_id;
  process.env.JKH_FIXTURE_EMAIL = fixture.email;
  process.env.JKH_FIXTURE_PASSWORD = fixture.password;
};
