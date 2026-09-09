export default {
  name: "no-fn-suffix",
  rules: {
    "no-fn-suffix": {
      create(ctx: Deno.lint.RuleContext) {
        return {
          TSPropertySignature(node: Deno.lint.TSPropertySignature) {
            const key = node.key;
            if (key.type === "Identifier" && key.name.endsWith("Fn")) {
              ctx.report({
                node: key,
                message:
                  "Don't suffix function-typed property names with 'Fn'. Use the plain name instead.",
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
