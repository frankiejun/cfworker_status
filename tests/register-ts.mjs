import { registerHooks } from "node:module";
import { extname } from "node:path";

// Resolve the extensionless imports used by the Worker for Node's TS support.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !extname(specifier)) specifier += ".ts";
    return nextResolve(specifier, context);
  },
});
