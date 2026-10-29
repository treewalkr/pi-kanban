import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

if (!("window" in globalThis)) {
  (globalThis as any).window = { location: { origin: "http://localhost:4600" } };
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte-ts-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const src = await Bun.file(args.path).text();
      const js = transpiler.transformSync(src);
      const out = compileModule(js, { generate: "client", filename: args.path });
      return { contents: out.js.code, loader: "js" };
    });
  },
});
