// Node-Loader für Tests, die Browser-Module aus web/ laden: dort importieren sie lib-Dateien als ./pulse-*.js (im Build aufgelöst,
// scripts/build-web.mjs). Hier dieselbe Umlenkung nach lib/. Nutzung: register('./web-loader.mjs', import.meta.url) vor dem import().
export async function resolve(spec, ctx, next) {
  if (/^\.\/pulse-[\w-]+\.js$/.test(spec) && ctx.parentURL && /\/web\/[\w-]+\.js$/.test(ctx.parentURL)) return next(new URL(`../lib/${spec.slice(2)}`, ctx.parentURL).href, ctx);
  return next(spec, ctx);
}
