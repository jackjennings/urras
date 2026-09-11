export default {
  name: "no-fn-suffix",
  rules: {
    "no-fn-suffix": {
      create(ctx: Deno.lint.RuleContext) {
        function check(
          node: { key: Deno.lint.Expression | Deno.lint.PrivateIdentifier },
        ) {
          const key = node.key;
          if (key.type === "Identifier" && key.name.endsWith("Fn")) {
            ctx.report({
              node: key,
              message:
                "Don't suffix function-typed property names with 'Fn'. Use the plain name instead.",
            });
          }
        }
        return {
          TSPropertySignature: check,
          PropertyDefinition: check,
          Property: check,
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
