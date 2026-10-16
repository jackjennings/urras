export default {
  name: "no-raw-fetch",
  rules: {
    "no-raw-fetch": {
      create(ctx: Deno.lint.RuleContext) {
        return {
          CallExpression(node: Deno.lint.CallExpression) {
            if (ctx.filename.endsWith("src/http-client.ts")) return;
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "fetch"
            ) {
              ctx.report({
                node: node.callee,
                message: "Use HttpClient instead of calling fetch() directly.",
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
