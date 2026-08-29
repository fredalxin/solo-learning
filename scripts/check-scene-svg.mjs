import assert from "node:assert/strict";
import { scopeSceneSvgStyles } from "../src/sceneSvg.js";

const scoped = scopeSceneSvgStyles('<svg><style>.t,.h{font-size:14px}@keyframes pulse{50%{opacity:.5}}.pulse{animation:pulse 1s}</style><text class="t">字</text></svg>');
const id = scoped.match(/data-scene-scope="([^"]+)"/)?.[1];
assert.ok(id);
assert.match(scoped, new RegExp(`\\[data-scene-scope="${id}"\\] \\.t`));
assert.match(scoped, /@keyframes pulse\{50%\{opacity:\.5}}/);
assert.doesNotMatch(scoped, /<style>\.t/);
console.log("scene SVG scoping check passed");
