const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.resolve(__dirname, "..", "web", "abonent_card.html");
const html = fs.readFileSync(file, "utf8");
const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let checked = 0;
while ((match = scriptPattern.exec(html))) {
  if (/\bsrc\s*=/.test(match[1])) continue;
  const code = match[2].trim();
  if (!code) continue;
  checked += 1;
  new vm.Script(code, { filename: `abonent_card.html:inline-${checked}` });
}
if (!checked) throw new Error("No inline scripts found in abonent_card.html");
console.log(`abonent_card inline scripts syntax OK (${checked})`);
