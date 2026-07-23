"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

assert.equal(
  fs.existsSync(path.join(root, "shared", "full_recalc_shadow_compare.js")),
  true,
  "the canonical shadow comparison asset must exist"
);

const card = read("web/abonent_card.html");
assert.match(
  card,
  /<script\s+src="\.\.\/shared\/full_recalc_shadow_compare\.js"><\/script>/,
  "the card must request the deployed /shared asset URL"
);

const compose = read("docker-compose.yml");
assert.match(
  compose,
  /- \.\/shared:\/usr\/share\/nginx\/html\/shared:ro/,
  "nginx must mount the canonical shared source at its /shared static path"
);

const nginx = read("nginx/default.conf");
assert.match(nginx, /root\s+\/usr\/share\/nginx\/html;/, "nginx web root changed");
assert.match(nginx, /try_files\s+\$uri\s+\$uri\/\s+=404;/, "nginx static contract changed");

console.log("test_shadow_compare_static_asset_contract.js: PASS");
